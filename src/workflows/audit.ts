import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  AuditInput,
  AuditorActivities,
  AuditorControls,
  AuditorSession,
} from '../contracts/audit.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import { parseAuditInput } from '../policy/audit.js';

export const auditInput = defineQuery<AuditInput>('auditInput');
export const auditStatus = defineQuery('auditStatus');
export const auditReconcile = defineSignal('auditReconcile');
export async function AuditWorkflow(raw: AuditInput) {
  let input: AuditInput;
  try {
    input = parseAuditInput(raw);
  } catch (e) {
    throw ApplicationFailure.nonRetryable(String(e), 'AuditInputRejected');
  }
  const models = proxyActivities<AuditorActivities>({
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  const controls = proxyActivities<AuditorControls>({
    taskQueue: workflowInfo().taskQueue + '.control',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  let phase = 'registering',
    error = '',
    stopFailure = '',
    notice = 0;
  let permit: ArtifactRef | null = null,
    session: AuditorSession | null = null,
    load: ArtifactRef | null = null,
    question: ArtifactRef | null = null;
  setHandler(auditInput, () => input);
  setHandler(auditStatus, () => ({ phase, error, stopFailure, permit, session, load, question }));
  setHandler(auditReconcile, () => {
    notice++;
  });
  const deadline = Date.now() + 20 * 60_000;
  function checkDeadline() {
    if (Date.now() >= deadline)
      throw ApplicationFailure.nonRetryable('audit-observation-timeout', 'AuditDeadline');
  }
  try {
    permit = await models.registerAuditor(input);
    const epoch = { permit, revision: 0, attempt: 0 };
    phase = 'launching';
    session = await models.launchAuditor(input, epoch);
    phase = 'loading';
    while (load === null) {
      checkDeadline();
      load = await models.observeAuditorLoad(input, session, epoch);
      if (load === null) await sleep('1 second');
    }
    phase = 'preparing-card';
    question = await models.prepareAuditQuestion(input, session, load, epoch);
    phase = 'auditing';
    const parentTurn = await models.answerAuditor(input, session, question, epoch);
    let answer: ArtifactRef | null = null;
    while (answer === null) {
      checkDeadline();
      answer = await models.observeAuditAnswer(input, session, load, question, parentTurn, epoch);
      if (answer === null) await sleep('1 second');
    }
    phase = 'verifying';
    const result = await models.finishAudit(
      input,
      session,
      load,
      question,
      parentTurn,
      answer,
      epoch,
    );
    phase = 'stopping';
    const stop = await controls.stopAuditor(input, permit);
    phase = 'audited';
    return { status: 'audited' as const, ...result, stop };
  } catch (failure) {
    const cancelled = isCancellation(failure);
    error = String(
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure,
    );
    return CancellationScope.nonCancellable(async () => {
      for (;;)
        try {
          phase = 'stopping';
          const stop = await controls.stopAuditor(input, permit);
          phase = cancelled ? 'cancelled' : 'blocked';
          return {
            status: cancelled ? ('cancelled' as const) : ('blocked' as const),
            error,
            stopFailure,
            stop,
          };
        } catch (e) {
          stopFailure = String(e);
          phase = 'stop-unknown';
          const observed = notice;
          await condition(() => notice !== observed);
        }
    });
  }
}
