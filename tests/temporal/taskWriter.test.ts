import { join } from 'node:path';
import { readFileSync, writeFileSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import { correctionFixture } from './correctionFixture.js';
import { acceptance, runReview, throughIntegration } from './localTaskRun.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import { inspectTaskWriter, taskWriter } from '../../src/adapters/codex/taskWriter.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { taskChecks } from '../../src/adapters/project/taskChecks.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import type { TaskSnapshot } from '../../src/contracts/localTask.js';
import { controlRef } from '../../src/policy/readerControl.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';
import { defaultDataConverter } from '@temporalio/common';
type NativeContext = {
  cwd: string;
  model: string;
  effort: string;
  sandbox_policy: { network_access: boolean };
  permission_profile: {
    network: string;
    file_system: {
      type: string;
      entries: { access: string; path: { type: string; path: string } }[];
    };
  };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
type Rewrite = (
  method: string,
  result: unknown,
  params: Record<string, unknown>,
  root: string,
) => unknown;
function fixture(rewrite: Rewrite) {
  const f = localTaskFixture({ disabledServers: ['disabled'] });
  f.processes.wait = vi.fn(async () => {});
  f.host.createRuntime = (root) => {
    const base = f.createRuntime(root);
    return {
      ...base,
      request: async (method, params) =>
        rewrite(method, await base.request(method, params), params, root),
    };
  };
  return f;
}
async function rejected(f: ReturnType<typeof fixture>, reason?: string) {
  const ref = await f.service.activities.prepareLocalTask(f.input);
  await expect(f.service.activities.writeLocalTask(f.input, ref)).rejects.toThrow(reason);
  return ref;
}
async function preparedWriter(f: ReturnType<typeof fixture>) {
  const ref = await f.service.activities.prepareLocalTask(f.input);
  const body = f.read(ref) as unknown as TaskSnapshot;
  const directory = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    artifacts.digest(localTaskKey(f.input)),
  );
  const grant = JSON.parse(readFileSync(join(directory, 'grant.json'), 'utf8')) as {
    instance: string;
  };
  const gate = taskGate(
    body.input,
    body.source,
    f.profile,
    f.registration.artifactRoot,
    grant.instance,
  );
  const files = taskFiles(f.registration.artifactRoot);
  const factory = vi.fn(f.host.createRuntime);
  const adapter = taskWriter(body, files, gate, factory, f.processes, vi.fn());
  return { ref, body, directory, gate, files, factory, adapter };
}
describe('writer native profile, primary proof and physical stop', { timeout: 15000 }, () => {
  it('sends the exact shared LOAD v4 instruction and preserves accepted RPC JSONL before implement', async () => {
    let sentLoad = '';
    let primaryLoad: unknown;
    const f = fixture((method, response, params) => {
      if (method === 'turn/start') {
        const message = (params.input as { text: string }[])[0]!.text;
        if (message.includes('Пути и хеши: ')) sentLoad = message;
      }
      if (method === 'thread/read') {
        const raw = response as { thread: { turns: { id: string }[] } };
        const turn = raw.thread.turns.find((turn) => turn.id === 'writer-turn-2');
        if (turn !== undefined) primaryLoad = structuredClone(turn);
      }
      return response;
    });
    const snapshot = await f.service.activities.prepareLocalTask(f.input);
    const body = f.read(snapshot) as unknown as TaskSnapshot;
    const refs = body.tree.files.map((file) => ({
      path: join(body.copy.root, file.path),
      sha256: file.version.content.sha256,
    }));
    const written = await f.service.activities.writeLocalTask(f.input, snapshot);
    expect(sentLoad.slice(sentLoad.indexOf('\n') + 1)).toBe(readerLoadPrompt(refs, 4));
    expect(sentLoad).toContain('text(await tools.exec_command({cmd:');
    const answer = f.read(written.answer);
    expect((answer.load as { turn: unknown }).turn).toEqual(primaryLoad);
    expect(f.state.starts).toBe(3);
  });

  it('rejects the live JSON-array LOAD failure shape even with raw JSONL text and never starts implement', async () => {
    const f = fixture((method, response) => {
      if (method !== 'thread/read') return response;
      const raw = response as {
        thread: { turns: { id: string; items: Record<string, unknown>[] }[] };
      };
      const load = raw.thread.turns.find((turn) => turn.id === 'writer-turn-2');
      if (load !== undefined) {
        const command = load.items.find((item) => item.type === 'commandExecution')!;
        const jsonl = String(command.aggregatedOutput);
        command.aggregatedOutput = JSON.stringify(
          jsonl.split('\n').map((line) => JSON.parse(line) as unknown),
        );
        load.items.push({ type: 'agentMessage', text: jsonl });
      }
      return response;
    });
    const implement = vi.fn();
    f.state.beforeImplement = implement;
    await rejected(f, 'reader-load-unconfirmed');
    expect(implement).not.toHaveBeenCalled();
    expect(f.state.starts).toBe(2);
  });

  it('observes a revoked no-start stop before the first writer and rejects corrupted retained markers without effects', async () => {
    const f = fixture((_method, response) => response),
      ref = await f.service.activities.prepareLocalTask(f.input),
      stop = await f.service.controls.stopLocalTask(f.input),
      body = JSON.parse(f.store.read(ref).toString()) as TaskSnapshot,
      directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        artifacts.digest(localTaskKey(f.input)),
      ),
      receipt = controlRef(f.read(stop).writer),
      files = taskFiles(f.registration.artifactRoot, { existingOnly: true }),
      published = vi.spyOn(artifacts, 'publishFile');
    expect(await inspectTaskWriter(body, files, directory, f.processes)).toMatchObject({
      status: 'stopped',
      receipt,
      runtime: { session: null, processes: [] },
    });
    expect(f.read(receipt)).toMatchObject({ notStarted: true, confirmed: true });
    expect(existsSync(join(directory, 'runtime-identity.json'))).toBe(false);
    writeFileSync(join(directory, 'writer-runtime.json'), '{corrupted');
    await expect(inspectTaskWriter(body, files, directory, f.processes)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(published).not.toHaveBeenCalled();
    published.mockRestore();
    unlinkSync(join(directory, 'writer-runtime.json'));
    for (const patch of [{ schemaVersion: 1 }, { notStarted: false }]) {
      const changed = f.save({ ...f.read(receipt), ...patch });
      writeFileSync(join(directory, 'writer-stopped.json'), JSON.stringify(changed));
      expect(await inspectTaskWriter(body, files, directory, f.processes)).toMatchObject({
        status: 'unknown',
        reason: 'task-writer-start-not-observed',
      });
    }
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('binds an unstarted stop to the failed baseline and rejects changed evidence or a later write', async () => {
    const f = fixture((_method, response) => response);
    f.state.alive = false;
    vi.mocked(taskChecks).mockImplementation(() => ({
      stop: async () => [],
      run: async (cwd, command) => {
        writeFileSync(join(cwd, 'baseline-cache'), 'original cache');
        return {
          command,
          code: 127,
          signal: null,
          error: null,
          elapsedMs: 1,
          log: 'missing test runner',
          stop: { confirmed: true, processes: [{ pid: 42, parent: 41, started: 'start' }] },
        };
      },
    }));
    const ref = await f.service.activities.prepareLocalTask(f.input);
    const body = f.read(ref) as unknown as TaskSnapshot;
    const checked = await f.service.activities.checkLocalTask(f.input, ref, 'baseline', null, null);
    expect(checked.status).toBe('FAIL');
    const dir = join(
      f.workspace,
      '.git/agent-workflow/tasks',
      artifacts.digest(localTaskKey(f.input)),
    );
    const files = taskFiles(f.registration.artifactRoot);
    const checkPath = join(dir, 'checks-baseline.json');
    const cache = join(body.copy.root, 'baseline-cache');
    const stop = () => f.service.controls.stopLocalTask(f.input);
    f.state.alive = true;
    await expect(stop()).rejects.toThrow('task-recovery-check-live');
    expect(existsSync(join(dir, 'writer-stopped.json'))).toBe(false);
    f.state.alive = false;
    unlinkSync(cache);
    await expect(stop()).rejects.toThrow('task-baseline-stop-binding');
    writeFileSync(cache, 'late mutation', { mode: 0o644 });
    await expect(stop()).rejects.toThrow('task-baseline-stop-binding');
    writeFileSync(cache, 'original cache');
    const wrongIntent = join(dir, 'checks-baseline-intent.json');
    const originalIntent = readFileSync(wrongIntent);
    writeFileSync(wrongIntent, '{}');
    await expect(stop()).rejects.toThrow('task-baseline-stop-binding');
    writeFileSync(wrongIntent, originalIntent);
    const stopped = await stop();
    const receipt = controlRef(f.read(stopped).writer);
    expect(await stop()).toEqual(stopped);
    expect(f.read(receipt)).toMatchObject({
      notStarted: true,
      baseline: checked.manifest,
      before: body.tree,
      after: files.observeTree(body.copy.root),
    });
    const inspect = () => inspectTaskWriter(body, files, dir, f.processes);
    expect(await inspect()).toMatchObject({ status: 'stopped', receipt });
    unlinkSync(checkPath);
    await expect(inspect()).rejects.toThrow('task-late-writer');
    writeFileSync(checkPath, JSON.stringify(checked), { mode: 0o600 });
    writeFileSync(cache, 'another mutation');
    await expect(stop()).rejects.toThrow('task-late-writer');
    await expect(inspect()).rejects.toThrow('task-late-writer');
    expect(f.state.creates).toBe(0);
  });
  it('reuses a retained bound physical stop after observer loss without starting a runtime or writing inspection evidence', async () => {
    const f = fixture((_m, r) => r),
      snapshotRef = await f.service.activities.prepareLocalTask(f.input),
      written = await f.service.activities.writeLocalTask(f.input, snapshotRef),
      body = JSON.parse(f.store.read(snapshotRef).toString()) as TaskSnapshot,
      directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        artifacts.digest(localTaskKey(f.input)),
      ),
      grant = JSON.parse(readFileSync(join(directory, 'grant.json'), 'utf8')) as {
        instance: string;
      },
      gate = taskGate(
        body.input,
        body.source,
        f.profile,
        f.registration.artifactRoot,
        grant.instance,
      ),
      files = taskFiles(f.registration.artifactRoot),
      factory = vi.fn(f.createRuntime),
      published = vi.spyOn(artifacts, 'publishFile');
    expect(await inspectTaskWriter(body, files, directory, f.processes)).toMatchObject({
      status: 'stopped',
      receipt: written.stop,
    });
    expect(published).not.toHaveBeenCalled();
    const recovered = taskWriter(body, files, gate, factory, f.processes, vi.fn());
    expect(await recovered.stop()).toEqual(written.stop);
    expect(factory).not.toHaveBeenCalled();
    expect(f.state.starts).toBe(3);
    expect(f.state.creates).toBe(1);
    writeFileSync(join(body.copy.root, 'owner.cjs'), 'late mutation');
    const changed = taskWriter(body, files, gate, factory, f.processes, vi.fn());
    await expect(changed.stop()).rejects.toThrow('task-late-writer');
    expect(factory).not.toHaveBeenCalled();
  });
  it('inspects an unstarted correction against its shared revoked grant', async () => {
    const f = correctionFixture();
    f.processes.wait = vi.fn(async () => {});
    const input = f.correctionInput;
    const planning = await f.service.activities.prepareSubstantialPlanning(input);
    const approved = await runReview(f, planning);
    const first = await throughIntegration(f, input, approved.manifest);
    const failed = await acceptance(f, first);
    const next = await f.service.activities.prepareLocalCorrection(
      input,
      first.snapshot,
      first.packet,
      failed.manifest,
    );
    const stopped = await f.service.controls.stopLocalTask(input);
    expect(await f.service.controls.stopLocalTask(input)).toEqual(stopped);
    const body = f.read(next) as unknown as TaskSnapshot;
    const directory = join(
      f.workspace,
      '.git/agent-workflow/tasks',
      artifacts.digest(localTaskKey(input)),
      'corrections',
      '1',
    );
    const observed = await inspectTaskWriter(
      body,
      taskFiles(f.registration.artifactRoot),
      directory,
      f.processes,
    );
    expect(observed.status).toBe('stopped');
    expect(f.state.creates).toBe(1);
  });
  it('reconciles startup children that exited before STOP and observes their original identities', async () => {
    const f = fixture((_m, r) => r);
    const { ref, body, directory, files } = await preparedWriter(f);
    const written = await f.service.activities.writeLocalTask(f.input, ref);
    const root = { pid: 999991, parent: 1, started: 'fixture' };
    const child = { pid: 999992, parent: root.pid, started: 'early child' };
    const grandchild = { pid: 999993, parent: child.pid, started: 'early grandchild' };
    const stop = f.read(written.stop);
    const inspect = () => inspectTaskWriter(body, files, directory, f.processes);
    function bind(initial: (typeof root)[]) {
      writeFileSync(
        join(directory, 'runtime-identity.json'),
        JSON.stringify({ processes: initial, session: null }),
      );
      writeFileSync(
        join(directory, 'writer-stopped.json'),
        JSON.stringify(
          f.save({
            ...stop,
            runtime: { processes: initial, session: written.session },
          }),
        ),
      );
    }
    bind([grandchild, root, child]);
    expect(await inspect()).toMatchObject({ status: 'stopped' });
    f.processes.alive.mockImplementationOnce(async (ids) =>
      ids.filter((p) => p.pid === grandchild.pid),
    );
    expect(await inspect()).toMatchObject({ status: 'live', processes: [grandchild] });
    bind([root, { ...child, parent: 1 }]);
    await expect(inspect()).rejects.toThrow('task-writer-stop-binding');
    bind([{ ...root, started: 'reused' }]);
    await expect(inspect()).rejects.toThrow('task-writer-stop-binding');
  });
  it('keeps live, missing and unbound retained writers blocked without a new effect', async () => {
    const f = fixture((_m, r) => r),
      snapshotRef = await f.service.activities.prepareLocalTask(f.input),
      written = await f.service.activities.writeLocalTask(f.input, snapshotRef),
      body = JSON.parse(f.store.read(snapshotRef).toString()) as TaskSnapshot,
      directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        artifacts.digest(localTaskKey(f.input)),
      ),
      stopFile = join(directory, 'writer-stopped.json'),
      stop = f.read(written.stop),
      observe = () =>
        inspectTaskWriter(body, taskFiles(f.registration.artifactRoot), directory, f.processes);
    f.state.alive = true;
    expect(await observe()).toMatchObject({ status: 'live' });
    unlinkSync(stopFile);
    expect(await observe()).toMatchObject({ status: 'live' });
    f.state.alive = false;
    expect(await observe()).toEqual({ status: 'unknown', reason: 'task-writer-stop-unconfirmed' });
    for (const change of [
      { input: { ...body.input, baseline: 'foreign' } },
      { source: { ...body.source, ino: 'foreign' } },
      { copy: { ...body.copy, root: f.workspace } },
      { before: null },
      { session: 'foreign' },
      { runtime: { processes: [], session: null } },
    ]) {
      writeFileSync(stopFile, JSON.stringify(f.save({ ...stop, ...change })));
      await expect(observe()).rejects.toThrow();
    }
    writeFileSync(stopFile, JSON.stringify(f.save({ ...stop, schemaVersion: 1 })));
    expect(await observe()).toEqual({
      status: 'unknown',
      reason: 'task-writer-stop-binding-unknown',
    });
    unlinkSync(stopFile);
    unlinkSync(join(directory, 'runtime-identity.json'));
    expect(await observe()).toEqual({ status: 'unknown', reason: 'task-writer-process-unknown' });
    unlinkSync(join(directory, 'writer-runtime.json'));
    expect(await observe()).toEqual({
      status: 'unknown',
      reason: 'task-writer-start-not-observed',
    });
    expect(f.state.starts).toBe(3);
    expect(f.state.creates).toBe(1);
  });
  it.each([null, 'disabled'])(
    'allows only an explicitly disabled empty server inventory: %s',
    async (runtimeStatus) => {
      const f = fixture((method, result) => {
        if (method === 'mcpServerStatus/list')
          return {
            data: [
              {
                name: 'disabled',
                pluginId: null,
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                runtimeStatus,
              },
            ],
            nextCursor: null,
          };
        if (method === 'thread/backgroundTerminals/list')
          return { data: [{ osPid: null }, { osPid: 999991 }], nextCursor: null };
        if (method === 'thread/start')
          (result as { sandbox: { writableRoots: string[] } }).sandbox.writableRoots = [];
        return result;
      });
      f.host.disabledServers = ['disabled'];
      vi.stubEnv('PATH', undefined);
      const s = await f.service.activities.prepareLocalTask(f.input);
      expect((await f.service.activities.writeLocalTask(f.input, s)).session).toBe('writer');
    },
  );
  it('accepts a terminal only when its PID belongs to the verified owned tree', async () => {
    const child = { pid: 999992, parent: 999991, started: 'owned-child' };
    const f = fixture((method, response) =>
      method === 'thread/backgroundTerminals/list'
        ? { data: [{ osPid: child.pid }], nextCursor: null }
        : response,
    );
    f.processes.descendants.mockImplementation(async () => [
      { pid: 999991, parent: 1, started: 'fixture' },
      ...(f.state.starts === 3 ? [child] : []),
    ]);
    const snapshot = await f.service.activities.prepareLocalTask(f.input);
    const result = await f.service.activities.writeLocalTask(f.input, snapshot);
    expect(f.processes.descendants).toHaveBeenLastCalledWith([999991]);
    expect(f.processes.terminate).toHaveBeenCalledWith([
      { pid: 999991, parent: 1, started: 'fixture' },
      child,
    ]);
    expect(f.read(result.stop)).toMatchObject({
      confirmed: true,
      processes: [expect.anything(), child],
    });
  });
  it.each(['unbound', 'reused'])(
    'cleans only the owned tree and refuses a normal stop for a %s terminal',
    async (kind) => {
      const root = { pid: 999991, parent: 1, started: 'fixture' };
      const foreign = { pid: 999992, parent: 1, started: kind + '-foreign-process' };
      const f = fixture((method, response) =>
        method === 'thread/backgroundTerminals/list'
          ? { data: [{ osPid: foreign.pid }], nextCursor: null }
          : response,
      );
      f.processes.descendants.mockImplementation(async (roots) => [
        root,
        ...(roots.includes(foreign.pid) ? [foreign] : []),
      ]);
      await rejected(f, 'task-terminal-process-identity-unknown');
      expect(f.processes.descendants).toHaveBeenLastCalledWith([root.pid]);
      expect(f.processes.terminate).toHaveBeenCalledExactlyOnceWith([root]);
      expect(f.state.alive).toBe(false);
      const directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        artifacts.digest(localTaskKey(f.input)),
      );
      expect(existsSync(join(directory, 'writer-stopped.json'))).toBe(false);
      expect(existsSync(join(directory, 'writer-result.json'))).toBe(false);
      expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
    },
  );
  it('does not signal a retained PID reused between alive and descendants and preserves both failures', async () => {
    const root = { pid: 999991, parent: 1, started: 'fixture' };
    const child = { pid: 999992, parent: root.pid, started: 'owned-child' };
    const history = new Error('history-unavailable');
    let reused = false;
    const f = fixture((method, response) => {
      if (method === 'thread/read') throw history;
      return response;
    });
    f.processes.descendants.mockImplementation(async () => [
      root,
      reused ? { ...child, started: 'foreign-reused-start' } : child,
    ]);
    f.processes.alive.mockImplementation(async (ids) => {
      if (ids.some((p) => p.pid === child.pid)) reused = true;
      return ids;
    });
    await rejected(f, history.message);
    const failed: unknown = await f.service.controls
      .stopLocalTask(f.input)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AggregateError);
    if (!(failed instanceof AggregateError)) throw new Error('aggregate failure missing');
    expect(f.processes.terminate).not.toHaveBeenCalled();
    expect(failed.errors).toEqual([history, new Error('task-process-identity-changed')]);
    const { failureConverter, payloadConverter } = defaultDataConverter;
    const restored = failureConverter.failureToError(
      failureConverter.errorToFailure(failed, payloadConverter),
      payloadConverter,
    );
    expect(restored.message).toBe(history.message);
    if (!(restored.cause instanceof Error)) throw new Error('serialized cause missing');
    expect(JSON.parse(restored.cause.message)).toEqual({
      primary: history.message,
      physical: 'task-process-identity-changed',
      physicalCause: null,
    });
    expect(f.state.alive).toBe(true);
    expect(f.state.starts).toBe(1);
  });
  it('interrupts an active primary turn and waits for its terminal state before physical stop', async () => {
    let interrupted = false;
    const methods: string[] = [];
    const f = localTaskFixture();
    f.processes.wait = vi.fn(async () => {});
    f.host.createRuntime = (root) => {
      const base = f.createRuntime(root);
      return {
        ...base,
        async request(method, params) {
          methods.push(method);
          if (method === 'turn/interrupt') {
            interrupted = true;
            return {};
          }
          const raw = await base.request(method, params);
          if (method === 'thread/read') {
            const t = raw as { thread: { turns: { status: string }[] } };
            t.thread.turns[0]!.status = interrupted ? 'interrupted' : 'inProgress';
          }
          return raw;
        },
      };
    };
    await rejected(f as ReturnType<typeof fixture>, 'task-turn-unconfirmed');
    await f.service.controls.stopLocalTask(f.input);
    expect(methods).toContain('turn/interrupt');
    expect(f.state.alive).toBe(false);
  });
  it.each(['same', 'conflict', 'disk'])('retains stop publication outcome: %s', async (kind) => {
    const f = fixture((_m, r) => r),
      original = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path.endsWith('writer-stopped.json')) {
        if (kind === 'disk') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        original(path, kind === 'same' ? bytes : Buffer.from('{}'));
        throw Object.assign(new Error('already published'), { code: 'EEXIST' });
      }
      return original(path, bytes);
    });
    const s = await f.service.activities.prepareLocalTask(f.input);
    if (kind === 'same')
      expect((await f.service.activities.writeLocalTask(f.input, s)).session).toBe('writer');
    else
      await expect(f.service.activities.writeLocalTask(f.input, s)).rejects.toThrow(
        kind === 'disk' ? 'disk full' : 'task-stop-conflict',
      );
  });
  it.each(['cursor', 'tools', 'plugin', 'resources', 'templates', 'server', 'foreign', 'running'])(
    'rejects an unknown or active external tool inventory: %s',
    async (defect) => {
      const f = fixture((method, result) => {
        if (method !== 'mcpServerStatus/list') return result;
        const s = {
          name: 'disabled',
          pluginId: null,
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          runtimeStatus: null,
        };
        f.host.disabledServers = ['disabled'];
        if (defect === 'cursor') return { data: [], nextCursor: 'next' };
        if (defect === 'tools') s.tools = { secret: {} };
        if (defect === 'plugin') s.pluginId = 'plugin' as never;
        if (defect === 'resources') s.resources = ['secret'] as never;
        if (defect === 'templates') s.resourceTemplates = ['secret'] as never;
        if (defect === 'server') s.serverInfo = {} as never;
        if (defect === 'foreign') s.name = 'foreign';
        if (defect === 'running') s.runtimeStatus = 'running' as never;
        return { data: [s], nextCursor: null };
      });
      f.host.disabledServers = ['disabled'];
      await rejected(f);
      expect(f.state.starts).toBe(0);
      await f.service.controls.stopLocalTask(f.input);
    },
  );
  it.each(['model', 'effort', 'cwd', 'approval', 'network', 'fork', 'roots', 'slash', 'tmpdir'])(
    'refuses thread/start profile mismatch before a model: %s',
    async (defect) => {
      const f = fixture((method, result) => {
        if (method !== 'thread/start') return result;
        const raw = result as {
          model: string;
          reasoningEffort: string;
          cwd: string;
          approvalPolicy: string;
          sandbox: Record<string, unknown>;
          thread: Record<string, unknown>;
        };
        if (defect === 'model') raw.model = 'other';
        if (defect === 'effort') raw.reasoningEffort = 'low';
        if (defect === 'cwd') raw.cwd = 'other';
        if (defect === 'approval') raw.approvalPolicy = 'on-request';
        if (defect === 'network') raw.sandbox.networkAccess = true;
        if (defect === 'fork') raw.thread.forkedFromId = 'parent';
        if (defect === 'roots') raw.sandbox.writableRoots = [f.workspace];
        if (defect === 'slash') raw.sandbox.excludeSlashTmp = false;
        if (defect === 'tmpdir') raw.sandbox.excludeTmpdirEnvVar = false;
        return raw;
      });
      await rejected(f, 'task-writer-profile');
      expect(f.state.starts).toBe(0);
      await f.service.controls.stopLocalTask(f.input);
    },
  );
  it.each([
    'partial',
    'metadata',
    'missing-context',
    'cwd',
    'model',
    'effort',
    'network',
    'permissions',
    'filesystem',
    'root',
    'read-only',
    'alias',
  ])('requires effective primary transcript evidence: %s', async (defect) => {
    const f = fixture((method, result, _params, root) => {
      if (method === 'turn/start') {
        const path = join(f.root, 'writer-transcript.jsonl'),
          records = readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s) as { payload: Record<string, unknown> });
        const meta = records[0]!.payload,
          ctx = records[1]!.payload as unknown as NativeContext;
        if (defect === 'partial') {
          writeFileSync(path, JSON.stringify(records[0]));
          return result;
        }
        if (defect === 'metadata') meta.cli_version = 'other';
        if (defect === 'missing-context') records.splice(1);
        if (defect === 'cwd') ctx.cwd = f.workspace;
        if (defect === 'model') ctx.model = 'other';
        if (defect === 'effort') ctx.effort = 'low';
        if (defect === 'network') ctx.sandbox_policy.network_access = true;
        if (defect === 'permissions') ctx.permission_profile.network = 'enabled';
        if (defect === 'filesystem') ctx.permission_profile.file_system.type = 'unrestricted';
        if (defect === 'root')
          ctx.permission_profile.file_system.entries[0]!.path.path = f.workspace;
        if (defect === 'read-only')
          ctx.permission_profile.file_system.entries = [
            { access: 'read', path: { type: 'path', path: root } },
          ];
        writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
      if (method === 'thread/read' && defect === 'alias') {
        const path = join(f.root, 'alias-transcript');
        if (!existsSync(path)) {
          symlinkSync(join(f.root, 'writer-transcript.jsonl'), path);
        }
        (result as { thread: { path: string } }).thread.path = path;
      }
      return result;
    });
    await rejected(f);
    expect(f.state.starts).toBe(1);
    await f.service.controls.stopLocalTask(f.input);
  });
  it.each([
    'history-id',
    'history-turns',
    'turn-status',
    'duplicate',
    'no-answer',
    'load-bytes',
    'premature',
  ])('rejects incomplete or untrusted primary output: %s', async (defect) => {
    const f = fixture((method, result, _params, root) => {
      if (method === 'turn/start' && defect === 'premature')
        writeFileSync(join(root, 'owner.cjs'), 'premature');
      if (method !== 'thread/read') return result;
      const t = (
        result as {
          thread: {
            id: string;
            turns: { id: string; status: string; items: Record<string, unknown>[] }[];
          };
        }
      ).thread;
      if (defect === 'history-id') t.id = 'other';
      if (defect === 'history-turns') t.turns = null as never;
      if (defect === 'turn-status' && t.turns[0]) t.turns[0].status = 'failed';
      if (defect === 'duplicate' && t.turns[0]) t.turns.push(t.turns[0]);
      if (defect === 'no-answer' && t.turns[2]) t.turns[2].items = [];
      if (defect === 'load-bytes' && t.turns[1]) t.turns[1].items = [];
      return result;
    });
    await rejected(f);
  });
  it('requires an advertised model/effort and stops a known precreation runtime', async () => {
    const f = fixture((method, result) => (method === 'model/list' ? { data: [] } : result));
    await rejected(f, 'task-model-unavailable');
    await f.service.controls.stopLocalTask(f.input);
    expect(f.state.starts).toBe(0);
    expect(f.state.alive).toBe(false);
  });
  it('does not adopt an unknown thread/start or create it a second time', async () => {
    const f = fixture((method, result) => {
      if (method === 'thread/start') throw new Error('creation reply lost');
      return result;
    });
    const s = await rejected(f, 'creation reply lost');
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'task-create-outcome-unknown',
    );
    await expect(f.service.activities.writeLocalTask(f.input, s)).rejects.toThrow();
    expect(f.state.creates).toBe(1);
    expect(f.state.alive).toBe(false);
  });
  it('retains a lost turn/start as unknown rather than starting another writer', async () => {
    let admitted: Record<string, unknown> | undefined;
    const f = fixture((method, result) => {
      if (method === 'turn/start') throw new Error('turn reply lost');
      return result;
    });
    const factory = f.host.createRuntime;
    f.host.createRuntime = (root) => {
      const runtime = factory(root);
      return {
        ...runtime,
        admitTurn: async (params) => {
          admitted = params;
        },
        request: async (method, params) => {
          if (method === 'turn/start') expect(params).toBe(admitted);
          return runtime.request(method, params);
        },
      };
    };
    const s = await rejected(f, 'turn reply lost');
    await f.service.controls.stopLocalTask(f.input);
    await expect(f.service.activities.writeLocalTask(f.input, s)).rejects.toThrow();
    expect(f.state.starts).toBe(1);
  });
  it('stops a first admission refusal without requesting unsupported native history', async () => {
    const methods: string[] = [];
    const f = fixture((method, result) => {
      methods.push(method);
      if (method === 'thread/read') throw new Error('list_turns is not supported yet');
      return result;
    });
    const factory = f.host.createRuntime;
    const admit = vi.fn(async () => {
      throw new Error('admission-refused');
    });
    f.host.createRuntime = (root) => ({ ...factory(root), admitTurn: admit });
    const snapshot = await rejected(f, 'admission-refused');
    await f.service.controls.stopLocalTask(f.input);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(methods).not.toContain('turn/start');
    expect(methods).not.toContain('thread/read');
    expect(f.state.starts).toBe(0);
    expect(f.state.alive).toBe(false);
    await expect(f.service.activities.writeLocalTask(f.input, snapshot)).rejects.toThrow();
    expect(f.state.creates).toBe(1);
  });
  it('still requires native history after a later admission refusal', async () => {
    let histories = 0;
    const f = fixture((method, result) => {
      if (method === 'thread/read' && ++histories > 1)
        throw new Error('list_turns is not supported yet');
      return result;
    });
    const factory = f.host.createRuntime;
    const admit = vi.fn(async () => {
      if (admit.mock.calls.length > 1) throw new Error('second-admission-refused');
    });
    f.host.createRuntime = (root) => ({ ...factory(root), admitTurn: admit });
    await rejected(f, 'second-admission-refused');
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'list_turns is not supported yet',
    );
    expect(f.state.starts).toBe(1);
    expect(f.processes.terminate).toHaveBeenCalledTimes(1);
    expect(f.state.alive).toBe(false);
  });
  it.each(['known', 'lost'])(
    'keeps logical stop unknown but physically cleans up after unavailable primary history, send=%s',
    async (send) => {
      const history = new Error(
        'app-server-error:{"code":-32601,"message":"list_turns is not supported yet"}',
      );
      const f = fixture((method, response) => {
        if (send === 'lost' && method === 'turn/start') throw new Error('turn response lost');
        if (method === 'thread/read') throw history;
        return response;
      });
      const snapshot = await rejected(f, send === 'lost' ? 'turn response lost' : history.message);
      await expect(f.service.controls.stopLocalTask(f.input)).rejects.toBe(history);
      expect(f.processes.terminate).toHaveBeenCalledTimes(1);
      expect(f.state.alive).toBe(false);
      const directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        artifacts.digest(localTaskKey(f.input)),
      );
      expect(existsSync(join(directory, 'writer-stopped.json'))).toBe(false);
      expect(existsSync(join(directory, 'writer-result.json'))).toBe(false);
      expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
      expect(
        await inspectTaskWriter(
          f.read(snapshot) as unknown as TaskSnapshot,
          taskFiles(f.registration.artifactRoot),
          directory,
          f.processes,
        ),
      ).toEqual({ status: 'unknown', reason: 'task-writer-stop-unconfirmed' });
      await expect(f.service.activities.writeLocalTask(f.input, snapshot)).rejects.toThrow();
      expect(f.state.creates).toBe(1);
      expect(f.state.starts).toBe(1);
    },
  );
  it.each(['loaded', 'terminals', 'interrupt', 'completion', 'final-history'])(
    'cleans up owned processes when the stop %s operation fails',
    async (stage) => {
      let stopping = false;
      let histories = 0;
      const failure = new Error('stop-' + stage + '-failed');
      const f = fixture((method, response) => {
        if (!stopping && method === 'thread/read') throw new Error('writer observation lost');
        if (stopping) {
          if (stage === 'completion' && method === 'thread/backgroundTerminals/list')
            return { data: [{ osPid: 999992 }], nextCursor: null };
          if (
            (stage === 'loaded' && method === 'thread/loaded/list') ||
            (stage === 'terminals' && method === 'thread/backgroundTerminals/list') ||
            (stage === 'final-history' && method === 'thread/read' && ++histories > 1)
          )
            throw failure;
          if ((stage === 'interrupt' || stage === 'completion') && method === 'thread/read') {
            const value = response as { thread: { turns: { status: string }[] } };
            value.thread.turns[0]!.status = 'inProgress';
          }
        }
        return response;
      });
      if (stage === 'completion')
        f.processes.descendants.mockImplementation(async (roots) => [
          { pid: 999991, parent: 1, started: 'fixture' },
          ...(roots.includes(999992)
            ? [{ pid: 999992, parent: 1, started: 'foreign-reused-terminal' }]
            : []),
        ]);
      const factory = f.host.createRuntime;
      f.host.createRuntime = (root) => {
        const base = factory(root);
        return {
          ...base,
          request: async (method, params) => {
            if (stopping && method === 'turn/interrupt') {
              if (stage === 'interrupt') throw failure;
              return {};
            }
            return base.request(method, params);
          },
          completed: async (thread, turn, signal) => {
            if (stopping && stage === 'completion') throw failure;
            await base.completed(thread, turn, signal);
          },
        };
      };
      await rejected(f, 'writer observation lost');
      stopping = true;
      await expect(f.service.controls.stopLocalTask(f.input)).rejects.toBe(failure);
      expect(f.processes.terminate).toHaveBeenCalledTimes(1);
      expect(f.processes.terminate).toHaveBeenCalledWith([
        { pid: 999991, parent: 1, started: 'fixture' },
      ]);
      expect(f.state.alive).toBe(false);
      expect(f.state.starts).toBe(1);
    },
  );
  it.each(['errors', 'plain-errors', 'strings', 'objects', 'bounded'])(
    'retains primary and physical failures across the SDK converter for %s',
    async (kind) => {
      const diagnostic = JSON.stringify({
        reason: 'reused',
        expectedPID: 999991,
        expectedStart: 'fixture',
        observed: { pid: 999991, parent: 1, started: 'changed' },
      });
      const primary: unknown =
        kind === 'strings'
          ? 'history-string'
          : kind === 'objects'
            ? Object.create(null)
            : new Error(kind === 'bounded' ? 'h'.repeat(5000) : 'history-unavailable');
      const physical: unknown =
        kind === 'plain-errors'
          ? new Error('physical-cleanup-failed', { cause: { unrecognized: true } })
          : kind === 'strings'
            ? 'physical-string'
            : kind === 'objects'
              ? { unrecognized: true }
              : new Error('writer-process-identity-lost', {
                  cause: new Error(kind === 'bounded' ? 'p'.repeat(5000) : diagnostic),
                });
      const f = fixture((method, response) => {
        if (method === 'thread/read') throw primary;
        return response;
      });
      const snapshot = await f.service.activities.prepareLocalTask(f.input);
      await expect(f.service.activities.writeLocalTask(f.input, snapshot)).rejects.toBe(primary);
      f.processes.terminate.mockRejectedValueOnce(physical);
      const failed: unknown = await f.service.controls
        .stopLocalTask(f.input)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(AggregateError);
      if (!(failed instanceof AggregateError)) throw new Error('aggregate failure missing');
      expect(failed.errors).toEqual([primary, physical]);
      const message = (failure: unknown) =>
        failure instanceof Error
          ? failure.message
          : typeof failure === 'string'
            ? failure
            : 'Non-Error stop failure';
      expect(failed.message).toBe(message(primary));
      const { failureConverter, payloadConverter } = defaultDataConverter;
      const restored = failureConverter.failureToError(
        failureConverter.errorToFailure(failed, payloadConverter),
        payloadConverter,
      );
      expect(restored.message).toBe(message(primary));
      expect(restored.cause).toBeInstanceOf(Error);
      if (!(restored.cause instanceof Error)) throw new Error('serialized cause missing');
      expect(JSON.parse(restored.cause.message)).toEqual({
        primary: message(primary).slice(0, 4096),
        physical: message(physical).slice(0, 4096),
        physicalCause:
          kind === 'errors' ? diagnostic : kind === 'bounded' ? 'p'.repeat(4096) : null,
      });
      expect(f.state.alive).toBe(true);
      expect(f.state.starts).toBe(1);
    },
  );
  it.each(['stop', 'failed-stop', 'freeze'] as const)(
    'does not send after a late admission resolves following %s',
    async (mode) => {
      const f = fixture((_method, response) => response);
      let entered!: () => void;
      let release!: () => void;
      const admitting = new Promise<void>((done) => {
        entered = done;
      });
      const pending = new Promise<void>((done) => {
        release = done;
      });
      const factory = f.host.createRuntime;
      f.host.createRuntime = (root) => ({
        ...factory(root),
        admitTurn: async () => {
          entered();
          await pending;
        },
      });
      const { adapter, gate } = await preparedWriter(f);
      const writing = adapter.write();
      const refused = expect(writing).rejects.toThrow(
        mode === 'freeze' ? 'task-permit-revoked' : 'task-writer-stopped',
      );
      await admitting;
      if (mode === 'freeze') gate.freeze();
      else if (mode === 'failed-stop') {
        f.processes.terminate.mockRejectedValueOnce(new Error('stop failed'));
        await expect(adapter.stop()).rejects.toThrow('stop failed');
        expect(() => gate.assert()).not.toThrow();
      } else {
        await adapter.stop();
        expect(() => gate.assert()).not.toThrow();
      }
      release();
      await refused;
      expect(f.state.starts).toBe(0);
      await expect(adapter.write()).rejects.toThrow(
        mode === 'freeze' ? 'task-permit-revoked' : 'task-writer-stopped',
      );
      await adapter.stop();
    },
  );
  it('keeps a restarted pending admission unknown without recreating its runtime', async () => {
    const f = fixture((_method, response) => response);
    const factory = f.host.createRuntime;
    f.host.createRuntime = (root) => ({
      ...factory(root),
      admitTurn: async () => {
        throw new Error('admission-refused');
      },
    });
    const { adapter, body, files, gate } = await preparedWriter(f);
    await expect(adapter.write()).rejects.toThrow('admission-refused');
    const replacement = vi.fn(f.host.createRuntime);
    const restarted = taskWriter(body, files, gate, replacement, f.processes, vi.fn());
    await expect(restarted.write()).rejects.toThrow('task-writer-runtime-unknown');
    await expect(restarted.stop()).rejects.toThrow('task-writer-runtime-unknown');
    expect(replacement).not.toHaveBeenCalled();
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(0);
    await adapter.stop();
  });
  it.each([
    'loaded',
    'terminals',
    'final-history',
    'process-identity',
    'still-alive',
    'late-write',
  ])('keeps physical stop unknown on %s', async (defect) => {
    const f = fixture((method, result) => {
      if (defect === 'loaded' && method === 'thread/loaded/list')
        return { data: [], nextCursor: null };
      if (defect === 'terminals' && method === 'thread/backgroundTerminals/list')
        return { data: [], nextCursor: 'next' };
      if (defect === 'final-history' && method === 'thread/read' && f.state.starts === 3) {
        const r = result as { thread: { turns: { status: string }[] } };
        r.thread.turns[0]!.status = 'running';
        return r;
      }
      return result;
    });
    if (defect === 'process-identity')
      f.processes.descendants.mockImplementation(async () => [
        { pid: 999991, parent: 1, started: f.state.starts === 3 ? 'changed' : 'fixture' },
      ]);
    if (defect === 'still-alive') f.processes.terminate.mockImplementation(async (ids) => ids);
    if (defect === 'late-write')
      f.processes.wait = vi.fn(async () => {
        const { readdirSync } = await import('node:fs');
        const name = readdirSync(join(f.registration.artifactRoot, 'copies')).find(
          (n) => !n.endsWith('.json'),
        )!;
        writeFileSync(
          join(f.registration.artifactRoot, 'copies', name, 'owner.cjs'),
          'late ' + Math.random(),
        );
      });
    await rejected(f);
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow();
  });
  it('uses a dedicated runtime identity and rejects a missing process before thread creation', async () => {
    const f = fixture((_m, r) => r);
    f.processes.descendants.mockResolvedValue([]);
    await rejected(f, 'task-writer-process-unknown');
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'task-writer-process-unknown',
    );
    expect(f.state.starts).toBe(0);
  });
  it('fails safely when runtime construction throws after its starting marker', async () => {
    const f = fixture((_m, r) => r);
    f.host.createRuntime = () => {
      throw new Error('spawn failed');
    };
    await rejected(f, 'spawn failed');
    await expect(f.service.controls.stopLocalTask(f.input)).rejects.toThrow(
      'task-writer-runtime-unknown',
    );
  });
});
