import { isDeepStrictEqual as same } from 'node:util';
import type { WriteObservation } from './observedWrite.js';
export { observeLocalWrite, type WriteObservation } from './observedWrite.js';
import { CompleteAsyncError } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import {
  claimWrittenTask,
  recordWrittenActivity,
  writtenActivityReceipt,
  type WrittenTaskExecution,
} from './writtenTaskRecovery.js';
import type { TaskProgressAuditActivities } from '../contracts/progressAudit.js';
import type { TaskContinuationControls } from '../contracts/taskContinuation.js';
import type { TaskExecutionControls } from '../contracts/taskExecution.js';
import type { TaskHumanActivities } from '../contracts/taskHuman.js';
import type { TaskHostAdmission } from '../contracts/taskRecovery.js';
import { taskHostPermissionOwner } from '../adapters/project/taskPermissionLock.js';
import { taskAdmissionIdentity, taskAdmissionsRelativePath } from '../policy/taskRecovery.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import { captureTaskBudget } from './taskBudget.js';
import type { TaskStageAuditActivities } from '../contracts/stageAudit.js';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Worker } from '@temporalio/worker';
import type { NativeConnection } from '@temporalio/worker';
import type {
  ReaderActivities,
  ReaderEpoch,
  ReaderInput,
  ReaderSession,
} from '../contracts/reader.js';
import type {
  ControlledReaderActivities,
  ReaderAuthority,
  ReaderControlActivities,
} from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from '../activities/preparation.js';
import type { CodexRpc } from '../activities/reader.js';
import { readerActivities } from '../activities/reader.js';
import { readerControlActivities } from '../activities/readerControl.js';
import { preparationActivities } from '../activities/preparation.js';
import { reviewActivities } from '../activities/review.js';
import { reviewProof } from '../adapters/codex/reviewProof.js';
import { requireScoped } from '../policy/review.js';
import { scopedReviewInputs } from '../adapters/codex/reviewInputs.js';
import { prepareScopedReview } from '../adapters/codex/reviewInputs.js';
import {
  scopedReader,
  readerTarget,
  readerKey,
  parseReaderInput,
} from '../policy/readerControl.js';
import type { ReviewActivities } from '../contracts/review.js';
import { parseProject, requireContract } from '../contracts/project.js';
import {
  artifactStore,
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../adapters/artifacts/files.js';
import { readerBoundary } from '../adapters/codex/readerBoundary.js';
import { readerBudget } from '../adapters/codex/readerBudget.js';
import { readerExecution, supportedReaderClient } from '../policy/readerExecution.js';
import { readerHeartbeat } from './readerHeartbeat.js';
import { localTaskActivities } from '../activities/localTask.js';
import { auditorActivities } from '../activities/audit.js';
import type { AuditInput, AuditorActivities, AuditorControls } from '../contracts/audit.js';
import type { TaskAuditActivities } from '../contracts/taskAudit.js';
import type { TaskPlanningProgressActivities } from '../contracts/taskAudit.js';
import { taskPlanningProgress } from '../activities/taskAudit.js';
import type { LocalTaskHost } from '../activities/localTask.js';
import type {
  LocalTaskActivities,
  LocalTaskControls,
  LocalTaskInput,
} from '../contracts/localTask.js';

export interface ReaderProjectHost {
  registration: LocalProjectRegistration;
  rpc: CodexRpc;
  authority: ReaderAuthority;
  localTasks?: LocalTaskHost;
  auditor?: true;
  /** Deliver once to an independent process using observeLocalWrite. */
  dispatchObservedWrite?(job: WriteObservation): Promise<void>;
}
export async function createReaderHost(
  connection: NativeConnection,
  taskQueue: string,
  workflowsPath: string,
  projects: ReaderProjectHost[],
  profile: { model: string; effort: string; clientVersion: string },
  directory: string,
  maxTurnStarts: number,
  resumeWritten?: WrittenTaskExecution,
  namespace = 'default',
) {
  projects = projects.map((project) => ({
    ...project,
    registration: captureRegistration(project.registration),
  }));
  const execution = readerExecution(profile);
  profile = execution.profile;
  const root = privateDirectory(directory);
  const instance = randomUUID(),
    tasksEnabled = projects.some((project) => project.localTasks !== undefined);
  const taskAdmissionsDirectory = tasksEnabled
    ? join(root, taskAdmissionsRelativePath(instance, 3))
    : null;
  const owner = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      id: instance,
      ...(tasksEnabled ? { tasks: true, taskBindings: 3 } : {}),
      ...(projects.some((project) => project.auditor === true) ? { audits: true } : {}),
    }),
  );
  const ownerFile = join(root, 'host-owner');
  if (resumeWritten !== undefined) resumeWritten = { ...resumeWritten };
  const continued =
    resumeWritten === undefined
      ? null
      : await claimWrittenTask(
          connection,
          taskQueue,
          projects,
          profile,
          root,
          resumeWritten,
          owner,
          namespace,
        );
  if (continued === null) publishFile(ownerFile, owner);
  let closing = false;
  const sessionOwners = new Map<string, string>();
  const planningSessions = new Map<string, ReaderSession>();
  const transferring = new Set<string>();
  const retiredReaders = new Map<
    string,
    {
      input: ReaderInput;
      permit: ReaderEpoch['permit'];
      revision: number;
      stop: Awaited<ReturnType<ReaderControlActivities['stopReader']>>;
    }
  >();
  const admitted = new Map<
    string,
    { input: ReaderInput; permit: ReaderEpoch['permit']; controls: ReaderControlActivities }
  >();
  const admissions = new Set<Promise<unknown>>();
  const registrations = new Map<
    string,
    {
      dispatchObservedWrite: ReaderProjectHost['dispatchObservedWrite'];
      controls: ReaderControlActivities;
      boundary: ReturnType<typeof readerBoundary>;
      models(): ReaderActivities;
      registration: LocalProjectRegistration;
      rpc: CodexRpc;
      reviews: ReviewActivities;
      tasks: ReturnType<typeof localTaskActivities> | null;
      audits: ReturnType<typeof auditorActivities> | null;
    }
  >();
  let modelWorker: Worker, controlWorker: Worker;
  function release() {
    requireContract(readPrivateFile(ownerFile).equals(owner), 'reader-host-owner-changed');
    unlinkSync(ownerFile);
    syncDirectory(root);
  }
  try {
    requireContract(supportedReaderClient(profile.clientVersion), 'unsupported-codex-client');
    requireContract(projects.length > 0, 'reader-host-projects-required');
    const admissionsRoot = privateDirectory(join(root, 'admissions'));
    if (taskAdmissionsDirectory !== null) privateDirectory(taskAdmissionsDirectory);
    const consume = readerBudget(join(root, 'turn-credits'), maxTurnStarts);
    for (const project of projects) {
      requireContract(
        project.registration.hostId === projects[0]!.registration.hostId &&
          project.registration.owner === projects[0]!.registration.owner,
        'reader-host-owner-mismatch',
      );
      const id = parseProject(project.registration.project).projectId;
      requireContract(!registrations.has(id), 'reader-host-project-duplicate');
      const path = privateDirectory(join(root, digest(id)));
      const boundary = readerBoundary(
        join(path, 'permissions'),
        artifactStore(project.registration.artifactRoot),
        project.registration.workspaceRoot,
        execution,
        () => requireContract(!closing, 'reader-host-closing'),
        consume,
      );
      let models: ReaderActivities | null = null;
      const baseControls = readerControlActivities(
        project.registration,
        project.rpc,
        boundary,
        project.authority,
      );
      const controls: ReaderControlActivities = {
        ...baseControls,
        async stopReader(input, permit, minimumRevision) {
          const retired = retiredReaders.get(readerKey(input));
          if (retired !== undefined) {
            requireContract(
              JSON.stringify(retired.input) === JSON.stringify(input) &&
                JSON.stringify(retired.permit) === JSON.stringify(permit) &&
                minimumRevision <= retired.revision,
              'reader-retired-binding',
            );
            return retired.stop;
          }
          return baseControls.stopReader(input, permit, minimumRevision);
        },
      };
      registrations.set(id, {
        dispatchObservedWrite: project.dispatchObservedWrite,
        controls,
        boundary,
        registration: project.registration,
        rpc: project.rpc,
        reviews: reviewActivities(project.registration, project.rpc, profile),
        audits:
          project.auditor === true
            ? auditorActivities(
                project.registration,
                project.rpc,
                profile,
                boundary,
                join(path, 'native-audits'),
                consume,
                project.authority,
              )
            : null,
        tasks:
          project.localTasks === undefined
            ? null
            : localTaskActivities(
                project.registration,
                { ...project.localTasks, authority: project.authority },
                project.rpc,
                profile,
                consume,
                {
                  instance,
                  ...(continued === null ? {} : { continued }),
                  owner: taskHostPermissionOwner(root, project.registration.artifactRoot, instance),
                  taskQueue: taskQueue + '.control',
                  namespace,
                  budget(_input, previous) {
                    return captureTaskBudget(
                      join(root, 'turn-credits'),
                      artifactStore(project.registration.artifactRoot),
                      previous,
                    );
                  },
                  admitted(input, gate) {
                    const record: TaskHostAdmission = {
                      schemaVersion: 1,
                      host: { pid: process.pid, id: instance },
                      input,
                      gate: continued === null ? gate : { ...gate, mode: 'retained' },
                    };
                    const path = join(
                        taskAdmissionsDirectory!,
                        digest(taskAdmissionIdentity(input)),
                      ),
                      bytes = Buffer.from(JSON.stringify(record));
                    try {
                      publishFile(path, bytes);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    }
                    requireContract(
                      readPrivateFile(path).equals(bytes),
                      'task-host-admission-conflict',
                    );
                  },
                },
              ),
        models() {
          models ??= readerActivities(
            project.registration,
            project.rpc,
            profile,
            join(path, 'effects'),
            boundary.boundary,
          );
          return models;
        },
      });
    }
    function project(input: Pick<ReaderInput, 'preparation'>) {
      const entry = registrations.get(input.preparation.project.projectId);
      requireContract(entry !== undefined, 'reader-host-project-unregistered');
      return entry;
    }
    function remember(input: ReaderInput, epoch: ReaderEpoch | undefined) {
      requireContract(!closing, 'reader-host-closing');
      requireContract(epoch !== undefined, 'reader-epoch-required');
      const entry = project(input);
      requireContract(
        readPrivateFile(
          join(admissionsRoot, digest(JSON.stringify(readerTarget(input, readerKey(input))))),
        ).equals(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              target: readerTarget(input, readerKey(input)),
              inputHash: digest(JSON.stringify(parseReaderInput(input))),
              permit: epoch.permit,
            }),
          ),
        ),
        'reader-host-admission-unconfirmed',
      );
      admitted.set(epoch.permit.sha256, { input, permit: epoch.permit, controls: entry.controls });
      return entry;
    }
    function assertContinuedRun(input: LocalTaskInput) {
      if (continued === null) return;
      const current = Context.current().info.workflowExecution;
      requireContract(
        same(input, continued.input) &&
          current?.workflowId === resumeWritten!.workflowId &&
          current.runId === resumeWritten!.runId,
        'written-task-run-mismatch',
      );
    }
    function task(input: LocalTaskInput) {
      requireContract(!closing, 'reader-host-closing');
      assertContinuedRun(input);
      const value = project(input.admission).tasks;
      requireContract(value !== null, 'local-task-host-unregistered');
      return value;
    }
    function audit(input: Pick<AuditInput, 'preparation'>) {
      requireContract(!closing, 'reader-host-closing');
      const value = project(input).audits;
      requireContract(value !== null, 'auditor-host-unregistered');
      return value;
    }
    const modelActivities: ControlledReaderActivities &
      ReviewActivities &
      LocalTaskActivities &
      AuditorActivities &
      TaskAuditActivities &
      TaskStageAuditActivities &
      TaskProgressAuditActivities = {
      prepareTaskProgressAudit(...args) {
        return readerHeartbeat(() =>
          audit({
            preparation: args[0].input.admission.preparation,
          }).activities.prepareTaskProgressAudit(...args),
        );
      },
      finishTaskProgressAudit(value) {
        return readerHeartbeat(() =>
          audit({
            preparation: value.context.input.admission.preparation,
          }).activities.finishTaskProgressAudit(value),
        );
      },
      prepareTaskStageAudit(...args) {
        return readerHeartbeat(() =>
          audit({
            preparation: args[0].input.admission.preparation,
          }).activities.prepareTaskStageAudit(...args),
        );
      },
      finishTaskStageAudit(value) {
        return readerHeartbeat(() =>
          audit({
            preparation: value.context.input.admission.preparation,
          }).activities.finishTaskStageAudit(value),
        );
      },
      verifyAuditResult(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.verifyAuditResult(...args));
      },
      prepareTaskPlanningAudit(...args) {
        return readerHeartbeat(() =>
          audit({ preparation: args[0].admission.preparation }).activities.prepareTaskPlanningAudit(
            ...args,
          ),
        );
      },
      finishTaskPlanningAudit(value) {
        return readerHeartbeat(() =>
          audit({
            preparation: value.input.admission.preparation,
          }).activities.finishTaskPlanningAudit(value),
        );
      },
      preflightAuditor(input) {
        return readerHeartbeat(() =>
          audit({ preparation: input }).activities.preflightAuditor(input),
        );
      },
      registerAuditor(input) {
        return readerHeartbeat(() => audit(input).activities.registerAuditor(input));
      },
      launchAuditor(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.launchAuditor(...args));
      },
      observeAuditorLoad(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.observeAuditorLoad(...args));
      },
      prepareAuditQuestion(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.prepareAuditQuestion(...args));
      },
      answerAuditor(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.answerAuditor(...args));
      },
      observeAuditAnswer(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.observeAuditAnswer(...args));
      },
      finishAudit(...args) {
        return readerHeartbeat(() => audit(args[0]).activities.finishAudit(...args));
      },
      prepareInitialArbitration(...args) {
        return readerHeartbeat(() => task(args[0]).activities.prepareInitialArbitration(...args));
      },
      finishInitialArbitration(...args) {
        return readerHeartbeat(() => task(args[0]).activities.finishInitialArbitration(...args));
      },
      prepareLocalArbitration(...args) {
        return readerHeartbeat(() => task(args[0]).activities.prepareLocalArbitration(...args));
      },
      finishLocalArbitration(...args) {
        return readerHeartbeat(() => task(args[0]).activities.finishLocalArbitration(...args));
      },
      prepareLocalCorrection(...args) {
        return readerHeartbeat(() => task(args[0]).activities.prepareLocalCorrection(...args));
      },
      prepareSubstantialPlanning(input) {
        return readerHeartbeat(() => task(input).activities.prepareSubstantialPlanning(input));
      },
      prepareLocalTask(...args) {
        return readerHeartbeat(() => task(args[0]).activities.prepareLocalTask(...args));
      },
      checkLocalTask(...args) {
        return readerHeartbeat(() => task(args[0]).activities.checkLocalTask(...args));
      },
      async writeLocalTask(...args) {
        requireContract(continued === null, 'written-task-writer-already-completed');
        const [input, snapshot] = args;
        const dispatch = project(input.admission).dispatchObservedWrite;
        if (input.schemaVersion === 1 && dispatch) {
          task(input);
          const info = Context.current().info;
          await dispatch({
            input,
            snapshot,
            execution: info.workflowExecution!,
            activityId: info.activityId,
            taskToken: info.taskToken,
            instance,
            workerPid: process.pid,
          });
          throw new CompleteAsyncError();
        }
        return readerHeartbeat(async () => {
          const result = await task(args[0]).activities.writeLocalTask(...args);
          if (args[0].schemaVersion === 1) {
            const info = Context.current().info;
            recordWrittenActivity(
              writtenActivityReceipt(root, instance, info.workflowExecution!, info.activityId),
              result,
            );
          }
          return result;
        });
      },
      planLocalIntegration(...args) {
        return readerHeartbeat(() => task(args[0]).activities.planLocalIntegration(...args));
      },
      integrateLocalTask(...args) {
        return readerHeartbeat(() => task(args[0]).activities.integrateLocalTask(...args));
      },
      recheckIntegratedTask(...args) {
        return readerHeartbeat(() => task(args[0]).activities.recheckIntegratedTask(...args));
      },
      prepareLocalAcceptance(...args) {
        return readerHeartbeat(() => task(args[0]).activities.prepareLocalAcceptance(...args));
      },
      finishLocalTask(...args) {
        return readerHeartbeat(() => task(args[0]).activities.finishLocalTask(...args));
      },
      prepareReviewPlan(input) {
        requireContract(!closing, 'reader-host-closing');
        return project(input).reviews.prepareReviewPlan(input);
      },
      finishReview(value) {
        requireContract(!closing, 'reader-host-closing');
        return project(value.input).reviews.finishReview(value);
      },
      async prepareControlledReader(input, epoch) {
        requireContract(!closing, 'reader-host-closing');
        const entry = remember(input, epoch);
        return readerHeartbeat(async () => {
          entry.boundary.boundary.assert(input, epoch);
          return scopedReader(input)
            ? prepareScopedReview(entry.registration, input)
            : preparationActivities(entry.registration).prepareProject(input.preparation);
        });
      },
      createReader(input, prepared, epoch) {
        const entry = remember(input, epoch);
        return readerHeartbeat(async () => {
          entry.boundary.boundary.assert(input, epoch!);
          let transfer: string | undefined;
          try {
            const snapshot = scopedReader(input)
              ? scopedReviewInputs(entry.registration, input).snapshot
              : null;
            if (snapshot?.schemaVersion === 4) {
              requireContract(entry.tasks !== null, 'reader-retarget-task-host-required');
              const last = snapshot.selection.history.answers.at(-1);
              if (last !== undefined) {
                const previous = await reviewProof(entry.registration, project(input).rpc)(
                  last,
                  requireScoped(input),
                );
                requireContract(
                  previous !== null &&
                    previous.snapshot.phase === snapshot.phase &&
                    previous.snapshot.scope === snapshot.scope &&
                    JSON.stringify(previous.input.preparation) ===
                      JSON.stringify(input.preparation) &&
                    JSON.stringify(previous.profile) === JSON.stringify(profile),
                  'reader-retarget-unqualified',
                );
                const oldKey = readerKey(previous.input),
                  newKey = readerKey(input),
                  owner = sessionOwners.get(previous.session);
                requireContract(
                  owner === oldKey || owner === newKey,
                  'reader-retarget-owner-conflict',
                );
                const old = [...admitted.values()].find(
                  (value) => readerKey(value.input) === oldKey,
                );
                requireContract(old !== undefined, 'reader-retarget-admission-missing');
                requireContract(!transferring.has(previous.session), 'reader-retarget-busy');
                transfer = previous.session;
                transferring.add(transfer);
                sessionOwners.set(transfer, newKey);
                if (!retiredReaders.has(oldKey)) {
                  const revision = await old.controls.freezeReader(old.input, old.permit);
                  const stop = await old.controls.stopReader(old.input, old.permit, revision);
                  requireContract(stop.status === 'stopped', 'reader-retarget-stop-unconfirmed');
                  publishFile(
                    join(privateDirectory(join(root, 'retired-readers')), digest(oldKey)),
                    Buffer.from(
                      JSON.stringify({
                        input: old.input,
                        permit: old.permit,
                        revision,
                        stop,
                        successor: input,
                      }),
                    ),
                  );
                  retiredReaders.set(oldKey, {
                    input: old.input,
                    permit: old.permit,
                    revision,
                    stop,
                  });
                }
              }
            }
            const result = await entry.models().createReader(input, prepared, epoch);
            planningSessions.set(readerKey(input), result);
            if (snapshot?.schemaVersion === 4 || snapshot?.schemaVersion === 6) {
              const owner = sessionOwners.get(result.id),
                key = readerKey(input);
              requireContract(
                owner === undefined || owner === key,
                'reader-retarget-owner-conflict',
              );
              sessionOwners.set(result.id, key);
            }
            return result;
          } finally {
            if (transfer !== undefined) transferring.delete(transfer);
          }
        });
      },
      loadReader(input, prepared, session, epoch) {
        const models = remember(input, epoch).models();
        return readerHeartbeat(() => models.loadReader(input, prepared, session, epoch));
      },
      answerReader(input, prepared, session, load, epoch) {
        const models = remember(input, epoch).models();
        return readerHeartbeat(() => models.answerReader(input, prepared, session, load, epoch));
      },
    };
    const controlActivities: ReaderControlActivities &
      LocalTaskControls &
      TaskContinuationControls &
      TaskExecutionControls &
      TaskHumanActivities &
      AuditorControls &
      TaskPlanningProgressActivities = {
      prepareTaskHuman(input) {
        return readerHeartbeat(() => task(input).humanActivities.prepareTaskHuman(input));
      },
      verifyTaskHumanCommand(context, command) {
        return readerHeartbeat(() =>
          task(context.input).humanActivities.verifyTaskHumanCommand(context, command),
        );
      },
      controlTaskHumanExecution(context, command, revision) {
        return readerHeartbeat(() =>
          task(context.input).humanActivities.controlTaskHumanExecution(context, command, revision),
        );
      },
      finishTaskHuman(request) {
        return readerHeartbeat(() => task(request.input).humanActivities.finishTaskHuman(request));
      },
      saveTaskHumanCheckpoint(value) {
        return readerHeartbeat(() =>
          task(value.input).humanActivities.saveTaskHumanCheckpoint(value),
        );
      },
      loadTaskHumanCheckpoint(...args) {
        return readerHeartbeat(() =>
          task(args[0]).humanActivities.loadTaskHumanCheckpoint(...args),
        );
      },
      saveTaskExecutionCheckpoint(value) {
        return readerHeartbeat(() =>
          task(value.input).executionControls.saveTaskExecutionCheckpoint(value),
        );
      },
      loadTaskExecutionCheckpoint(...args) {
        return readerHeartbeat(() =>
          task(args[0]).executionControls.loadTaskExecutionCheckpoint(...args),
        );
      },
      captureTaskExecutionBudget(...args) {
        return readerHeartbeat(() =>
          task(args[0]).executionControls.captureTaskExecutionBudget(...args),
        );
      },
      prepareTaskExecution(input) {
        return readerHeartbeat(() => task(input).executionControls.prepareTaskExecution(input));
      },
      findTaskExecutionCommand(...args) {
        return readerHeartbeat(() =>
          task(args[0]).executionControls.findTaskExecutionCommand(...args),
        );
      },
      interruptTaskExecution(...args) {
        return readerHeartbeat(() =>
          task(args[0]).executionControls.interruptTaskExecution(...args),
        );
      },
      holdTaskExecution(...args) {
        return readerHeartbeat(() => task(args[0]).executionControls.holdTaskExecution(...args));
      },
      resumeTaskExecution(...args) {
        return readerHeartbeat(() => task(args[0]).executionControls.resumeTaskExecution(...args));
      },
      holdTaskPlanning(...args) {
        return readerHeartbeat(() => task(args[0]).continuationControls.holdTaskPlanning(...args));
      },
      resumeTaskPlanning(...args) {
        return readerHeartbeat(() =>
          task(args[0]).continuationControls.resumeTaskPlanning(...args),
        );
      },
      captureTaskPlanningProgress(input, planning) {
        requireContract(!closing, 'reader-host-closing');
        const entry = project({ preparation: input.admission.preparation });
        requireContract(entry.tasks !== null, 'local-task-host-unregistered');
        return taskPlanningProgress(
          entry.registration,
          entry.rpc,
          profile,
          input,
          planning,
          [...admitted.values()]
            .filter(
              (row) =>
                row.input.preparation.project.projectId ===
                input.admission.preparation.project.projectId,
            )
            .map((row) => ({
              input: row.input,
              permit: row.permit,
              session: planningSessions.get(readerKey(row.input)) ?? null,
              operations: artifactStore(entry.registration.artifactRoot).publish(
                Buffer.from(
                  JSON.stringify({
                    kind: 'task-planning-reader-operations',
                    input: row.input,
                    permit: row.permit,
                    observation: entry.boundary.inspect(row.input),
                  }),
                ),
              ),
            })),
        );
      },
      stopAuditor(input, permit) {
        const value = project(input).audits;
        requireContract(value !== null, 'auditor-host-unregistered');
        return value.controls.stopAuditor(input, permit);
      },
      stopLocalTask(input) {
        const value = project(input.admission).tasks;
        assertContinuedRun(input);
        requireContract(value !== null, 'local-task-host-unregistered');
        return value.controls.stopLocalTask(input);
      },
      async registerReader(input, workflowId) {
        requireContract(!closing, 'reader-host-closing');
        const controls = project(input).controls;
        const admission = controls.registerReader(input, workflowId).then((permit) => {
          const path = join(
            admissionsRoot,
            digest(JSON.stringify(readerTarget(input, workflowId))),
          );
          const bytes = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              target: readerTarget(input, workflowId),
              inputHash: digest(JSON.stringify(parseReaderInput(input))),
              permit,
            }),
          );
          try {
            publishFile(path, bytes);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          requireContract(readPrivateFile(path).equals(bytes), 'reader-host-admission-conflict');
          admitted.set(permit.sha256, { input, permit, controls });
          return permit;
        });
        admissions.add(admission);
        try {
          return await admission;
        } finally {
          admissions.delete(admission);
        }
      },
      applyReaderCommand(input, permit, command) {
        return project(input).controls.applyReaderCommand(input, permit, command);
      },
      freezeReader(input, permit) {
        return project(input).controls.freezeReader(input, permit);
      },
      stopReader(input, permit, revision) {
        return project(input).controls.stopReader(input, permit, revision);
      },
    };
    controlWorker = await Worker.create({
      connection,
      namespace,
      taskQueue: taskQueue + '.control',
      activities: controlActivities,
      maxConcurrentActivityTaskExecutions: 1,
      shutdownGraceTime: '5 seconds',
      shutdownForceTime: '10 seconds',
    });
    modelWorker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath,
      activities: modelActivities,
      maxConcurrentActivityTaskExecutions: 1,
      shutdownGraceTime: '5 seconds',
      shutdownForceTime: '10 seconds',
    });
  } catch (failure) {
    if (continued === null) release();
    else continued.restoreFormer();
    throw failure;
  }
  return {
    taskAdmissionsDirectory,
    async runUntil<T>(run: () => Promise<T>): Promise<T> {
      const modelRun = modelWorker.run(),
        controlRun = controlWorker.run();
      const stopped = Promise.all([modelRun, controlRun]).then(() => {
        throw new Error('reader-host-stopped');
      });
      try {
        return await Promise.race([run(), stopped]);
      } finally {
        closing = true;
        let confirmed = false;
        try {
          await Promise.allSettled(admissions);
          for (const entry of registrations.values()) await entry.tasks?.stopAll();
          for (const entry of registrations.values()) await entry.audits?.stopAll();
          for (const { input, permit, controls } of admitted.values()) {
            const revision = await controls.freezeReader(input, permit);
            await controls.stopReader(input, permit, revision);
          }
          confirmed = true;
        } finally {
          modelWorker.shutdown();
          controlWorker.shutdown();
          await Promise.allSettled([modelRun, controlRun]);
          if (confirmed) release();
        }
      }
    },
  };
}
