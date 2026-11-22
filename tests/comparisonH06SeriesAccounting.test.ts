import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeComparisonReceipt } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import type { H06DelegatedDeliveryProof } from './comparisonH06DelegatedDelivery.js';
import * as native from './comparisonH06NativeJournal.js';
import {
  verifyH06SeriesAccounting,
  type H06SeriesAccountingInput,
} from './comparisonH06SeriesAccounting.js';

const roots: string[] = [];
const time = Date.UTC(2026, 10, 18, 0);
const profile = { model: 'model', effort: 'medium' };
const shell = (...argv: string[]) => argv.map((word) => `'${word}'`).join(' ');
type Row = { type: string; timestamp: string; payload: Record<string, unknown> };
const row = (type: string, payload: Row['payload'], ms = 0): Row => ({
  type,
  payload,
  timestamp: new Date(time + ms).toISOString(),
});
const event = (type: string, turn_id: string, ms: number, details = {}) =>
  row('event_msg', { type, turn_id, ...details }, ms);
const context = (turn_id: string, cwd: string) =>
  row('turn_context', {
    turn_id,
    cwd,
    ...profile,
    approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' },
    permission_profile: { type: 'disabled' },
  });
const response = (session: string, turn: string, id = session + '-' + turn, count = 1) =>
  row('token_usage_record', {
    session_id: session,
    thread_id: session,
    turn_id: turn,
    response_id: id,
    usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 3 },
    thread_token_usage: {
      input_tokens: count * 9,
      cached_input_tokens: count * 2,
      output_tokens: count * 3,
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(legacy = false) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'h06-series-accounting-'));
  roots.push(directory);
  const rootPath = join(directory, 'root.jsonl'),
    actorPath = join(directory, 'actor.jsonl');
  const operation = 'h06-operation';
  const operator = { locator: join(directory, 'operator.json'), hash: digest('operator') };
  const evidenceRoot = join(directory, 'evidence');
  const execution = {
    node: '/approved/node',
    tsx: '/approved/tsx.mjs',
    series: '/approved/series.ts',
    step: join(directory, 'step.json'),
    evidenceRoot,
    ...(legacy
      ? {
          legacy: {
            package: '/approved/package.ts',
            reader: '/approved/main.ts',
            packets: {
              load: join(directory, 'load.json'),
              warmPause: join(directory, 'warm-pause.json'),
              warmResume: join(directory, 'warm-resume.json'),
              coldPause: join(directory, 'cold-pause.json'),
              coldResume: join(directory, 'cold-resume.json'),
            },
          },
        }
      : {}),
  };
  const node = [execution.node, '--import', execution.tsx];
  const launch = shell(...node, execution.series, '--step', execution.step);
  const wrapper = (tool: string, args: unknown) =>
    row('response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      input: `text(await tools.${tool}(${JSON.stringify(args)}));\n`,
    });
  const commandArgs = { cmd: launch, workdir: directory, shell: '/bin/sh', login: false };
  const command = (codexCommand: string, turn = 'root-turn') =>
    event('item_completed', turn, 810, {
      item: {
        type: 'CommandExecution',
        command: ['/bin/sh', '-c', codexCommand],
        cwd: pathToFileURL(directory).href,
        status: 'completed',
        exit_code: 0,
      },
    });
  const main = command(launch);
  Object.assign(main.payload.item as object, {
    status: 'failed',
    exit_code: 1,
    aggregated_output: `comparison-h06-step-record:${operator.hash}\n`,
  });
  const rootUser = row('response_item', { type: 'message', role: 'user' }, 20);
  const rootContext = context('root-turn', directory);
  const rootStart = event('task_started', 'root-turn', 0);
  const rootEnd = event('task_complete', 'root-turn', 1000, { duration_ms: 1000 });
  const rootUsage = response('root', 'root-turn');
  const args = { threadId: 'actor', prompt: 'pinned stage' };
  const item = {
    type: 'McpToolCall',
    server: 'codex_app',
    tool: 'send_message_to_thread',
    id: 'native-send',
    arguments: args,
  };
  const outbound = event('item_completed', 'root-turn', 200, { item });
  const call = row(
    'response_item',
    {
      type: 'function_call',
      name: 'mcp__codex_app__send_message_to_thread',
      arguments: JSON.stringify(args),
    },
    100,
  );
  const rootRows = [
    row('session_meta', { id: 'root' }),
    rootStart,
    rootContext,
    rootUser,
    wrapper('exec_command', { ...commandArgs, yield_time_ms: 1000 }),
    ...(legacy ? [call, event('item_started', 'root-turn', 110, { item }), outbound] : []),
    rootUsage,
    main,
    rootEnd,
  ];
  const attribution = {
    turn_trigger: 'app_tool_send_message',
    parent_turn_id: 'root-turn',
    root_turn_id: 'root-turn',
  };
  const actorStart = event('task_started', 'actor-turn', 180, { turn_attribution: attribution });
  const inbound = row('response_item', { type: 'function_call_output' }, 190);
  const actorEnd = event('task_complete', 'actor-turn', 700, { duration_ms: 520 });
  const actorUsage = response('actor', 'actor-turn');
  const actorRows = [
    row('session_meta', { id: 'actor' }),
    actorStart,
    context('actor-turn', directory),
    inbound,
    actorUsage,
    actorEnd,
  ];
  const pin = (path: string, rows: Row[], entry: Row) => ({
    locator: `${path}#L${rows.indexOf(entry) + 1}`,
    hash: digest(JSON.stringify(entry) + '\n'),
  });
  const write = (path: string, rows: Row[]) =>
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const managed: NativeComparisonReceipt = {
    id: 'managed-1',
    run: operation,
    stage: 'execution',
    participant: 'writer',
    responses: 2,
    input_uncached: 10,
    input_cached: 4,
    output: 5,
    source: { locator: join(directory, 'writer.jsonl') + '#L10', hash: digest('managed') },
  };
  const input: H06SeriesAccountingInput = {
    operator,
    opId: operation,
    profile,
    root: {
      session: 'root',
      transcript: rootPath,
      turnId: 'root-turn',
      workspace: directory,
      source: pin(rootPath, rootRows, rootUser),
      startedAtMs: time + 100,
    },
    managed: { receipts: [managed], starts: 1 },
    execution,
  };
  function proof(): H06DelegatedDeliveryProof {
    const user = input.root.source;
    return {
      kind: 'h06-delegated-delivery-proof/1',
      input: {
        kind: 'comparison-h06-delegated-delivery/1',
        sessionsRoot: directory,
        root: { threadId: 'root', workspace: directory, turnId: 'root-turn', user },
        actor: { threadId: 'actor', workspace: directory },
        command: {
          kind: 'comparison-h06-delegated-command/1',
          nonce: 'stage',
          requestHash: digest('request'),
          action: 'LOAD',
          target: {},
        },
        prompt: args.prompt,
      },
      user,
      outbound: pin(rootPath, rootRows, outbound),
      inbound: pin(actorPath, actorRows, inbound),
      confirmation: pin(actorPath, actorRows, inbound),
      actorTurnId: 'actor-turn',
      authorityIssued: false,
      mayRun: false,
      qualification: false,
    };
  }
  const terminal = (session: string, turn: string, source: InputRef) => ({ session, turn, source });
  function flush() {
    write(rootPath, rootRows);
    if (legacy) write(actorPath, actorRows);
    input.root.source = pin(rootPath, rootRows, rootUser);
    if (legacy) input.actorDeliveries = [proof()];
    return {
      kind: 'comparison-h06-series-accounting/1',
      operator: { ...operator },
      through: [
        terminal('root', 'root-turn', pin(rootPath, rootRows, rootEnd)),
        ...(legacy ? [terminal('actor', 'actor-turn', pin(actorPath, actorRows, actorEnd))] : []),
      ],
    };
  }
  function verify(packet: unknown = flush()) {
    const locator = join(directory, 'accounting.json'),
      bytes = JSON.stringify(packet);
    writeFileSync(locator, bytes);
    return verifyH06SeriesAccounting({ locator, hash: digest(bytes) }, input);
  }
  return {
    directory,
    verify,
    flush,
    input,
    managed,
    rootRows,
    rootStart,
    rootEnd,
    rootContext,
    rootUsage,
    actorRows,
    actorStart,
    actorEnd,
    actorUsage,
    attribution,
    inbound,
    outbound,
    item,
    call,
    pin,
    rootPath,
    actorPath,
    terminal,
    main,
    node,
    command,
    wrapper,
    commandArgs,
  };
}

it.each([false, true])(
  'recomputes managed and external costs through complete primary turns / legacy=%s',
  (legacy) => {
    const f = fixture(legacy);
    f.rootRows.push(event('task_started', 'future-turn', 2000));
    if (legacy) f.actorRows.push(event('task_started', 'future-actor', 2100));
    const result = f.verify();
    const count = legacy ? 2 : 1;
    expect(result.totals).toEqual({
      reservedManagedStarts: 1 + count,
      observedResponses: 2 + count,
      inputUncached: 10 + 7 * count,
      inputCached: 4 + 2 * count,
      output: 5 + 3 * count,
    });
    expect(result.externalTurns).toHaveLength(count);
    expect(result.window).toEqual({ startedAtMs: time, endedAtMs: time + 1000 });
  },
);

it('does not use a foreign turn command to prove the series step ran', () => {
  const f = fixture();
  f.main.payload.turn_id = 'previous-turn';
  expect(() => f.verify()).toThrow('h06-series-accounting-tool-turn');
});

it('rejects a tool start without turn attribution in a delegated window', () => {
  const f = fixture(true);
  const start = f.command(shell('/bin/cat', join(f.directory, 'input')), 'actor-turn');
  start.payload.type = 'item_started';
  delete start.payload.turn_id;
  f.actorRows.splice(-1, 0, start);
  expect(() => f.verify()).toThrow('h06-series-accounting-tool-turn');
});

it('charges a recognized capacity retry and requires its independent terminal pin', () => {
  const f = fixture();
  Object.assign(f.rootEnd.payload, {
    root_turn_id: 'root-turn',
    last_agent_message: null,
    error: { codex_error_info: 'server_overloaded' },
  });
  const retry = 'retry-turn';
  const attribution = {
    turn_id: retry,
    turn_trigger: 'capacity_retry_manual',
    root_turn_id: retry,
    parent_turn_id: null,
    initiating_agent_path: null,
  };
  const start = event('task_started', retry, 1200, { turn_attribution: attribution });
  const end = event('task_complete', retry, 2200, { duration_ms: 1000 });
  f.rootRows.push(
    start,
    context(retry, f.directory),
    response('root', retry, 'retry-response', 2),
    end,
  );
  const packet = f.flush();
  const final = f.terminal('root', retry, f.pin(f.rootPath, f.rootRows, end));
  expect(() => f.verify({ ...packet, through: [final] })).toThrow('h06-series-accounting-window');
  packet.through.push(final);
  expect(f.verify(packet).totals.reservedManagedStarts).toBe(3);
  start.timestamp = new Date(time + 900).toISOString();
  const reversed = f.flush();
  reversed.through.push(final);
  expect(() => f.verify(reversed)).toThrow('h06-series-accounting-root-time');
});

it('accepts each distinct proven Legacy turn from the same actor journal', () => {
  const f = fixture(true);
  const id = 'second-send';
  const second = event('item_completed', 'root-turn', 750, {
    item: { ...f.item, id, arguments: { ...f.item.arguments, prompt: 'second pinned stage' } },
  });
  f.rootRows.splice(-1, 0, second);
  const secondInbound = row('response_item', { type: 'function_call_output' }, 760);
  const end = event('task_complete', 'next-actor-turn', 850, { duration_ms: 100 });
  f.actorRows.push(
    event('task_started', 'next-actor-turn', 750, { turn_attribution: f.attribution }),
    context('next-actor-turn', f.directory),
    secondInbound,
    response('actor', 'next-actor-turn', 'next-actor-response', 2),
    end,
  );
  const packet = f.flush();
  const first = f.input.actorDeliveries![0]!;
  f.input.actorDeliveries = [
    first,
    {
      ...first,
      actorTurnId: 'next-actor-turn',
      outbound: f.pin(f.rootPath, f.rootRows, second),
      inbound: f.pin(f.actorPath, f.actorRows, secondInbound),
    },
  ];
  packet.through.push(f.terminal('actor', 'next-actor-turn', f.pin(f.actorPath, f.actorRows, end)));
  expect(f.verify(packet).externalTurns).toHaveLength(3);
});

it.each([
  ['kind', 'invalid'],
  ['operator', null],
  ['through', null],
] as const)('rejects a mismatched reconciliation packet %s', (key, value) => {
  const f = fixture();
  expect(() => f.verify({ ...f.flush(), [key]: value })).toThrow('h06-series-accounting-binding');
});

it.each([
  'duplicate',
  'extra',
  'wrong-hash',
  'wrong-path',
  'omitted-actor',
  'unclosed-root',
] as const)('fails closed on unproved terminal inventory %s', (fault) => {
  const f = fixture(true);
  const packet = f.flush();
  const first = packet.through[0]!;
  if (fault === 'duplicate') packet.through.push(first);
  if (fault === 'extra') packet.through.push({ ...first, turn: 'extra' });
  if (fault === 'wrong-hash') first.source.hash = 'bad';
  if (fault === 'wrong-path') first.source.locator = f.actorPath + '#L1';
  if (fault === 'omitted-actor') packet.through.pop();
  if (fault === 'unclosed-root') packet.through.shift();
  expect(() => f.verify(packet)).toThrow();
});

it.each([
  ['start-id', 'wrong'],
  ['terminal-id', 'wrong'],
  ['terminal-error', {}],
  ['grant-time', 1001],
  ['grant-time', -1],
  ['timestamp', 'unknown'],
  ['timestamp', '1970-01-01T00:00:00.000Z'],
  ['duration', null],
  ['duration', 1.5],
  ['duration', -1],
  ['duration', 4000],
  ['terminal-order', -2],
  ['context', 'different'],
  ['effort', 'low'],
  ['usage-turn', 'other'],
  ['usage-removed', true],
  ['usage-cumulative', {}],
  ['no-terminal', true],
] as const)('keeps unproved root facts blocked %s %j', (fault, value) => {
  const f = fixture();
  if (fault === 'start-id') f.rootStart.payload.turn_id = value;
  if (fault === 'terminal-id') f.rootEnd.payload.turn_id = value;
  if (fault === 'terminal-error') f.rootEnd.payload.error = value;
  if (fault === 'grant-time') f.input.root.startedAtMs = time + Number(value);
  if (fault === 'timestamp') f.rootStart.timestamp = String(value);
  if (fault === 'duration') f.rootEnd.payload.duration_ms = value;
  if (fault === 'terminal-order')
    f.rootEnd.timestamp = new Date(time + Number(value)).toISOString();
  if (fault === 'context') f.rootContext.payload.model = value;
  if (fault === 'effort') f.rootContext.payload.effort = value;
  if (fault === 'usage-turn') f.rootUsage.payload.turn_id = value;
  if (fault === 'usage-removed') f.rootRows.splice(f.rootRows.indexOf(f.rootUsage), 1);
  if (fault === 'usage-cumulative') f.rootUsage.payload.thread_token_usage = value;
  if (fault === 'no-terminal') f.rootRows.pop();
  expect(() => f.verify()).toThrow();
});

it.each([
  'unknown-child',
  'tool-spawn',
  'collab',
  'unmatched-send',
  'mcp',
  'echo-changed',
  'duplicate-send',
  'late-event',
] as const)('refuses an untracked effect %s', (fault) => {
  const f = fixture(true);
  const position = f.rootRows.indexOf(f.outbound);
  switch (fault) {
    case 'unknown-child':
      f.actorRows.splice(-1, 0, event('task_started', 'hidden', 300));
      break;
    case 'tool-spawn':
      f.rootRows.splice(
        position,
        0,
        row('response_item', { type: 'function_call', name: 'collaboration.spawn_agent' }),
      );
      break;
    case 'collab':
      f.rootRows.splice(
        position,
        0,
        event('item_completed', 'root-turn', 150, { item: { type: 'CollabAgentSpawn' } }),
      );
      break;
    case 'unmatched-send':
      f.outbound.payload.item = { ...f.item, tool: 'create_thread' };
      break;
    case 'mcp':
      f.outbound.payload.item = { ...f.item, server: 'other' };
      break;
    case 'echo-changed':
      f.call.payload.arguments = JSON.stringify({ threadId: 'other' });
      break;
    case 'duplicate-send':
      f.rootRows.splice(position + 1, 0, structuredClone(f.outbound));
      break;
    case 'late-event':
      f.rootRows.splice(position + 1, 0, event('item_started', 'root-turn', 205, { item: f.item }));
      break;
  }
  expect(() => f.verify()).toThrow();
});

it.each([
  'role',
  'parent',
  'root',
  'window',
  'inbound',
  'wrong-window',
  'end-error',
  'same-response',
] as const)('requires bound actor delivery and terminal %s', (fault) => {
  const f = fixture(true);
  if (fault === 'role') f.attribution.turn_trigger = 'other';
  if (fault === 'parent') f.attribution.parent_turn_id = 'other';
  if (fault === 'root') f.attribution.root_turn_id = 'other';
  if (fault === 'window') f.actorRows.splice(2, 0, event('task_complete', 'actor-turn', 200));
  if (fault === 'inbound') {
    f.actorRows.splice(f.actorRows.indexOf(f.inbound), 1);
    f.actorRows.push(f.inbound);
  }
  if (fault === 'wrong-window') f.actorEnd.timestamp = new Date(time + 1100).toISOString();
  if (fault === 'end-error') f.actorEnd.payload.error = 'aborted';
  if (fault === 'same-response') f.actorUsage.payload.response_id = f.rootUsage.payload.response_id;
  expect(() => f.verify()).toThrow();
});

it.each([
  'none',
  'external-session',
  'wrong-run',
  'duplicate',
  'duplicate-source',
  'unknown',
  'negative',
  'unsafe',
  'overflows',
  'zero-starts',
  'fractional-starts',
  'overflow-starts',
] as const)('rejects invalid managed accounting %s', (fault) => {
  const f = fixture();
  const managed = f.input.managed;
  if (fault === 'none') managed.receipts = [];
  if (fault === 'external-session') f.managed.participant = 'root';
  if (fault === 'wrong-run') f.managed.run = 'other';
  if (fault === 'duplicate') managed.receipts = [f.managed, f.managed];
  if (fault === 'duplicate-source') managed.receipts = [f.managed, { ...f.managed, id: 'another' }];
  if (fault === 'unknown') f.managed.input_uncached = null;
  if (fault === 'negative') f.managed.output = -1;
  if (fault === 'unsafe') f.managed.input_cached = Number.MAX_SAFE_INTEGER + 1;
  if (fault === 'overflows') f.managed.input_cached = Number.MAX_SAFE_INTEGER;
  if (fault === 'zero-starts') managed.starts = 0;
  if (fault === 'fractional-starts') managed.starts = 1.5;
  if (fault === 'overflow-starts') managed.starts = Number.MAX_SAFE_INTEGER;
  expect(() => f.verify()).toThrow();
});

it('rejects a rewritten native prefix during verification', () => {
  const f = fixture();
  const read = native.readH06NativeJournal;
  vi.spyOn(native, 'readH06NativeJournal')
    .mockImplementationOnce(read)
    .mockImplementationOnce((path) => Buffer.concat([Buffer.from('!'), read(path)]));
  expect(() => f.verify()).toThrow('h06-series-accounting-prefix-changed');
});

it('requires a cutoff covering a late primary response in the same closed turn', () => {
  const f = fixture();
  const late = response('root', 'root-turn', 'late-response', 2);
  f.rootRows.push(late);
  expect(() => f.verify()).toThrow('h06-series-accounting-unsealed-usage');
  const packet = f.flush();
  packet.through[0]!.source = f.pin(f.rootPath, f.rootRows, late);
  expect(f.verify(packet).totals).toMatchObject({ observedResponses: 4, output: 11 });
  f.rootRows.push(structuredClone(f.rootEnd));
  f.flush();
  expect(() => f.verify(packet)).toThrow('h06-series-accounting-terminal');
});

it('rejects late effects in the retained turn', () => {
  const f = fixture();
  f.rootRows.push(f.command(shell('/bin/cat', f.rootPath)));
  expect(() => f.verify()).toThrow('h06-series-accounting-late-effect');
});

it.each(['function_call', 'custom_tool_call', 'message'] as const)(
  'checks the unattributed native tail %s',
  (type) => {
    const f = fixture();
    f.rootRows.push(row('response_item', { type }));
    if (type === 'message') expect(f.verify().externalTurns).toHaveLength(1);
    else expect(() => f.verify()).toThrow('h06-series-accounting-late-effect');
  },
);

it('refuses a late tool with the closed turn ID after the next turn starts', () => {
  const f = fixture();
  f.rootRows.push(event('task_started', 'future', 1500), f.command(shell('/bin/cat', f.rootPath)));
  expect(() => f.verify()).toThrow('h06-series-accounting-late-effect');
});

it('allows only the pinned Legacy dispatcher and reader commands beside the root launch', () => {
  const f = fixture(true);
  const { legacy, evidenceRoot } = f.input.execution;
  const tool = (type: string) => event('item_completed', 'root-turn', 70, { item: { type } });
  f.rootRows.splice(
    -1,
    0,
    f.command(
      shell(
        ...f.node,
        legacy!.package,
        '--admit',
        join(evidenceRoot, 'delegated-claim.json'),
        'load',
      ),
    ),
    f.command(
      shell(
        ...f.node,
        legacy!.package,
        '--settle',
        join(evidenceRoot, 'delegated-claim.json'),
        'load',
      ),
    ),
    f.command(shell('/bin/cat', f.rootPath)),
    { ...f.main, payload: { ...f.main.payload, type: 'item_started' } },
    f.wrapper('write_stdin', { session_id: 42, chars: '' }),
    row('response_item', { type: 'function_call', name: 'mcp__codex_app__wait_threads' }),
    row('response_item', { type: 'function_call', namespace: 'codex_app', name: 'wait_threads' }),
    row('response_item', { type: 'function_call', name: 'wait' }),
    event('item_completed', 'root-turn', 70, {
      item: { type: 'McpToolCall', server: 'codex_app', tool: 'wait_threads' },
    }),
    tool('Reasoning'),
    tool('AgentMessage'),
    tool('UserMessage'),
    tool('FunctionCallOutput'),
    event('token_count', 'root-turn', 90, { info: null }),
    event('thread_settings_applied', 'root-turn', 91),
    row('world_state', {}),
    row('response_item', { type: 'additional_tools' }),
    row('response_item', { type: 'agent_message' }),
  );
  f.call.payload.name = 'send_message_to_thread';
  f.call.payload.namespace = 'codex_app';
  f.actorRows.splice(
    -1,
    0,
    f.command(shell(...f.node, legacy!.package, 'warm', legacy!.packets.load), 'actor-turn'),
    f.command(
      shell(
        ...f.node,
        legacy!.reader,
        'read-chat',
        join(evidenceRoot, 'package-load-read-1.json'),
        '--full',
      ),
      'actor-turn',
    ),
  );
  expect(f.verify().externalTurns).toHaveLength(2);
});

it('binds the real desktop connector wrapper to one primary delivery', () => {
  const f = fixture(true);
  const delivery = f.wrapper('mcp__codex_app__send_message_to_thread', f.item.arguments);
  const at = f.rootRows.indexOf(f.call);
  f.rootRows.splice(at, 1, delivery, f.wrapper('mcp__codex_app__wait_threads', {}));
  expect(f.verify().externalTurns).toHaveLength(2);
  f.rootRows.splice(at + 1, 0, structuredClone(delivery));
  expect(() => f.verify()).toThrow('h06-series-accounting-untracked-tool');
});

it.each([
  [],
  ['/bin/sh', '-c'],
  ['/bin/zsh', '-c', 'safe'],
  ['/bin/sh', '-lc', 'safe'],
  ['/bin/sh', '-c', null],
  ['/bin/sh', '-c', "'/bin/cat' 'relative'"],
  ['/bin/sh', '-c', "'/bin/cat' '/wrong/../file'"],
  ['/bin/sh', '-c', 'node other-workflow.ts'],
])('rejects an unapproved native command %j', (...argv) => {
  const f = fixture();
  Object.assign(f.main.payload.item as object, { command: argv });
  expect(() => f.verify()).toThrow('h06-series-accounting-command');
});

it.each([
  ['cwd', '/elsewhere'],
  ['status', 'inProgress'],
  ['exit_code', 0],
  ['aggregated_output', null],
  ['aggregated_output', 'series-step-failed\n'],
] as const)('requires a completed root launcher %s %j', (key, value) => {
  const f = fixture();
  Object.assign(f.main.payload.item as object, { [key]: value });
  expect(() => f.verify()).toThrow(key === 'cwd' ? 'command' : 'launch-unproved');
});

it.each([
  { workdir: '/other' },
  { login: true },
  { shell: '/bin/zsh' },
  { more: true },
  { cmd: 'codex exec unwanted' },
])('rejects unapproved command tool arguments %j', (change) => {
  const f = fixture();
  f.rootRows.splice(-1, 0, f.wrapper('exec_command', { ...f.commandArgs, ...change }));
  expect(() => f.verify()).toThrow('h06-series-accounting-command');
});

it.each([
  { type: 'custom_tool_call', name: 'apply_patch' },
  { type: 'custom_tool_call', name: 'exec', namespace: 'other' },
  { type: 'custom_tool_call', name: 'exec', input: 'text(await arbitrary());' },
  {
    type: 'custom_tool_call',
    name: 'exec',
    input: 'text(await tools.write_stdin({"session_id":1,"chars":"new command"}));',
  },
  {
    type: 'custom_tool_call',
    name: 'exec',
    input: 'text(await tools.write_stdin({"session_id":null,"chars":""}));',
  },
  { type: 'function_call', name: 'mcp__other__wait_threads' },
  { type: 'function_call', name: 'wait_threads' },
  { type: 'function_call', name: 'wait', namespace: 'other' },
  { type: 'web_search_call' },
])('rejects any other native tool %j', (payload) => {
  const f = fixture();
  f.rootRows.splice(-1, 0, row('response_item', payload));
  expect(() => f.verify()).toThrow();
});

it.each(['missing-path', 'wrong-root', 'wrong-name'] as const)(
  'checks Legacy LOAD scope %s',
  (fault) => {
    const f = fixture(true);
    const { legacy, evidenceRoot } = f.input.execution;
    const read = shell(...f.node, legacy!.reader, 'read-chat');
    const target =
      fault === 'wrong-root'
        ? '/other/package-load-read-1.json'
        : join(evidenceRoot, 'private.json');
    f.actorRows.splice(
      -1,
      0,
      f.command(
        fault === 'missing-path' ? read : read + ' ' + shell(target, '--full'),
        'actor-turn',
      ),
    );
    expect(() => f.verify()).toThrow('h06-series-accounting-command');
  },
);
