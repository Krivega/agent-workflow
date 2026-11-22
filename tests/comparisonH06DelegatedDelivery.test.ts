import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NativeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  planH06DelegatedDelivery,
  verifyH06DelegatedDelivery,
  type H06DelegatedDeliveryInput,
} from './comparisonH06DelegatedDelivery.js';

const nativeRead = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeFs>();
  return {
    ...actual,
    readSync: ((...args: unknown[]) => {
      const count = Reflect.apply(actual.readSync, undefined, args) as number;
      nativeRead.afterRead?.();
      return count;
    }) as typeof actual.readSync,
  };
});

const temporary: string[] = [];
afterEach(() => {
  nativeRead.afterRead = undefined;
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
type NativeRecord = { type: string; payload: Record<string, unknown> };
function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'h06-delegated-delivery-'));
  temporary.push(directory);
  const sessions = join(directory, 'sessions'),
    rootWorkspace = join(directory, 'root'),
    actorWorkspace = join(directory, 'actor');
  for (const path of [sessions, rootWorkspace, actorWorkspace]) mkdirSync(path);
  const session = (id: string) => ({
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      cli_version: '0.166.0-alpha.6',
      source: 'vscode',
      originator: 'codex_work_desktop',
      thread_source: 'user',
    },
  });
  const event = (type: string, rest: Record<string, unknown> = {}): NativeRecord => ({
    type: 'event_msg',
    payload: { type, ...rest },
  });
  const start = (turn_id: string) => event('task_started', { turn_id });
  const context = (turn_id: string, cwd: string) => ({
    type: 'turn_context',
    payload: {
      turn_id,
      root_turn_id: turn_id,
      cwd,
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
    },
  });
  const rootPath = join(sessions, 'rollout-root.jsonl'),
    actorPath = join(sessions, 'rollout-actor.jsonl');
  const input: H06DelegatedDeliveryInput = {
    kind: 'comparison-h06-delegated-delivery/1',
    sessionsRoot: sessions,
    root: {
      threadId: 'root',
      workspace: rootWorkspace,
      turnId: 'root-turn',
      user: { locator: rootPath + '#L4', hash: '' },
    },
    actor: { threadId: 'actor', workspace: actorWorkspace },
    command: {
      kind: 'comparison-h06-delegated-command/1',
      nonce: 'unique-nonce',
      requestHash: 'a'.repeat(64),
      action: 'PREPARE',
      target: { generation: 1 },
    },
    prompt: '',
  };
  input.prompt = 'Delivery only\n' + canonical(input.command);
  const envelope =
    '<codex_delegation>\n  <source_thread_id>root</source_thread_id>\n  <input>' +
    input.prompt +
    '</input>\n</codex_delegation>';
  const rootSession = session('root'),
    actorSession = session('actor');
  const rootContext = context('root-turn', rootWorkspace),
    actorContext = context('actor-turn', actorWorkspace);
  const human = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Continue the delegated preparation.' }],
  };
  const call = {
    type: 'McpToolCall',
    id: 'native-call',
    server: 'codex_app',
    tool: 'send_message_to_thread',
    arguments: { threadId: 'actor', prompt: input.prompt },
    status: 'completed',
    result: { isError: false, content: [{ type: 'text', text: '{"threadId":"actor"}' }] },
  };
  const delivery = {
    type: 'function_call_output',
    id: 'delivery',
    namespace: 'codex_app',
    name: 'send_message_to_thread',
    output: envelope,
    internal_chat_message_metadata_passthrough: { turn_id: 'actor-turn' },
  };
  const confirmation = {
    type: 'FunctionCallOutput',
    id: 'delivery',
    namespace: 'codex_app',
    name: 'send_message_to_thread',
    output: envelope,
  };
  const rootRows: NativeRecord[] = [
    rootSession,
    start('root-turn'),
    rootContext,
    { type: 'response_item', payload: human },
    event('item_completed', { thread_id: 'root', turn_id: 'root-turn', item: call }),
  ];
  const actorRows: NativeRecord[] = [
    actorSession,
    start('actor-turn'),
    actorContext,
    { type: 'response_item', payload: delivery },
    event('item_completed', { thread_id: 'actor', turn_id: 'actor-turn', item: confirmation }),
  ];
  const flush = () => {
    for (const [path, rows] of [
      [rootPath, rootRows],
      [actorPath, actorRows],
    ] as const)
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    input.root.user.hash = digest(JSON.stringify(rootRows[3]) + '\n');
  };
  flush();
  return {
    input,
    rootRows,
    actorRows,
    rootPath,
    actorPath,
    flush,
    directory,
    event,
    rootSession,
    actorSession,
    rootContext,
    actorContext,
    human,
    call,
    delivery,
    confirmation,
  };
}

function retryFixture(count = 1) {
  const f = fixture();
  const retries: {
    terminal: NativeRecord;
    started: NativeRecord;
    context: NativeRecord;
  }[] = [];
  let previousTurn = f.input.root.turnId;
  for (let index = 0; index < count; index++) {
    const turn = 'root-retry-' + index;
    const terminal = f.event('task_complete', {
      turn_id: previousTurn,
      root_turn_id: previousTurn,
      last_agent_message: null,
      error: { codex_error_info: 'server_overloaded' },
    });
    const started = f.event('task_started', {
      turn_id: turn,
      turn_attribution: {
        turn_id: turn,
        root_turn_id: turn,
        turn_trigger: 'capacity_retry_manual',
        parent_turn_id: null,
        initiating_agent_path: null,
      },
    });
    const context: NativeRecord = {
      type: 'turn_context',
      payload: { ...structuredClone(f.rootContext.payload), turn_id: turn, root_turn_id: turn },
    };
    f.rootRows.splice(f.rootRows.length - 1, 0, terminal, started, context);
    retries.push({ terminal, started, context });
    previousTurn = turn;
  }
  f.rootRows.at(-1)!.payload.turn_id = previousTurn;
  f.flush();
  return { ...f, retries };
}

it.each([1, 2])(
  'retains the original user source through %i native manual capacity retries',
  (count) => {
    const f = retryFixture(count);
    const proof = planH06DelegatedDelivery(f.input);
    expect(proof.input.root.turnId).toBe('root-turn');
    expect(proof.user).toEqual(f.input.root.user);
    expect(proof.outbound.locator).toBe(f.rootPath + '#L' + (5 + count * 3));
    expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
    // Later native turns must not rewrite the established source of a previous delivery.
    f.rootRows.push(f.event('task_started', { turn_id: 'later-ordinary-turn' }));
    f.flush();
    expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
  },
);

it('keeps the actor binding when the root operator changes model during a native capacity retry', () => {
  const f = retryFixture();
  Object.assign(f.rootContext.payload, { model: 'root-original', effort: 'high' });
  Object.assign(f.retries[0]!.context.payload, { model: 'root-retry', effort: 'medium' });
  f.flush();
  const proof = planH06DelegatedDelivery(f.input);
  expect(proof.input.actor).toEqual(f.input.actor);
  expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
});

const retryMutations: [string, (f: ReturnType<typeof retryFixture>) => void][] = [
  [
    'new human source in retry turn',
    (f) => {
      f.rootRows.splice(f.rootRows.length - 1, 0, {
        type: 'response_item',
        payload: structuredClone(f.human),
      });
    },
  ],
  [
    'ordinary new turn',
    (f) => {
      f.retries[0]!.started.payload.turn_attribution = undefined;
    },
  ],
  [
    'successful previous terminal',
    (f) => {
      f.retries[0]!.terminal.payload.error = null;
      f.retries[0]!.terminal.payload.last_agent_message = 'completed';
    },
  ],
  [
    'different previous error',
    (f) => {
      f.retries[0]!.terminal.payload.error = { codex_error_info: 'other' };
    },
  ],
  [
    'previous error after a final agent answer',
    (f) => {
      f.retries[0]!.terminal.payload.last_agent_message = 'answer';
    },
  ],
  [
    'retry working directory changed',
    (f) => {
      f.retries[0]!.context.payload.cwd = f.input.actor.workspace;
    },
  ],
  [
    'retry approval changed',
    (f) => {
      f.retries[0]!.context.payload.approval_policy = 'on-request';
    },
  ],
  [
    'retry sandbox changed',
    (f) => {
      f.retries[0]!.context.payload.sandbox_policy = { type: 'workspace-write' };
    },
  ],
  [
    'retry permission profile changed',
    (f) => {
      f.retries[0]!.context.payload.permission_profile = { type: 'restricted' };
    },
  ],
  [
    'delegated retry source',
    (f) => {
      f.rootRows.splice(f.rootRows.length - 1, 0, {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: 'root-retry-0' },
        },
      });
    },
  ],
];
it.each(retryMutations)('rejects a capacity continuation with %s', (_name, mutate) => {
  const f = retryFixture();
  mutate(f);
  f.flush();
  expect(() => planH06DelegatedDelivery(f.input)).toThrow('h06-delegated-delivery-outbound');
});

it('rechecks native capacity evidence instead of trusting the previously pinned outbound', () => {
  const f = retryFixture(),
    proof = planH06DelegatedDelivery(f.input);
  f.retries[0]!.terminal.payload.error = null;
  f.flush();
  expect(() => verifyH06DelegatedDelivery(proof)).toThrow('h06-delegated-delivery-outbound');
});

it.each(
  (['task_complete', 'task_aborted', 'turn_aborted'] as const).flatMap((type) =>
    ([false, true] as const).map((retry) => [type, retry] as const),
  ),
)('rejects outbound after %s in its own issuing turn (capacity retry: %s)', (type, retry) => {
  const f = retry ? retryFixture() : fixture();
  const turn = retry ? 'root-retry-0' : 'root-turn';
  f.rootRows.splice(f.rootRows.length - 1, 0, f.event(type, { turn_id: turn }));
  f.flush();
  expect(() => planH06DelegatedDelivery(f.input)).toThrow('h06-delegated-delivery-outbound');
});

it('pins a same-turn delivery and rechecks it after unrelated native events are appended', () => {
  const f = fixture();
  const originalRoot = readFileSync(f.rootPath),
    originalActor = readFileSync(f.actorPath);
  const proof = planH06DelegatedDelivery(f.input);
  expect(proof).toMatchObject({
    kind: 'h06-delegated-delivery-proof/1',
    actorTurnId: 'actor-turn',
    authorityIssued: false,
    mayRun: false,
    qualification: false,
    user: f.input.root.user,
    outbound: { locator: f.rootPath + '#L5' },
    inbound: { locator: f.actorPath + '#L4' },
    confirmation: { locator: f.actorPath + '#L5' },
  });
  expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
  expect(readFileSync(f.rootPath)).toEqual(originalRoot);
  expect(readFileSync(f.actorPath)).toEqual(originalActor);
  f.rootRows.push(f.event('item_completed', { item: { type: 'AgentMessage' } }));
  f.actorRows.push(f.event('task_complete', { turn_id: 'actor-turn' }));
  f.flush();
  expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
});

it.each([
  ['local delivery', null],
  ['omitted host', null],
  ['user destination', null],
  ['remote host', 'h06-delegated-delivery-outbound'],
  ['different version', 'h06-delegated-delivery-version'],
  ['actor as human', 'h06-delegated-delivery-session'],
  ['harness text', 'h06-delegated-delivery-user-source'],
  ['foreign parent', 'h06-delegated-delivery-attribution'],
  ['other trigger', 'h06-delegated-delivery-attribution'],
  ['agent origin', 'h06-delegated-delivery-attribution'],
  ['foreign actor context', 'h06-delegated-delivery-context'],
  ['early confirmation', 'h06-delegated-delivery-confirmation'],
])('verifies the native Desktop 0.169 delivery chain: %s', (kind, error) => {
  const f = fixture(),
    root = f.input.root.turnId,
    actor = 'actor-turn';
  Object.assign(f.rootSession.payload, {
    cwd: f.input.root.workspace,
    cli_version: '0.169.0-alpha.11.1',
    thread_source: kind === 'actor as human' ? 'agent_created_thread' : 'user',
  });
  Object.assign(f.actorSession.payload, {
    cwd: f.input.actor.workspace,
    cli_version: kind === 'different version' ? '0.166.0-alpha.6' : '0.169.0-alpha.11.1',
    thread_source:
      kind === 'user destination' || kind === 'different version' ? 'user' : 'agent_created_thread',
  });
  Object.assign(f.human, {
    internal_chat_message_metadata_passthrough: {
      turn_id: root,
      content_item_kinds: ['user.text'],
      content_item_metadata: [
        { provenance: { type: kind === 'harness text' ? 'harness' : 'user' } },
      ],
    },
  });
  if (kind !== 'omitted host')
    Object.assign(f.call.arguments, { hostId: kind === 'remote host' ? 'other' : 'local' });
  f.actorContext.payload.root_turn_id = kind === 'foreign actor context' ? actor : root;
  Object.assign(f.actorRows[1]!.payload, {
    root_turn_id: root,
    turn_attribution: {
      turn_id: actor,
      root_turn_id: root,
      parent_turn_id: kind === 'foreign parent' ? 'other' : root,
      turn_trigger: kind === 'other trigger' ? 'composer' : 'app_tool_send_message',
      initiating_agent_path: kind === 'agent origin' ? '/root' : null,
    },
  });
  if (kind === 'early confirmation')
    [f.actorRows[3], f.actorRows[4]] = [f.actorRows[4]!, f.actorRows[3]!];
  f.flush();
  if (error === null)
    expect(planH06DelegatedDelivery(f.input)).toMatchObject({
      actorTurnId: actor,
      authorityIssued: false,
      mayRun: false,
    });
  else expect(() => planH06DelegatedDelivery(f.input)).toThrow(error);
});

it.each(['user', 'outbound', 'inbound', 'confirmation'] as const)(
  'rejects a changed %s reference',
  (part) => {
    const f = fixture(),
      proof = planH06DelegatedDelivery(f.input);
    proof[part].hash = '0'.repeat(64);
    expect(() => verifyH06DelegatedDelivery(proof)).toThrow('h06-delegated-delivery-proof-changed');
  },
);

it('rejects a changed native confirmation after the proof was captured', () => {
  const f = fixture(),
    proof = planH06DelegatedDelivery(f.input);
  Object.assign(f.confirmation, { extra: true });
  f.flush();
  expect(() => verifyH06DelegatedDelivery(proof)).toThrow('h06-delegated-delivery-proof-changed');
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'missing root native call id',
    (f) => {
      Object.assign(f.call, { id: undefined });
    },
  ],
  [
    'missing actor native delivery id',
    (f) => {
      Object.assign(f.delivery, { id: undefined });
      Object.assign(f.confirmation, { id: undefined });
    },
  ],
  [
    'wrong source hash',
    (f) => {
      f.input.root.user.hash = '0'.repeat(64);
    },
  ],
  [
    'outside source path',
    (f) => {
      f.input.root.user.locator = f.actorPath + '#L4';
    },
  ],
  [
    'wrong source turn',
    (f) => {
      f.input.root.turnId = 'other-turn';
    },
  ],
  [
    'root context changed',
    (f) => {
      f.rootContext.payload.cwd = f.input.actor.workspace;
    },
  ],
  [
    'actor context changed',
    (f) => {
      f.actorContext.payload.cwd = f.input.root.workspace;
    },
  ],
  [
    'duplicate root context',
    (f) => {
      f.rootRows.push(f.rootRows[2]!);
    },
  ],
  [
    'duplicate actor context',
    (f) => {
      f.actorRows.push(f.actorRows[2]!);
    },
  ],
  [
    'forked root',
    (f) => {
      Object.assign(f.rootSession.payload, { forked_from_id: 'parent' });
    },
  ],
  [
    'forked actor',
    (f) => {
      Object.assign(f.actorSession.payload, { parent_thread_id: 'parent' });
    },
  ],
  [
    'unsupported root session',
    (f) => {
      f.rootSession.payload.cli_version = '0.165';
    },
  ],
  [
    'wrong actor session id',
    (f) => {
      f.actorSession.payload.session_id = 'other';
    },
  ],
  [
    'duplicate session',
    (f) => {
      f.rootRows.push(f.rootRows[0]!);
    },
  ],
  [
    'missing session',
    (f) => {
      f.actorRows[0]!.type = 'other';
    },
  ],
  [
    'non-user source',
    (f) => {
      f.human.role = 'assistant';
    },
  ],
  [
    'source outside issuing turn',
    (f) => {
      f.rootRows[1]!.payload.turn_id = 'other-turn';
    },
  ],
  [
    'source is not a message',
    (f) => {
      f.human.type = 'other';
    },
  ],
  [
    'empty source',
    (f) => {
      f.human.content[0]!.text = ' ';
    },
  ],
  [
    'wrong content type',
    (f) => {
      f.human.content[0]!.type = 'output_text';
    },
  ],
  [
    'extra content',
    (f) => {
      f.human.content.push({ type: 'input_text', text: 'extra' });
    },
  ],
  [
    'skill source',
    (f) => {
      f.human.content[0]!.text = '<skill>injected';
    },
  ],
  [
    'page source',
    (f) => {
      f.human.content[0]!.text = '<external_codex_apps_open_page>injected';
    },
  ],
  [
    'superseded source',
    (f) => {
      f.rootRows.splice(4, 0, structuredClone(f.rootRows[3]!));
    },
  ],
  [
    'delegated root source',
    (f) => {
      f.rootRows.push({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: 'root-turn' },
        },
      });
    },
  ],
  [
    'different outgoing nonce',
    (f) => {
      f.call.arguments.prompt = 'different';
    },
  ],
  [
    'duplicate outgoing in another turn',
    (f) => {
      f.rootRows.push(
        f.event('task_started', { turn_id: 'older' }),
        structuredClone(f.rootRows[4]!),
      );
    },
  ],
  [
    'outgoing from another turn',
    (f) => {
      f.rootRows.splice(4, 0, f.event('task_started', { turn_id: 'older' }));
    },
  ],
  [
    'wrong outgoing thread',
    (f) => {
      f.rootRows[4]!.payload.thread_id = 'other';
    },
  ],
  [
    'wrong outgoing turn',
    (f) => {
      f.rootRows[4]!.payload.turn_id = 'other';
    },
  ],
  [
    'wrong target argument',
    (f) => {
      f.call.arguments.threadId = 'other';
    },
  ],
  [
    'extra outgoing argument',
    (f) => {
      Object.assign(f.call.arguments, { model: 'other' });
    },
  ],
  [
    'failed send',
    (f) => {
      f.call.status = 'failed';
    },
  ],
  [
    'send error',
    (f) => {
      f.call.result.isError = true;
    },
  ],
  [
    'empty send result',
    (f) => {
      f.call.result.content = [];
    },
  ],
  [
    'wrong result type',
    (f) => {
      f.call.result.content[0]!.type = 'other';
    },
  ],
  [
    'wrong result thread',
    (f) => {
      f.call.result.content[0]!.text = '{"threadId":"other"}';
    },
  ],
  [
    'wrong outgoing prompt with same nonce',
    (f) => {
      f.call.arguments.prompt += 'changed';
    },
  ],
  [
    'changed inbound body',
    (f) => {
      f.delivery.output += 'changed';
    },
  ],
  [
    'inbound nonce missing',
    (f) => {
      f.delivery.output = 'other';
    },
  ],
  [
    'duplicate inbound',
    (f) => {
      f.actorRows.push(structuredClone(f.actorRows[3]!));
    },
  ],
  [
    'inbound call id present',
    (f) => {
      Object.assign(f.delivery, { call_id: 'unexpected' });
    },
  ],
  [
    'inbound in another turn',
    (f) => {
      f.delivery.internal_chat_message_metadata_passthrough.turn_id = 'other';
    },
  ],
  [
    'missing confirmation',
    (f) => {
      f.confirmation.type = 'other';
    },
  ],
  [
    'duplicate confirmation',
    (f) => {
      f.actorRows.push(structuredClone(f.actorRows[4]!));
    },
  ],
  [
    'confirmation thread changed',
    (f) => {
      f.actorRows[4]!.payload.thread_id = 'other';
    },
  ],
  [
    'confirmation turn changed',
    (f) => {
      f.actorRows[4]!.payload.turn_id = 'other';
    },
  ],
  [
    'confirmation name changed',
    (f) => {
      f.confirmation.name = 'other';
    },
  ],
  [
    'confirmation namespace changed',
    (f) => {
      f.confirmation.namespace = 'other';
    },
  ],
  [
    'confirmation body changed',
    (f) => {
      f.confirmation.output += 'changed';
    },
  ],
];
it.each(mutations)('rejects %s', (name, change) => {
  const f = fixture();
  change(f);
  const expectedHash = f.input.root.user.hash;
  f.flush();
  if (name === 'wrong source hash') f.input.root.user.hash = expectedHash;
  expect(() => planH06DelegatedDelivery(f.input)).toThrow();
});

it.each(['root', 'actor'])('rejects multiple native files for the %s thread', (thread) => {
  const f = fixture();
  writeFileSync(join(f.input.sessionsRoot, 'duplicate-' + thread + '.jsonl'), '{}\n');
  expect(() => planH06DelegatedDelivery(f.input)).toThrow('h06-delegated-delivery-transcript');
});

it('ignores unrelated files and rejects a root path replaced by a symlink', () => {
  const f = fixture();
  mkdirSync(join(f.input.sessionsRoot, 'nested'));
  writeFileSync(join(f.input.sessionsRoot, 'unrelated.txt'), 'ignored');
  expect(planH06DelegatedDelivery(f.input).mayRun).toBe(false);
  const alias = join(f.directory, 'sessions-alias');
  symlinkSync(f.input.sessionsRoot, alias);
  expect(() => planH06DelegatedDelivery({ ...f.input, sessionsRoot: alias })).toThrow();
});

it.each(['root', 'actor'])(
  'accepts a complete %s proof prefix with an unfinished appended record',
  (thread) => {
    const f = fixture(),
      proof = planH06DelegatedDelivery(f.input);
    const path = thread === 'root' ? f.rootPath : f.actorPath;
    appendFileSync(path, '{"type":"event_msg","payload":');
    expect(planH06DelegatedDelivery(f.input)).toEqual(proof);
    expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
  },
);

it('keeps pinned delivery rows stable when the real root journal grows during its native read', () => {
  const f = fixture(),
    proof = planH06DelegatedDelivery(f.input);
  const before = readFileSync(f.rootPath);
  let appended = false;
  nativeRead.afterRead = () => {
    if (appended) return;
    appended = true;
    appendFileSync(
      f.rootPath,
      JSON.stringify(f.event('diagnostic', { message: 'appended during read' })) + '\n{"type":',
    );
  };
  expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
  expect(appended).toBe(true);
  expect(readFileSync(f.rootPath).subarray(0, before.length)).toEqual(before);
});

it.each(['root', 'actor'])('rejects a required unfinished native %s record', (thread) => {
  const f = fixture();
  const path = thread === 'root' ? f.rootPath : f.actorPath;
  writeFileSync(path, readFileSync(path).subarray(0, -1));
  expect(() => planH06DelegatedDelivery(f.input)).toThrow(
    thread === 'root' ? 'h06-delegated-delivery-outbound' : 'h06-delegated-delivery-confirmation',
  );
});

it('does not infer an inbound delivery from its unfinished native JSON record', () => {
  const f = fixture();
  const prefix =
    f.actorRows
      .slice(0, 3)
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n';
  writeFileSync(f.actorPath, prefix + JSON.stringify(f.actorRows[3]));
  expect(() => planH06DelegatedDelivery(f.input)).toThrow('h06-delegated-delivery-inbound');
});

it.each(['root', 'actor'])(
  'ignores an unfinished UTF-8 sequence after a complete %s proof prefix',
  (thread) => {
    const f = fixture(),
      proof = planH06DelegatedDelivery(f.input);
    appendFileSync(thread === 'root' ? f.rootPath : f.actorPath, Buffer.from([0xd0]));
    expect(verifyH06DelegatedDelivery(proof)).toEqual(proof);
  },
);

it.each(['root', 'actor'])('rejects invalid UTF-8 in the %s transcript', (thread) => {
  const f = fixture();
  const path = thread === 'root' ? f.rootPath : f.actorPath;
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([255, 10])]));
  expect(() => planH06DelegatedDelivery(f.input)).toThrow('h06-native-journal-encoding');
});

it.each([
  (f: ReturnType<typeof fixture>) => ({ ...f.input, kind: 'other' }),
  (f: ReturnType<typeof fixture>) => ({
    ...f.input,
    command: { ...f.input.command, kind: 'other' },
  }),
  (f: ReturnType<typeof fixture>) => ({ ...f.input, prompt: 'changed' }),
  (f: ReturnType<typeof fixture>) => ({
    ...f.input,
    actor: { ...f.input.actor, threadId: 'root' },
  }),
  (f: ReturnType<typeof fixture>) => ({
    ...f.input,
    root: { ...f.input.root, user: { ...f.input.root.user, locator: 'invalid' } },
  }),
])('rejects malformed input %#', (input) => {
  const f = fixture();
  expect(() => planH06DelegatedDelivery(input(f))).toThrow();
});
