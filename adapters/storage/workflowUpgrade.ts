import type { Json, EvidenceContext, TechnicalState } from '../../core/evidence.js';
import type { InputRef } from '../../core/localRun.js';
import { readPrivateFile } from './storeFiles.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { validateCheckpoint } from './workflowValidation.js';
import { requestHash, digest } from './storeCodec.js';
import { unwrap } from './sqliteEvidenceStore.js';

export interface WorkflowUpgrade {
  schema_version: 1;
  context: EvidenceContext;
  source: TechnicalState;
  target: Json;
  stopped_writers_receipt: InputRef;
}
// An explicit, reversible transform; existing readers still reject execution schema 1.
export function previewWorkflowUpgrade(
  context: EvidenceContext,
  source: TechnicalState,
  stopped: InputRef,
): WorkflowUpgrade {
  requireWorkflow(
    stopped.locator.trim().length > 0 && /^[a-f0-9]{64}$/u.test(stopped.hash),
    'upgrade-stop-required',
  );
  requireWorkflow(
    !source.released && !source.frozen && source.owner === context.actor_id,
    'upgrade-owner-mismatch',
  );
  const checkpoint = object(structuredClone(source.checkpoint)),
    workflow = object(checkpoint.workflow),
    execution = object(workflow.execution);
  requireWorkflow(
    workflow.schema_version === 1 &&
      execution.schema_version === 1 &&
      execution.supervision === undefined,
    'unsupported-upgrade-source',
  );
  workflow.execution = { ...execution, schema_version: 2 };
  validateCheckpoint(workflow);
  requireWorkflow(
    execution.task_id === context.task_id && execution.generation === source.generation,
    'upgrade-identity-mismatch',
  );
  checkpoint.workflow = workflow;
  return {
    schema_version: 1,
    context: structuredClone(context),
    source: structuredClone(source),
    target: checkpoint as Json,
    stopped_writers_receipt: stopped,
  };
}
export async function applyWorkflowUpgrade(
  plan: WorkflowUpgrade,
  store: EvidenceStore,
  operation: string,
  direction: 'upgrade' | 'rollback',
  backup: InputRef,
) {
  requireWorkflow(plan.schema_version === 1, 'unsupported-upgrade-plan');
  const checked = previewWorkflowUpgrade(plan.context, plan.source, plan.stopped_writers_receipt);
  requireWorkflow(sameValue(checked, plan), 'upgrade-plan-changed');
  for (const ref of [backup, plan.stopped_writers_receipt])
    requireWorkflow(digest(readPrivateFile(ref.locator)) === ref.hash, 'upgrade-proof-changed');
  requireWorkflow(
    sameValue(JSON.parse(readPrivateFile(backup.locator).toString('utf8')) as unknown, plan),
    'upgrade-backup-mismatch',
  );
  const stopped = object(
    JSON.parse(readPrivateFile(plan.stopped_writers_receipt.locator).toString('utf8')) as unknown,
  );
  requireWorkflow(
    stopped.kind === 'workflow-writers-stopped' &&
      stopped.project_id === plan.context.project_id &&
      stopped.task_id === plan.context.task_id &&
      stopped.run_id === plan.context.run_id &&
      stopped.remaining === 0,
    'upgrade-writers-unconfirmed',
  );
  const reply = await store.execute({ context: plan.context, command: { type: 'state' } }),
    state = unwrap<TechnicalState>(reply);
  const expected = direction === 'upgrade' ? plan.source.checkpoint : plan.target,
    target = direction === 'upgrade' ? plan.target : plan.source.checkpoint;
  requireWorkflow(
    state.generation === plan.source.generation &&
      state.owner === plan.source.owner &&
      !state.released &&
      !state.frozen,
    'upgrade-owner-changed',
  );
  requireWorkflow(
    state.revision === plan.source.revision + (direction === 'upgrade' ? 0 : 1) &&
      sameValue(state.checkpoint, expected),
    'upgrade-input-changed',
  );
  const request = {
    context: plan.context,
    command: {
      type: 'mutate' as const,
      mutation: {
        operation_id: operation,
        expected_revision: state.revision,
        owner_generation: state.generation,
        payload_hash: '',
      },
      change: { type: 'checkpoint' as const, state: target, effects: [] },
    },
  };
  request.command.mutation.payload_hash = requestHash(request);
  return unwrap(await store.execute(request));
}
