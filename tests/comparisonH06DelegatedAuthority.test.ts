import { fork } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  consumeH06DelegatedAuthority,
  h06DelegatedPhaseAction,
  h06DelegatedStages,
  openH06DelegatedPhaseLedger,
  planH06DelegatedAuthority,
  planH06AutonomousGrant,
  readH06DelegatedAuthority,
  type H06DelegatedInput,
  type H06DelegatedPhase,
} from './comparisonH06DelegatedAuthority.js';
import { planH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import {
  observeH06NativePrimaryGrant,
  planH06NativeAttempt,
} from './comparisonH06NativeAttempt.js';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
type NativeRecord = { type: string; payload: Record<string, unknown> };
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-delegated-authority-'));
  temporary.push(root);
  const workspace = join(root, 'material'),
    chat = join(root, 'chat'),
    sessions = join(root, 'sessions');
  for (const directory of [workspace, chat, sessions]) mkdirSync(directory);
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, body] of Object.entries(materials.cases.find(({ id }) => id === 'H-06')!.files))
    writeFileSync(join(workspace, name), body);
  const pin = (name: string, body: unknown = name): H04Pin => {
    const path = join(root, name),
      bytes = typeof body === 'string' ? body : canonical(body) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const operationId = 'h06-delegated';
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId,
      variant: 'legacy',
      workspaceRoot: workspace,
      node: pin('node'),
      timeoutMs: 2000,
    },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'root-thread', workspace: chat },
    budget: {
      maxElapsedMs: 300000,
      reserveMs: 120000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: 20000 },
    appServer: pin('app-server'),
    server: null,
    bootstrap: pin('bootstrap', {
      kind: 'comparison-h06-native-legacy-bootstrap/2',
      projectId: 'project',
      runId: 'run',
      actorId: 'actor-thread',
      generation: 1,
      permissions: ['read', 'manage', 'produce'],
    }),
    runtime: [pin('runtime')],
  };
  const session = (id: string): NativeRecord => ({
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
  const context = (turn_id: string, cwd: string): NativeRecord => ({
    type: 'turn_context',
    payload: {
      turn_id,
      cwd,
      model: 'fixture',
      effort: 'medium',
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
    },
  });
  const literal =
    'Измени способ приёмки на автономный и выполни тёплый, холодный и завершающий этапы.';
  const previous = structuredClone(request);
  mkdirSync(join(root, 'previous'));
  previous.evidenceRoot = join(root, 'previous', operationId);
  const budgetText =
    canonical({
      kind: 'comparison-h06-native-grant/2',
      operationId,
      variant: 'legacy',
      requestHash: digest(canonical({ request: previous, assets: h06Assets() })),
      budget: previous.budget,
    }) + '\n\n';
  const rootPath = join(sessions, 'rollout-root-thread.jsonl'),
    actorPath = join(sessions, 'rollout-actor-thread.jsonl');
  const rootRows = [
    session('root-thread'),
    event('task_started', { turn_id: 'budget-turn' }),
    context('budget-turn', chat),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: budgetText }],
      },
    },
    event('task_complete', { turn_id: 'budget-turn' }),
    event('task_started', { turn_id: 'root-turn' }),
    context('root-turn', chat),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: literal }],
      },
    },
  ];
  const actorRows = [session('actor-thread')];
  const flush = () => {
    for (const [path, rows] of [
      [rootPath, rootRows],
      [actorPath, actorRows],
    ] as const)
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };
  flush();
  const input: H06DelegatedInput = {
    kind: 'comparison-h06-delegated-legacy/1',
    attempt: pin('attempt.json', request),
    source: {
      transcript: rootPath,
      turnId: 'root-turn',
      source: {
        locator: rootPath + '#L8',
        hash: digest(JSON.stringify(rootRows[7]) + '\n'),
      },
    },
    budgetSource: {
      attempt: pin('budget-attempt.json', previous),
      source: {
        transcript: rootPath,
        turnId: 'budget-turn',
        source: {
          locator: rootPath + '#L4',
          hash: digest(JSON.stringify(rootRows[3]) + '\n'),
        },
      },
    },
    normalization: {
      kind: 'root-operator-normalization/1',
      decision: 'autonomous-legacy-warm-cold-completion',
    },
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', 'root-thread');
  function updateRequest() {
    input.attempt = pin('attempt.json', request);
  }
  function delivery(
    claim: ReturnType<typeof consumeH06DelegatedAuthority>,
    intent: H04Pin,
    phase: H06DelegatedPhase,
    targetChange: Record<string, unknown> = {},
  ) {
    const command = {
      kind: 'comparison-h06-delegated-command/1',
      nonce: phase.nonce,
      requestHash: phase.requestHash,
      action: h06DelegatedPhaseAction(phase.stage),
      target: {
        claim: claim.receipt,
        intent,
        stage: phase.stage,
        generation: phase.generation,
        storeRevision: phase.storeRevision,
        controlRevision: phase.controlRevision,
        requirementsRevision: phase.requirementsRevision,
        ...targetChange,
      },
    };
    const prompt = 'Delivery only\n' + canonical(command),
      actorTurn = 'actor-' + phase.nonce;
    const envelope =
      '<codex_delegation>\n  <source_thread_id>root-thread</source_thread_id>\n  <input>' +
      prompt +
      '</input>\n</codex_delegation>';
    rootRows.push(
      event('item_completed', {
        thread_id: 'root-thread',
        turn_id: 'root-turn',
        item: {
          type: 'McpToolCall',
          id: 'call-' + phase.nonce,
          server: 'codex_app',
          tool: 'send_message_to_thread',
          arguments: { threadId: 'actor-thread', prompt },
          status: 'completed',
          result: {
            isError: false,
            content: [{ type: 'text', text: '{"threadId":"actor-thread"}' }],
          },
        },
      }),
    );
    actorRows.push(
      event('task_started', { turn_id: actorTurn }),
      context(actorTurn, workspace),
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: 'delivery-' + phase.nonce,
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output: envelope,
          internal_chat_message_metadata_passthrough: { turn_id: actorTurn },
        },
      },
      event('item_completed', {
        thread_id: 'actor-thread',
        turn_id: actorTurn,
        item: {
          type: 'FunctionCallOutput',
          id: 'delivery-' + phase.nonce,
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output: envelope,
        },
      }),
    );
    flush();
    return pin(
      'delivery-' + phase.nonce + '.json',
      planH06DelegatedDelivery({
        kind: 'comparison-h06-delegated-delivery/1',
        sessionsRoot: sessions,
        root: {
          threadId: 'root-thread',
          workspace: chat,
          turnId: 'root-turn',
          user: input.source.source,
        },
        actor: { threadId: 'actor-thread', workspace },
        command,
        prompt,
      }),
    );
  }
  return {
    root,
    request,
    previous,
    budgetText,
    input,
    pin,
    updateRequest,
    flush,
    rootRows,
    actorRows,
    rootPath,
    event,
    context,
    literal,
    delivery,
  };
}

type Claim = ReturnType<typeof consumeH06DelegatedAuthority>;
function phase(
  claim: Claim,
  stage: H06DelegatedPhase['stage'] = 'load',
  predecessor: H04Pin | null = null,
): H06DelegatedPhase {
  return {
    stage,
    nonce: 'nonce-' + stage,
    rootThread: claim.request.chat.threadId,
    actorThread: claim.actorId,
    requestHash: claim.requestHash,
    generation: claim.generation,
    storeRevision: 1,
    controlRevision: 1,
    requirementsRevision: 1,
    predecessor,
  };
}
function settle(
  f: ReturnType<typeof fixture>,
  claim: Claim,
  current: H06DelegatedPhase,
  intent: H04Pin,
  targetChange: Record<string, unknown> = {},
) {
  const predecessor =
    current.predecessor === null
      ? null
      : (JSON.parse(readH04Pin(current.predecessor).toString()) as { outcome: H04Pin });
  const previousOutcome =
    predecessor === null
      ? null
      : (JSON.parse(readH04Pin(predecessor.outcome).toString()) as { delivery: H04Pin });
  return f.pin('outcome-' + current.nonce + '.json', {
    kind: 'h06-delegated-phase-outcome/1',
    claim: claim.receipt,
    intent,
    stage: current.stage,
    status: 'confirmed',
    delivery:
      current.stage === 'completion'
        ? previousOutcome!.delivery
        : f.delivery(claim, intent, current, targetChange),
    result: f.pin('result-' + current.nonce + '.json', {
      kind: 'fixture-domain-result',
      stage: current.stage,
    }),
  });
}

it('plans read-only and preserves the literal user text separately from operator normalization', () => {
  const f = fixture(),
    before = readFileSync(f.rootPath);
  const plan = planH06DelegatedAuthority(f.input);
  expect(plan).toMatchObject({ mayRun: false, qualification: false, source: { text: f.literal } });
  expect(plan.budgetSource.source.text).toBe(f.budgetText);
  expect(plan.budgetSource.source.text.endsWith('\n\n')).toBe(true);
  expect(readFileSync(f.rootPath)).toEqual(before);
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

function directGrant(f: ReturnType<typeof fixture>, body?: string) {
  const proposal = planH06AutonomousGrant(f.input.attempt);
  f.rootRows[7]!.payload.content = [
    { type: 'input_text', text: body ?? proposal.expectedGrantText + '\n\n' },
  ];
  f.input.source.source.hash = digest(JSON.stringify(f.rootRows[7]) + '\n');
  f.input.budgetSource = {
    attempt: structuredClone(f.input.attempt),
    source: structuredClone(f.input.source),
  };
  f.flush();
  return proposal;
}

it('binds only the exact direct Desktop 0.169 grant to the local root turn', () => {
  const f = fixture();
  Object.assign(f.rootRows[0]!.payload, {
    cli_version: '0.169.0-alpha.11.1',
    cwd: f.request.chat.workspace,
  });
  Object.assign(f.rootRows[6]!.payload, { root_turn_id: 'root-turn' });
  const metadata = {
    turn_id: 'root-turn',
    content_item_kinds: ['user.text'],
    content_item_metadata: [{ provenance: { type: 'user' } }],
  };
  Object.assign(f.rootRows[7]!.payload, { internal_chat_message_metadata_passthrough: metadata });
  f.flush();
  expect(() => planH06DelegatedAuthority(f.input)).toThrow('h06-delegated-session');
  directGrant(f);
  expect(planH06DelegatedAuthority(f.input)).toMatchObject({ mayRun: false });
  f.rootRows.push(
    { type: 'compacted', payload: { resume_metadata: { last_started_turn_id: 'root-turn' } } },
    { type: 'world_state', payload: { full: true } },
    structuredClone(f.rootRows[6]!),
  );
  f.flush();
  expect(planH06DelegatedAuthority(f.input)).toMatchObject({ mayRun: false });
  metadata.content_item_metadata[0]!.provenance.type = 'harness';
  directGrant(f);
  expect(() => planH06DelegatedAuthority(f.input)).toThrow('h06-delegated-direct-origin');
});

it('prepares an exact /3 grant proposal without a future human source or any reservation', () => {
  const f = fixture();
  rmSync(f.rootPath);
  const proposal = planH06AutonomousGrant(f.input.attempt);
  expect(JSON.parse(proposal.expectedGrantText) as unknown).toEqual({
    acceptanceProfile: 'h06-autonomous-recovery/3',
    kind: 'comparison-h06-autonomous-grant/3',
    operationId: f.request.binding.operationId,
    variant: 'legacy',
    requestHash: proposal.requestHash,
    budget: f.request.budget,
  });
  expect(proposal).toMatchObject({ mayRun: false, qualification: false });
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

it('consumes one direct human /3 grant once and bridges the same root without a second mode decision', () => {
  const f = fixture(),
    proposal = directGrant(f);
  const claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.budget.mode).toBe('autonomous-grant');
  expect(claim.budget.requestHash).toBe(proposal.requestHash);
  expect(claim.budget.source).toEqual(claim.source);
  expect(claim.source.text).toBe(proposal.expectedGrantText + '\n\n');
  expect(claim.budget.bridge.path).toBe(
    join(claim.request.evidenceRoot, 'autonomous-reservation.json'),
  );
  expect(readH06DelegatedAuthority(claim.receipt)).toEqual(claim);
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
  expect(existsSync(f.previous.evidenceRoot)).toBe(false);
});

it('retains a direct grant through a verified native capacity retry without changing its source or caps', () => {
  const f = fixture();
  directGrant(f);
  const original = planH06DelegatedAuthority(f.input);
  capacityRetry(f);
  const claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.sourceKey).toBe(original.sourceKey);
  expect(claim.budget.mode).toBe('autonomous-grant');
  expect(claim.stopDeadlineMs - claim.startedAt).toBe(f.request.budget.maxElapsedMs);
  expect(openH06DelegatedPhaseLedger(claim.receipt).admitPhase(phase(claim))).toBeDefined();
});

it.each([
  'kind',
  'acceptanceProfile',
  'requestHash',
  'operationId',
  'variant',
  'budget',
  'opaque',
  'extra',
])('does not treat a direct grant with changed %s as new autonomous authority', (field) => {
  const f = fixture(),
    proposal = planH06AutonomousGrant(f.input.attempt);
  const body = JSON.parse(proposal.expectedGrantText) as Record<string, unknown>;
  const changes: Record<string, unknown> = {
    kind: 'comparison-h06-native-grant/2',
    acceptanceProfile: 'other-profile',
    requestHash: '0'.repeat(64),
    operationId: 'other-operation',
    variant: 'temporal',
    budget: { ...f.request.budget, maxOutput: 1 },
    extra: true,
  };
  body[field] = changes[field];
  directGrant(f, field === 'opaque' ? 'Продолжай, считай сообщение отправленным' : canonical(body));
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-grant');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

it('cannot reset a consumed direct grant by changing its package and evidence root', () => {
  const f = fixture();
  directGrant(f);
  const claim = consumeH06DelegatedAuthority(f.input);
  mkdirSync(join(f.root, 'second'));
  f.request.evidenceRoot = join(f.root, 'second', f.request.binding.operationId);
  f.request.runtime = [f.pin('new-runtime')];
  f.updateRequest();
  f.input.budgetSource.attempt = structuredClone(f.input.attempt);
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-grant');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(claim.budget.bridge.path)).toBe(true);
});

it('reads the complete authority prefix while the active journal has an unfinished appended line', () => {
  const f = fixture();
  appendFileSync(
    f.rootPath,
    Buffer.concat([Buffer.from('{"type":"partial","text":"'), Buffer.from([0xf0, 0x9f])]),
  );
  const claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.source.text).toBe(f.literal);
  expect(readH06DelegatedAuthority(claim.receipt)).toEqual(claim);
});

it('accepts historical outer whitespace only in the autonomous reader and keeps /2 strict', async () => {
  const f = fixture();
  const original = planH06NativeAttempt(f.previous);
  await expect(observeH06NativePrimaryGrant(original, f.input.budgetSource.source)).rejects.toThrow(
    'h06-native-attempt-authority-body',
  );
  expect(planH06DelegatedAuthority(f.input).budgetSource.requestHash).toBe(original.requestHash);
});

it('does not reread superseded runtime bytes when verifying the old request hash', () => {
  const f = fixture();
  writeFileSync(f.previous.runtime[0]!.path, 'superseded bytes');
  f.request.runtime = [f.pin('autonomous-runtime', 'new bytes')];
  f.updateRequest();
  const claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.budget.request.runtime).toEqual(f.previous.runtime);
  expect(readH06DelegatedAuthority(claim.receipt)).toEqual(claim);
});

it('atomically bridges the original evidence root and makes the old /2 attempt unavailable', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  const bridge = JSON.parse(readH04Pin(claim.budget.bridge).toString()) as {
    claimPath: string;
    requestHash: string;
  };
  expect(claim.budget.bridge.path).toBe(
    join(f.previous.evidenceRoot, 'autonomous-reservation.json'),
  );
  expect(bridge).toMatchObject({
    claimPath: claim.receipt.path,
    requestHash: claim.budget.requestHash,
  });
  expect(() => planH06NativeAttempt(f.previous)).toThrow('h06-native-attempt-not-fresh');
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
});

it('rejects an already occupied original budget root without consuming a new claim', () => {
  const f = fixture();
  mkdirSync(f.previous.evidenceRoot);
  writeFileSync(join(f.previous.evidenceRoot, 'owner'), 'previous attempt');
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-consumed');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

it('requires separate old and autonomous evidence roots before reserving either', () => {
  const f = fixture();
  f.request.evidenceRoot = f.previous.evidenceRoot;
  f.updateRequest();
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-consumed');
  expect(existsSync(f.previous.evidenceRoot)).toBe(false);
});

it('rechecks the original bridge bytes and directory identity during reopen', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input),
    before = readH04Pin(claim.budget.bridge);
  writeFileSync(claim.budget.bridge.path, '{}');
  expect(() => readH06DelegatedAuthority(claim.receipt)).toThrow();
  writeFileSync(claim.budget.bridge.path, before);
  renameSync(f.previous.evidenceRoot, f.previous.evidenceRoot + '-original');
  mkdirSync(f.previous.evidenceRoot);
  writeFileSync(claim.budget.bridge.path, before);
  expect(() => readH06DelegatedAuthority(claim.receipt)).toThrow('h06-delegated-budget-changed');
});

it.each(['budget', 'stimulus', 'bootstrap', 'appServer', 'node', 'timeout'])(
  'does not transfer the original grant to changed %s scope',
  (field) => {
    const f = fixture();
    if (field === 'budget') f.request.budget.maxOutput--;
    if (field === 'stimulus') f.request.stimulus.longStageMs++;
    if (field === 'bootstrap')
      f.request.bootstrap = f.pin('new-bootstrap', readH04Pin(f.request.bootstrap).toString());
    if (field === 'appServer') f.request.appServer = f.pin('new-app-server');
    if (field === 'node') f.request.binding.node = f.pin('new-node');
    if (field === 'timeout') f.request.binding.timeoutMs++;
    f.updateRequest();
    expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-scope');
    expect(existsSync(f.previous.evidenceRoot)).toBe(false);
  },
);

it.each(['body', 'source-hash', 'delegated-turn', 'request-hash'])(
  'rejects a changed original budget %s',
  (mutation) => {
    const f = fixture();
    if (mutation === 'source-hash') f.input.budgetSource.source.source.hash = '0'.repeat(64);
    if (mutation === 'body') {
      f.rootRows[3]!.payload.content = [
        { type: 'input_text', text: f.budgetText.trim() + ' changed' },
      ];
      f.input.budgetSource.source.source.hash = digest(JSON.stringify(f.rootRows[3]) + '\n');
    }
    if (mutation === 'request-hash') {
      f.previous.runtime = [f.pin('unapproved-runtime')];
      f.input.budgetSource.attempt = f.pin('budget-attempt.json', f.previous);
    }
    if (mutation === 'delegated-turn')
      f.rootRows.push({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: 'budget-turn' },
        },
      });
    f.flush();
    expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
    expect(existsSync(f.request.evidenceRoot)).toBe(false);
  },
);

it('requires a distinct later autonomous decision instead of reinterpreting the budget grant', () => {
  const f = fixture();
  f.rootRows.splice(4);
  f.input.source = structuredClone(f.input.budgetSource.source);
  f.flush();
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-order');
});

it('keeps one budget source key when a later current decision is appended', () => {
  const f = fixture(),
    initial = planH06DelegatedAuthority(f.input);
  const message = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: f.literal }],
    },
  };
  f.rootRows.push(
    f.event('task_started', { turn_id: 'later-decision' }),
    f.context('later-decision', f.request.chat.workspace),
    message,
  );
  f.input.source = {
    transcript: f.rootPath,
    turnId: 'later-decision',
    source: {
      locator: f.rootPath + '#L' + f.rootRows.length,
      hash: digest(JSON.stringify(message) + '\n'),
    },
  };
  f.flush();
  expect(planH06DelegatedAuthority(f.input).sourceKey).toBe(initial.sourceKey);
});

function capacityRetry(
  f: ReturnType<typeof fixture>,
  sourceTurn = 'root-turn',
  targetTurn = 'capacity-retry',
) {
  f.rootRows.push(
    f.event('task_complete', {
      turn_id: sourceTurn,
      root_turn_id: sourceTurn,
      last_agent_message: null,
      error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' },
    }),
    f.event('task_started', {
      turn_id: targetTurn,
      turn_attribution: {
        turn_id: targetTurn,
        turn_trigger: 'capacity_retry_manual',
        parent_turn_id: null,
        initiating_agent_path: null,
        root_turn_id: targetTurn,
      },
    }),
    f.context(targetTurn, f.request.chat.workspace),
  );
  f.flush();
}

it('retains the original human decision over native capacity retry between preflight and first claim', () => {
  const f = fixture(),
    original = planH06DelegatedAuthority(f.input);
  capacityRetry(f);
  const claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.source.turnId).toBe('root-turn');
  expect(claim.source.source).toEqual(f.input.source.source);
  expect(claim.sourceKey).toBe(original.sourceKey);
  expect(claim.stopDeadlineMs - claim.startedAt).toBe(f.request.budget.maxElapsedMs);
  const intent = openH06DelegatedPhaseLedger(claim.receipt).admitPhase(phase(claim));
  expect(JSON.parse(readH04Pin(intent).toString()) as unknown).toMatchObject({
    phase: { stage: 'load' },
  });
});

it('preserves an issued claim deadline and source over a subsequent verified retry', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  capacityRetry(f);
  capacityRetry(f, 'capacity-retry', 'capacity-retry-again');
  const reopened = readH06DelegatedAuthority(claim.receipt);
  expect(reopened.startedAt).toBe(claim.startedAt);
  expect(reopened.workDeadlineMs).toBe(claim.workDeadlineMs);
  expect(reopened.stopDeadlineMs).toBe(claim.stopDeadlineMs);
  expect(openH06DelegatedPhaseLedger(claim.receipt).admitPhase(phase(claim))).toBeDefined();
});

it.each([
  'new-user',
  'delegated',
  'completed-target',
  'scope',
  'successful-source',
  'ordinary-trigger',
])('does not retain the decision over a capacity-shaped retry with %s', (mutation) => {
  const f = fixture();
  capacityRetry(f);
  if (mutation === 'new-user')
    f.rootRows.push({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'A newer real user decision' }],
      },
    });
  if (mutation === 'delegated')
    f.rootRows.push({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        namespace: 'codex_app',
        name: 'send_message_to_thread',
        internal_chat_message_metadata_passthrough: { turn_id: 'capacity-retry' },
      },
    });
  if (mutation === 'completed-target')
    f.rootRows.push(f.event('task_complete', { turn_id: 'capacity-retry' }));
  if (mutation === 'scope') f.rootRows.at(-1)!.payload.cwd = '/different-workspace';
  if (mutation === 'successful-source') f.rootRows.at(-3)!.payload.error = null;
  if (mutation === 'ordinary-trigger')
    f.rootRows.at(-2)!.payload.turn_attribution = {
      turn_id: 'capacity-retry',
      turn_trigger: 'user',
      parent_turn_id: null,
      initiating_agent_path: null,
      root_turn_id: 'capacity-retry',
    };
  f.flush();
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-source-stale');
  expect(existsSync(f.previous.evidenceRoot)).toBe(false);
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

it('rejects an ambiguous root transcript in a nested native session directory', () => {
  const f = fixture(),
    archive = join(f.root, 'sessions', 'archive');
  mkdirSync(archive);
  writeFileSync(join(archive, 'duplicate-root-thread.jsonl'), readFileSync(f.rootPath));
  expect(() => planH06DelegatedAuthority(f.input)).toThrow('h06-delegated-source-path');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it('issues one distinct claim and reopens under the actor without resetting deadlines', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  expect(claim.kind).toBe('h06-delegated-legacy-claim/1');
  expect(claim.qualification).toBe(false);
  vi.stubEnv('CODEX_THREAD_ID', 'actor-thread');
  appendFileSync(
    f.rootPath,
    JSON.stringify(f.event('task_complete', { turn_id: 'root-turn' })) + '\n',
  );
  const reopened = readH06DelegatedAuthority(claim.receipt);
  expect(reopened).toEqual(claim);
  expect(reopened.stopDeadlineMs - reopened.startedAt).toBe(f.request.budget.maxElapsedMs);
  expect(reopened.stopDeadlineMs - reopened.workDeadlineMs).toBe(f.request.budget.reserveMs);
  expect(() => openH06DelegatedPhaseLedger(claim.receipt).admitPhase(phase(claim))).toThrow(
    'h06-delegated-source-stale',
  );
});

it('rejects actor issuance and leaves the source unconsumed', () => {
  const f = fixture();
  vi.stubEnv('CODEX_THREAD_ID', 'actor-thread');
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-root-only');
  vi.stubEnv('CODEX_THREAD_ID', 'root-thread');
  expect(consumeH06DelegatedAuthority(f.input).source.text).toBe(f.literal);
});

it('keeps a global source reservation across request hash, operation and evidence changes', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  mkdirSync(join(f.root, 'second'));
  f.request.evidenceRoot = join(f.root, 'second', f.request.binding.operationId);
  f.request.runtime = [f.pin('runtime-v2')];
  f.updateRequest();
  expect(() => planH06DelegatedAuthority(f.input)).toThrow('h06-delegated-budget-consumed');
  rmSync(f.previous.evidenceRoot, { recursive: true });
  const next = planH06DelegatedAuthority(f.input);
  expect(next.sourceKey).toBe(claim.sourceKey);
  expect(next.requestHash).not.toBe(claim.requestHash);
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it('allows only one consumer racing in separate processes and never replenishes its source', async () => {
  const f = fixture();
  const modulePath = fileURLToPath(
    new URL('./comparisonH06DelegatedAuthority.ts', import.meta.url),
  );
  const inputPin = f.pin('race-input.json', f.input);
  const program = f.pin(
    'race.mjs',
    `
import {readFileSync} from 'node:fs';
import {planH06DelegatedAuthority,consumeH06DelegatedAuthority} from ${JSON.stringify(modulePath)};
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
planH06DelegatedAuthority(input);
process.send('ready');
process.once('message',()=>{
 try {consumeH06DelegatedAuthority(input);process.send('consumed');}
 catch {process.send('rejected');}
 process.disconnect();
});
`,
  );
  const launch = () => {
    const child = fork(program.path, [inputPin.path], {
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    let output = '';
    child.stderr!.on('data', (part) => {
      output += String(part);
    });
    let ready: () => void, complete: (result: string) => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const finished = new Promise<string>((resolve, reject) => {
      complete = resolve;
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(output));
      });
    });
    child.on('message', (value) => {
      if (value === 'ready') ready();
      else complete(String(value));
    });
    return { child, prepared, finished };
  };
  const consumers = [launch(), launch()];
  try {
    await Promise.all(consumers.map(({ prepared }) => prepared));
    for (const { child } of consumers) child.send('consume');
    expect((await Promise.all(consumers.map(({ finished }) => finished))).sort()).toEqual([
      'consumed',
      'rejected',
    ]);
    rmSync(f.request.evidenceRoot, { recursive: true });
    expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
  } finally {
    for (const { child } of consumers) child.kill();
  }
}, 15000);

it.each([
  ['maxElapsedMs', 1500001],
  ['reserveMs', 119999],
  ['maxManagedStarts', 25],
  ['maxInputUncached', 500001],
  ['maxOutput', 30001],
] as const)('rejects the delegated %s cap without consumption', (name, value) => {
  const f = fixture();
  f.request.budget[name] = value;
  f.updateRequest();
  expect(() => consumeH06DelegatedAuthority(f.input)).toThrow('h06-delegated-cap');
  expect(existsSync(join(f.root, 'agent-workflow-evidence'))).toBe(false);
});

it.each(['source-hash', 'inbound', 'new-user', 'new-turn', 'fork', 'profile'])(
  'rejects a changed or delegated root source: %s',
  (mutation) => {
    const f = fixture();
    if (mutation === 'source-hash') f.input.source.source.hash = '0'.repeat(64);
    if (mutation === 'fork') f.rootRows[0]!.payload.parent_thread_id = 'other';
    if (mutation === 'profile') f.rootRows[2]!.payload.approval_policy = 'on-request';
    if (mutation === 'new-user')
      f.rootRows.push({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Later user' }],
        },
      });
    if (mutation === 'new-turn')
      f.rootRows.push(
        f.event('task_started', { turn_id: 'next-turn' }),
        f.context('next-turn', f.request.chat.workspace),
      );
    if (mutation === 'inbound')
      f.rootRows.push({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: 'root-turn' },
        },
      });
    f.flush();
    expect(() => consumeH06DelegatedAuthority(f.input)).toThrow();
    expect(existsSync(f.request.evidenceRoot)).toBe(false);
  },
);

it('rejects modified package pins and substituted evidence directories on reopen', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  writeFileSync(f.request.runtime[0]!.path, 'changed');
  expect(() => readH06DelegatedAuthority(claim.receipt)).toThrow();
  writeFileSync(f.request.runtime[0]!.path, 'runtime');
  renameSync(f.request.evidenceRoot, f.request.evidenceRoot + '-original');
  mkdirSync(f.request.evidenceRoot);
  writeFileSync(
    claim.receipt.path,
    readFileSync(join(f.request.evidenceRoot + '-original', 'delegated-claim.json')),
  );
  expect(() => readH06DelegatedAuthority(claim.receipt)).toThrow('h06-delegated-root-changed');
});

it('retains UNKNOWN after reopening a pending phase and rejects resend or skipping', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  const ledger = openH06DelegatedPhaseLedger(claim.receipt);
  expect(() => ledger.admitPhase(phase(claim, 'warm-pause'))).toThrow(
    'h06-delegated-phase-binding',
  );
  const current = phase(claim),
    intent = ledger.admitPhase(current);
  expect(openH06DelegatedPhaseLedger(claim.receipt).inspect()).toEqual({
    status: 'UNKNOWN',
    phases: [{ phase: current, intent, outcome: null }],
  });
  expect(() => ledger.admitPhase(current)).toThrow('h06-delegated-phase-unknown');
  expect(() => ledger.admitPhase(phase(claim, 'warm-pause'))).toThrow(
    'h06-delegated-phase-unknown',
  );
});

it('records all six exact deliveries in order and retains the initial budget through completion', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  let predecessor: H04Pin | null = null;
  for (const [index, stage] of h06DelegatedStages.entries()) {
    const current = {
      ...phase(claim, stage, predecessor),
      storeRevision: index + 1,
      controlRevision: index + 1,
    };
    const ledger = openH06DelegatedPhaseLedger(claim.receipt);
    const intent = ledger.admitPhase(current);
    vi.stubEnv('CODEX_THREAD_ID', 'actor-thread');
    predecessor = ledger.settlePhase(settle(f, claim, current, intent));
    expect(ledger.inspect().status).toBe('RECORDED');
  }
  expect(openH06DelegatedPhaseLedger(claim.receipt).inspect().phases).toHaveLength(6);
  expect(f.rootRows).toHaveLength(13);
  expect(f.actorRows).toHaveLength(21);
  expect(readH06DelegatedAuthority(claim.receipt).workDeadlineMs).toBe(claim.workDeadlineMs);
  expect(() => openH06DelegatedPhaseLedger(claim.receipt).admitPhase(phase(claim))).toThrow();
});

it('requires completion to inherit exactly the preceding cold-resume delivery', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input);
  const ledger = openH06DelegatedPhaseLedger(claim.receipt);
  let predecessor: H04Pin | null = null;
  for (const stage of h06DelegatedStages.slice(0, -1)) {
    const current = phase(claim, stage, predecessor),
      intent = ledger.admitPhase(current);
    predecessor = ledger.settlePhase(settle(f, claim, current, intent));
  }
  const current = phase(claim, 'completion', predecessor),
    intent = ledger.admitPhase(current);
  const outcome = f.pin('wrong-completion.json', {
    kind: 'h06-delegated-phase-outcome/1',
    claim: claim.receipt,
    intent,
    stage: 'completion',
    status: 'confirmed',
    delivery: f.delivery(claim, intent, current),
    result: f.pin('completion-result.json', { completed: true }),
  });
  expect(() => ledger.settlePhase(outcome)).toThrow('h06-delegated-completion-delivery');
  expect(ledger.inspect().status).toBe('UNKNOWN');
});

it('does not accept a canonical /2 input or claim as delegated authority', () => {
  const f = fixture();
  expect(() =>
    consumeH06DelegatedAuthority({ ...f.input, kind: 'comparison-h06-native-grant/2' }),
  ).toThrow('h06-delegated-kind');
  const oldClaim = f.pin('old-claim.json', { kind: 'h06-native-claim/2' });
  expect(() => readH06DelegatedAuthority(oldClaim)).toThrow();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it.each([
  'generation',
  'requestHash',
  'rootThread',
  'actorThread',
  'predecessor',
  'requirementsRevision',
  'nonce',
  'storeRevision',
])('rejects phase binding changes: %s', (field) => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input),
    ledger = openH06DelegatedPhaseLedger(claim.receipt);
  const current = phase(claim),
    intent = ledger.admitPhase(current);
  const predecessor = ledger.settlePhase(settle(f, claim, current, intent));
  const next = phase(claim, 'warm-pause', predecessor) as unknown as Record<string, unknown>;
  const changes: Record<string, unknown> = {
    generation: 2,
    requestHash: '0'.repeat(64),
    rootThread: 'other',
    actorThread: 'other',
    predecessor: null,
    requirementsRevision: 2,
    nonce: current.nonce,
    storeRevision: 0,
  };
  next[field] = changes[field];
  expect(() => ledger.admitPhase(next)).toThrow('h06-delegated-phase-binding');
});

it('rejects delivery target changes even when their native proof is valid', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input),
    ledger = openH06DelegatedPhaseLedger(claim.receipt);
  const current = phase(claim),
    intent = ledger.admitPhase(current);
  expect(() => ledger.settlePhase(settle(f, claim, current, intent, { storeRevision: 9 }))).toThrow(
    'h06-delegated-delivery-binding',
  );
  expect(ledger.inspect().status).toBe('UNKNOWN');
});

it('does not extend expired work and can still record a known result without admitting a new phase', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input),
    ledger = openH06DelegatedPhaseLedger(claim.receipt);
  const current = phase(claim),
    intent = ledger.admitPhase(current),
    outcome = settle(f, claim, current, intent);
  vi.spyOn(Date, 'now').mockReturnValue(claim.stopDeadlineMs + 1);
  const predecessor = ledger.settlePhase(outcome);
  expect(() => ledger.admitPhase(phase(claim, 'warm-pause', predecessor))).toThrow(
    'h06-delegated-work-expired',
  );
  expect(readH06DelegatedAuthority(claim.receipt).stopDeadlineMs).toBe(claim.stopDeadlineMs);
});

it('rechecks settled result pins and rejects unknown ledger files', () => {
  const f = fixture(),
    claim = consumeH06DelegatedAuthority(f.input),
    ledger = openH06DelegatedPhaseLedger(claim.receipt);
  const current = phase(claim),
    intent = ledger.admitPhase(current);
  ledger.settlePhase(settle(f, claim, current, intent));
  const resultPath = join(f.root, 'result-' + current.nonce + '.json'),
    before = readFileSync(resultPath);
  writeFileSync(resultPath, 'changed');
  expect(() => ledger.inspect()).toThrow();
  writeFileSync(resultPath, before);
  writeFileSync(join(claim.request.evidenceRoot, 'delegated-phases', 'unexpected.json'), '{}');
  expect(() => ledger.inspect()).toThrow('h06-delegated-phase-files');
});
