import type { AuditInput } from '../../src/contracts/audit.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupervisedTaskInput } from '../../src/contracts/localTask.js';
import type { TaskPlanningAudit } from '../../src/contracts/taskAudit.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { auditFixture } from './auditFixture.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { taskPlanningProgress } from '../../src/activities/taskAudit.js';
import { parseLocalTask } from '../../src/policy/localTask.js';

export function taskAuditFixture(stages = false, progress?: 'no-progress' | 'doubt') {
  const f = substantialTaskFixture();
  const auditor = auditFixture({
    ...f,
    input: { preparation: f.substantialInput.admission.preparation, roleId: 'reviewer' },
  });
  const request = {
    ...f.request,
    roles: [
      ...f.request.roles,
      {
        ...f.request.roles[0]!,
        roleId: 'auditor',
        applies: false,
        reason: 'Independent supervision cannot grant technical acceptance',
        paths: [],
      },
    ],
  };
  f.substantialInput.admission.planning = f.save({ ...request, phase: 'planning' });
  f.substantialInput.admission.acceptance = f.save(request);
  const progressRequest =
    progress === undefined
      ? null
      : f.save({
          schemaVersion: 1,
          kind: 'task-progress-request',
          preparation: f.substantialInput.admission.preparation,
          checkpoint: 'before-writing',
          trigger: progress,
          goal: {
            path: f.proposal.requirement.locator,
            ...f.store.publish(readFileSync(join(f.workspace, f.proposal.requirement.locator))),
          },
          evidence: [
            f.store.publish(readFileSync(join(f.workspace, f.proposal.requirement.locator))),
          ],
          reason:
            'Запрошена независимая оценка приближения к исходной цели после подготовки; это обращение, а не готовый диагноз отсутствия прогресса.',
        });
  const input = parseLocalTask({
    ...f.substantialInput,
    schemaVersion: progress === undefined ? (stages ? 8 : 7) : 9,
    ...(progress === undefined
      ? {}
      : {
          progress: {
            checkpoint: 'before-writing',
            trigger: { kind: progress, evidence: progressRequest },
          },
        }),
    audit: {
      planningEstimateMs: 1000,
      ...(stages
        ? {
            stages: {
              baseline: 1000,
              writing: 1000,
              'candidate-checks': 1000,
              integration: 1000,
              'integrated-checks': 1000,
              acceptance: 1000,
            },
          }
        : {}),
    },
  }) as SupervisedTaskInput;
  const service = localTaskActivities(
    f.registration,
    { ...f.host, auditorRpc: auditor.rpc },
    f.rpc,
    f.profile,
    () => {},
  );
  const prepare = async () => {
    const planning = await service.activities.prepareSubstantialPlanning(input);
    const record: TaskPlanningAudit = {
      schemaVersion: 1,
      kind: 'task-planning-supervision',
      input,
      planning,
      timing: {
        stage: 'planning',
        estimateMs: 1000,
        elapsedMs: 1000,
        externalWaitMs: 0,
        knownElapsedMs: 1000,
      },
      claim: null,
      audit: null,
    };
    return { planning, record };
  };
  const runAudit = async (value: AuditInput) => {
    const a = auditor.service.activities;
    const s = await auditor.setup(value);
    const session = await a.launchAuditor(s.input, s.epoch);
    const load = (await a.observeAuditorLoad(s.input, session, s.epoch))!;
    const question = await a.prepareAuditQuestion(s.input, session, load, s.epoch);
    const parentTurn = await a.answerAuditor(s.input, session, question, s.epoch);
    const answer = (await a.observeAuditAnswer(
      s.input,
      session,
      load,
      question,
      parentTurn,
      s.epoch,
    ))!;
    const result = await a.finishAudit(
      s.input,
      session,
      load,
      question,
      parentTurn,
      answer,
      s.epoch,
    );
    const stop = await auditor.service.controls.stopAuditor(s.input, s.permit);
    return { session, question, parentTurn, answer, load, result, stop };
  };
  const audit = async () => {
    const { planning, record } = await prepare();
    const a = auditor.service.activities;
    const preflight = await a.preflightAuditor(input.admission.preparation);
    record.timing.elapsedMs = record.timing.knownElapsedMs = 2000;
    const progress = await taskPlanningProgress(
      f.registration,
      f.rpc,
      f.profile,
      input,
      planning,
      [],
    );
    const auditInput = await a.prepareTaskPlanningAudit(
      input,
      planning,
      preflight,
      record.timing,
      progress,
    );
    const inspected = await runAudit(auditInput);
    const { result, stop } = inspected;
    record.claim = 'planning:overrun';
    record.audit = { input: auditInput, result: result.manifest, stop };
    return { planning, record, ...inspected };
  };
  return { ...f, service, input, auditor, prepare, audit, runAudit };
}
