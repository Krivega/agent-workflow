import { execFileSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs';
import type * as NativeAttempt from './comparisonH06NativeAttempt.js';
import type * as ReferenceAuthority from './td054DeadlineReference.mjs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { object } from '../src/contracts/project.js';
import {
  prepareTD054DeadlineProbe,
  runTD054DeadlineProbe,
  checkTD054LiveResult,
  readTD054Claim,
  readTD054SavedClaim,
  td054ReferenceSource,
  observeTD054Processes,
} from './td054DeadlineProbe.mjs';

const mock = vi.hoisted(() => ({
  grant: vi.fn(),
  history: vi.fn(),
  setup: vi.fn(),
  stage: vi.fn(),
  pause: vi.fn(),
  missing: false,
  quietRemainingMs: null as number | null,
  psCost: 0,
  portCost: 0,
  psRows: '',
  observations: [] as { executable: string; timeout: number }[],
  referenceAdmit: vi.fn(),
  referenceInspect: vi.fn(),
}));
// Keep orchestration tests pure; the installed 12k-file closure is verified after source freeze.
vi.mock('node:fs', async (load) => ({
  ...(await load<typeof FileSystem>()),
  readdirSync: () => [],
}));
vi.mock('node:child_process', async (load) => {
  const actual = await load<typeof ChildProcess>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] === '/bin/ps') {
        const options = args[2] as { timeout: number };
        mock.observations.push({ executable: '/bin/ps', timeout: options.timeout });
        vi.setSystemTime(Date.now() + mock.psCost);
        return `${process.pid} 1 R Sat Nov  7 12:00:00 2026\n${mock.psRows}`;
      }
      if (args[0] === '/usr/sbin/lsof') {
        const options = args[2] as { timeout: number };
        mock.observations.push({ executable: '/usr/sbin/lsof', timeout: options.timeout });
        vi.setSystemTime(Date.now() + mock.portCost);
        throw Object.assign(new Error('synthetic absence'), { status: 1, stdout: '', stderr: '' });
      }
      return actual.execFileSync(...args);
    },
  };
});
vi.mock('node:timers/promises', () => ({ setTimeout: mock.pause }));
vi.mock('./comparisonH06NativeAttempt.js', async (load) => ({
  ...(await load<typeof NativeAttempt>()),
  observeH06NativePrimaryGrant: mock.grant,
  observeH06NativePrimaryGrantHistory: mock.history,
}));
vi.mock('./td054DeadlineReference.mjs', async (load) => ({
  ...(await load<typeof ReferenceAuthority>()),
  admitTD054Reference: mock.referenceAdmit,
  inspectTD054Reference: mock.referenceInspect,
}));
vi.mock('./comparisonH06NativeTemporalServerSetup.js', () => ({
  withH06NativeTemporalServer: mock.setup,
}));
vi.mock('./comparisonH06NativeTemporalProcesses.js', () => ({
  h06TemporalWorkerProcesses: () => ({ deadlineLoad: mock.stage }),
}));
vi.mock('./comparisonH06NativeTurnLedger.js', () => ({
  openH06NativeTurnLedger: () => ({
    inspect: () => ({ status: 'RECORDED', used: 1, admissions: [{}] }),
  }),
}));
vi.mock('./comparisonH06NativeUsage.js', () => ({
  bindH06NativeUsageParticipants: () => ({ status: 'BOUND', participants: [] }),
  sealH06NativeUsage: vi.fn(),
  checkH06NativeUsage: () => ({
    status: 'UNKNOWN',
    exceeded: { inputUncached: false, output: false },
    providerHardCap: false,
  }),
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mock.missing = false;
  mock.quietRemainingMs = null;
  mock.psCost = 0;
  mock.portCost = 0;
  mock.psRows = '';
  mock.observations.splice(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const read = (path: string) => object(JSON.parse(readFileSync(path, 'utf8')));
function save(path: string, value: unknown) {
  const bytes = JSON.stringify(value);
  writeFileSync(path, bytes);
  return { path, sha256: digest(bytes) };
}
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'td054-synthetic-run-'));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    chat = join(root, 'chat');
  mkdirSync(workspace);
  mkdirSync(chat);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  for (const name of ['RULES.md', 'reviewer.md'])
    writeFileSync(join(workspace, name), 'declared synthetic input');
  mkdirSync(join(workspace, 'tasks'));
  writeFileSync(join(workspace, 'tasks/task.md'), 'declared synthetic input');
  const preparation = {
    schemaVersion: 1,
    taskId: 'ref',
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    revision: 1,
    card: 'tasks/task.md',
    project: {
      schemaVersion: 1,
      projectId: 'project',
      workspaceId: 'isolated',
      rules: ['RULES.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
      checks: ['syntax'],
    },
  };
  const binary = save(join(root, 'binary'), 'never executed synthetic file');
  const bootstrap = save(join(root, 'bootstrap'), {
    input: { admission: { preparation } },
    profile: { clientVersion: '0.154.0', model: 'fixture', effort: 'medium' },
    disabledServers: [],
    address: '127.0.0.1:7244',
    server: { httpPort: 7245, metricsPort: 7246 },
  });
  const reference = save(join(root, 'reference.json'), {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId: 'ref',
      variant: 'temporal',
      workspaceRoot: workspace,
      node: binary,
      timeoutMs: 1000,
    },
    chat: { threadId: 'thread', workspace: chat },
    evidenceRoot: join(root, 'ref'),
    budget: {
      maxElapsedMs: 90000,
      reserveMs: 15000,
      maxManagedStarts: 24,
      maxInputUncached: 10000,
      maxOutput: 1000,
    },
    stimulus: { longStageMs: 5000, initialLeaseMs: null },
    appServer: save(join(root, 'app'), 'fake'),
    server: save(join(root, 'server'), 'fake'),
    bootstrap,
    runtime: [save(join(root, 'runtime'), 'fake')],
  });
  const packet = prepareTD054DeadlineProbe('td054-synthetic', reference);
  const evidence = String(packet.evidenceRoot),
    serverRoot = String(packet.serverRoot);
  const grant = {
    transcript: '/synthetic-only',
    anchor: { turn_id: 'turn' },
    source: { locator: '/synthetic-only#L1', hash: '0'.repeat(64) },
    sessionsRoot: root,
  };
  mock.grant.mockResolvedValue(grant);
  mock.history.mockResolvedValue(grant);
  mock.pause.mockImplementation(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  });
  const identities = [{ pid: 8002, parent: 8001, started: 'transport-identity' }];
  const workerIdentities = [{ pid: 8001, ppid: 7000, identity: 'worker-identity' }];
  const serverIdentities = [{ pid: 9001, ppid: 7000, identity: 'server-identity' }];
  mock.stage.mockImplementation(async (input: { server: unknown }) => {
    const claim = read(join(evidence, 'attempt-claim.json')),
      work = Number(claim.workDeadlineMs);
    const started = {
      role: 'reader',
      session: 'session',
      turnId: 'turn',
      observedAt: Number(claim.startedAt) + 1000,
    };
    save(join(evidence, 'load-started.json'), started);
    save(join(evidence, 'workflow-started.json'), { workflowId: 'workflow', runId: 'run' });
    const active = save(join(evidence, 'load-at-deadline.json'), {
      started,
      observedAt: work + 2,
      primary: { thread: { id: 'session', turns: [{ id: 'turn', status: 'inProgress' }] } },
    });
    save(join(evidence, 'active-confirmed.json'), { snapshot: active, observedAt: work + 2 });
    mkdirSync(join(evidence, 'transport-initial'));
    if (!mock.missing) {
      const stop = save(join(evidence, 'transport-initial/transport-stop.json'), {
        operationId: packet.operationId,
        receipts: [{ role: 'reader', confirmed: true, processes: identities }],
      });
      save(join(evidence, 'transport-stop-observed.json'), {
        stop,
        identities,
        observedAt: work + 100,
      });
    }
    save(join(evidence, 'transport-initial/reader-0.jsonl.diagnostics.json'), { records: [] });
    save(join(serverRoot, 'worker-deadline-load-outcome.json'), {
      kind: 'h06-native-temporal-process-outcome/1',
      stage: 'deadline-load',
      pid: 8001,
      server: input.server,
      observedExit: true,
      workDeadlineMs: work,
      stopDeadlineMs: claim.stopDeadlineMs,
      failure: 'Error: h06-temporal-process-deadline',
      receipt: { stopped: true, identities: workerIdentities },
      deadlineCancel: { sentAt: work, deliveredAt: work + 1 },
      recordedAt: work + 200,
    });
    vi.setSystemTime(work + 250);
    throw new Error('h06-temporal-process-deadline');
  });
  mock.setup.mockImplementation(
    async (
      setup: { expected: unknown },
      run: (server: unknown, signal: AbortSignal) => Promise<never>,
    ) => {
      const expected = object(setup.expected);
      expect(expected).toEqual({ ...object(packet.server), requestHash: packet.requestHash });
      const ready = save(join(serverRoot, 'server-ready.json'), {
        ...expected,
        process: { pid: 9001 },
      });
      try {
        return await run(ready, new AbortController().signal);
      } finally {
        save(join(serverRoot, 'server-stop.json'), {
          requestHash: packet.requestHash,
          ready,
          receipt: { stopped: true, identities: serverIdentities },
        });
        if (mock.quietRemainingMs !== null) {
          const claim = read(join(evidence, 'attempt-claim.json'));
          vi.setSystemTime(Number(claim.finalDeadlineMs) - mock.quietRemainingMs);
        }
      }
    },
  );
  return { packet, evidence, serverRoot, grant };
}

it('wires an authorized synthetic deadline through the canonical runner and independently checks immutable STOP', async () => {
  const f = fixture();
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: 'PASS',
    nativeDeadline: 'PASS',
    r12FormalColdStop: 'UNKNOWN',
    mayRun: false,
    managedUsage: { status: 'UNKNOWN' },
  });
  expect(mock.setup).toHaveBeenCalledOnce();
  expect(mock.stage).toHaveBeenCalledOnce();
  await expect(
    checkTD054LiveResult({ claim: result.claim, quiet: result.quiet }),
  ).resolves.toMatchObject({ status: 'PASS' });
  await expect(runTD054DeadlineProbe(f.packet, {}, new AbortController().signal)).rejects.toThrow();
  expect(mock.setup).toHaveBeenCalledOnce();
  writeFileSync(join(f.evidence, 'load-at-deadline.json'), '{}');
  await expect(
    checkTD054LiveResult({ claim: result.claim, quiet: result.quiet }),
  ).rejects.toThrow();
}, 30000);

it('persists UNKNOWN when owned cleanup lacks primary STOP instead of accepting supervisor exit alone', async () => {
  const f = fixture();
  mock.missing = true;
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: 'UNKNOWN',
    nativeDeadline: 'UNKNOWN',
    qualification: false,
    mayRun: false,
  });
  expect(read(join(f.evidence, 'live-result.json'))).toMatchObject({ status: 'UNKNOWN' });
  expect(mock.setup).toHaveBeenCalledOnce();
}, 30000);

it('requires current/latest source for a consumed execution claim but keeps saved history read-only', async () => {
  const f = fixture();
  mock.setup.mockImplementationOnce(async () => {
    const path = join(f.evidence, 'attempt-claim.json');
    const claim = { path, sha256: digest(readFileSync(path)) };
    mock.grant.mockRejectedValue(new Error('chat-continuation-human-superseded'));
    await expect(readTD054Claim(claim)).rejects.toThrow('human-superseded');
    await expect(readTD054SavedClaim(claim)).resolves.toMatchObject({
      packet: { requestHash: f.packet.requestHash },
    });
    throw new Error('execution admission refused');
  });
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({ status: 'UNKNOWN', mayRun: false });
  expect(mock.stage).not.toHaveBeenCalled();
  expect(mock.history).toHaveBeenCalled();
});

it('uses one PS command for the entire owned set and compares normalized process start times', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const identity = { pid: 1234567, parent: process.pid, started: 'Sat Nov  7 12:00:00 2026' };
  mock.psRows = `${identity.pid} ${process.pid} S Sat Nov  7 12:00:00 2026\n`;
  const identities = [
    identity,
    ...Array.from({ length: 100 }, (_, index) => ({ ...identity, pid: identity.pid + index + 1 })),
  ];
  expect(observeTD054Processes(identities, 1010)).toEqual([identity]);
  expect(mock.observations).toEqual([{ executable: '/bin/ps', timeout: 10 }]);
});

it('does not spend a full quiet pause or renew per-command timeouts after the original budget is nearly exhausted', async () => {
  const f = fixture();
  mock.quietRemainingMs = 500;
  mock.psCost = 150;
  mock.portCost = 100;
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: 'UNKNOWN',
    error: expect.stringContaining('td054-quiet-window-budget') as unknown,
  });
  expect(mock.observations).toEqual([
    { executable: '/bin/ps', timeout: 500 },
    { executable: '/usr/sbin/lsof', timeout: 350 },
    { executable: '/usr/sbin/lsof', timeout: 250 },
    { executable: '/usr/sbin/lsof', timeout: 150 },
  ]);
  expect(mock.pause).not.toHaveBeenCalled();
});

it('stops observation immediately when PS consumes the remaining original deadline', async () => {
  const f = fixture();
  mock.quietRemainingMs = 100;
  mock.psCost = 100;
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: 'UNKNOWN',
    error: expect.stringContaining('td054-observation-deadline') as unknown,
  });
  expect(mock.observations).toEqual([{ executable: '/bin/ps', timeout: 100 }]);
  expect(mock.pause).not.toHaveBeenCalled();
});

it('does not start another port observation when lsof consumes the final deadline', async () => {
  const f = fixture();
  mock.quietRemainingMs = 200;
  mock.portCost = 200;
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result.status).toBe('UNKNOWN');
  expect(mock.observations).toEqual([
    { executable: '/bin/ps', timeout: 200 },
    { executable: '/usr/sbin/lsof', timeout: 200 },
  ]);
  expect(mock.pause).not.toHaveBeenCalled();
});

it('refuses late post-pause observations instead of extending the original final deadline', async () => {
  const f = fixture();
  mock.quietRemainingMs = 4000;
  mock.pause.mockImplementationOnce(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms + 1001);
  });
  const result = await runTD054DeadlineProbe(f.packet, {}, new AbortController().signal);
  expect(result).toMatchObject({
    status: 'UNKNOWN',
    error: expect.stringContaining('td054-observation-deadline') as unknown,
  });
  expect(mock.pause).toHaveBeenCalledOnce();
  expect(mock.observations.filter((item) => item.executable === '/bin/ps')).toHaveLength(1);
  expect(mock.observations.filter((item) => item.executable === '/usr/sbin/lsof')).toHaveLength(3);
});

it.each(['literal', 'reference'] as const)(
  'shares one original operation/root across both admissions after a first %s run',
  async (first) => {
    const f = fixture();
    const reference = {
      kind: 'td054-native-load-deadline-reference/2',
      binding: { synthetic: true },
      packet: f.packet,
    };
    const approved = {
      nativeGrant: f.grant,
      serverGrant: f.grant,
      referenceApproval: {
        kind: 'td054-actual-reference-consent/2',
        binding: reference.binding,
        sourceText: 'synthetic genuine-reference fixture, not numeric USER JSON',
      },
    };
    mock.referenceAdmit.mockResolvedValue(approved);
    mock.referenceInspect.mockResolvedValue(approved);
    const source = td054ReferenceSource(reference);
    const outcome = await runTD054DeadlineProbe(
      f.packet,
      first === 'reference' ? source : {},
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'PASS' });
    expect(read(join(f.evidence, 'attempt-claim.json'))).toMatchObject({
      kind:
        first === 'reference'
          ? 'td054-native-load-deadline-reference-claim/2'
          : 'td054-native-load-deadline-claim/1',
    });
    if (first === 'reference') {
      expect(mock.grant).not.toHaveBeenCalled();
      expect(mock.history).not.toHaveBeenCalled();
      expect(read(join(f.evidence, 'attempt-claim.json'))).toMatchObject({
        referenceApproval: approved.referenceApproval,
      });
    }
    await expect(
      runTD054DeadlineProbe(f.packet, source, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      runTD054DeadlineProbe(f.packet, {}, new AbortController().signal),
    ).rejects.toThrow();
    expect(mock.stage).toHaveBeenCalledOnce();
  },
);

it('rechecks reference current-source before stage while retaining historical saved proof', async () => {
  const f = fixture();
  const reference = {
    kind: 'td054-native-load-deadline-reference/2',
    binding: { synthetic: true },
    packet: f.packet,
  };
  const observed = {
    nativeGrant: f.grant,
    serverGrant: f.grant,
    referenceApproval: {
      kind: 'td054-actual-reference-consent/2',
      binding: reference.binding,
    },
  };
  mock.referenceAdmit.mockResolvedValue(observed);
  mock.referenceInspect.mockResolvedValue(observed);
  mock.setup.mockImplementationOnce(async () => {
    const path = join(f.evidence, 'attempt-claim.json');
    const claim = { path, sha256: digest(readFileSync(path)) };
    mock.referenceAdmit.mockRejectedValue(new Error('reference-human-superseded'));
    await expect(readTD054Claim(claim)).rejects.toThrow('reference-human-superseded');
    await expect(readTD054SavedClaim(claim)).resolves.toMatchObject({
      kind: 'td054-native-load-deadline-reference-claim/2',
    });
    throw new Error('reference execution admission refused');
  });
  expect(
    await runTD054DeadlineProbe(
      f.packet,
      td054ReferenceSource(reference),
      new AbortController().signal,
    ),
  ).toMatchObject({ status: 'UNKNOWN', mayRun: false });
  expect(mock.stage).not.toHaveBeenCalled();
});
