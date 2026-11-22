import { relative } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { sameRefs } from '../../core/council.js';
import { confirmCouncilDelegation, type CouncilSender } from './councilDelegation.js';
import { councilReviewBrief, nativeCouncilReviewBrief } from './councilReviewBrief.js';
import type { CouncilReviewRequest, ReviewBinding } from '../../core/council.js';
import type { AgentSession } from '../../core/dataRoute.js';
import type { InputRef } from '../../core/localRun.js';
import { contentHash, projectText } from '../project/projectFiles.js';
import type { AppServerRpc } from './appServerTransport.js';
import { confirmNativeRead } from './nativeRead.js';
import { confirmCouncilOrigin } from './councilOrigin.js';
import { councilRequestFile } from './councilRequestFile.js';
import { decodeChatArtifact } from '../storage/sharedArtifacts.js';
import { sameValue } from '../../core/equality.js';

export async function verifyNativeReview(
  rpc: Pick<AppServerRpc, 'request'>,
  evidenceRoot: string,
  session: AgentSession,
  request: CouncilReviewRequest,
  answerTurn: string,
  answerEvidence: InputRef,
  receipt: (name: string, value: unknown) => Promise<InputRef>,
  sender?: CouncilSender,
  retainedEvidenceRoot = evidenceRoot,
): Promise<ReviewBinding> {
  requireWorkflow(request.session_id === session.id, 'review-session-mismatch');
  // The local receipt identifies a LOAD; only native history proves that it happened.
  const source = await projectText(
    retainedEvidenceRoot,
    relative(retainedEvidenceRoot, request.load.locator),
  );
  requireWorkflow(contentHash(source) === request.load.hash, 'native-load-receipt-changed');
  const saved = object(decodeChatArtifact(retainedEvidenceRoot, source));
  requireWorkflow(
    saved.session === session.id &&
      Array.isArray(saved.refs) &&
      sameRefs(saved.refs as InputRef[], request.reads),
    'native-load-receipt-mismatch',
  );
  const loadTurn = textField(saved.turn);
  const thread = object(
    object(await rpc.request('thread/read', { threadId: session.id, includeTurns: true })).thread,
  );
  requireWorkflow(thread.id === session.id && Array.isArray(thread.turns), 'wrong-thread-read');
  const turns = thread.turns.map(object);
  requireWorkflow(
    new Set(turns.map((turn) => textField(turn.id))).size === turns.length,
    'ambiguous-review-turns',
  );
  const loadIndex = turns.findIndex((turn) => turn.id === loadTurn);
  const answerIndex = turns.findIndex((turn) => turn.id === answerTurn);
  requireWorkflow(loadIndex >= 0 && answerIndex > loadIndex, 'review-before-load');
  const load = turns[loadIndex]!;
  const answer = turns[answerIndex]!;
  requireWorkflow(
    turns
      .slice(loadIndex + 1, answerIndex)
      .every(
        (turn) =>
          Array.isArray(turn.items) &&
          ['completed', 'failed', 'interrupted'].includes(String(turn.status)),
      ),
    'native-load-history-unconfirmed',
  );
  requireWorkflow(
    !turns
      .slice(loadIndex, answerIndex + 1)
      .some(
        (turn) =>
          Array.isArray(turn.items) &&
          turn.items.some((item: unknown) => object(item).type === 'contextCompaction'),
      ),
    'native-load-compacted',
  );
  confirmNativeRead(load, request.reads);
  const origin = await confirmCouncilOrigin(
    retainedEvidenceRoot,
    session,
    request.origin,
    turns[0]!,
  );
  requireWorkflow(
    answer.status === 'completed' && Array.isArray(answer.items),
    'review-turn-incomplete',
  );
  const marker = councilReviewBrief(request);
  const file = councilRequestFile(evidenceRoot, request);
  const fileMarker = councilReviewBrief(request, file.ref);
  const messages = answer.items
    .map(object)
    .filter((item) => item.type === 'userMessage' && Array.isArray(item.content))
    .flatMap((item) => (item.content as unknown[]).map(object))
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part.text as string).replace(/^Workflow delivery id: "[^\n]*"\n/u, ''))
    .filter((text) => text.startsWith(marker) || text.startsWith(fileMarker));
  const delegation =
    sender === undefined
      ? undefined
      : await confirmCouncilDelegation(
          rpc,
          sender,
          session,
          answer,
          nativeCouncilReviewBrief(request, file.ref, sender.reason),
        );
  requireWorkflow(
    messages.length === (delegation === undefined ? 1 : 0),
    'native-review-request-mismatch',
  );
  const compact = delegation !== undefined || messages[0]!.startsWith(fileMarker);
  if (compact)
    requireWorkflow(
      (await projectText(evidenceRoot, relative(evidenceRoot, file.ref.locator))) === file.content,
      'native-review-request-file-changed',
    );
  const answerSource = await projectText(
    evidenceRoot,
    relative(evidenceRoot, answerEvidence.locator),
  );
  requireWorkflow(
    contentHash(answerSource) === answerEvidence.hash &&
      sameValue(decodeChatArtifact(evidenceRoot, answerSource), answer),
    'native-review-answer-changed',
  );
  return {
    schema_version: 1,
    request: structuredClone(request),
    load_turn: loadTurn,
    answer_turn: answerTurn,
    answer_evidence: answerEvidence,
    ...(compact ? { request_file: file.ref } : {}),
    evidence: await receipt(`review-${session.id}-${answerTurn}`, {
      request,
      origin,
      load,
      answer,
      ...(delegation === undefined ? {} : { delegation }),
    }),
  };
}
