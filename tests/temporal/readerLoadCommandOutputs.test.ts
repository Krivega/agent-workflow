import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactStore, digest } from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import {
  captureReaderLoadCommandOutputs,
  readerLoadObserved,
} from '../../src/adapters/codex/readerLoadCommandOutputs.js';
import { confirmObservedLoad } from '../../src/adapters/codex/observedLoad.js';
import { serialInvocations } from '../../adapters/codex/chatCommandSettlement.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';

const roots: string[] = [];
vi.mock('node:os', async (original) => {
  const native = await original<typeof os>();
  return { ...native, homedir: vi.fn(native.homedir) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'reader-load-output-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  vi.stubEnv('CODEX_HOME', root);
  const path = join(sessions, 'rollout-session.jsonl'),
    store = artifactStore(join(root, 'artifacts'));
  const profile = { model: 'fixture', effort: 'medium', clientVersion: '0.154.0' };
  const ref = { path: '/declared/rules', sha256: digest('hello') };
  const first = { ...ref, format: 'aw-native-read-parts/1', offset: 0, length: 5, content: 'he' };
  const last = { ...first, offset: 2, content: 'llo' };
  const command = 'node -e "literal read with $ and ` preserved"';
  const literal = `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:12000}));`;
  const item: Record<string, unknown> = {
    id: 'exec',
    type: 'commandExecution',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: null,
    cwd: workspace,
    source: 'unifiedExecStartup',
    commandActions: [{ type: 'unknown', command }],
  };
  const turn: Record<string, unknown> = {
    id: 'turn',
    status: 'completed',
    items: [
      item,
      {
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: JSON.stringify(last) + '\n',
      },
    ],
  };
  const primary: Record<string, unknown> = {
    id: 'session',
    path,
    cwd: workspace,
    model: profile.model,
    reasoningEffort: profile.effort,
    cliVersion: profile.clientVersion,
  };
  const meta: Record<string, unknown> = {
    id: 'session',
    cwd: workspace,
    cli_version: profile.clientVersion,
  };
  const context: Record<string, unknown> = {
    turn_id: 'turn',
    cwd: workspace,
    model: profile.model,
    effort: profile.effort,
    approval_policy: 'never',
    sandbox_policy: { type: 'read-only' },
  };
  const native: Record<string, unknown> = {
    id: 'exec',
    type: 'CommandExecution',
    status: 'completed',
    exit_code: 0,
    aggregated_output: '',
    cwd: workspace,
    source: 'unified_exec_startup',
    command: ['/bin/zsh', '-lc', command],
  };
  const call: Record<string, unknown> = {
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'call',
    name: 'exec',
    input: literal,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
  };
  const returned: Record<string, unknown> = {
    type: 'custom_tool_call_output',
    call_id: 'call',
    output: [
      {
        type: 'input_text',
        text: JSON.stringify({
          exit_code: 0,
          output: JSON.stringify(first) + '\n',
          chunk_id: 'chunk',
          wall_time_seconds: 0.1,
          original_token_count: 10,
        }),
      },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
  };
  const rows = [
    { type: 'session_meta', payload: meta },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'turn_context', payload: context },
    { type: 'response_item', payload: call },
    {
      type: 'event_msg',
      payload: { type: 'item_completed', thread_id: 'session', turn_id: 'turn', item: native },
    },
    { type: 'response_item', payload: returned },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ];
  const flush = () => writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const capture = () => {
    flush();
    return captureReaderLoadCommandOutputs(store, primary, turn, workspace, profile);
  };
  const observe = (proof: unknown) =>
    readerLoadObserved(store, turn, proof, workspace, profile, 'session');
  const result = () => object(JSON.parse(String(object((returned.output as unknown[])[0]).text)));
  const changeResult = (patch: Record<string, unknown>) => {
    returned.output = [{ type: 'input_text', text: JSON.stringify({ ...result(), ...patch }) }];
  };
  return {
    root,
    workspace,
    path,
    store,
    profile,
    ref,
    first,
    primary,
    turn,
    item,
    meta,
    context,
    native,
    call,
    returned,
    rows,
    flush,
    capture,
    observe,
    literal,
    result,
    changeResult,
  };
}

it('uses the existing literal grammar and rechecks separate pinned native output without changing RPC', () => {
  const f = fixture(),
    original = JSON.stringify(f.turn);
  expect(serialInvocations(f.literal)).toEqual([
    { command: object((f.item.commandActions as unknown[])[0]).command },
  ]);
  expect(() => confirmObservedLoad(f.turn, [f.ref])).toThrow('reader-load-invalid-fragment');
  const proof = f.capture();
  expect(proof).not.toBeNull();
  expect(() => confirmObservedLoad(f.observe(proof), [f.ref])).not.toThrow();
  expect(JSON.stringify(f.turn)).toBe(original);
  const saved = object(JSON.parse(f.store.read(proof!).toString()));
  expect(saved).toMatchObject({
    kind: 'reader-load-command-outputs/3',
    turn: 'turn',
    bindings: [{ item: 'exec', callLine: 4, commandLine: 5, returnLine: 6 }],
  });
  unlinkSync(f.path);
  expect(() => confirmObservedLoad(f.observe(proof), [f.ref])).not.toThrow();
});

it('accepts the actual generated v4 literal through the unchanged native collector', () => {
  const f = fixture(),
    path = join(f.workspace, 'source'),
    ref = { path, sha256: digest('hello') };
  writeFileSync(path, 'hello');
  const expression = readerLoadPrompt([ref], 4).split('\n').at(-1)!;
  const invocation = serialInvocations(expression)![0]!;
  if (!('command' in invocation)) throw new Error('expected exec_command');
  const { command } = invocation;
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: f.workspace, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  f.call.input = expression;
  f.native.command = ['/bin/zsh', '-lc', command];
  f.item.commandActions = [{ type: 'unknown', command }];
  f.turn.items = [f.item];
  f.changeResult({ exit_code: result.status, output: result.stdout });
  const before = JSON.stringify(f.turn),
    proof = f.capture();
  expect(proof).not.toBeNull();
  expect(() => confirmObservedLoad(f.observe(proof), [ref])).not.toThrow();
  expect(JSON.stringify(f.turn)).toBe(before);
});

it('keeps genuine nonempty RPC evidence and permits only the known code-mode framing', () => {
  const f = fixture();
  f.item.aggregatedOutput = JSON.stringify(f.first) + '\n';
  expect(f.capture()).toBeNull();
  expect(f.observe(null)).toBe(f.turn);
  expect(() => confirmObservedLoad(f.turn, [f.ref])).not.toThrow();
  f.item.aggregatedOutput = '';
  (f.returned.output as unknown[]).unshift({
    type: 'input_text',
    text: 'Script completed\nWall time 0.1 seconds\nOutput:\n',
  });
  expect(() => confirmObservedLoad(f.observe(f.capture()), [f.ref])).not.toThrow();
});

it('binds the default native sessions directory when CODEX_HOME is absent', () => {
  const f = fixture();
  f.flush();
  vi.stubEnv('CODEX_HOME', undefined);
  vi.mocked(os.homedir).mockReturnValue(f.root);
  const directory = join(f.root, '.codex', 'sessions');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'rollout-session.jsonl');
  writeFileSync(path, readFileSync(f.path));
  const proof = captureReaderLoadCommandOutputs(
    f.store,
    { ...f.primary, path },
    f.turn,
    f.workspace,
    f.profile,
  );
  expect(() => confirmObservedLoad(f.observe(proof), [f.ref])).not.toThrow();
});

it('rejects nontext code-mode invocation input', () => {
  const f = fixture();
  f.call.input = null;
  expect(() => f.capture()).toThrow();
});

const defects = [
  'header-id',
  'header-path',
  'header-model',
  'header-effort',
  'header-version',
  'header-cwd',
  'meta-id',
  'meta-cwd',
  'meta-version',
  'duplicate-meta',
  'missing-context',
  'duplicate-context',
  'context-model',
  'context-effort',
  'context-cwd',
  'context-approval',
  'context-sandbox',
  'compacted',
  'missing-start',
  'missing-end',
  'native-id',
  'native-thread',
  'native-turn',
  'native-status',
  'native-exit',
  'native-source',
  'native-cwd',
  'native-output',
  'native-command-short',
  'native-shell',
  'native-shell-mode',
  'duplicate-command',
  'rpc-duplicate',
  'rpc-cwd',
  'rpc-source',
  'rpc-actions',
  'rpc-command',
  'eval',
  'raw-render',
  'single-quote',
  'parallel',
  'wrong-command',
  'duplicate-call',
  'duplicate-call-id',
  'cross-name-call-id',
  'cross-kind-call-id',
  'cross-kind-return-id',
  'network-access',
  'nontext-output',
  'call-status',
  'native-command-number',
  'native-command-empty',
  'native-command-large',
  'nontext-result',
  'empty-result',
  'output-not-string',
  'single-function-return',
  'foreign-call-turn',
  'wrong-return-id',
  'duplicate-return',
  'foreign-return-turn',
  'return-array',
  'extra-output',
  'raw-output',
  'bad-framing',
  'result-extra',
  'pending',
  'exit',
  'large-output',
  'large-result',
  'empty-output',
  'wrong-order',
  'turn-status',
  'turn-items',
] as const;
it.each(defects)('rejects unbound or ambiguous primary evidence: %s', (defect) => {
  const f = fixture();
  if (defect.startsWith('header-'))
    f.primary[
      {
        id: 'id',
        path: 'path',
        model: 'model',
        effort: 'reasoningEffort',
        version: 'cliVersion',
        cwd: 'cwd',
      }[defect.slice(7)]!
    ] = 'foreign';
  if (defect.startsWith('meta-'))
    f.meta[{ id: 'id', cwd: 'cwd', version: 'cli_version' }[defect.slice(5)]!] = 'foreign';
  if (defect === 'duplicate-meta') f.rows.unshift(f.rows[0]!);
  if (defect === 'missing-context') f.rows.splice(2, 1);
  if (defect === 'duplicate-context') f.rows.splice(2, 0, f.rows[2]!);
  if (defect.startsWith('context-'))
    f.context[
      {
        model: 'model',
        effort: 'effort',
        cwd: 'cwd',
        approval: 'approval_policy',
        sandbox: 'sandbox_policy',
      }[defect.slice(8)]!
    ] = 'foreign';
  if (defect === 'compacted') f.rows.splice(3, 0, { type: 'compacted', payload: {} });
  if (defect === 'missing-start') f.rows.splice(1, 1);
  if (defect === 'missing-end') f.rows.pop();
  if (
    defect.startsWith('native-') &&
    ['id', 'status', 'exit', 'source', 'cwd', 'output'].includes(defect.slice(7))
  )
    f.native[
      {
        id: 'id',
        status: 'status',
        exit: 'exit_code',
        source: 'source',
        cwd: 'cwd',
        output: 'aggregated_output',
      }[defect.slice(7)]!
    ] = 'foreign';
  if (defect === 'native-thread') f.rows[4]!.payload.thread_id = 'foreign';
  if (defect === 'native-turn') f.rows[4]!.payload.turn_id = 'foreign';
  if (defect === 'native-command-short') f.native.command = ['/bin/zsh'];
  if (defect === 'native-shell') (f.native.command as string[])[0] = '/foreign';
  if (defect === 'native-shell-mode') (f.native.command as string[])[1] = 'unknown';
  if (defect === 'duplicate-command')
    f.rows.splice(5, 0, {
      ...f.rows[4]!,
      payload: { ...f.rows[4]!.payload, item: { ...f.native, id: 'other' } },
    });
  if (defect === 'rpc-duplicate') (f.turn.items as unknown[]).push(f.item);
  if (defect === 'rpc-cwd') f.item.cwd = '/foreign';
  if (defect === 'rpc-source') f.item.source = 'foreign';
  if (defect === 'rpc-actions') f.item.commandActions = [];
  if (defect === 'rpc-command') f.item.commandActions = [{ command: 'foreign' }];
  if (defect === 'eval') f.call.input = 'await eval("(async()=>{"+load("next")+"})()");';
  if (defect === 'raw-render')
    f.call.input = 'const r=await tools.exec_command({cmd:"read"});text(r.output);';
  if (defect === 'single-quote')
    f.call.input = "text(await tools.exec_command({cmd:'read',max_output_tokens:12000}));";
  if (defect === 'parallel') f.call.input = String(f.call.input) + String(f.call.input);
  if (defect === 'wrong-command')
    f.call.input = 'text(await tools.exec_command({cmd:"foreign",max_output_tokens:12000}));';
  if (defect === 'duplicate-call')
    f.rows.splice(4, 0, { type: 'response_item', payload: { ...f.call, call_id: 'duplicate' } });
  if (defect === 'duplicate-call-id')
    f.rows.splice(4, 0, { type: 'response_item', payload: { ...f.call, input: 'unrelated' } });
  if (defect === 'cross-name-call-id')
    f.rows.splice(4, 0, { type: 'response_item', payload: { ...f.call, name: 'other' } });
  if (defect === 'cross-kind-call-id')
    f.rows.splice(4, 0, { type: 'response_item', payload: { ...f.call, type: 'function_call' } });
  if (defect === 'cross-kind-return-id')
    f.rows.splice(6, 0, {
      type: 'response_item',
      payload: { ...f.returned, type: 'function_call_output' },
    });
  if (defect === 'network-access')
    f.context.sandbox_policy = { type: 'read-only', network_access: true };
  if (defect === 'nontext-output') object((f.returned.output as unknown[])[0]).type = 'image';
  if (defect === 'call-status') f.call.status = 'inProgress';
  if (defect === 'native-command-number') (f.native.command as unknown[])[2] = 1;
  if (defect === 'native-command-empty') (f.native.command as string[])[2] = '';
  if (defect === 'native-command-large') (f.native.command as string[])[2] = 'x'.repeat(24001);
  if (defect === 'nontext-result') object((f.returned.output as unknown[])[0]).text = 123;
  if (defect === 'empty-result') object((f.returned.output as unknown[])[0]).text = '';
  if (defect === 'output-not-string') f.changeResult({ output: 123 });
  if (defect === 'single-function-return') f.returned.type = 'function_call_output';
  if (defect === 'foreign-call-turn')
    f.call.internal_chat_message_metadata_passthrough = { turn_id: 'foreign' };
  if (defect === 'wrong-return-id') f.returned.call_id = 'foreign';
  if (defect === 'duplicate-return') f.rows.splice(6, 0, f.rows[5]!);
  if (defect === 'foreign-return-turn')
    f.returned.internal_chat_message_metadata_passthrough = { turn_id: 'foreign' };
  if (defect === 'return-array') f.returned.output = 'not-array';
  if (defect === 'extra-output')
    (f.returned.output as unknown[]).push({ type: 'input_text', text: 'extra' });
  if (defect === 'raw-output')
    f.returned.output = [{ type: 'input_text', text: JSON.stringify(f.first) }];
  if (defect === 'bad-framing')
    (f.returned.output as unknown[]).unshift({ type: 'input_text', text: 'other header' });
  if (defect === 'result-extra') f.changeResult({ unbound: true });
  if (defect === 'pending') f.changeResult({ session_id: 123 });
  if (defect === 'exit') f.changeResult({ exit_code: 1 });
  if (defect === 'large-output') f.changeResult({ output: 'x'.repeat(24001) });
  if (defect === 'large-result') f.changeResult({ chunk_id: 'x'.repeat(24001) });
  if (defect === 'empty-output') f.changeResult({ output: '' });
  if (defect === 'wrong-order') [f.rows[3], f.rows[4]] = [f.rows[4]!, f.rows[3]!];
  if (defect === 'turn-status') f.turn.status = 'failed';
  if (defect === 'turn-items') f.turn.items = 'unknown';
  expect(() => f.capture()).toThrow();
});

it('accepts an explicitly disabled native network policy and ignores unrelated invocation kinds', () => {
  const f = fixture();
  f.context.sandbox_policy = { type: 'read-only', network_access: false };
  f.rows.splice(4, 0, {
    type: 'response_item',
    payload: { ...f.call, type: 'function_call', call_id: 'unrelated', name: 'other' },
  });
  expect(() => confirmObservedLoad(f.observe(f.capture()), [f.ref])).not.toThrow();
});

it.each(['symlink', 'hardlink', 'partial', 'non-utf8'] as const)(
  'rejects unsafe native journal bytes: %s',
  (kind) => {
    const f = fixture();
    f.flush();
    if (kind === 'symlink') {
      const copy = join(f.root, 'copy');
      writeFileSync(copy, readFileSync(f.path));
      unlinkSync(f.path);
      symlinkSync(copy, f.path);
    }
    if (kind === 'hardlink') linkSync(f.path, join(f.root, 'alias'));
    if (kind === 'partial') writeFileSync(f.path, 'unfinished');
    if (kind === 'non-utf8') writeFileSync(f.path, Buffer.from([255, 10]));
    expect(() =>
      captureReaderLoadCommandOutputs(f.store, f.primary, f.turn, f.workspace, f.profile),
    ).toThrow();
  },
);

it.each(['binding', 'rpc', 'session', 'prefix', 'kind'] as const)(
  'rejects changed recorded provenance: %s',
  (kind) => {
    const f = fixture(),
      original = f.capture()!,
      proof = object(JSON.parse(f.store.read(original).toString()));
    if (kind === 'binding') proof.bindings = [];
    if (kind === 'rpc') proof.rpcSha256 = '0'.repeat(64);
    if (kind === 'session') object(proof.header).id = 'foreign';
    if (kind === 'prefix') proof.prefix = f.store.publish(Buffer.from('{}\n'));
    if (kind === 'kind') proof.kind = 'unknown';
    const changed = f.store.publish(Buffer.from(JSON.stringify(proof)));
    expect(() => f.observe(changed)).toThrow();
  },
);
