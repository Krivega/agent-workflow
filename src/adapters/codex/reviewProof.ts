import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readerLoadObserved } from './readerLoadCommandOutputs.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { ScopedReaderInput } from '../../contracts/reader.js';
import type { ReviewSnapshot, ReviewReport } from '../../contracts/review.js';
import type { ReaderExecution } from '../../contracts/readerControl.js';
import type { CodexRpc } from '../../contracts/codex.js';
import type { LocalProjectRegistration } from '../../activities/preparation.js';
import { object, requireContract, text } from '../../contracts/project.js';
import { checkRegistration } from '../../policy/preparation.js';
import { controlRef } from '../../policy/readerControl.js';
import { supportedReaderClient } from '../../policy/readerExecution.js';
import { parseReviewSnapshot, requireScoped } from '../../policy/review.js';
import { artifactStore } from '../artifacts/files.js';
import { readerSession } from './readerSession.js';
import { confirmObservedLoad } from './observedLoad.js';
import { readerContextCompacted } from './readerContext.js';
import { recoverSentTurn } from './recoveredSend.js';
import {
  readerOperationId,
  readerLoadPrompt,
  readerAnswerPrompt,
  readerReport,
} from './readerMessages.js';

export function reviewProof(registration: LocalProjectRegistration, rpc: CodexRpc) {
  const store = artifactStore(registration.artifactRoot);
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  async function prior(
    ref: ArtifactRef,
    current: ScopedReaderInput,
  ): Promise<{
    snapshot: ReviewSnapshot;
    report: ReviewReport;
    profile: ReaderExecution['profile'];
    session: string;
    input: ScopedReaderInput;
    answerTurn: Record<string, unknown>;
    openFindings: string[];
  } | null> {
    const answer = read(ref);
    requireContract(
      answer.kind === 'reader-answer' && answer.roleId === current.roleId,
      'review-history-role-mismatch',
    );
    if (!Object.hasOwn(answer, 'input')) return null;
    const input = requireScoped(answer.input);
    checkRegistration(input.preparation, registration);
    requireContract(
      input.preparation.taskId === current.preparation.taskId && input.roleId === current.roleId,
      'review-history-target-mismatch',
    );
    const snapshot = parseReviewSnapshot(read(input.review), input);
    const oldProfile = object(answer.profile);
    const sourceProfile = {
      model: text(oldProfile.model),
      effort: text(oldProfile.effort),
      clientVersion: text(oldProfile.clientVersion),
    };
    requireContract(
      supportedReaderClient(sourceProfile.clientVersion),
      'review-history-client-unsupported',
    );
    const prepared = object(answer.prepared),
      creation = read(controlRef(answer.creation));
    requireContract(
      creation.kind === 'reader-session' &&
        same(creation.input, input) &&
        same(creation.prepared, prepared),
      'review-history-creation-mismatch',
    );
    const session = readerSession(
      creation.response,
      registration.workspaceRoot,
      sourceProfile,
      text(answer.session),
    );
    const predecessor =
      snapshot.schemaVersion === 4 ? snapshot.selection.history.answers.at(-1) : undefined;
    let inherited: string[] = [];
    if (predecessor === undefined)
      requireContract(
        (session.thread.turns as unknown[]).length === 0,
        'review-history-session-not-fresh',
      );
    else {
      const previous = await prior(predecessor, current);
      requireContract(
        previous !== null &&
          previous.session === session.id &&
          same(previous.profile, sourceProfile) &&
          same(creation.resumedFrom, predecessor),
        'review-history-resume-mismatch',
      );
      inherited = previous.openFindings;
      const turns = (session.thread.turns as unknown[]).map(object);
      requireContract(turns.at(-1)?.id === previous.answerTurn.id, 'review-history-resume-prefix');
    }
    const preparation = read(controlRef(prepared.manifest));
    requireContract(
      preparation.schemaVersion === 2 &&
        preparation.kind === 'reader-preparation' &&
        same(preparation.input, input) &&
        same(preparation.inputs, snapshot.files),
      'review-history-preparation-mismatch',
    );
    const load = read(controlRef(answer.load)),
      refs = [
        ...snapshot.files.map((f) => ({
          path: resolve(registration.workspaceRoot, f.path),
          sha256: f.sha256,
        })),
        ...(snapshot.schemaVersion !== 1
          ? snapshot.evidence.map((ref) => ({ path: store.path(ref), sha256: ref.sha256 }))
          : []),
      ];
    requireContract(
      load.kind === 'reader-load' &&
        load.session === session.id &&
        load.roleId === input.roleId &&
        same(load.prepared, prepared) &&
        same(load.refs, refs),
      'review-history-load-mismatch',
    );
    const loadTurn = object(load.observed),
      answerTurn = object(answer.observed);
    const promptVersion = load.promptVersion === undefined ? 1 : load.promptVersion;
    requireContract(
      promptVersion === 1 || promptVersion === 2 || promptVersion === 3 || promptVersion === 4,
      'review-load-prompt-version',
    );
    requireContract(
      Number.isSafeInteger(load.attempt) &&
        Number(load.attempt) >= 0 &&
        Number.isSafeInteger(answer.attempt) &&
        Number(answer.attempt) >= 0,
      'review-history-attempt-invalid',
    );
    const primary = object(
      object(await rpc.request('thread/read', { threadId: session.id, includeTurns: true })).thread,
    );
    requireContract(
      primary.id === session.id &&
        primary.cwd === registration.workspaceRoot &&
        Array.isArray(primary.turns),
      'review-history-primary-unknown',
    );
    const turns = primary.turns.map(object);
    if (predecessor !== undefined)
      requireContract(
        same(session.thread.turns, turns.slice(0, (session.thread.turns as unknown[]).length)),
        'review-history-resume-prefix',
      );
    requireContract(
      turns.every((t) => ['completed', 'failed', 'interrupted'].includes(String(t.status))),
      'review-history-session-busy',
    );
    for (const [turn, operation, prompt, attempt] of [
      [loadTurn, 'load', readerLoadPrompt(refs, promptVersion), Number(load.attempt)],
      [answerTurn, 'answer', readerAnswerPrompt(input, snapshot), Number(answer.attempt)],
    ] as const) {
      const id = text(turn.id),
        matches = turns.filter((t) => t.id === id);
      requireContract(
        matches.length === 1 && turn.status === 'completed' && same(matches[0], turn),
        'review-history-turn-mismatch',
      );
      requireContract(
        recoverSentTurn(
          { thread: primary },
          session.id,
          `Workflow operation: ${readerOperationId(input, operation, attempt)}\n${prompt}`,
        ) === id,
        'review-history-message-mismatch',
      );
    }
    const answerIndex = turns.findIndex((turn) => turn.id === answerTurn.id);
    requireContract(
      answerIndex > turns.findIndex((turn) => turn.id === loadTurn.id) &&
        !readerContextCompacted(
          { thread: { id: session.id, turns: turns.slice(0, answerIndex + 1) } },
          session.id,
          text(loadTurn.id),
        ),
      'review-history-context-invalid',
    );
    confirmObservedLoad(
      promptVersion === 3 || promptVersion === 4
        ? readerLoadObserved(
            store,
            loadTurn,
            load.commandOutputs,
            registration.workspaceRoot,
            sourceProfile,
            session.id,
          )
        : loadTurn,
      refs,
    );
    const report = readerReport(answerTurn, input, snapshot);
    requireContract(same(report, answer.report), 'review-history-report-mismatch');
    const resolved = report.schemaVersion === 2 ? report.resolved : [];
    requireContract(
      new Set(resolved).size === resolved.length && resolved.every((id) => inherited.includes(id)),
      'review-resolution-invalid',
    );
    const openFindings = [
      ...new Set([
        ...inherited.filter((id) => !resolved.includes(id)),
        ...report.findings.filter((f) => f.blocking).map((f) => f.id),
      ]),
    ];
    requireContract(report.verdict !== 'PASS' || openFindings.length === 0, 'review-open-failure');
    return {
      snapshot,
      report,
      profile: sourceProfile,
      session: session.id,
      input,
      answerTurn,
      openFindings,
    };
  }
  return (ref: ArtifactRef, current: ScopedReaderInput) => prior(ref, current);
}
