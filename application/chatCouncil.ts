import { object, requireWorkflow } from '../core/connection.js';
import { confirmSession } from '../core/dataRoute.js';
import {
  assignAdviser,
  answerCouncil,
  sameRefs,
  selectedRole,
  councilProfileRefs,
  councilReviewRequest,
  councilAdviserName,
} from '../core/council.js';
import type { Council, CouncilRole, ReviewAnswer } from '../core/council.js';
import type { InputRef, LocalRun } from '../core/localRun.js';
import type { CouncilSessions } from '../ports/agentSessions.js';
import type { WorkflowInputs } from '../ports/workflowJournal.js';
import { collectInputRefs } from '../core/inputRefs.js';

export async function observeChatCouncil(
  council: Council,
  role: CouncilRole,
  run: LocalRun,
  turn: string,
  principal: string,
  sessions: CouncilSessions,
  inputs: WorkflowInputs,
) {
  requireWorkflow(
    run.spec.session_id !== principal &&
      run.spec.parent_run_id !== null &&
      run.spec.fork_turns === 'none',
    'chat-independent-role-required',
  );
  const actual = await sessions.inspect(run.spec.session_id);
  requireWorkflow(
    actual !== null &&
      actual.id === run.spec.session_id &&
      actual.workspace === run.spec.workspace &&
      actual.project_id === run.spec.project_id &&
      actual.native_child === false &&
      actual.parent_id === null &&
      actual.forked_from === null,
    'chat-role-identity-unconfirmed',
  );
  requireWorkflow(actual.name === councilAdviserName(role), 'chat-adviser-name-unconfirmed');
  requireWorkflow(actual.observed_turn === turn, 'chat-adviser-turn-unconfirmed');
  confirmSession(actual, { ...run.spec.requested, reason: role }, false);
  const response = await sessions.poll(actual, turn);
  requireWorkflow(response.status === 'completed', 'chat-role-still-running');
  const raw = object(JSON.parse(response.answer.content) as unknown) as unknown as ReviewAnswer & {
    target_ref?: InputRef;
  };
  requireWorkflow(
    response.answer.outcome === raw.verdict &&
      response.answer.coverage === 'complete' &&
      response.answer.scope.length === 1 &&
      response.answer.scope[0] === council.target.scope &&
      sameRefs(response.answer.sources, raw.sources),
    'chat-role-answer-unconfirmed',
  );
  const binding = await sessions.verifyReview(
    actual,
    councilReviewRequest(council, role, run),
    turn,
    response.answer.evidence,
  );
  if (raw.target_ref !== undefined)
    requireWorkflow(
      raw.target === undefined &&
        binding.request_file !== undefined &&
        sameRefs([raw.target_ref], [binding.request_file]),
      'chat-role-target-reference-mismatch',
    );
  const answer = {
    ...raw,
    target: raw.target_ref === undefined ? raw.target : binding.request.target,
    evidence: response.answer.evidence,
    binding,
  };
  await inputs.verify(
    councilProfileRefs(
      role,
      selectedRole(council.selection, role).requirements,
      council.configuration,
    ),
  );
  // Acceptance retains planning inputs as history; target inputs describe the implemented files.
  const { inputs: plannedInputs, ...currentRequest } = binding.request;
  await inputs.verify([
    actual.receipt,
    ...collectInputRefs(run),
    ...collectInputRefs({ ...answer, binding: { ...binding, request: currentRequest } }),
    ...(council.phase === 'planning' ? collectInputRefs(plannedInputs) : []),
  ]);
  const previous = council.advisers[role];
  requireWorkflow(
    previous === undefined || previous.run.spec.session_id === run.spec.session_id,
    'reviewer-replacement-needs-recovery',
  );
  requireWorkflow(
    previous === undefined ||
      (previous.run.loaded?.origin !== undefined &&
        sameRefs([previous.run.loaded.origin], [run.loaded!.origin!])),
    'chat-council-origin-changed',
  );
  requireWorkflow(
    previous === undefined || previous.status === 'running',
    'adviser-already-answered',
  );
  // A repeat keeps the native reviewer, but validates the new brief/LOAD as an active assignment.
  const advisers = { ...council.advisers };
  delete advisers[role];
  const assigned = assignAdviser({ ...council, advisers }, role, run);
  return answerCouncil(assigned, role, actual.id, answer);
}
