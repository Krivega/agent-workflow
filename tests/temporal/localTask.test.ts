import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import { localTaskKey, parseLocalTask } from '../../src/policy/localTask.js';
afterEach(() => vi.restoreAllMocks());

import { throughIntegration, acceptance } from './localTaskRun.js';
import * as checks from '../../src/adapters/project/taskChecks.js';
describe('complete local B1 boundary', { timeout: 15000 }, () => {
  it('uses the captured workspace and commands when the caller mutates its registration', async () => {
    const f = localTaskFixture(),
      other = localTaskFixture();
    f.registration.workspaceRoot = other.workspace;
    f.registration.commands.smoke.executable = '';
    const snapshot = await f.service.activities.prepareLocalTask(f.input);
    expect(f.read(snapshot).source).toMatchObject({ root: f.workspace });
    expect(f.state.starts).toBe(0);
    expect(other.state.starts).toBe(0);
  });
  it('still stops its existing task when backend policy is lost', async () => {
    const f = localTaskFixture();
    declareBackendFixture(f.workspace);
    const home = taskBackendHome(f.workspace);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    reserveTaskBackend(f.workspace, {
      schemaVersion: 1,
      projectId: 'neutral',
      taskId: 'one',
      backend: 'temporal',
      cardName: 'one.md',
      origin: 'a'.repeat(64),
    });
    await f.service.activities.prepareLocalTask(f.input);
    unlinkSync(join(home, 'backend-policy.json'));
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'backend-policy-required',
    );
    expect(f.read(await f.service.controls.stopLocalTask(f.input)).confirmed).toBe(true);
  });
  it('keeps the simulator fail-closed on unknown RPCs and process roots', async () => {
    const f = localTaskFixture();
    expect(await f.processes.descendants([42])).toEqual([]);
    await expect(f.rpc.request('unknown', {})).rejects.toThrow('unexpected reader RPC');
    await expect(f.createRuntime(f.workspace).request('unknown', {})).rejects.toThrow(
      'unexpected writer RPC',
    );
    const runner = checks.taskChecks(join(f.root, 'checks'), f.processes),
      failed = await runner.run(f.workspace, {
        executable: join(f.root, 'missing-executable'),
        args: [],
        timeoutMs: 100,
      });
    expect(failed.code).toBeNull();
    expect(failed.log).toBe('');
  });
  it('writes only an isolated copy, stops the owned runtime, runs real checks, integrates and accepts independently', async () => {
    const f = localTaskFixture();
    let beforeImplement: unknown;
    f.state.beforeImplement = () => {
      const root = f.registration.artifactRoot;
      beforeImplement = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(root, entry.name), 'utf8'))
        .filter((raw) => raw.startsWith('{"kind":"task-writer-ready",'))
        .map((raw): unknown => JSON.parse(raw));
    };
    const run = await throughIntegration(f);
    expect(f.state.starts).toBe(3);
    expect(f.state.alive).toBe(false);
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toContain('trim');
    const verdict = await acceptance(f, run);
    expect(verdict.complete).toBe(true);
    const packetRef = (f.read(run.packet.request).evidence as Parameters<typeof f.read>[0][])[0]!,
      packet = f.read(packetRef),
      writerEvidence = packet.writer as Record<string, unknown>;
    expect(packetRef.bytes).toBeLessThan(24000);
    const original = f.read(writerEvidence.source as Parameters<typeof f.read>[0]);
    expect(writerEvidence.primary).toEqual((original.primary as { turn: unknown }).turn);
    expect(f.read(writerEvidence.load as Parameters<typeof f.read>[0])).toEqual(original.load);
    const ready = f.read(writerEvidence.ready as Parameters<typeof f.read>[0]);
    expect(beforeImplement).toEqual([ready]);
    expect(ready).toMatchObject({
      kind: 'task-writer-ready',
      session: run.writer.session,
      input: f.input,
      load: writerEvidence.load,
    });
    expect(writerEvidence.effectiveProfiles).toHaveLength(3);
    for (const log of packet.logs as Record<string, unknown>[]) {
      const primary = f.read(log.source as Parameters<typeof f.read>[0]);
      expect(log.log).toEqual(primary.log);
      expect(f.read(log.before as Parameters<typeof f.read>[0])).toEqual(primary.before);
      expect(f.read(log.after as Parameters<typeof f.read>[0])).toEqual(primary.after);
    }
    const result = await run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest);
    expect(result.status).toBe('done');
    expect(f.state.starts).toBe(5);
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).toContain('Результат: DONE');
    expect(
      await run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest),
    ).toEqual(result);
    await expect(
      run.a.finishLocalTask(
        f.input,
        run.snapshot,
        { ...run.packet, reviewId: 'foreign' },
        verdict.manifest,
      ),
    ).rejects.toThrow('task-completion-binding');
    await f.service.stopAll();
    expect(await f.service.controls.stopLocalTask(f.input)).toBeDefined();
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'task-already-closed',
    );
    const logs = f.read(run.checked.manifest).outcomes as { proof: Parameters<typeof f.read>[0] }[];
    expect(f.read(logs[1]!.proof).log).toContain('real validate PASS');
  });
  it('does not start a writer after a real failed baseline and retains a FAIL receipt', async () => {
    const f = localTaskFixture();
    writeFileSync(join(f.workspace, 'smoke.cjs'), "throw new Error('real baseline failure');");
    const raw = f.plan.consumers.find((r) => r.locator === 'smoke.cjs')!;
    const { digest } = await import('../../src/adapters/artifacts/files.js');
    raw.hash = digest(readFileSync(join(f.workspace, 'smoke.cjs')));
    const body = Buffer.from(JSON.stringify(f.plan));
    writeFileSync(join(f.workspace, 'plan.json'), body);
    f.input.admission.plan.sha256 = digest(body);
    const snapshot = await f.service.activities.prepareLocalTask(f.input),
      baseline = await f.service.activities.checkLocalTask(
        f.input,
        snapshot,
        'baseline',
        null,
        null,
      );
    expect(baseline.status).toBe('FAIL');
    expect(f.state.starts).toBe(0);
    await f.service.controls.stopLocalTask(f.input);
    await f.service.stopAll();
  });
  it.each(['outside', 'wrongProfile', 'compact'] as const)(
    'rejects %s before any integration or DONE',
    async (defect) => {
      const f = localTaskFixture();
      f.state[defect] = true;
      const snapshot = await f.service.activities.prepareLocalTask(f.input);
      await expect(f.service.activities.writeLocalTask(f.input, snapshot)).rejects.toThrow();
      await f.service.controls.stopLocalTask(f.input);
      expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).not.toContain('trim');
      expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).not.toContain('DONE');
    },
  );
  it('preserves an independent FAIL and refuses completion', async () => {
    const f = localTaskFixture(),
      run = await throughIntegration(f);
    f.state.verdict = 'FAIL';
    const verdict = await acceptance(f, run);
    expect(verdict.complete).toBe(false);
    await expect(
      run.a.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest),
    ).rejects.toThrow('task-acceptance-not-passed');
    await f.service.controls.stopLocalTask(f.input);
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).not.toContain('DONE');
  });
  it('conflicts with foreign source changes and never overwrites them', async () => {
    const f = localTaskFixture(),
      a = f.service.activities,
      snapshot = await a.prepareLocalTask(f.input),
      writer = await a.writeLocalTask(f.input, snapshot),
      checks = await a.checkLocalTask(f.input, snapshot, 'candidate', writer, null);
    const intent = await a.planLocalIntegration(f.input, snapshot, writer, checks.manifest);
    writeFileSync(join(f.workspace, 'owner.cjs'), 'foreign change');
    await expect(a.integrateLocalTask(f.input, snapshot, intent)).rejects.toThrow(
      'task-source-conflict',
    );
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toBe('foreign change');
  });
  it('checks versioned input and stable task identity before any effect', () => {
    const f = localTaskFixture();
    expect(localTaskKey(f.input)).toBe('aw/task/neutral/one');
    for (const patch of [
      { schemaVersion: 2 },
      { executor: { path: '../outside', sha256: f.input.executor.sha256 } },
      { baseline: 'invalid check' },
      { extra: 1 },
    ])
      expect(() => parseLocalTask({ ...f.input, ...patch })).toThrow();
    expect(readdirSync(f.workspace)).toContain('owner.cjs');
    expect(() => parseLocalTask(null as unknown as LocalTaskInput)).toThrow();
  });
});
