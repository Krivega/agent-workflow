import { supportedTaskClient } from '../../policy/readerExecution.js';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { ReaderExecution } from '../../contracts/readerControl.js';
import { exactFields, object, requireContract, text } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { type artifactStore, digest, readPrivateFile } from '../artifacts/files.js';

type Store = ReturnType<typeof artifactStore>;
type Header = {
  id: string;
  path: string;
  cwd: string;
  model: string;
  effort: string;
  clientVersion: string;
};
type Row = { line: number; hash: string; record: Record<string, unknown> };
type Binding = {
  item: string;
  commandLine: number;
  commandHash: string;
  callLine: number;
  callHash: string;
  returnLine: number;
  returnHash: string;
  outputHash: string;
};
const code = 'reader-load-command-source';

// This deliberately accepts less than code-mode's general JavaScript grammar.
function directCommand(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const match =
    /^\s*text\(\s*await\s+tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")\s*,\s*max_output_tokens\s*:\s*12000\s*\}\s*\)\s*\)\s*;?\s*$/u.exec(
      input,
    );
  return match === null ? null : String(JSON.parse(match[1]!));
}

function header(
  primary: Record<string, unknown>,
  workspace: string,
  profile: ReaderExecution['profile'],
): Header {
  const result = {
    id: text(primary.id),
    path: text(primary.path),
    cwd: text(primary.cwd),
    model: text(primary.model),
    effort: text(primary.reasoningEffort),
    clientVersion: text(primary.cliVersion),
  };
  const root = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  requireContract(
    result.cwd === workspace &&
      result.model === profile.model &&
      result.effort === profile.effort &&
      result.clientVersion === profile.clientVersion &&
      supportedTaskClient(result.clientVersion) &&
      isAbsolute(result.path) &&
      resolve(result.path) === result.path &&
      result.path.startsWith(root + sep) &&
      basename(result.path).endsWith('-' + result.id + '.jsonl'),
    code,
  );
  return result;
}

function records(bytes: Buffer): Row[] {
  const value = bytes.toString('utf8');
  requireContract(Buffer.from(value).equals(bytes) && value.endsWith('\n'), code);
  return value
    .slice(0, -1)
    .split('\n')
    .map((line, i) => ({
      line: i + 1,
      hash: digest(line + '\n'),
      record: object(JSON.parse(line)),
    }));
}

function scoped(rows: Row[], h: Header, turn: Record<string, unknown>) {
  const meta = rows.filter(({ record }) => record.type === 'session_meta');
  requireContract(meta.length === 1, code);
  const m = object(meta[0]!.record.payload);
  requireContract(m.id === h.id && m.cwd === h.cwd && m.cli_version === h.clientVersion, code);
  const events = (kind: string) =>
    rows.filter(
      ({ record }) =>
        record.type === 'event_msg' &&
        object(record.payload).type === kind &&
        object(record.payload).turn_id === turn.id,
    );
  const start = events('task_started'),
    end = events('task_complete');
  requireContract(
    start.length === 1 &&
      end.length === 1 &&
      start[0]!.line < end[0]!.line &&
      end[0]!.line === rows.length,
    code,
  );
  const within = rows.filter(({ line }) => line > start[0]!.line && line < end[0]!.line);
  const contexts = within.filter(
    ({ record }) => record.type === 'turn_context' && object(record.payload).turn_id === turn.id,
  );
  requireContract(
    contexts.length === 1 && !within.some(({ record }) => record.type === 'compacted'),
    code,
  );
  const context = object(contexts[0]!.record.payload);
  const sandbox = object(context.sandbox_policy);
  requireContract(
    context.cwd === h.cwd &&
      context.model === h.model &&
      context.effort === h.effort &&
      context.approval_policy === 'never' &&
      sandbox.type === 'read-only' &&
      (sandbox.network_access === undefined || sandbox.network_access === false),
    code,
  );
  return within;
}

function empty(item: Record<string, unknown>) {
  return (
    item.type === 'commandExecution' &&
    item.status === 'completed' &&
    item.exitCode === 0 &&
    (item.aggregatedOutput === null || item.aggregatedOutput === '')
  );
}

function correlate(rows: Row[], h: Header, turn: Record<string, unknown>) {
  requireContract(turn.status === 'completed' && Array.isArray(turn.items), code);
  const within = scoped(rows, h, turn),
    items = turn.items.map(object);
  const commands = within.filter(
    ({ record }) =>
      record.type === 'event_msg' &&
      object(record.payload).type === 'item_completed' &&
      object(object(record.payload).item).type === 'CommandExecution',
  );
  const invocations = within.filter(
    ({ record }) =>
      record.type === 'response_item' &&
      ['custom_tool_call', 'function_call'].includes(String(object(record.payload).type)),
  );
  const calls = invocations.filter(
    ({ record }) =>
      object(record.payload).type === 'custom_tool_call' && object(record.payload).name === 'exec',
  );
  const bindings: Binding[] = [],
    outputs = new Map<string, string>();
  for (const item of items.filter(empty)) {
    const native = commands.filter(
      ({ record }) => object(object(record.payload).item).id === item.id,
    );
    requireContract(
      native.length === 1 && items.filter((v) => v.id === item.id).length === 1,
      code,
    );
    const commandRecord = native[0]!,
      event = object(commandRecord.record.payload),
      command = object(event.item);
    requireContract(
      event.thread_id === h.id &&
        event.turn_id === turn.id &&
        command.status === 'completed' &&
        command.exit_code === 0 &&
        command.source === 'unified_exec_startup' &&
        command.cwd === h.cwd &&
        command.aggregated_output === '' &&
        Array.isArray(command.command) &&
        command.command.length === 3 &&
        ['/bin/zsh', '/bin/bash'].includes(String(command.command[0])) &&
        ['-lc', '-c'].includes(String(command.command[1])),
      code,
    );
    const literal: unknown = command.command[2];
    requireContract(
      typeof literal === 'string' && literal.length > 0 && Buffer.byteLength(literal) <= 24000,
      code,
    );
    requireContract(
      commands.filter(({ record }) => {
        const argv = object(object(record.payload).item).command;
        return Array.isArray(argv) && argv[2] === literal;
      }).length === 1,
      code,
    );
    const actions = item.commandActions;
    requireContract(
      item.cwd === h.cwd &&
        item.source === 'unifiedExecStartup' &&
        Array.isArray(actions) &&
        actions.length === 1 &&
        object(actions[0]).command === literal,
      code,
    );
    const matching = calls.filter(
      ({ record }) => directCommand(object(record.payload).input) === literal,
    );
    requireContract(matching.length === 1, code);
    const call = matching[0]!,
      callPayload = object(call.record.payload),
      id = text(callPayload.call_id);
    requireContract(
      invocations.filter(({ record }) => object(record.payload).call_id === id).length === 1 &&
        callPayload.status === 'completed' &&
        object(callPayload.internal_chat_message_metadata_passthrough).turn_id === turn.id,
      code,
    );
    const returns = within.filter(
      ({ record }) =>
        record.type === 'response_item' &&
        ['custom_tool_call_output', 'function_call_output'].includes(
          String(object(record.payload).type),
        ) &&
        object(record.payload).call_id === id,
    );
    requireContract(returns.length === 1, code);
    const returned = returns[0]!,
      returnedPayload = object(returned.record.payload);
    requireContract(
      call.line < commandRecord.line &&
        commandRecord.line < returned.line &&
        returnedPayload.type === 'custom_tool_call_output' &&
        object(returnedPayload.internal_chat_message_metadata_passthrough).turn_id === turn.id &&
        Array.isArray(returnedPayload.output),
      code,
    );
    const blocks = returnedPayload.output.map(object);
    for (const block of blocks) {
      exactFields(block, ['type', 'text']);
      requireContract(block.type === 'input_text', code);
    }
    requireContract(
      blocks.length === 1 ||
        (blocks.length === 2 &&
          typeof blocks[0]!.text === 'string' &&
          /^Script completed\nWall time [0-9.]+ seconds\nOutput:\n$/u.test(blocks[0]!.text)),
      code,
    );
    const raw = blocks.at(-1)!.text;
    requireContract(
      typeof raw === 'string' && raw.length > 0 && Buffer.byteLength(raw) <= 24000,
      code,
    );
    const result = object(JSON.parse(raw));
    requireContract(
      Object.keys(result).every((key) =>
        ['output', 'exit_code', 'chunk_id', 'wall_time_seconds', 'original_token_count'].includes(
          key,
        ),
      ) &&
        result.exit_code === 0 &&
        typeof result.output === 'string',
      code,
    );
    requireContract(result.output.length > 0 && !outputs.has(text(item.id)), code);
    outputs.set(text(item.id), result.output);
    bindings.push({
      item: text(item.id),
      commandLine: commandRecord.line,
      commandHash: commandRecord.hash,
      callLine: call.line,
      callHash: call.hash,
      returnLine: returned.line,
      returnHash: returned.hash,
      outputHash: digest(result.output),
    });
  }
  requireContract(bindings.length > 0, code);
  return {
    bindings,
    observed: {
      ...turn,
      items: items.map((item) =>
        outputs.has(String(item.id))
          ? { ...item, aggregatedOutput: outputs.get(String(item.id))! }
          : item,
      ),
    },
  };
}

/** Preserve the original RPC snapshot; only independently bound native tool returns supplement it. */
export function captureReaderLoadCommandOutputs(
  store: Store,
  primary: Record<string, unknown>,
  turn: Record<string, unknown>,
  workspace: string,
  profile: ReaderExecution['profile'],
): ArtifactRef | null {
  requireContract(Array.isArray(turn.items), code);
  if (!turn.items.map(object).some(empty)) return null;
  const h = header(primary, workspace, profile),
    before = lstatSync(h.path);
  requireContract(realpathSync(h.path) === h.path && before.isFile() && before.nlink === 1, code);
  const all = readPrivateFile(h.path),
    after = lstatSync(h.path);
  requireContract(before.dev === after.dev && before.ino === after.ino && after.nlink === 1, code);
  const chunks = all.toString('utf8').split('\n');
  let size = 0,
    found = false;
  for (const line of chunks) {
    if (line === '') break;
    size += Buffer.byteLength(line + '\n');
    const record = object(JSON.parse(line));
    if (
      record.type === 'event_msg' &&
      object(record.payload).type === 'task_complete' &&
      object(record.payload).turn_id === turn.id
    ) {
      found = true;
      break;
    }
  }
  requireContract(found && size <= all.length, code);
  const prefix = all.subarray(0, size),
    { bindings } = correlate(records(prefix), h, turn);
  return store.publish(
    Buffer.from(
      JSON.stringify({
        kind: 'reader-load-command-outputs/3',
        header: h,
        turn: turn.id,
        rpcSha256: digest(JSON.stringify(turn)),
        prefix: store.publish(prefix),
        bindings,
      }),
    ),
  );
}

/** Recheck every supplement against the same saved RPC and immutable native prefix. */
export function readerLoadObserved(
  store: Store,
  turn: Record<string, unknown>,
  proof: unknown,
  workspace: string,
  profile: ReaderExecution['profile'],
  session: string,
) {
  if (proof === null) return turn;
  const body = object(JSON.parse(store.read(controlRef(proof)).toString()));
  exactFields(body, ['kind', 'header', 'turn', 'rpcSha256', 'prefix', 'bindings']);
  const h = object(body.header);
  exactFields(h, ['id', 'path', 'cwd', 'model', 'effort', 'clientVersion']);
  const checked = header(
    {
      id: h.id,
      path: h.path,
      cwd: h.cwd,
      model: h.model,
      reasoningEffort: h.effort,
      cliVersion: h.clientVersion,
    },
    workspace,
    profile,
  );
  requireContract(
    body.kind === 'reader-load-command-outputs/3' &&
      checked.id === session &&
      body.turn === turn.id &&
      body.rpcSha256 === digest(JSON.stringify(turn)),
    code,
  );
  const result = correlate(records(store.read(controlRef(body.prefix))), checked, turn);
  requireContract(same(body.bindings, result.bindings), code);
  return result.observed;
}
