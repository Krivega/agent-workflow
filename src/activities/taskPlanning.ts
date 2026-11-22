import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef, PreparationInput } from '../contracts/preparation.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { reviewActivities } from './review.js';
import {
  parseReviewInput,
  parseReviewRequest,
  parseReviewSnapshot,
  requireScoped,
} from '../policy/review.js';
import { controlRef } from '../policy/readerControl.js';
import { requireContract, object, text } from '../contracts/project.js';
import { artifactStore } from '../adapters/artifacts/files.js';

export async function confirmTaskPlanning(
  registration: LocalProjectRegistration,
  approval: {
    accepted: ArtifactRef;
    preparation: PreparationInput;
    plan: { path: string; sha256: string };
    scope: string;
    paths: string[];
    prefix: 'mechanical' | 'substantial';
  },
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
) {
  const store = artifactStore(registration.artifactRoot);
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const accepted = read(approval.accepted);
  requireContract(
    accepted.kind === 'reader-review-result' && accepted.complete === true,
    approval.prefix + '-acceptance-required',
  );
  const planning = parseReviewInput(accepted.input),
    request = parseReviewRequest(read(planning.request), planning);
  requireContract(
    same(planning.preparation, approval.preparation) &&
      request.phase === 'planning' &&
      request.scope === approval.scope,
    approval.prefix + '-planning-binding',
  );
  const reports = accepted.reports;
  requireContract(
    Array.isArray(reports) && reports.length > 0,
    approval.prefix + '-planning-incomplete',
  );
  const covered = new Set<string>(),
    sessions: string[] = [];
  for (const rawReport of reports) {
    const report = object(rawReport),
      answer = read(controlRef(report.answer)),
      actor = requireScoped(answer.input),
      snapshot = parseReviewSnapshot(read(actor.review), actor);
    requireContract(
      snapshot.phase === 'planning' &&
        snapshot.files.some(
          (f) => f.path === approval.plan.path && f.sha256 === approval.plan.sha256,
        ),
      approval.prefix + '-planning-material-missing',
    );
    for (const file of snapshot.files) covered.add(file.path);
    sessions.push(text(answer.session));
  }
  requireContract(
    approval.paths.every((path) => covered.has(path)),
    approval.prefix + '-planning-inputs-incomplete',
  );
  const verified = await reviewActivities(registration, rpc, profile).finishReview({
    schemaVersion: 1,
    input: planning,
    plan: controlRef(accepted.plan),
    answers: accepted.answers as { roleId: string; answer: ArtifactRef | null }[],
  });
  requireContract(
    verified.complete && same(verified.manifest, approval.accepted),
    approval.prefix + '-planning-not-passed',
  );
  return { accepted: approval.accepted, sessions };
}
