import { resolve, join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import type * as TransportModule from '../adapters/codex/appServerTransport.js';
import type { H01AttemptContext, H01NativeObserver } from './comparisonH01Contract.js';
import { h01ReadJson, h01Record } from './comparisonH01Contract.js';
import { createH03LegacyAdapter } from './comparisonH03Legacy.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import {
  h03Material,
  h03PreparedMetadata,
  h03Procedures,
  h03Scenario,
} from './comparisonH03Contract.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { object, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
const h03Boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  descendants: vi.fn(),
  alive: vi.fn(),
  terminate: vi.fn(),
  wait: vi.fn(),
  check: vi.fn(),
}));
vi.mock('../adapters/codex/appServerTransport.js', async (original) => ({
  ...(await original<typeof TransportModule>()),
  StdioAppServer: class {
    constructor(...args: unknown[]) {
      return h03Boundary.spawn(...args) as object;
    }
  },
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = h03Boundary.descendants;
    alive = h03Boundary.alive;
    terminate = h03Boundary.terminate;
    wait = h03Boundary.wait;
  },
}));
vi.mock('./comparisonH01.js', () => ({ checkNativeCase: h03Boundary.check }));
import { compactFixture } from './compactFixtures.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { compactContextLine } from '../adapters/project/compactContext.js';
import type { CompactContextPacket } from '../adapters/project/compactContext.js';

let f: Awaited<ReturnType<typeof compactFixture>>;
beforeEach(async () => {
  f = await compactFixture();
  f.run.spec.host_id = 'local';
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});

async function fixture(compacted = true, clientVersion = '0.163.0-alpha.11.2') {
  const anchor = {
    thread_id: 'session',
    turn_id: 'turn',
    host_id: 'local' as const,
    workspace: f.root,
  };
  const records: { type: string; payload: Record<string, unknown> }[] = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        session_id: 'session',
        cli_version: clientVersion,
        cwd: f.root,
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: f.root,
        model: f.run.spec.requested.model,
        effort: f.run.spec.requested.effort,
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  ];
  if (compacted) records.push({ type: 'compacted', payload: {} });
  const save = () =>
    f.file(
      'compact-native.jsonl',
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
  await save();
  const host = new FileCurrentChatHost(f.root, resolve(f.root, 'compact-native.jsonl'), anchor);
  const packet = async (): Promise<CompactContextPacket> => ({
    ...f.build(),
    boundary: (await host.compaction()) ?? f.proof,
  });
  host.compactContext = packet;
  const add = (text: string, patch: Record<string, unknown> = {}) => {
    const record = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'session',
        turn_id: 'turn',
        item: {
          type: 'CommandExecution',
          cwd: f.root,
          status: 'completed',
          exit_code: 0,
          aggregated_output: text,
          ...patch,
        },
      },
    };
    records.push(record);
    return record;
  };
  const full = (includeRules = true) =>
    add(
      [...f.loaded.procedures, ...(includeRules ? f.loaded.rules : [])]
        .map((entry) =>
          JSON.stringify({
            chat_read: 'marker',
            locator: entry.locator,
            hash: entry.hash,
            content: entry.content,
          }),
        )
        .join('\n'),
    );
  const rules = () =>
    add(
      f.loaded.rules
        .map((entry) =>
          JSON.stringify({
            chat_read: 'marker',
            locator: entry.locator,
            hash: entry.hash,
            content: entry.content,
          }),
        )
        .join('\n'),
    );
  return { host, packet, records, save, add, full, rules };
}

it.each(['0.163.0-alpha.11.2', '0.164.0-alpha.11.1'])(
  'requires observed current-turn compact text after the last compaction and keeps full rules for %s',
  async (clientVersion) => {
    const h = await fixture(true, clientVersion);
    h.records.push(
      { type: 'other', payload: {} },
      { type: 'event_msg', payload: { type: 'other' } },
    );
    h.add('not a packet', { type: 'Other' });
    h.add('', { aggregated_output: null });
    h.add('unrelated output');
    h.rules();
    const line = compactContextLine(await h.packet());
    h.add('{"chat_compact":"older","content":"truncated');
    h.add(JSON.stringify({ ...line, action: 'another-action' }));
    h.add(JSON.stringify({ ...line, payload_hash: 'c'.repeat(64) }));
    h.add(JSON.stringify(line));
    await h.save();
    const receipt = await h.host.load(f.run, 'marker');
    expect(receipt.compact).toMatchObject({
      owner: 'session',
      generation: 1,
      action: 'continue-chat',
    });
    expect(receipt.compact_fallback).toBeUndefined();
    expect(receipt.rules).toEqual(f.run.spec.rules);
    expect(receipt.procedures.map((p) => p.id)).toEqual(['bootstrap', 'task', 'evidence']);
    h.records.push({ type: 'compacted', payload: {} });
    await h.save();
    await expect(h.host.load(f.run, 'marker', true)).rejects.toThrow(
      'chat-compact-full-load-required:chat-compact-read-unconfirmed',
    );
  },
);

it.each([
  'missing-rule',
  'stale-source',
  'wrong-role',
  'wrong-owner',
  'wrong-generation',
  'new-revision',
  'duplicate',
  'failed-command',
  'no-rules',
  'foreign-thread',
  'foreign-turn',
  'foreign-workspace',
  'failed-status',
])('refuses %s until a complete valid LOAD is observed', async (kind) => {
  const h = await fixture();
  if (kind !== 'no-rules') h.rules();
  const packet = await h.packet();
  if (kind === 'missing-rule') packet.procedures[0]!.rules.pop();
  if (kind === 'stale-source')
    packet.procedures[0]!.source = { ...packet.procedures[0]!.source, hash: 'f'.repeat(64) };
  if (kind === 'wrong-role') packet.role = 'auditor';
  if (kind === 'wrong-owner') packet.owner = 'another';
  if (kind === 'wrong-generation') packet.generation++;
  if (kind === 'new-revision') f.context.messages!.requirements_revision++;
  const line = JSON.stringify(compactContextLine(packet));
  const row = h.add(
    line,
    kind === 'failed-command'
      ? { exit_code: 1 }
      : kind === 'foreign-workspace'
        ? { cwd: '/other' }
        : kind === 'failed-status'
          ? { status: 'failed' }
          : {},
  );
  if (kind === 'foreign-thread') row.payload.thread_id = 'other';
  if (kind === 'foreign-turn') row.payload.turn_id = 'other';
  if (kind === 'duplicate') h.add(line);
  await h.save();
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-full-load-required:');
  h.full(kind === 'no-rules');
  await h.save();
  const recovered = await h.host.load(f.run, 'marker');
  if (kind === 'no-rules') expect(recovered.compact).toBeDefined();
  else {
    expect(recovered.compact).toBeUndefined();
    expect(recovered.compact_fallback).toBeDefined();
  }
});

it('requires a new packet for a new action rather than reusing an old compact receipt', async () => {
  const h = await fixture();
  h.rules();
  h.add(JSON.stringify(compactContextLine(await h.packet())));
  await h.save();
  const initial = await h.host.load(f.run, 'marker');
  f.run.loaded = initial;
  h.host.compactContext = async () => ({
    ...(await h.packet()),
    action: 'check-chat',
    payload_hash: 'b'.repeat(64),
  });
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-read-unconfirmed');
  h.add(JSON.stringify(compactContextLine(await h.host.compactContext(f.run, 'marker'))));
  await h.save();
  expect((await h.host.load(f.run, 'marker')).compact!.action).toBe('check-chat');
});

it('accepts a fresh state after unknown reconciliation without reusing the older packet', async () => {
  const h = await fixture();
  f.effects.push({ id: 'send', intent: {}, outcome: 'unknown', receipt: null });
  h.rules();
  h.add(JSON.stringify(compactContextLine(await h.packet())));
  await h.save();
  const old = await h.host.load(f.run, 'marker');
  f.effects[0]!.outcome = 'confirmed';
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-read-unconfirmed');
  const line = JSON.stringify(compactContextLine(await h.packet()));
  h.add(line);
  await h.save();
  const current = await h.host.load(f.run, 'marker');
  expect(current.compact!.state_hash).not.toBe(old.compact!.state_hash);
  expect(current.compact!.payload_hash).toBe(old.compact!.payload_hash);
  expect(current.compact_fallback).toBeUndefined();
  h.add(line);
  await h.save();
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-read-duplicate');
});

it('keeps old full LOAD before compaction and refuses source changes or an old boundary', async () => {
  const h = await fixture(false);
  h.full();
  await h.save();
  expect((await h.host.load(f.run, 'marker')).compact).toBeUndefined();
  const old = await h.packet();
  h.records.push({ type: 'compacted', payload: {} });
  h.rules();
  h.add(JSON.stringify(compactContextLine(old)));
  h.host.compactContext = async () => old;
  await h.save();
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-boundary-unconfirmed');
  const current = await h.packet();
  h.host.compactContext = async () => current;
  await f.file(current.procedures[0]!.source.locator, 'changed bytes');
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-source-stale');
});

it('preserves missing state and uncertain failures as full recovery reasons', async () => {
  const h = await fixture();
  delete h.host.compactContext;
  h.full();
  await h.save();
  expect((await h.host.load(f.run, 'marker')).compact_fallback).toBe(
    'chat-compact-state-unavailable',
  );
  h.host.compactContext = () => Promise.reject('unknown');
  expect((await h.host.load(f.run, 'marker')).compact_fallback).toBe(
    'chat-compact-outcome-unknown',
  );
});

it('refuses a compaction receipt lost during packet materialization', async () => {
  const h = await fixture();
  h.rules();
  await h.save();
  const packet = await h.packet();
  h.host.compactContext = async () => {
    h.records.splice(
      h.records.findIndex((record) => record.type === 'compacted'),
      1,
    );
    await h.save();
    return packet;
  };
  await expect(h.host.load(f.run, 'marker')).rejects.toThrow('chat-compact-boundary-unconfirmed');
});

function h03NativeFixture() {
  const root = join(f.root, 'h03-native'),
    put = (path: string, bytes: string): InputRef => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 });
      return { locator: path, hash: digest(bytes) };
    };
  const roots = {
    workspaceRoot: join(root, 'writer/workspace'),
    evidenceRoot: join(root, 'evidence'),
    stateRoot: join(root, 'state'),
    hostRoot: join(root, 'host'),
    artifactRoot: join(root, 'artifacts'),
  };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const rules = 'H03 unit rules: preserve F-01 and pending. No blind retry.\n',
    executor = 'H03 unit read-only executor.\n';
  const rulesPin = put(join(root, 'rules.md'), rules),
    executorPin = put(join(root, 'executor.md'), executor);
  for (const [name, bytes] of Object.entries({
    ...h03Material.files,
    ...h03PreparedMetadata(rules, executor),
  }))
    put(join(roots.workspaceRoot, name), bytes);
  const runtime = join(root, 'runtime'),
    descriptor = put(
      join(runtime, 'project/workflow.json'),
      readFileSync(new URL('../project/workflow.json', import.meta.url), 'utf8'),
    );
  const procedures = h03Procedures.map((id) =>
    f.loaded.procedures.find((procedure) => procedure.id === id)!,
  );
  const pins = procedures.map((procedure) => {
    put(join(roots.workspaceRoot, procedure.locator), procedure.content);
    return put(join(runtime, procedure.locator), procedure.content);
  });
  const controller = new AbortController();
  const observer: H01NativeObserver = {
    controlRef: rulesPin,
    verify: vi.fn(async () => {}),
    beforeModelStart: vi.fn(async () => {}),
    confirmModelStart: vi.fn(),
    confirmCompaction: vi.fn(),
    registerCreation: vi.fn(),
    registerCapabilities: vi.fn(),
    registerParticipant: vi.fn(),
    observeParticipant: vi.fn(),
    completeParticipant: vi.fn(),
    accounting: vi.fn(() => ({
      participants: [],
      receipts: [],
      reservedManagedStarts: null,
      observedResponses: null,
      inputUncached: null,
      inputCached: null,
      output: null,
      unknown: false,
      evidence: [],
    })),
  };
  const end = String(process.hrtime.bigint() + 15_000_000_000n),
    ctx = {
      opId: 'h03-native-unit',
      requestHash: digest('h03-request'),
      variant: 'baseline',
      roots,
      identity: { taskId: 'h03-unit-task', owner: 'unit-owner', generation: 1 },
      profile: { model: 'unit-model', effort: 'high', clientVersion: '0.165.0-alpha.1.2' },
      rules: rulesPin,
      executor: executorPin,
      reviewer: executorPin,
      binary: put(join(root, 'binary'), 'never executed'),
      criteria: { ref: rulesPin, value: h03Scenario },
      material: { ref: rulesPin, value: h03Material },
      runtime: { engine: 'legacy', root: runtime, files: [descriptor, ...pins] },
      verifiedAuthorization: rulesPin,
      deadlineNs: end,
      workDeadlineNs: end,
      signal: controller.signal,
      nativeObserver: observer,
      budget: {
        maxMs: 15000,
        reserveMs: 1000,
        maxManagedStarts: 6,
        maxInputUncached: 100000,
        maxOutput: 100000,
      },
    } as unknown as H01AttemptContext;
  const transcript = join(root, 'native.jsonl'),
    session = 'h03-reader',
    records: { type: string; payload: Record<string, unknown> }[] = [
      {
        type: 'session_meta',
        payload: {
          id: session,
          session_id: session,
          cli_version: ctx.profile.clientVersion,
          cwd: roots.workspaceRoot,
          source: 'cli',
        },
      },
    ];
  const write = () =>
    put(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  write();
  let total = 0,
    live = true,
    compactCount = 0;
  const listeners = new Set<(value: Record<string, unknown>) => void>(),
    thread = {
      id: session,
      cwd: roots.workspaceRoot,
      path: transcript,
      projectId: null,
      parentThreadId: null,
      forkedFromId: null,
      turns: [] as Record<string, unknown>[],
    };
  const options = {
    lostAck: false,
    missingCost: false,
    lateCost: false,
    partialCost: false,
    costMutation: false,
    unsupported: false,
    requestError: false,
    delayedLoadCost: false,
    badProbe: false,
    abortAt: '',
    tamperContextAt: '',
  };
  const nativeUsage = (turn: string) => {
    total++;
    records.push({
      type: 'token_usage_record',
      payload: {
        thread_id: session,
        session_id: session,
        turn_id: turn,
        response_id: 'native-unit-response-' + String(total),
        usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 },
        thread_token_usage: {
          input_tokens: total * 2,
          cached_input_tokens: 0,
          output_tokens: total,
        },
      },
    });
  };
  const refs = (ids: readonly string[]) => [
    ...ids.map((id) => `procedures/${id}.md`),
    '.h03/rules.md',
    '.h03/executor.md',
    'evidence/initial-context.json',
  ];
  const readLines = (marker: string, paths: string[]) =>
    paths
      .map((locator) => {
        const content = readFileSync(join(roots.workspaceRoot, locator), 'utf8');
        return JSON.stringify({ chat_read: marker, locator, hash: digest(content), content });
      })
      .join('\n');
  const response = () => ({
    cwd: roots.workspaceRoot,
    model: ctx.profile.model,
    reasoningEffort: ctx.profile.effort,
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: structuredClone(thread),
  });
  const raw = {
    pid: 72001,
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    observe: vi.fn((listener: (value: Record<string, unknown>) => void) => {
      if (compactCount > 0 && listeners.size === 0) {
        if (options.partialCost) appendFileSync(transcript, '{"partial":');
        if (options.costMutation) ctx.requestHash = digest('changed-during-cost-wait');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    completed: vi.fn(
      async (_id: string, _turn: string, _signal?: AbortSignal, verify?: () => Promise<void>) => {
        await verify?.();
      },
    ),
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'model/list')
        return {
          data: [
            {
              model: ctx.profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: ctx.profile.effort }],
            },
          ],
        };
      if (method === 'mcpServerStatus/list') return { data: [] };
      if (method === 'thread/start' || method === 'thread/resume') return response();
      if (method === 'thread/read') return { thread: structuredClone(thread) };
      if (method === 'thread/loaded/list') return { data: [session], nextCursor: null };
      if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
      if (method === 'thread/compact/start') {
        compactCount++;
        if (options.requestError) throw new Error('native-request-lost');
        if (options.unsupported)
          throw new Error('app-server-error:{"code":-32601,"message":"method unavailable"}');
        if (!options.missingCost && !options.lateCost) nativeUsage('compaction');
        records.push({ type: 'compacted', payload: {} });
        write();
        for (const listener of listeners)
          listener({
            method: 'item/completed',
            params: {
              threadId: session,
              turnId: 'compact',
              item: { type: 'contextCompaction', id: 'compact-item' },
            },
          });
        if (options.lateCost)
          setTimeout(() => {
            nativeUsage('compaction');
            write();
            for (const listener of listeners) listener({ method: 'usage/available' });
          }, 20);
        if (options.abortAt === 'compact') controller.abort();
        if (options.lostAck) return new Promise(() => {});
        return {};
      }
      if (method === 'turn/start') {
        const text = textField(object((params.input as unknown[])[0]).text),
          turn = 'turn-' + String(thread.turns.length + 1);
        records.push({
          type: 'turn_context',
          payload: {
            turn_id: turn,
            cwd: roots.workspaceRoot,
            model: ctx.profile.model,
            effort: ctx.profile.effort,
            approval_policy: 'never',
            sandbox_policy: { type: 'read-only', network_access: false },
            permission_profile: { type: 'disabled' },
          },
        });
        records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
        const outputs: string[] = [];
        if (text.includes(':initial')) {
          outputs.push(readLines('h03-initial', refs(['bootstrap', 'task', 'evidence'])));
          const match = text.match(/Прочитай также текущий checkpoint (\{[^\n]+?\})\./u)!;
          const pin = JSON.parse(match[1]!) as InputRef,
            content = readFileSync(pin.locator, 'utf8');
          outputs.push(JSON.stringify({ path: pin.locator, sha256: pin.hash, content }));
        } else if (text.includes(':probes')) {
          const views = readdirSync(roots.evidenceRoot)
            .filter((name) => name.startsWith('h03-legacy-probe-input-'))
            .map((name) =>
              object(JSON.parse(readFileSync(join(roots.evidenceRoot, name), 'utf8'))),
            );
          for (const view of views) {
            const marker = 'h03-' + textField(view.probe);
            outputs.push(readLines(marker, refs([])));
            if (!options.badProbe) outputs.push(textField(view.line));
          }
        } else if (text.includes(':recovery'))
          outputs.push(readLines('h03-recovery', refs(h03Procedures)));
        else outputs.push('unit turn');
        const items = outputs.map((output) => ({
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: output,
        }));
        for (const output of outputs)
          records.push({
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              thread_id: session,
              turn_id: turn,
              item: {
                type: 'CommandExecution',
                cwd: roots.workspaceRoot,
                exit_code: 0,
                status: 'completed',
                aggregated_output: output,
              },
            },
          });
        if (!options.delayedLoadCost) nativeUsage(turn);
        records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
        write();
        thread.turns.push({ id: turn, status: 'completed', items });
        if (options.tamperContextAt === turn)
          appendFileSync(join(roots.workspaceRoot, 'evidence/initial-context.json'), '\n');
        if (options.abortAt === turn) controller.abort();
        return { turn: { id: turn } };
      }
      return {};
    }),
  };
  const identity: ProcessIdentity = {
    pid: raw.pid,
    parent: process.pid,
    started: 'h03-unit-process-start',
  };
  h03Boundary.spawn.mockReset().mockReturnValue(raw);
  h03Boundary.descendants.mockReset().mockImplementation(async () => (live ? [identity] : []));
  h03Boundary.alive
    .mockReset()
    .mockImplementation(async (ids: ProcessIdentity[]) => (live ? ids : []));
  h03Boundary.terminate.mockReset().mockImplementation(async (ids: ProcessIdentity[]) => {
    if (ids.some((id) => id.pid === identity.pid)) live = false;
    return ids;
  });
  h03Boundary.wait.mockReset().mockResolvedValue(undefined);
  h03Boundary.check.mockReset().mockImplementation(async () => ({
    known: true,
    passed: false,
    failed: true,
    evidence: h01Record(roots.evidenceRoot, 'unit-initial-check', {
      kind: 'unit-checker-fixture',
      passed: false,
      known: true,
    }),
  }));
  const start = () => ({
    cwd: roots.workspaceRoot,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    model: ctx.profile.model,
    config: { model_reasoning_effort: ctx.profile.effort },
  });
  return {
    ctx,
    options,
    observer,
    raw,
    thread,
    controller,
    transcript,
    records,
    write,
    start,
    compactCount: () => compactCount,
    finishLoadCost: () => {
      nativeUsage('turn-1');
      write();
    },
  };
}

it('observes H04 primary notifications without mutating the transport message or granting compaction', async () => {
  const unit = h03NativeFixture();
  unit.ctx.criteria = { ...unit.ctx.criteria, value: { ...unit.ctx.criteria.value, id: 'H-04' } };
  const observe = vi.fn((message: Record<string, unknown>) => {
    object(message.params).changed = true;
  });
  const port = createH02NativeRpc(unit.ctx, 'h04-waiter', { stage: 'execution', observe });
  await port.rpc.request('thread/start', unit.start());
  const primary = { method: 'item/started', params: { item: { type: 'commandExecution' } } };
  unit.raw.observe.mock.calls[0]![0](primary);
  expect(observe).toHaveBeenCalledOnce();
  expect(primary).toEqual({
    method: 'item/started',
    params: { item: { type: 'commandExecution' } },
  });
  expect(object(observe.mock.calls[0]![0].params).changed).toBe(true);
  const host = new FileCurrentChatHost(unit.ctx.roots.workspaceRoot, unit.transcript, {
    thread_id: 'h03-reader',
    turn_id: 'unused',
    workspace: unit.ctx.roots.workspaceRoot,
    host_id: 'local',
  });
  await expect(port.compact!(host)).rejects.toThrow('h03-native-compaction-context');
  expect(unit.compactCount()).toBe(0);
  expect(object(h01ReadJson(await port.stop()))).toMatchObject({
    kind: 'comparison-h04-stop',
    confirmed: true,
  });
});

async function h05RecoveryFixture(withPathObservation = false) {
  const unit = h03NativeFixture();
  unit.ctx.criteria = { ...unit.ctx.criteria, value: { ...unit.ctx.criteria.value, id: 'H-05' } };
  unit.observer.assertRecoveryParticipant = vi.fn();
  const first = createH02NativeRpc(unit.ctx, 'h05-first', { stage: 'execution' });
  await first.rpc.request('thread/start', unit.start());
  await first.rpc.request('turn/start', {
    threadId: unit.thread.id,
    input: [{ type: 'text', text: 'H05 known native turn' }],
  });
  if (withPathObservation)
    await first.rpc.request('thread/read', { threadId: unit.thread.id, includeTurns: true });
  const detached = await first.detachForRecovery!();
  let live = true;
  const nextRaw = { ...unit.raw, pid: 72002 },
    nextIdentity = { pid: 72002, parent: process.pid, started: 'h05-second-process' };
  h03Boundary.spawn.mockReturnValue(nextRaw);
  h03Boundary.descendants.mockImplementation(async () => (live ? [nextIdentity] : []));
  h03Boundary.alive.mockImplementation(async (ids: ProcessIdentity[]) =>
    live ? ids.filter((id) => id.pid === nextIdentity.pid) : [],
  );
  h03Boundary.terminate.mockImplementation(async (ids: ProcessIdentity[]) => {
    if (ids.some((id) => id.pid === nextIdentity.pid)) live = false;
    return ids;
  });
  return { ...unit, first, detached, nextRaw };
}

it('refuses a second H05 native turn before another reservation or send', async () => {
  const unit = h03NativeFixture();
  unit.ctx.criteria = { ...unit.ctx.criteria, value: { ...unit.ctx.criteria.value, id: 'H-05' } };
  const port = createH02NativeRpc(unit.ctx, 'h05-once', { stage: 'execution' });
  await port.rpc.request('thread/start', unit.start());
  const request = { threadId: unit.thread.id, input: [{ type: 'text', text: 'one turn' }] };
  await port.rpc.request('turn/start', request);
  await expect(port.rpc.request('turn/start', request)).rejects.toThrow('h05-one-native-turn');
  expect(unit.observer.beforeModelStart).toHaveBeenCalledOnce();
  expect(unit.thread.turns).toHaveLength(1);
  await port.stop();
});

it.each(['scenario', 'fresh', 'no-turn', 'already-stopped', 'no-guard', 'unconfirmed', 'partial'])(
  'refuses H05 detach with %s without creating a recovery binding',
  async (mode) => {
    const unit = h03NativeFixture();
    if (mode !== 'scenario')
      unit.ctx.criteria = {
        ...unit.ctx.criteria,
        value: { ...unit.ctx.criteria.value, id: 'H-05' },
      };
    unit.observer.assertRecoveryParticipant = vi.fn();
    const port = createH02NativeRpc(unit.ctx, 'h05-detach-refused', { stage: 'execution' });
    if (!['scenario', 'fresh'].includes(mode)) {
      await port.rpc.request('thread/start', unit.start());
      if (mode !== 'no-turn')
        await port.rpc.request('turn/start', {
          threadId: unit.thread.id,
          input: [{ type: 'text', text: 'known turn' }],
        });
    }
    if (mode === 'already-stopped') await port.stop();
    if (mode === 'no-guard') delete unit.observer.assertRecoveryParticipant;
    if (mode === 'unconfirmed') h03Boundary.descendants.mockResolvedValue([]);
    if (mode === 'partial')
      writeFileSync(unit.transcript, readFileSync(unit.transcript, 'utf8').trimEnd());
    await expect(port.detachForRecovery!()).rejects.toThrow(
      mode === 'already-stopped'
        ? 'h02-native-rpc-frozen'
        : mode === 'no-guard'
          ? 'h05-recovery-guard-required'
          : mode === 'unconfirmed'
            ? 'h05-detach-unconfirmed'
            : mode === 'partial'
              ? 'h05-detach-prefix'
              : 'h05-detach-context',
    );
    expect(
      port.evidence.some(
        (ref) => object(h01ReadJson(ref)).kind === 'comparison-h05-recovery-binding',
      ),
    ).toBe(false);
    await port.stop();
  },
);

it.each([false, true])(
  'physically restarts H05 with path observation %s and seals one participant after both STOP receipts',
  async (withPathObservation) => {
    const unit = await h05RecoveryFixture(withPathObservation);
    expect(unit.observer.completeParticipant).not.toHaveBeenCalled();
    expect(h03Boundary.spawn.mock.calls[0]![5]).toMatch(/primary\.jsonl$/u);
    const resumed = createH02NativeRpc(unit.ctx, 'h05-second', {
      stage: 'execution',
      resume: unit.detached,
    });
    await resumed.rpc.request('thread/resume', { ...unit.start(), threadId: unit.thread.id });
    await resumed.rpc.request('thread/read', { threadId: unit.thread.id, includeTurns: true });
    await resumed.rpc.completed(unit.thread.id, 'turn-1');
    const stop = object(h01ReadJson(await resumed.stop()));
    expect(stop).toMatchObject({ kind: 'comparison-h05-stop', confirmed: true });
    expect(unit.observer.registerCreation).toHaveBeenCalledOnce();
    expect(unit.observer.beforeModelStart).toHaveBeenCalledOnce();
    expect(unit.observer.completeParticipant).toHaveBeenCalledOnce();
    const completion = vi.mocked(unit.observer.completeParticipant).mock.calls[0]![1];
    expect(completion.evidence).toContainEqual(unit.detached);
    expect(completion.evidence).toContainEqual(object(h01ReadJson(unit.detached)).stop);
    expect(unit.thread.turns).toHaveLength(1);
  },
);

it.each(['thread/start', 'turn/start', 'thread/compact/start', 'thread/read'])(
  'refuses H05 recovered %s before spawning or issuing another native turn',
  async (method) => {
    const unit = await h05RecoveryFixture();
    const resumed = createH02NativeRpc(unit.ctx, 'h05-refused', {
      stage: 'execution',
      resume: unit.detached,
    });
    await expect(resumed.rpc.request(method, { threadId: unit.thread.id })).rejects.toThrow(
      method === 'thread/read' ? 'h05-recovery-resume-required' : 'h05-recovery-read-only',
    );
    expect(h03Boundary.spawn).toHaveBeenCalledOnce();
    expect(unit.thread.turns).toHaveLength(1);
    expect(unit.observer.completeParticipant).not.toHaveBeenCalled();
  },
);

it.each(['binding', 'stop', 'process-stop', 'prefix', 'guard-missing', 'guard-unknown', 'live'])(
  'refuses H05 recovery %s before a second native environment',
  async (mode) => {
    const unit = await h05RecoveryFixture();
    const saved = object(h01ReadJson(unit.detached));
    let resume = unit.detached;
    if (mode === 'binding') saved.requestHash = digest('foreign-request');
    if (mode === 'stop' || mode === 'process-stop') {
      const stopped = object(h01ReadJson(saved.stop as InputRef));
      if (mode === 'stop') stopped.confirmed = false;
      else stopped.evidence = [];
      saved.stop = h01Record(unit.ctx.roots.evidenceRoot, 'changed-stop', stopped);
    }
    if (['binding', 'stop', 'process-stop'].includes(mode))
      resume = h01Record(unit.ctx.roots.evidenceRoot, 'changed-recovery', saved);
    if (mode === 'prefix') appendFileSync(unit.transcript, '\n');
    if (mode === 'guard-missing') delete unit.observer.assertRecoveryParticipant;
    if (mode === 'guard-unknown')
      vi.mocked(unit.observer.assertRecoveryParticipant!).mockImplementation(() => {
        throw new Error('h05-recovery-participant-sealed');
      });
    if (mode === 'live') {
      const resumed = createH02NativeRpc(unit.ctx, 'h05-live', { stage: 'execution', resume });
      h03Boundary.alive.mockImplementation(async (ids: ProcessIdentity[]) => ids);
      await expect(
        resumed.rpc.request('thread/resume', {
          ...unit.start(),
          threadId: unit.thread.id,
        }),
      ).rejects.toThrow('h05-recovery-process-live');
    } else
      expect(() =>
        createH02NativeRpc(unit.ctx, 'h05-bad', {
          stage: 'execution',
          resume,
        }),
      ).toThrow();
    expect(h03Boundary.spawn).toHaveBeenCalledOnce();
    expect(unit.observer.completeParticipant).not.toHaveBeenCalled();
  },
);

it('runs H03 Legacy through real LOAD, compaction boundary, refused compact inputs and unchanged SQLite FAIL/pending', async () => {
  const unit = h03NativeFixture(),
    result = await createH03LegacyAdapter().execute(unit.ctx);
  const projection = object(h01ReadJson(result.projection)),
    report = object(h01ReadJson(projection.caseReport as InputRef));
  expect(result.outcome).toBe('completed');
  expect(report).toMatchObject({
    outcome: 'accepted',
    session: 'h03-reader',
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  });
  expect(Object.values(object(report.checks)).every(Boolean)).toBe(true);
  expect(unit.compactCount()).toBe(1);
  expect(unit.observer.beforeModelStart).toHaveBeenCalledTimes(4);
  expect(unit.observer.confirmCompaction).toHaveBeenCalledOnce();
  const starts = vi.mocked(unit.observer.beforeModelStart).mock.calls.map(([start]) => start);
  expect(starts.filter((start) => start.method === 'thread/compact/start')).toHaveLength(1);
  expect(starts.every((start) => start.stage === 'execution')).toBe(true);
  expect(result.nativeAcceptance).toEqual(object(report.recovered).load);
  const context = object(h01ReadJson(report.context as InputRef));
  expect(context).toMatchObject({
    kind: 'comparison-h03-context',
    opId: unit.ctx.opId,
    requestHash: unit.ctx.requestHash,
    failure: { id: 'F-01' },
  });
  for (const ref of [object(report.initial).load, object(report.recovered).load]) {
    const primary = object(h01ReadJson(ref as InputRef));
    expect(object(primary.receipt).rules).toContainEqual({
      locator: 'evidence/initial-context.json',
      hash: (report.context as InputRef).hash,
    });
  }
  const before = object(h01ReadJson(object(report.retained).before as InputRef)),
    after = object(h01ReadJson(object(report.retained).after as InputRef));
  expect(after.effects).toEqual(before.effects);
  expect(after.failure).toEqual(before.failure);
  expect(object(object(after.failure).body).result).toBe('FAIL');
  expect(
    readFileSync(join(unit.ctx.roots.workspaceRoot, 'evidence/manifest.json'), 'utf8'),
  ).toContain('F-01');
  expect(h01ReadJson(result.stop)).toMatchObject({ kind: 'comparison-h03-stop', confirmed: true });
  for (const probe of Object.values(object(report.probes))) {
    expect(probe).toMatchObject({ refused: true });
    const observed = object(h01ReadJson(object(probe).observed as InputRef));
    expect(observed.error).toMatch(/^chat-compact-full-load-required:/u);
  }
}, 30_000);

it.each([
  'normal',
  'lost-ack',
  'late-cost',
  'partial-cost',
  'slow-cost',
  'temporal-credit',
] as const)(
  'reserves and confirms H03 compaction once with %s and primary cost in the same session',
  async (mode) => {
    const unit = h03NativeFixture();
    unit.options.lostAck = mode === 'lost-ack';
    unit.options.lateCost = ['late-cost', 'partial-cost', 'slow-cost'].includes(mode);
    unit.options.partialCost = mode === 'partial-cost';
    if (mode === 'slow-cost') {
      let count = 0;
      vi.mocked(unit.observer.verify).mockImplementation(async () => {
        if (unit.compactCount() > 0 && ++count === 2)
          await new Promise((resolve) => setTimeout(resolve, 70));
      });
    }
    const port = createH02NativeRpc(unit.ctx, 'compaction', {
      stage: 'execution',
      ...(mode !== 'temporal-credit'
        ? {}
        : {
            startForTurn: async (params: Record<string, unknown>) => ({
              origin: 'temporal-host' as const,
              key: digest('credit'),
              hash: digest(JSON.stringify(params)),
              stage: 'execution' as const,
              session: textField(params.threadId),
            }),
          }),
    });
    await port.rpc.request('thread/start', unit.start());
    await port.rpc.request('turn/start', {
      threadId: 'h03-reader',
      input: [{ type: 'text', text: 'Unit native LOAD preparation' }],
    });
    const host = new FileCurrentChatHost(unit.ctx.roots.workspaceRoot, unit.transcript, {
      thread_id: 'h03-reader',
      turn_id: 'unused',
      workspace: unit.ctx.roots.workspaceRoot,
      host_id: 'local',
    });
    const operation = port.compact!(host);
    expect(port.compact!(host)).toBe(operation);
    const boundary = await operation;
    expect(unit.compactCount()).toBe(1);
    expect(
      vi
        .mocked(unit.observer.beforeModelStart)
        .mock.calls.filter(([start]) => start.method === 'thread/compact/start'),
    ).toEqual([
      [
        expect.objectContaining({
          method: 'thread/compact/start',
          stage: 'execution',
          origin: 'legacy',
        }),
      ],
    ]);
    expect(unit.observer.confirmCompaction).toHaveBeenCalledOnce();
    const proof = object(h01ReadJson(port.compactionEvidence!));
    expect(proof).toMatchObject({
      kind: 'comparison-native-compaction',
      scenario: 'H-03',
      session: 'h03-reader',
      boundary,
    });
    expect(proof.usage).toHaveLength(1);
    const start = vi.mocked(unit.observer.beforeModelStart).mock.calls.at(-1)![0],
      intent = object(h01ReadJson(proof.request as InputRef));
    expect(intent).toMatchObject({
      kind: 'comparison-native-compaction-dispatch',
      start,
      params: { threadId: 'h03-reader' },
    });
    expect(unit.observer.confirmCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        before: proof.before,
        boundary,
        through: proof.through,
        evidence: proof.request,
      }),
    );
    expect(h01ReadJson(await port.stop())).toMatchObject({
      kind: 'comparison-h03-stop',
      confirmed: true,
    });
  },
  30_000,
);

it.each([
  'missing-cost',
  'partial',
  'reservation',
  'confirmation',
  'cancel',
  'cost-mutation',
  'request-error',
] as const)(
  'retains UNKNOWN without retrying H03 compaction after %s',
  async (mode) => {
    const unit = h03NativeFixture();
    if (mode === 'missing-cost') {
      unit.options.missingCost = true;
      unit.ctx.workDeadlineNs = String(process.hrtime.bigint() + 600_000_000n);
    }
    if (mode === 'cancel') unit.options.abortAt = 'compact';
    if (mode === 'cost-mutation') unit.options.costMutation = true;
    if (mode === 'request-error') unit.options.requestError = true;

    if (mode === 'confirmation')
      vi.mocked(unit.observer.confirmCompaction!).mockImplementationOnce(() => {
        throw new Error('primary-cost-unknown');
      });
    const port = createH02NativeRpc(unit.ctx, 'compaction', { stage: 'execution' });
    await port.rpc.request('thread/start', unit.start());
    await port.rpc.request('turn/start', {
      threadId: 'h03-reader',
      input: [{ type: 'text', text: 'Unit native LOAD preparation' }],
    });
    if (mode === 'reservation')
      vi.mocked(unit.observer.beforeModelStart).mockRejectedValueOnce(new Error('no-budget'));
    if (mode === 'partial') appendFileSync(unit.transcript, '{"unfinished":');
    const host = new FileCurrentChatHost(unit.ctx.roots.workspaceRoot, unit.transcript, {
      thread_id: 'h03-reader',
      turn_id: 'unused',
      workspace: unit.ctx.roots.workspaceRoot,
      host_id: 'local',
    });
    const operation = port.compact!(host);
    await expect(operation).rejects.toThrow();
    expect(port.compact!(host)).toBe(operation);
    expect(unit.compactCount()).toBe(['partial', 'reservation'].includes(mode) ? 0 : 1);
    if (mode === 'missing-cost') expect(unit.observer.confirmCompaction).not.toHaveBeenCalled();
    await port.stop();
    expect(unit.raw.close).toHaveBeenCalledOnce();
    expect(port.compactionEvidence).toBeNull();
  },
  30_000,
);

it.each([
  'metadata',
  'descriptor',
  'procedure',
  'initial-pass',
  'initial-unknown',
  'bad-probe',
  'abort-preparation',
  'abort-probes',
  'abort-recovery',
  'accounting',
  'cleanup-abort',
  'unsupported',
  'non-error-probe',
  'context-tamper',
  'context-after-stop',
] as const)(
  'keeps H03 Legacy non-accepted at %s and preserves the available STOP',
  async (mode) => {
    const unit = h03NativeFixture();
    if (mode === 'metadata')
      writeFileSync(join(unit.ctx.roots.workspaceRoot, '.h03/rules.md'), 'changed');
    if (mode === 'descriptor') unit.ctx.runtime.files = [];
    if (mode === 'procedure') unit.ctx.runtime.files.splice(1, 1);
    if (mode === 'initial-pass')
      h03Boundary.check.mockImplementationOnce(async () => ({
        passed: true,
        known: true,
        evidence: unit.ctx.rules,
      }));
    if (mode === 'initial-unknown')
      h03Boundary.check.mockImplementationOnce(async () => ({
        passed: false,
        known: false,
        evidence: unit.ctx.rules,
      }));
    if (mode === 'bad-probe') unit.options.badProbe = true;
    if (mode === 'non-error-probe') {
      const load = FileCurrentChatHost.prototype.load;
      vi.spyOn(FileCurrentChatHost.prototype, 'load').mockImplementation(async function (
        this: FileCurrentChatHost,
        run,
        marker,
        reuse,
      ) {
        if (marker === 'h03-missing-rule') throw 'non-error owner failure';
        return load.call(this, run, marker, reuse);
      });
    }
    if (mode === 'unsupported') unit.options.unsupported = true;
    if (mode === 'context-tamper') unit.options.tamperContextAt = 'turn-2';
    if (mode === 'context-after-stop')
      unit.raw.close.mockImplementationOnce(() => {
        appendFileSync(join(unit.ctx.roots.workspaceRoot, 'evidence/initial-context.json'), '\n');
      });
    if (mode === 'abort-preparation') unit.options.abortAt = 'turn-1';
    if (mode === 'abort-probes') unit.options.abortAt = 'turn-2';
    if (mode === 'abort-recovery') unit.options.abortAt = 'turn-3';
    if (mode === 'accounting')
      vi.mocked(unit.observer.accounting).mockReturnValue({
        ...unit.observer.accounting(),
        unknown: true,
      });
    if (mode === 'cleanup-abort')
      unit.raw.close.mockImplementationOnce(() => unit.controller.abort());
    const result = await createH03LegacyAdapter().execute(unit.ctx),
      report = object(h01ReadJson(object(h01ReadJson(result.projection)).caseReport as InputRef));
    expect(result.outcome).toBe(
      ['bad-probe', 'non-error-probe'].includes(mode) ? 'failed' : 'unknown',
    );
    expect(report).toMatchObject({
      ...(mode === 'unsupported' ? { outcome: 'not-run' } : {}),
      nativeAcceptance: false,
      qualification: false,
      partialScope: true,
    });
    expect(h01ReadJson(result.stop)).toHaveProperty('kind', 'comparison-h03-stop');
    if (['metadata', 'descriptor', 'procedure', 'initial-pass', 'initial-unknown'].includes(mode))
      expect(h03Boundary.spawn).not.toHaveBeenCalled();
    if (['abort-probes', 'abort-recovery', 'accounting', 'cleanup-abort'].includes(mode))
      expect(object(report.retained).pending).not.toBeNull();
  },
  30_000,
);

it('refuses compaction before reserving when the predecessor LOAD cost arrives after its terminal', async () => {
  const unit = h03NativeFixture();
  unit.options.delayedLoadCost = true;
  const port = createH02NativeRpc(unit.ctx, 'predecessor-cost', { stage: 'execution' });
  await port.rpc.request('thread/start', unit.start());
  await port.rpc.request('turn/start', {
    threadId: 'h03-reader',
    input: [{ type: 'text', text: 'Unit native LOAD preparation' }],
  });
  const host = new FileCurrentChatHost(unit.ctx.roots.workspaceRoot, unit.transcript, {
    thread_id: 'h03-reader',
    turn_id: 'turn-1',
    workspace: unit.ctx.roots.workspaceRoot,
    host_id: 'local',
  });
  const pending = port.compact!(host);
  await expect(pending).rejects.toThrow();
  expect(unit.compactCount()).toBe(0);
  expect(
    vi
      .mocked(unit.observer.beforeModelStart)
      .mock.calls.filter(([start]) => start.method === 'thread/compact/start'),
  ).toEqual([]);
  unit.finishLoadCost();
  expect(port.compact!(host)).toBe(pending);
  expect(unit.compactCount()).toBe(0);
  expect(port.compactionEvidence).toBeNull();
  await port.stop();
}, 30_000);
