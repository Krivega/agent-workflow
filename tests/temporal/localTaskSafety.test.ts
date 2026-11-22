import { delimiter, join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import { throughIntegration, acceptance } from './localTaskRun.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import * as checks from '../../src/adapters/project/taskChecks.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import { NativeWriterProcesses } from '../../src/adapters/codex/writerProcesses.js';
const nativeTaskChecks = checks.taskChecks;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function directory(f: ReturnType<typeof localTaskFixture>) {
  return join(f.workspace, '.git/agent-workflow/tasks', digest(localTaskKey(f.input)));
}
function fixture() {
  const f = localTaskFixture();
  f.processes.wait = vi.fn(async () => {});
  return f;
}
async function candidate(f: ReturnType<typeof fixture>) {
  const a = f.service.activities,
    ref = await a.prepareLocalTask(f.input),
    writer = await a.writeLocalTask(f.input, ref);
  return { a, ref, writer };
}
describe('B1 repeated effects, failed proofs and completion boundary', { timeout: 15000 }, () => {
  it('joins a repeated stop after a real active check has cleared its process state', async () => {
    const f = fixture(),
      processes = new NativeWriterProcesses();
    let runner!: ReturnType<typeof checks.taskChecks>, cleared!: () => void, release!: () => void;
    const firstCheckStopped = new Promise<void>((resolve) => {
        cleared = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      }),
      stoppedChecks: number[][] = [];
    vi.mocked(checks.taskChecks).mockImplementation((directory) => {
      runner = nativeTaskChecks(directory, processes);
      return {
        ...runner,
        async stop() {
          const stopped = await runner.stop();
          stoppedChecks.push(stopped.map((identity) => identity.pid));
          if (stopped.length > 0) {
            cleared();
            await released;
          }
          return stopped;
        },
      };
    });
    const snapshot = await f.service.activities.prepareLocalTask(f.input);
    await f.service.activities.writeLocalTask(f.input, snapshot);
    const marker = join(f.root, 'active-check'),
      running = runner.run(f.workspace, {
        executable: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`,
        ],
        timeoutMs: 5000,
      }),
      interrupted = expect(running).rejects.toThrow('task-check-interrupted');
    try {
      for (let i = 0; i < 200 && !existsSync(marker); i++) await processes.wait(10);
      expect(existsSync(marker)).toBe(true);
      const first = f.service.controls.stopLocalTask(f.input);
      await firstCheckStopped;
      const second = f.service.controls.stopLocalTask(f.input),
        outcomes = Promise.allSettled([first, second]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      expect({
        stoppedChecks,
        outcomes: (await outcomes).map((result) =>
          result.status === 'rejected' ? String(result.reason) : result.status,
        ),
      }).toEqual({ stoppedChecks: [expect.any(Array)], outcomes: ['fulfilled', 'fulfilled'] });
      expect(await second).toEqual(await first);
      expect(stoppedChecks).toHaveLength(1);
      expect(stoppedChecks[0]!.length).toBeGreaterThan(0);
      await interrupted;
    } finally {
      release();
      await runner.stop();
      await interrupted;
    }
  });
  it('revokes dispatch synchronously, shares a failed stop and safely retries its cleanup', async () => {
    const f = fixture(),
      factory = vi.mocked(checks.taskChecks).getMockImplementation()!;
    let release!: () => void,
      calls = 0;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(checks.taskChecks).mockImplementation((...args) => {
      const runner = factory(...args);
      return {
        ...runner,
        async stop() {
          if (++calls === 1) {
            await released;
            throw new Error('check stop unavailable');
          }
          return runner.stop();
        },
      };
    });
    const snapshot = await f.service.activities.prepareLocalTask(f.input),
      first = f.service.controls.stopLocalTask(f.input),
      second = f.service.controls.stopLocalTask(f.input),
      outcomes = Promise.allSettled([first, second]),
      root = directory(f);
    try {
      expect(existsSync(join(root, 'revoked.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'permission.json'), 'utf8'))).toMatchObject({
        active: false,
      });
      await expect(f.service.activities.writeLocalTask(f.input, snapshot)).rejects.toThrow(
        'task-permit-revoked',
      );
    } finally {
      release();
    }
    expect(
      (await outcomes).map((result) =>
        result.status === 'rejected' ? String(result.reason) : result.status,
      ),
    ).toEqual(['Error: check stop unavailable', 'Error: check stop unavailable']);
    expect(calls).toBe(1);
    expect(existsSync(join(root, 'stopped.json'))).toBe(false);
    expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
    const retried = await f.service.controls.stopLocalTask(f.input);
    expect(f.read(retried)).toMatchObject({ kind: 'task-stopped', confirmed: true });
    expect(calls).toBe(2);
    expect(f.state.creates).toBe(0);
    expect(f.state.starts).toBe(0);
    expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(false);
  });
  it.each(
    (['ordinary', 'no-snapshot', 'correcting'] as const).flatMap((variant) =>
      ['control', 'stopAll'].map((other) => ({ variant, other })),
    ),
  )(
    'publishes one identical receipt for concurrent $variant control/$other stops',
    async ({ variant, other }) => {
      const f = fixture(),
        input: LocalTaskInput =
          variant === 'correcting'
            ? {
                ...f.input,
                schemaVersion: 4,
                corrections: {
                  maxRounds: 1,
                  checks: [{ roleId: 'reviewer', commands: ['smoke', 'validate'] }],
                },
              }
            : f.input,
        factory = vi.mocked(checks.taskChecks).getMockImplementation()!;
      let arrived!: () => void, release!: () => void;
      const bothWaiting = new Promise<void>((resolve) => {
          arrived = resolve;
        }),
        released = new Promise<void>((resolve) => {
          release = resolve;
        });
      let waiting = 0;
      vi.mocked(checks.taskChecks).mockImplementation((...args) => {
        const runner = factory(...args);
        return {
          ...runner,
          async stop() {
            const stopped = await runner.stop();
            if (++waiting === 1) arrived();
            await released;
            return stopped;
          },
        };
      });
      if (variant === 'no-snapshot') {
        Object.assign(f.registration.commands.smoke, { timeoutMs: 0 });
        f.service = f.makeService();
        await expect(f.service.activities.prepareLocalTask(input)).rejects.toThrow(
          'task-check-timeout-invalid',
        );
      } else {
        const snapshot = await f.service.activities.prepareLocalTask(input);
        await f.service.activities.writeLocalTask(input, snapshot);
      }
      const root = join(f.workspace, '.git/agent-workflow/tasks', digest(localTaskKey(input))),
        stoppedFile = join(root, 'stopped.json'),
        publication = artifacts.publishFile,
        published: Buffer[] = [],
        stop = vi.spyOn(f.service.controls, 'stopLocalTask'),
        first = f.service.controls.stopLocalTask(input),
        all = other === 'stopAll' ? f.service.stopAll() : f.service.controls.stopLocalTask(input),
        settled = Promise.allSettled([first, all]);
      vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (path === stoppedFile) published.push(Buffer.from(bytes));
        publication(path, bytes);
      });
      await bothWaiting;
      expect(existsSync(stoppedFile)).toBe(false);
      release();
      expect(published).toHaveLength(0);
      const outcomes = await settled;
      expect(waiting).toBe(1);
      expect(published).toHaveLength(1);
      expect(
        outcomes.map((result) =>
          result.status === 'rejected' ? String(result.reason) : result.status,
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
      expect(stop).toHaveBeenCalledTimes(2);
      const firstRef = await first;
      const secondRef: unknown = await stop.mock.results[1]!.value;
      expect(secondRef).toEqual(firstRef);
      expect(await f.service.controls.stopLocalTask(input)).toEqual(firstRef);
      expect(JSON.parse(readFileSync(stoppedFile, 'utf8'))).toEqual(firstRef);
      expect(f.read(firstRef)).toMatchObject({
        kind: variant === 'no-snapshot' ? 'task-not-started' : 'task-stopped',
        confirmed: true,
      });
      expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(false);
      expect(f.state.creates).toBe(variant === 'no-snapshot' ? 0 : 1);
      expect(f.state.starts).toBe(variant === 'no-snapshot' ? 0 : 3);
    },
  );
  it.each(['ordinary', 'no-snapshot', 'correcting'] as const)(
    'retains a conflicting %s stop receipt and leaves the reservation held',
    async (variant) => {
      const f = fixture(),
        input: LocalTaskInput =
          variant === 'correcting'
            ? {
                ...f.input,
                schemaVersion: 4,
                corrections: {
                  maxRounds: 1,
                  checks: [{ roleId: 'reviewer', commands: ['smoke', 'validate'] }],
                },
              }
            : f.input;
      if (variant === 'no-snapshot') {
        Object.assign(f.registration.commands.smoke, { timeoutMs: 0 });
        f.service = f.makeService();
        await expect(f.service.activities.prepareLocalTask(input)).rejects.toThrow(
          'task-check-timeout-invalid',
        );
      } else {
        const snapshot = await f.service.activities.prepareLocalTask(input);
        await f.service.activities.writeLocalTask(input, snapshot);
      }
      const root = join(f.workspace, '.git/agent-workflow/tasks', digest(localTaskKey(input))),
        stoppedFile = join(root, 'stopped.json'),
        conflicting = Buffer.from(JSON.stringify(f.save({ kind: 'conflicting-stop' }))),
        publication = artifacts.publishFile;
      vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (path === stoppedFile) publication(path, conflicting);
        publication(path, bytes);
      });
      const outcomes = await Promise.allSettled([
        f.service.controls.stopLocalTask(input),
        f.service.stopAll(),
      ]);
      expect(
        outcomes.map((result) =>
          result.status === 'rejected' ? String(result.reason) : result.status,
        ),
      ).toEqual(['Error: task-receipt-conflict', 'Error: task-receipt-conflict']);
      expect(readFileSync(stoppedFile)).toEqual(conflicting);
      expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
    },
  );
  it('recovers a lost writer result publication from its immutable proof and keeps a missing result unknown', async () => {
    const f = fixture(),
      { a, ref, writer } = await candidate(f),
      folder = join(directory(f), 'task-effects');
    for (const name of readdirSync(folder).filter((n) => n.endsWith('.receipt')))
      unlinkSync(join(folder, name));
    expect(await a.writeLocalTask(f.input, ref)).toEqual(writer);
    expect(f.state.starts).toBe(3);
    const other = fixture();
    other.host.createRuntime = () => {
      throw new Error('spawn failed');
    };
    const s = await other.service.activities.prepareLocalTask(other.input);
    await expect(other.service.activities.writeLocalTask(other.input, s)).rejects.toThrow(
      'spawn failed',
    );
    await expect(other.service.activities.writeLocalTask(other.input, s)).rejects.toThrow(
      'effect-outcome-unknown',
    );
  });
  it('retains the original evidence through admission and freezes added and deleted file contents in the packet', async () => {
    const f = fixture();
    f.plan.paths.push('new', 'consumer.cjs');
    const bytes = Buffer.from(JSON.stringify(f.plan));
    writeFileSync(join(f.workspace, 'plan.json'), bytes);
    f.input.admission.plan.sha256 = digest(bytes);
    const extra = f.save({ kind: 'prior-decision', text: 'accepted evidence' });
    f.input.admission.acceptance = f.save({
      ...f.review,
      schemaVersion: 2,
      evidence: [extra],
      expectedFiles: [],
    });
    const runtime = f.createRuntime;
    f.host.createRuntime = (root) => {
      const r = runtime(root);
      return {
        ...r,
        async request(method, params) {
          const result = await r.request(method, params);
          if (method === 'turn/start' && f.state.starts === 3) {
            writeFileSync(join(root, 'new'), 'added');
            unlinkSync(join(root, 'consumer.cjs'));
          }
          return result;
        },
      };
    };
    // This variant tests the packet's add/delete encoding with a check that does not consume the deleted module.
    vi.spyOn(checks, 'taskChecks').mockReturnValue({
      stop: vi.fn(),
      run: vi.fn<ReturnType<typeof checks.taskChecks>['run']>(async (_cwd, command) => ({
        code: 0,
        signal: null,
        error: null,
        stop: { confirmed: true as const, processes: [] },
        elapsedMs: 1,
        command,
        log: 'variant checks',
      })),
    });
    const run = await throughIntegration(f),
      request = f.read(run.packet.request);
    expect(request.evidence).toHaveLength(2);
    expect((request.evidence as ArtifactRef[])[0]).toEqual(extra);
    const packet = f.read((request.evidence as ArtifactRef[])[1]!);
    expect(packet.diff).toEqual(
      expect.arrayContaining([
        { path: 'new', before: null, after: 'added' },
        expect.objectContaining({ path: 'consumer.cjs', after: null }),
      ]),
    );
    expect(
      await run.a.prepareLocalAcceptance(
        f.input,
        run.snapshot,
        run.writer,
        run.candidate.manifest,
        run.intent,
        run.integration,
        run.checked.manifest,
        run.baseline.manifest,
      ),
    ).toEqual(run.packet);
  });
  it('uses the native process adapter and an empty external server list by default', () => {
    const f = fixture();
    expect(
      localTaskActivities(
        f.registration,
        { profile: f.profile, createRuntime: f.createRuntime },
        f.rpc,
        f.profile,
        () => {},
      ),
    ).toBeDefined();
  });
  it('continues from the exact implementation turn after a lost reply and integrates its change once', async () => {
    const f = fixture();
    const marker = '// applied implementation';
    f.host.createRuntime = (root) => {
      const runtime = f.createRuntime(root);
      return {
        ...runtime,
        async request(method, params) {
          const response = await runtime.request(method, params);
          if (method === 'turn/start' && f.state.starts === 3) {
            appendFileSync(join(root, 'owner.cjs'), marker + '\n');
            throw new Error('implementation reply lost');
          }
          return response;
        },
      };
    };
    const run = await throughIntegration(f);
    const path = join(f.workspace, 'owner.cjs');
    const before = readFileSync(path, 'utf8');
    expect(before.split(marker)).toHaveLength(2);
    expect(await run.a.integrateLocalTask(f.input, run.snapshot, run.intent)).toEqual(
      run.integration,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(3);
  });
  it('keeps an undelivered implementation unknown without applying the candidate', async () => {
    const f = fixture();
    const before = readFileSync(join(f.workspace, 'owner.cjs'));
    f.host.createRuntime = (root) => {
      const runtime = f.createRuntime(root);
      return {
        ...runtime,
        async request(method, params) {
          if (method === 'turn/start' && f.state.starts === 2) throw new Error('no delivery');
          return runtime.request(method, params);
        },
      };
    };
    const a = f.service.activities,
      snapshot = await a.prepareLocalTask(f.input);
    await expect(a.writeLocalTask(f.input, snapshot)).rejects.toThrow('no delivery');
    await expect(a.writeLocalTask(f.input, snapshot)).rejects.toThrow('effect-outcome-unknown');
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(2);
    expect(readFileSync(join(f.workspace, 'owner.cjs'))).toEqual(before);
  });
  it('reuses confirmed preparation, writer and check results without another command or model start', async () => {
    const f = fixture(),
      a = f.service.activities,
      s = await a.prepareLocalTask(f.input);
    expect(await a.prepareLocalTask(f.input)).toEqual(s);
    const first = await a.checkLocalTask(f.input, s, 'baseline', null, null);
    expect(await a.checkLocalTask(f.input, s, 'baseline', null, null)).toEqual(first);
    const w = await a.writeLocalTask(f.input, s);
    expect(await a.writeLocalTask(f.input, s)).toEqual(w);
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(3);
    await f.service.controls.stopLocalTask(f.input);
    expect(await f.service.controls.stopLocalTask(f.input)).toEqual(
      await f.service.controls.stopLocalTask(f.input),
    );
  });
  it('holds an unknown interrupted check instead of running it again', async () => {
    const f = fixture();
    vi.spyOn(checks, 'taskChecks').mockReturnValue({
      run: vi.fn().mockRejectedValue(new Error('lost check')),
      stop: vi.fn(),
    });
    const s = await f.service.activities.prepareLocalTask(f.input);
    await expect(
      f.service.activities.checkLocalTask(f.input, s, 'baseline', null, null),
    ).rejects.toThrow('lost check');
    await expect(
      f.service.activities.checkLocalTask(f.input, s, 'baseline', null, null),
    ).rejects.toThrow('task-check-outcome-unknown');
    expect(f.state.starts).toBe(0);
  });
  it('pins a check request and rejects altered registration/profile/input/snapshot', async () => {
    const f = fixture(),
      a = f.service.activities,
      s = await a.prepareLocalTask(f.input);
    await a.checkLocalTask(f.input, s, 'baseline', null, null);
    writeFileSync(join(directory(f), 'checks-baseline-intent.json'), '{}');
    await expect(a.checkLocalTask(f.input, s, 'baseline', null, null)).rejects.toThrow(
      'task-check-request-conflict',
    );
    await expect(a.prepareLocalTask({ ...f.input, baseline: 'validate' })).rejects.toThrow(
      'task-input-conflict',
    );
    await expect(a.writeLocalTask(f.input, f.save({ ...f.read(s), profile: {} }))).rejects.toThrow(
      'task-snapshot-binding',
    );
    await expect(a.writeLocalTask(f.input, f.save({ ...f.read(s), commands: {} }))).rejects.toThrow(
      'task-snapshot-unconfirmed',
    );
    const b = localTaskActivities(f.registration, f.host, f.rpc, f.profile, () => {});
    await expect(b.activities.prepareLocalTask(f.input)).rejects.toThrow('task-permit-revoked');
  });
  it.each(['invalid-timeout', 'unknown-command', 'changed-profile'])(
    'rejects unsafe preparation: %s',
    async (defect) => {
      const f = fixture();
      if (defect === 'invalid-timeout')
        Object.assign(f.registration.commands.smoke, { timeoutMs: 0 });
      if (defect === 'unknown-command') f.registration.commands.smoke.executable = '';
      if (defect === 'changed-profile') f.input.executor.sha256 = '0'.repeat(64);
      else f.service = f.makeService();
      await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow();
      await f.service.controls.stopLocalTask(f.input);
      expect(f.state.starts).toBe(0);
    },
  );
  it('resolves a registered executable through PATH and pins its content', async () => {
    const f = fixture();
    const bin = join(f.root, 'path-bin'),
      executable = join(f.root, 'trusted-path-check'),
      content = '#!/bin/sh\nexit 0\n';
    mkdirSync(bin);
    writeFileSync(executable, content, { mode: 0o700 });
    symlinkSync(executable, join(bin, 'fixture-path-check'));
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    Object.assign(f.registration.commands.smoke, {
      executable: 'fixture-path-check',
      timeoutMs: 3000,
    });
    f.service = f.makeService();
    const s = await f.service.activities.prepareLocalTask(f.input);
    expect(f.read(s).commands).toMatchObject({
      smoke: { executable, timeoutMs: 3000, sha256: digest(content) },
    });
  });
  it('rejects an executable modified since preparation', async () => {
    const f = fixture();
    const executable = join(f.root, 'trusted-check');
    writeFileSync(executable, 'old');
    f.registration.commands.smoke.executable = executable;
    f.service = f.makeService();
    const s = await f.service.activities.prepareLocalTask(f.input);
    writeFileSync(executable, 'new');
    await expect(
      f.service.activities.checkLocalTask(f.input, s, 'baseline', null, null),
    ).rejects.toThrow('task-check-runtime-changed');
  });
  it.each(['signal', 'error', 'mutation'])(
    'retains actual check failure evidence: %s',
    async (defect) => {
      const f = fixture();
      vi.spyOn(checks, 'taskChecks').mockReturnValue({
        stop: vi.fn(),
        run: vi.fn<ReturnType<typeof checks.taskChecks>['run']>(async (cwd, command) => {
          if (defect === 'mutation') writeFileSync(join(cwd, 'owner.cjs'), 'changed');
          return {
            code: 0,
            signal: defect === 'signal' ? 'SIGTERM' : null,
            error: defect === 'error' ? 'failure' : null,
            stop: { confirmed: true as const, processes: [] },
            elapsedMs: 1,
            command,
            log: 'primary log',
          };
        }),
      });
      const s = await f.service.activities.prepareLocalTask(f.input),
        r = await f.service.activities.checkLocalTask(f.input, s, 'baseline', null, null);
      expect(r.status).toBe('FAIL');
      expect(f.read(r.manifest).outcomes).toHaveLength(1);
    },
  );
  it('rejects missing, stale or unconfirmed writer/integration/check evidence', async () => {
    const f = fixture(),
      { a, ref, writer } = await candidate(f);
    for (const [stage, w, i, message] of [
      ['candidate', null, null, 'task-check-writer-missing'],
      ['integrated', writer, null, 'task-integration-missing'],
      ['integrated', writer, f.save({}), 'task-integration-unconfirmed'],
      ['baseline', writer, null, 'task-baseline-binding'],
      ['unknown', null, null, 'task-check-stage'],
    ] as const)
      await expect(a.checkLocalTask(f.input, ref, stage as never, w, i)).rejects.toThrow(message);
    await expect(a.planLocalIntegration(f.input, ref, writer, f.proof)).rejects.toThrow();
    const bad = { ...writer, stop: f.save({ kind: 'task-writers-stopped', confirmed: false }) };
    await expect(a.checkLocalTask(f.input, ref, 'candidate', bad, null)).rejects.toThrow(
      'task-writer-stop-unconfirmed',
    );
    await expect(
      a.checkLocalTask(f.input, ref, 'candidate', { ...writer, tree: f.save({}) }, null),
    ).rejects.toThrow('task-copy-after-stop');
  });
  it('requires a nonempty result and an exact candidate tree', async () => {
    const f = fixture();
    f.state.write = false;
    const { a, ref, writer } = await candidate(f);
    const checks = await a.checkLocalTask(f.input, ref, 'candidate', writer, null);
    expect(checks.status).toBe('FAIL');
    const pass = f.save({ ...f.read(checks.manifest), status: 'PASS' });
    await expect(a.planLocalIntegration(f.input, ref, writer, pass)).rejects.toThrow(
      'task-result-empty',
    );
  });
  it('binds integration intent and receipt and retries exactly once without rewriting source', async () => {
    const f = fixture(),
      run = await throughIntegration(f);
    expect(await run.a.integrateLocalTask(f.input, run.snapshot, run.intent)).toEqual(
      run.integration,
    );
    writeFileSync(join(directory(f), 'integration-receipt.json'), '{}');
    await expect(run.a.integrateLocalTask(f.input, run.snapshot, run.intent)).rejects.toThrow(
      'task-integration-receipt-conflict',
    );
    writeFileSync(join(directory(f), 'integration-intent.json'), JSON.stringify(f.proof));
    await expect(run.a.integrateLocalTask(f.input, run.snapshot, run.intent)).rejects.toThrow(
      'task-integration-intent-changed',
    );
  });
  it('surfaces disk failure after integration instead of claiming a receipt', async () => {
    const f = fixture(),
      { a, ref, writer } = await candidate(f),
      check = await a.checkLocalTask(f.input, ref, 'candidate', writer, null),
      intent = await a.planLocalIntegration(f.input, ref, writer, check.manifest),
      original = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path.endsWith('integration-receipt.json'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return original(path, bytes);
    });
    await expect(a.integrateLocalTask(f.input, ref, intent)).rejects.toThrow('disk full');
  });
  it('does not declare stopped on a partial integration and leaves the source reservation held', async () => {
    const f = fixture(),
      { ref, writer } = await candidate(f),
      body = f.read(ref) as never;
    const files = (await import('../../src/adapters/project/taskFiles.js')).taskFiles(
      f.registration.artifactRoot,
    );
    const before = files.version(f.workspace, 'owner.cjs'),
      after = files.version((body as { copy: { root: string } }).copy.root, 'owner.cjs');
    writeFileSync(
      join(directory(f), 'integration-intent.json'),
      JSON.stringify(
        f.save({
          changes: [
            { path: 'owner.cjs', before, after },
            { path: 'consumer.cjs', before: files.version(f.workspace, 'consumer.cjs'), after },
          ],
          writer,
        }),
      ),
    );
    files.replace(f.workspace, 'owner.cjs', after);
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'task-partial-integration-unknown',
    );
    expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
  });
  it('requires the exact final packet, matching independent session and unchanged source before DONE', async () => {
    const f = fixture(),
      run = await throughIntegration(f),
      verdict = await acceptance(f, run);
    await expect(
      run.a.finishLocalTask(
        f.input,
        run.snapshot,
        { ...run.packet, reviewId: 'wrong' },
        verdict.manifest,
      ),
    ).rejects.toThrow('task-acceptance-binding');
    writeFileSync(join(f.workspace, 'consumer.cjs'), 'foreign');
    await expect(
      run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest),
    ).rejects.toThrow();
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).not.toContain('DONE');
  });
  it.each(['before', 'after', 'foreign'])(
    'recovers card projection after an interrupted completion: %s',
    async (state) => {
      const f = fixture(),
        run = await throughIntegration(f),
        verdict = await acceptance(f, run),
        original = artifacts.publishFile;
      let fail = true;
      vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (fail && path.endsWith('done.json')) {
          fail = false;
          throw new Error('projection reply lost');
        }
        return original(path, bytes);
      });
      await expect(
        run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest),
      ).rejects.toThrow('projection reply lost');
      const commit = f.read(
          JSON.parse(
            readFileSync(join(directory(f), 'completion-intent.json'), 'utf8'),
          ) as ArtifactRef,
        ),
        projection = f.read(commit.projection as ArtifactRef),
        card = join(f.workspace, 'tasks/one.md');
      if (state === 'before')
        writeFileSync(
          card,
          artifacts
            .artifactStore(f.registration.artifactRoot)
            .read((projection.before as { content: ArtifactRef }).content),
        );
      if (state === 'foreign') writeFileSync(card, 'foreign card');
      if (state === 'foreign') {
        await expect(
          run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest),
        ).rejects.toThrow('task-card-conflict');
        expect(readFileSync(card, 'utf8')).toBe('foreign card');
      } else {
        expect(
          (await run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest)).status,
        ).toBe('done');
        expect(readFileSync(card, 'utf8').match(/Результат: DONE/gu)).toHaveLength(1);
      }
    },
  );
  it('stops before preparation, after failed admission, and refuses an unknown orphan runtime', async () => {
    const f = fixture();
    expect(f.read(await f.service.controls.stopLocalTask(f.input))).toMatchObject({
      confirmed: true,
      kind: 'task-not-started',
    });
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'task-already-closed',
    );
    expect(f.state.creates).toBe(0);
    expect(f.state.starts).toBe(0);
    const other = fixture();
    other.input.executor.sha256 = '0'.repeat(64);
    await expect(other.service.activities.prepareLocalTask(other.input)).rejects.toThrow();
    writeFileSync(join(directory(other), 'writer-runtime.json'), '{}');
    await expect(other.service.controls.stopLocalTask(other.input)).rejects.toThrow(
      'task-writer-runtime-unknown',
    );
  });
  it('never treats a lost grant beside a prepared scope as an unstarted task', async () => {
    const f = fixture();
    await f.service.activities.prepareLocalTask(f.input);
    const root = directory(f),
      reservation = join(f.workspace, '.git/agent-workflow/source-reservation');
    unlinkSync(join(root, 'grant.json'));
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'task-writer-runtime-unknown',
    );
    expect(existsSync(join(root, 'stopped.json'))).toBe(false);
    expect(existsSync(reservation)).toBe(true);
  });
});
