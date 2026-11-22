import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import type * as NodeProcesses from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import {
  h01RequestHash,
  verifyH01GuardAuthorization,
  comparisonKind,
  comparisonLabel,
} from './comparisonH01Contract.js';
import type {
  H01ExecutionRequest,
  H01GuardDescriptor,
  H01KeeperInput,
} from './comparisonH01Contract.js';
import { runH01OwnedChild } from './comparisonH01Keeper.js';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import type * as Safety from '../examples/temporal-consumers/full/safety.mjs';
import type * as SharedContract from './comparisonH01Contract.js';

vi.mock('./comparisonH01Contract.js', async (load) => {
  const actual = await load<typeof SharedContract>();
  return {
    ...actual,
    verifyH01GuardAuthorization: vi.fn<() => Promise<void>>(),
  };
});
vi.mock('node:child_process', async (load) => {
  const actual = await load<typeof NodeProcesses>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('../examples/temporal-consumers/full/safety.mjs', async (load) => {
  const actual = await load<typeof Safety>();
  return { ...actual, ownProcess: vi.fn(actual.ownProcess) };
});
const nodeProcesses = await vi.importActual<typeof NodeProcesses>('node:child_process');
const safety = await vi.importActual<typeof Safety>(
  '../examples/temporal-consumers/full/safety.mjs',
);
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(verifyH01GuardAuthorization).mockImplementation(async () => {});
  vi.mocked(spawn).mockImplementation(nodeProcesses.spawn);
  vi.mocked(ownProcess).mockImplementation(safety.ownProcess);
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  mode = 'completed',
  elapsedMs = 3000,
  reserveMs = 1000,
  scenario: 'H-01' | 'H-02' | 'H-03' | 'H-04' | 'H-05' = 'H-01',
) {
  const label = comparisonLabel(scenario);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h01-owned-node-')));
  roots.push(root);
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const pin = (name: string, content: string): InputRef => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
    return { locator: path, hash: digest(content) };
  };
  const evidenceRoot = dir('evidence'),
    controller = new AbortController();
  const request: H01ExecutionRequest = {
    kind: comparisonKind(scenario, 'execution'),
    executionVersion: 2,
    opId: 'h01-node',
    variant: 'candidate',
    material: pin('material.json', '{}'),
    criteria: pin('criteria.json', '{}'),
    profile: pin('profile.json', '{}'),
    runtime: pin('runtime.json', '{}'),
    bootstrap: pin('bootstrap.json', '{}'),
    roots: {
      workspaceRoot: dir('workspace'),
      evidenceRoot,
      hostRoot: dir('host'),
      artifactRoot: dir('artifacts'),
      stateRoot: dir('state'),
    },
    identity: { taskId: 'h01-task', owner: 'operator', generation: scenario === 'H-05' ? 2 : 1 },
    budget: {
      maxManagedStarts: 3,
      maxElapsedMs: elapsedMs,
      reserveMs,
      maxInputUncached: 10,
      maxOutput: 10,
    },
    authorization: {
      root,
      transcript: join(root, 'human.jsonl'),
      anchor: {
        thread_id: 'human',
        turn_id: 'turn',
        workspace: root,
        host_id: 'local',
      },
      source: {
        locator: join(root, 'human.jsonl') + '#L1',
        hash: digest('primary'),
      },
      requestHash: digest('unassigned'),
    },
  };
  request.authorization.requestHash = h01RequestHash(request);
  const requestRef = pin('request.json', JSON.stringify(request));
  const started = process.hrtime.bigint(),
    deadlineNs = String(started + BigInt(elapsedMs) * 1_000_000n),
    workDeadlineNs = String(BigInt(deadlineNs) - BigInt(reserveMs) * 1_000_000n);
  const descriptor: H01GuardDescriptor = {
    kind: comparisonKind(scenario, 'guard'),
    executionVersion: 2,
    opId: request.opId,
    request: requestRef,
    requestHash: h01RequestHash(request),
    variant: request.variant,
    roots: request.roots,
    budget: request.budget,
    profile: { model: 'none', effort: 'none', clientVersion: 'none' },
    binary: pin('binary', 'not executable'),
    authorization: request.authorization,
    pins: [requestRef],
    startedNs: String(started),
    deadlineNs,
    workDeadlineNs,
  };
  const controlRef = pin('control.json', JSON.stringify(descriptor));
  const report = {
    kind: comparisonKind(scenario, 'execution-report'),
    executionVersion: 2,
    opId: request.opId,
    requestHash: h01RequestHash(request),
    outcome: mode === 'failed' ? 'failed' : 'accepted',
  };
  const child = `import process from 'node:process';
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
setTimeout(()=>process.exit(19), 2300).unref();
process.once('message',message=>{
  const mode=${JSON.stringify(mode)};
  if(mode==='no-ipc'){process.disconnect();process.exit(0);}
  process.send({...message,kind:mode==='wrong-ipc'?'wrong':${JSON.stringify('comparison-' + label + '-owned-child-ready')}});
  if(mode==='wrong-ipc'){setInterval(()=>{},100);return;}
  if(mode==='timeout'){process.on('SIGTERM',()=>{});setInterval(()=>{},100);return;}
  if(mode==='signal'){process.kill(process.pid,'SIGTERM');return;}
  if(mode!=='missing-report')writeFileSync(${JSON.stringify(join(evidenceRoot, label + '-child-report.json'))},JSON.stringify(${JSON.stringify(report)}));
  if(mode==='late-process'){
    const descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),1500);'],{stdio:'ignore'});
    descendant.unref();
    setTimeout(()=>process.exit(0),100);return;
  }
  if(mode==='held'){setInterval(()=>{},100);return;}
  setTimeout(()=>process.exit(mode==='failed'?1:0),20);
});
`;
  const input: H01KeeperInput = {
    entrypoint: pin('child.mjs', child),
    request: requestRef,
    controlRef,
    evidenceRoot,
    deadlineNs,
    workDeadlineNs,
    opId: request.opId,
  };
  const read = (ref: InputRef) =>
    JSON.parse(readFileSync(ref.locator).toString()) as Record<string, unknown>;
  return {
    root,
    input,
    controller,
    pin,
    read,
    run: () => runH01OwnedChild(input, controller.signal, scenario),
  };
}

it('binds the H02 IPC and physical Node child report to its own request', async () => {
  const f = fixture('completed', 3000, 1000, 'H-02');
  const result = await f.run();
  expect(result.outcome).toBe('completed');
  expect(f.read(result.stop)).toMatchObject({
    kind: 'h02-keeper-stop',
    ready: true,
    stopped: true,
  });
  expect(f.read(result.report!)).toMatchObject({ kind: 'comparison-h02-execution-report' });
});

it.each(['H-03', 'H-04', 'H-05'] as const)(
  'preserves the %s IPC and its real owned Node exit under the shared keeper',
  async (scenario) => {
    const f = fixture('completed', 3000, 1000, scenario);
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(f.read(result.stop)).toMatchObject({
      kind: comparisonLabel(scenario) + '-keeper-stop',
      ready: true,
      stopped: true,
    });
    expect(f.read(result.report!)).toMatchObject({
      kind: comparisonKind(scenario, 'execution-report'),
    });
  },
);

it('retains an H04 missing child report as UNKNOWN after a confirmed physical exit', async () => {
  const f = fixture('missing-report', 3000, 1000, 'H-04');
  const result = await f.run();
  expect(result.outcome).toBe('unknown');
  expect(result.report).toBeUndefined();
  expect(f.read(result.stop)).toMatchObject({ kind: 'h04-keeper-stop', stopped: true });
});

it('retains an H05 missing child report as UNKNOWN after a confirmed physical exit', async () => {
  const f = fixture('missing-report', 3000, 1000, 'H-05');
  const result = await f.run();
  expect(result.outcome).toBe('unknown');
  expect(result.report).toBeUndefined();
  expect(f.read(result.stop)).toMatchObject({ kind: 'h05-keeper-stop', stopped: true });
});

function stopDetails(
  f: ReturnType<typeof fixture>,
  result: Awaited<ReturnType<typeof runH01OwnedChild>>,
): string {
  const stop = f.read(result.stop),
    stderr = join(f.input.evidenceRoot, 'h01-child.stderr');
  return JSON.stringify({
    reason: stop.reason,
    error: stop.error,
    stderr: existsSync(stderr) ? readFileSync(stderr, 'utf8').slice(0, 1000) : null,
    result,
  }).slice(0, 4096);
}

describe('H01 owned Node keeper (no Temporal/native/model execution)', () => {
  it.each(['completed', 'failed'])(
    'preserves a real child %s report only after exit and confirmed process stop',
    async (mode) => {
      const f = fixture(mode),
        result = await f.run();
      expect(result.outcome, stopDetails(f, result)).toBe(mode);
      expect(f.read(result.stop), stopDetails(f, result)).toMatchObject({
        kind: 'h01-keeper-stop',
        opId: 'h01-node',
        stopped: true,
        ready: true,
        softStop: false,
        forcedStop: false,
        notStarted: false,
        signal: null,
      });
      expect(result.report?.locator).toBe(join(f.input.evidenceRoot, 'h01-child-report.json'));
      expect(result.evidence.some((ref) => ref.locator.endsWith('h01-child.stdout'))).toBe(true);
    },
  );
  it.each(['no-ipc', 'wrong-ipc', 'missing-report', 'signal'])(
    'retains %s as unknown',
    async (mode) => {
      const f = fixture(mode),
        result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.read(result.stop).stopped, stopDetails(f, result)).toBe(true);
    },
  );
  it('stops a held child on the original work/hard clock without resetting the deadline', async () => {
    const f = fixture('timeout', 1800, 700),
      result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).softStop, stopDetails(f, result)).toBe(true);
    expect(f.read(result.stop).stopped, stopDetails(f, result)).toBe(true);
  });
  it('stops an owned child when the caller cancels, preserving its report as unaccepted evidence', async () => {
    const f = fixture('held');
    const running = f.run();
    const timer = setTimeout(() => f.controller.abort(), 500);
    try {
      const result = await running;
      expect(result.outcome).toBe('unknown');
      expect(f.read(result.stop), stopDetails(f, result)).toMatchObject({
        stopped: true,
        softStop: true,
      });
    } finally {
      clearTimeout(timer);
    }
  });
  it('retains a late descendant cleanup as unknown even when the leader exits zero', async () => {
    const f = fixture('late-process'),
      result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop), stopDetails(f, result)).toMatchObject({
      forcedStop: true,
      code: 0,
    });
  });
  it.each(['initial', 'after-verify'])(
    'rejects changed entrypoint bytes %s before spawn',
    async (stage) => {
      const f = fixture();
      const change = () =>
        writeFileSync(f.input.entrypoint.locator, 'throw new Error("must never execute")');
      if (stage === 'initial') change();
      else
        vi.mocked(verifyH01GuardAuthorization).mockImplementation(async () => {
          change();
        });
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.read(result.stop).notStarted).toBe(true);
      expect(result.report).toBeUndefined();
    },
  );
  it.each(['initial', 'after-verify'])('observes cancellation %s before spawn', async (stage) => {
    const f = fixture();
    if (stage === 'initial') f.controller.abort();
    else
      vi.mocked(verifyH01GuardAuthorization).mockImplementation(async () => {
        f.controller.abort();
      });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).notStarted).toBe(true);
  });
  it('rejects a mismatched operation or deadline binding before spawn', async () => {
    const f = fixture();
    f.input.opId = 'other';
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).notStarted).toBe(true);
  });
  it('handles a closed IPC channel without accepting a zero child exit', async () => {
    const f = fixture();
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      const child = nodeProcesses.spawn(command, args, options);
      child.disconnect();
      return child;
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).softStop, stopDetails(f, result)).toBe(true);
  });
  it('does not open or accept a report when the process observer returns unknown', async () => {
    const f = fixture();
    vi.mocked(ownProcess).mockImplementationOnce((child, options) => {
      const actual = safety.ownProcess(child, options),
        done = actual.done.then((receipt) => ({
          ...receipt,
          stopped: false,
          reason: 'injected observer loss after actual stop',
        }));
      return { child, done, stop: () => done };
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(result.report).toBeUndefined();
    expect(f.read(result.stop), stopDetails(f, result)).toMatchObject({
      stopped: false,
      reason: 'injected observer loss after actual stop',
    });
    expect(
      existsSync(join(f.input.evidenceRoot, 'h01-child-report.json')),
      stopDetails(f, result),
    ).toBe(true);
    expect(
      readFileSync(join(f.input.evidenceRoot, 'h01-child-report.json')).length,
    ).toBeGreaterThan(0);
  });
  it('refuses an authorization that finishes after the original work deadline', async () => {
    const f = fixture('completed', 100, 50);
    vi.mocked(verifyH01GuardAuthorization).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).notStarted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('can complete without an optional caller signal', async () => {
    const f = fixture(),
      result = await runH01OwnedChild(f.input);
    expect(result.outcome, stopDetails(f, result)).toBe('completed');
  });
  it('does not deliver a bootstrap capability when cancellation was observed immediately after spawn', async () => {
    const f = fixture();
    const messages: unknown[] = [];
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      const child = nodeProcesses.spawn(command, args, options);
      vi.spyOn(child, 'send').mockImplementation((message) => {
        messages.push(message);
        return true;
      });
      f.controller.abort();
      return child;
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop), stopDetails(f, result)).toMatchObject({
      ready: false,
      softStop: true,
    });
    expect(messages).toEqual([]);
  });
  it('cannot move the common start clock into the future to gain time', async () => {
    const f = fixture();
    const descriptor = f.read(f.input.controlRef);
    for (const key of ['startedNs', 'deadlineNs', 'workDeadlineNs'])
      descriptor[key] = String(BigInt(String(descriptor[key])) + 30_000_000_000n);
    f.input.controlRef = f.pin('future-control.json', JSON.stringify(descriptor));
    f.input.deadlineNs = String(descriptor.deadlineNs);
    f.input.workDeadlineNs = String(descriptor.workDeadlineNs);
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).notStarted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('preserves existing output evidence and refuses an implicit second child attempt', async () => {
    const f = fixture();
    writeFileSync(join(f.input.evidenceRoot, 'h01-child.stderr'), 'old primary');
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).notStarted).toBe(true);
    expect(readFileSync(join(f.input.evidenceRoot, 'h01-child.stderr')).toString()).toBe(
      'old primary',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
