import { expect, it, vi, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyManagedTaskInput, TaskSnapshot } from '../../src/contracts/localTask.js';
import { taskGate, taskGateBinding } from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { localTaskKey, parseLocalTask } from '../../src/policy/localTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { taskWriter } from '../../src/adapters/codex/taskWriter.js';
import * as effects from '../../src/adapters/artifacts/effects.js';
import { makeArchiveCommand } from '../../src/client/finalization.js';
import { finalizationTarget } from '../../src/policy/finalization.js';
import { completedArchiveFixture } from './finalizationFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { runReview } from './localTaskRun.js';

afterEach(() => vi.restoreAllMocks());
function managed(
  f: ReturnType<typeof substantialTaskFixture>,
  version: 11 | 12,
): AnyManagedTaskInput {
  const fields = { ...f.substantialInput, continuation: { attempt: 3, previous: f.proof } };
  return version === 12
    ? { ...fields, schemaVersion: 12, startAdmission: f.proof }
    : { ...fields, schemaVersion: 11 };
}
it.each([11, 12] as const)(
  'keeps execution attempt %i in the same grant namespace and recovery identity',
  (version) => {
    const f = substantialTaskFixture(),
      input = managed(f, version);
    const binding = taskGateBinding(
      input,
      taskFiles(f.registration.artifactRoot).binding(f.workspace),
      f.profile,
      f.registration.artifactRoot,
      'instance',
    );
    expect(binding.directory).toBe(
      `${f.workspace}/.git/agent-workflow/tasks/${digest(localTaskKey(input))}/execution-attempts/3`,
    );
    expect(taskAdmissionIdentity(input)).toBe(JSON.stringify([localTaskKey(input), 3]));
  },
);
it.each([11, 12] as const)(
  'binds Writer intents to execution attempt for schema%i without dispatching a model',
  async (version) => {
    const f = substantialTaskFixture(),
      planning = await f.service.activities.prepareSubstantialPlanning(f.substantialInput),
      approved = await runReview(f, planning),
      snapshotRef = await f.service.activities.prepareLocalTask(
        f.substantialInput,
        approved.manifest,
      ),
      original = f.read(snapshotRef) as unknown as TaskSnapshot;
    if (original.schemaVersion !== 3) throw new Error('substantial snapshot required');
    await f.service.controls.stopLocalTask(f.substantialInput);
    const input = managed(f, version),
      snapshot: TaskSnapshot = { ...original, input },
      files = taskFiles(f.registration.artifactRoot),
      gate = taskGate(
        input,
        snapshot.source,
        f.profile,
        f.registration.artifactRoot,
        'new-attempt',
      );
    gate.install();
    let operationId = '';
    vi.spyOn(effects, 'effectJournal').mockImplementation(() => ({
      async execute(intent) {
        operationId = intent.operationId;
        throw new Error('path observed before any Writer effect');
      },
    }));
    const factory = vi.fn(f.host.createRuntime),
      writer = taskWriter(snapshot, files, gate, factory, f.processes, vi.fn());
    await expect(writer.write()).rejects.toThrow('path observed before any Writer effect');
    expect(operationId).toBe(`task-create-${digest(localTaskKey(input))}-a3`);
    expect(factory).not.toHaveBeenCalled();
    gate.freeze();
    gate.release();
  },
);
it.each([11, 12] as const)(
  'looks up the immutable DONE receipt in execution attempt for schema%i',
  async (version) => {
    const f = completedArchiveFixture(),
      result = f.read(f.done.result),
      old = parseLocalTask(result.input);
    if (old.schemaVersion !== 1) throw new Error('native archive fixture required');
    const fields = {
        ...old,
        admission: { ...old.admission, schemaVersion: 3 as const, planning: f.proof },
        continuation: { attempt: 3, previous: f.proof },
      },
      task: AnyManagedTaskInput =
        version === 12
          ? { ...fields, schemaVersion: 12, startAdmission: f.proof }
          : { ...fields, schemaVersion: 11 };
    f.input.result = f.save({ ...result, input: task });
    mkdirSync(join(f.taskDirectory, 'execution-attempts', '3'), { recursive: true });
    f.input.command = makeArchiveCommand({
      ...f.input.command,
      target: finalizationTarget(f.input),
    });
    await expect(f.activity.archiveFinalizedTask(f.input)).rejects.toThrow(
      `/execution-attempts/3/done.json`,
    );
    expect(f.verify).not.toHaveBeenCalled();
  },
);
