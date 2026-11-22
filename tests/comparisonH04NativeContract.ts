import { join } from 'node:path';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { serialInvocations } from '../adapters/codex/chatCommandSettlement.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import materialSource from '../comparison/materials.json' with { type: 'json' };
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import { h01RawFile, h01ReadJson, h01ReadPin } from './comparisonH01Contract.js';
import type { H04OperationBinding } from './comparisonH04Contract.js';

const suite = parseComparisonSuite(suiteSource);
export const h04Scenario = Object.freeze(suite.scenarios.find((row) => row.id === 'H-04')!);
export const h04Material = parseComparisonMaterials(materialSource, suite).find(
  (row) => row.id === 'H-04',
)!;
Object.freeze(h04Material.files);
Object.freeze(h04Material.mutable);
Object.freeze(h04Material);
Object.freeze(h04Scenario.checks);
export const h04Procedures = [
  'bootstrap',
  'task',
  'evidence',
  'implementation',
  'boundary-review',
] as const;
export function h04PreparedMetadata(
  rules: string,
  executor: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    '.h04/rules.md': rules,
    '.h04/task.md': h04Material.instructions + '\n',
    '.h04/executor.md':
      'Read-only H04 waiter. One launch and exactly one blocking wait in this native turn; no model polling, operation writes, duplicate effect or authority changes.\n' +
      executor,
  });
}
export interface H04NativeOperationRequest {
  kind: 'comparison-h04-native-operation';
  schemaVersion: 1;
  opId: string;
  requestHash: string;
  material: InputRef;
  failure: InputRef;
  engine: 'legacy' | 'temporal';
  operationId: string;
  outputRoot: string;
  workspace: string;
  deadlineNs: string;
  node: InputRef;
  waiter: InputRef;
}
export function h04NativeBinding(request: H04NativeOperationRequest): H04OperationBinding {
  return {
    operationId: request.operationId,
    inputHash: digest(canonical(request)),
    outputRoot: request.outputRoot,
  };
}
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function h04NativeWaitCommand(request: H04NativeOperationRequest, ref: InputRef) {
  return [request.node.locator, request.waiter.locator, '--wait', ref.locator, ref.hash]
    .map(quote)
    .join(' ');
}
export function h04NativeLaunchCode(request: H04NativeOperationRequest, ref: InputRef) {
  return (
    'text(await tools.exec_command(' +
    JSON.stringify({
      cmd: h04NativeWaitCommand(request, ref),
      workdir: request.workspace,
      yield_time_ms: 1000,
      max_output_tokens: 2000,
    }) +
    '));'
  );
}
export function h04NativeWaitingCode(sessionId: number) {
  return (
    'text(await tools.write_stdin(' +
    JSON.stringify({
      session_id: sessionId,
      chars: '',
      yield_time_ms: 60000,
      max_output_tokens: 2000,
    }) +
    '));'
  );
}
export interface H04NativeWaitProof {
  launch: InputRef;
  started: InputRef;
  wait: InputRef;
  completed: InputRef;
  terminal: InputRef;
  turn: string;
  sessionId: number;
}
export function h04NativeRecord(ref: InputRef) {
  const match = /^(.*)#L([1-9]\d*)$/u.exec(ref.locator);
  requireWorkflow(match !== null, 'h04-native-line');
  const line = h01RawFile(match[1]!).toString('utf8').split('\n')[Number(match[2]) - 1];
  requireWorkflow(line !== undefined && digest(line + '\n') === ref.hash, 'h04-native-line-pin');
  return object(JSON.parse(line));
}
export interface H04NativeCaseReport {
  kind: 'comparison-h04-case';
  scenario: 'H-04';
  opId: string;
  engine: 'legacy' | 'temporal';
  session: string | null;
  outcome: 'accepted' | 'failed' | 'unknown' | 'not-run';
  checks: Record<string, boolean>;
  blocking: string[];
  request: InputRef | null;
  nativeWait: H04NativeWaitProof | null;
  primary: Record<
    | 'result'
    | 'application'
    | 'effectStart'
    | 'gate'
    | 'history'
    | 'workflow'
    | 'terminal'
    | 'wait',
    InputRef | null
  >;
  stop: InputRef;
  evidence: InputRef[];
  nativeAcceptance: false;
  qualification: false;
  partialScope: true;
}

/** Only one deliberately closed native code-mode format is accepted. Self-reported wait counts are ignored. */
export function verifyH04NativeWait(
  requestRef: InputRef,
  participant: ComparisonParticipant,
  terminalRef: InputRef,
): H04NativeWaitProof {
  const request = object(h01ReadJson(requestRef)) as unknown as H04NativeOperationRequest;
  requireWorkflow(
    request.kind === 'comparison-h04-native-operation' &&
      request.schemaVersion === 1 &&
      request.opId === participant.run,
    'h04-native-request-binding',
  );
  const text = h01RawFile(participant.transcript).toString('utf8');
  requireWorkflow(text.endsWith('\n'), 'h04-native-history-partial');
  let lines = text
    .slice(0, -1)
    .split('\n')
    .map((line, i) => ({
      record: object(JSON.parse(line)),
      ref: { locator: participant.transcript + '#L' + (i + 1), hash: digest(line + '\n') },
    }));
  for (const [boundary, end] of [
    [participant.through, true],
    [participant.after, false],
  ] as const) {
    if (boundary === undefined) continue;
    const index = lines.findIndex((line) => canonical(line.ref) === canonical(boundary));
    requireWorkflow(index >= 0, 'h04-native-range');
    lines = end ? lines.slice(0, index + 1) : lines.slice(index + 1);
  }
  const events = lines.filter(({ record }) => record.type === 'event_msg');
  const starts = events.filter(({ record }) => object(record.payload).type === 'task_started');
  const ends = events.filter(({ record }) => object(record.payload).type === 'task_complete');
  requireWorkflow(starts.length === 1 && ends.length === 1, 'h04-native-one-turn');
  const turn = textField(object(starts[0]!.record.payload).turn_id);
  requireWorkflow(
    object(ends[0]!.record.payload).turn_id === turn &&
      lines.indexOf(starts[0]!) < lines.indexOf(ends[0]!),
    'h04-native-same-turn',
  );
  const body = lines.slice(lines.indexOf(starts[0]!) + 1, lines.indexOf(ends[0]!));
  const calls = body.filter(
    ({ record }) =>
      record.type === 'response_item' &&
      ['function_call', 'custom_tool_call'].includes(String(object(record.payload).type)),
  );
  requireWorkflow(calls.length === 2, 'h04-native-two-calls');
  const launch = calls[0]!,
    wait = calls[1]!;
  const parse = (line: typeof launch) => {
    const p = object(line.record.payload);
    requireWorkflow(
      p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string',
      'h04-native-tool-format',
    );
    const invocations = serialInvocations(p.input as string);
    requireWorkflow(invocations?.length === 1, 'h04-native-serial-tool');
    return { payload: p, invocation: invocations[0]! };
  };
  const first = parse(launch),
    second = parse(wait);
  const output = (call: typeof first, line: typeof launch) => {
    const matching = body.filter(
      ({ record }) =>
        record.type === 'response_item' &&
        object(record.payload).type === 'custom_tool_call_output' &&
        object(record.payload).call_id === call.payload.call_id,
    );
    requireWorkflow(
      matching.length === 1 && body.indexOf(matching[0]!) > body.indexOf(line),
      'h04-native-tool-output',
    );
    const value = object(matching[0]!.record.payload).output;
    requireWorkflow(Array.isArray(value), 'h04-native-output-format');
    const blocks = value.map(object);
    requireWorkflow(
      blocks.every(
        (block) =>
          Object.keys(block).every((key) => ['text', 'type'].includes(key)) &&
          (block.type === undefined || block.type === 'input_text'),
      ) &&
        (blocks.length === 1 ||
          (blocks.length === 2 &&
            typeof blocks[0]!.text === 'string' &&
            /^Script completed\nWall time [0-9.]+ seconds\nOutput:\n$/u.test(blocks[0]!.text))) &&
        typeof blocks.at(-1)!.text === 'string',
      'h04-native-output-format',
    );
    return { line: matching[0]!, value: object(JSON.parse(textField(blocks.at(-1)!.text))) };
  };
  const launched = output(first, launch),
    waited = output(second, wait);
  const sessionId = launched.value.session_id;
  requireWorkflow(
    'command' in first.invocation &&
      first.invocation.command === h04NativeWaitCommand(request, requestRef) &&
      Number.isSafeInteger(sessionId) &&
      Number(sessionId) > 0 &&
      launched.value.exit_code === undefined,
    'h04-native-launch-binding',
  );
  requireWorkflow(
    'process' in second.invocation &&
      second.invocation.process === String(sessionId) &&
      body.indexOf(launched.line) < body.indexOf(wait) &&
      waited.value.session_id === undefined &&
      waited.value.exit_code === 0,
    'h04-native-wait-binding',
  );
  requireWorkflow(
    first.payload.input === h04NativeLaunchCode(request, requestRef) &&
      second.payload.input === h04NativeWaitingCode(Number(sessionId)),
    'h04-native-wait-parameters',
  );
  const terminalText = h01ReadPin(terminalRef).toString('utf8');
  requireWorkflow(waited.value.output === terminalText, 'h04-native-primary-result');
  const items = (type: string) =>
    body.filter(
      ({ record }) => record.type === 'event_msg' && object(record.payload).type === type,
    );
  const started = items('item_started'),
    completed = items('item_completed');
  requireWorkflow(started.length === 1 && completed.length === 1, 'h04-native-command-count');
  const a = object(started[0]!.record.payload),
    b = object(completed[0]!.record.payload),
    ai = object(a.item),
    bi = object(b.item);
  const cmd = ai.command;
  requireWorkflow(
    a.thread_id === participant.session &&
      b.thread_id === participant.session &&
      a.turn_id === turn &&
      b.turn_id === turn &&
      ai.type === 'CommandExecution' &&
      bi.type === 'CommandExecution' &&
      typeof ai.id === 'string' &&
      ai.id.length > 0 &&
      ai.id === bi.id &&
      bi.process_id === String(sessionId) &&
      canonical(ai.command) === canonical(bi.command) &&
      Array.isArray(cmd) &&
      cmd.length === 3 &&
      (cmd[1] === '-lc' || cmd[1] === '-c') &&
      cmd[2] === first.invocation.command &&
      (bi.cwd === request.workspace || bi.cwd === 'file://' + request.workspace) &&
      bi.status === 'completed' &&
      bi.exit_code === 0,
    'h04-native-command-binding',
  );
  requireWorkflow(
    body.indexOf(started[0]!) < body.indexOf(launched.line) &&
      body.indexOf(wait) < body.indexOf(completed[0]!) &&
      body.indexOf(completed[0]!) < body.indexOf(waited.line),
    'h04-native-wait-order',
  );
  return {
    launch: launch.ref,
    started: started[0]!.ref,
    wait: wait.ref,
    completed: completed[0]!.ref,
    terminal: waited.line.ref,
    turn,
    sessionId: Number(sessionId),
  };
}

export function h04NativeTerminalPath(request: H04NativeOperationRequest) {
  return join(request.outputRoot, 'terminal.json');
}
