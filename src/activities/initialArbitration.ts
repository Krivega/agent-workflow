import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import type { InitialArbitrationTaskInput, TaskTree } from '../contracts/localTask.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { ReviewInput, ReviewReport, ReviewRequest } from '../contracts/review.js';
import type { ReaderExecution } from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { object, requireContract } from '../contracts/project.js';
import { controlRef } from '../policy/readerControl.js';
import { parseReviewInput, parseReviewRequest, requireScoped } from '../policy/review.js';
import { arbitrationReadiness } from '../policy/arbitration.js';
import { reviewProof } from '../adapters/codex/reviewProof.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { reviewActivities } from './review.js';

export function initialArbitrationActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  profile: ReaderExecution['profile'],
) {
  const files = taskFiles(registration.artifactRoot),
    store = files.store,
    save = files.save;
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  function current(input: InitialArbitrationTaskInput, ref: ArtifactRef) {
    const before = read(ref);
    requireContract(
      before.kind === 'substantial-preflight' && same(before.input, input),
      'initial-preflight-binding',
    );
    requireContract(
      same(files.capture(registration.workspaceRoot, before.paths as string[]), before.tree),
      'initial-input-changed',
    );
    return before;
  }
  async function verified(
    review: ReviewInput,
    ref: ArtifactRef,
    selectedProfile: ReaderExecution['profile'],
  ) {
    const body = read(ref),
      activity = reviewActivities(registration, rpc, selectedProfile);
    requireContract(
      body.kind === 'reader-review-result' && same(body.input, review),
      'initial-review-binding',
    );
    const plan = await activity.prepareReviewPlan(review);
    requireContract(same(plan.manifest, body.plan), 'initial-review-plan-unconfirmed');
    const confirmed = await activity.finishReview({
      schemaVersion: 1,
      input: review,
      plan: plan.manifest,
      answers: body.answers as { roleId: string; answer: ArtifactRef | null }[],
    });
    requireContract(same(confirmed.manifest, ref), 'initial-review-unconfirmed');
    return body;
  }
  async function prepare(
    input: InitialArbitrationTaskInput,
    preflight: ArtifactRef,
    planning: ReviewInput,
    reviewed: ArtifactRef,
  ) {
    planning = parseReviewInput(planning);
    const before = current(input, preflight);
    requireContract(same(before.planning, planning), 'initial-planning-binding');
    const request = parseReviewRequest(read(planning.request), planning);
    requireContract(request.schemaVersion === 6, 'initial-planning-version');
    const outcome = await verified(planning, reviewed, profile);
    const reports = outcome.reports as {
      roleId: string;
      answer: ArtifactRef;
      report: Extract<ReviewReport, { schemaVersion: 4 }>;
    }[];
    requireContract(
      outcome.complete === false &&
        reports.length === request.roles.filter((r) => r.applies === true).length &&
        reports.every((r) => r.report.coverage === 'complete'),
      'initial-planning-incomplete',
    );
    const conflicts = reports.flatMap((row) =>
      row.report.conflicts.map((conflict) => ({ row, conflict })),
    );
    requireContract(conflicts.length === 1, 'initial-single-confirmed-conflict-required');
    const { row, conflict } = conflicts[0]!;
    const sessions = reports.map((r) => String(read(r.answer).session));
    const procedure = store.publish(
      readFileSync(new URL('../../procedures/arbitration.md', import.meta.url)),
    );
    const manifest = save({
      kind: 'initial-arbitration-request',
      input,
      preflight,
      planning,
      reviewed,
      target: { roleId: row.roleId, findingId: conflict.findingId },
      conflict,
      sessions,
      writablePaths: object(before.plan).paths,
      plan: before.plan,
      currentTree: before.tree,
      originalReports: reports.map((r) => ({ source: r.answer, ...read(r.answer) })),
      priorEvidence: request.evidence.map((source) => ({
        source,
        content: store.read(source).toString('utf8'),
      })),
    });
    const arbitration: ReviewRequest = {
      schemaVersion: 7,
      phase: 'arbitration',
      scope: 'initial-conflict-' + manifest.sha256,
      sharedPaths: [],
      evidence: [procedure, manifest],
      expectedFiles: (before.tree as TaskTree).files.map((f) => ({
        path: f.path,
        ...f.version.content,
      })),
      arbitration: {
        target: { roleId: row.roleId, findingId: conflict.findingId },
        trigger: manifest,
        profile: input.arbitration.profile,
      },
      roles: input.admission.preparation.project.roles.map((r) => ({
        roleId: r.id,
        applies: r.id === input.arbitration.roleId,
        reason: 'Confirmed primary planning conflict; no implementation or acceptance',
        paths:
          r.id === input.arbitration.roleId
            ? (before.tree as TaskTree).files.map((f) => f.path)
            : [],
        complete: true,
        attestedBy: 'project adapter',
        discoveryRule: 'exact primary conflict',
        history: { complete: true, answers: [] },
      })),
    };
    current(input, preflight);
    return {
      manifest,
      review: {
        schemaVersion: 1 as const,
        preparation: input.admission.preparation,
        reviewId: 'initial-arbitration-' + manifest.sha256.slice(0, 32),
        request: save(arbitration),
      },
    };
  }
  async function finish(
    input: InitialArbitrationTaskInput,
    prepared: { manifest: ArtifactRef; review: ReviewInput },
    reviewed: ArtifactRef,
  ) {
    const trigger = read(prepared.manifest),
      preflight = controlRef(trigger.preflight),
      before = current(input, preflight);
    requireContract(
      trigger.kind === 'initial-arbitration-request' && same(trigger.input, input),
      'initial-arbitration-binding',
    );
    const rebuilt = await prepare(
      input,
      preflight,
      parseReviewInput(trigger.planning),
      controlRef(trigger.reviewed),
    );
    requireContract(same(rebuilt, prepared), 'initial-arbitration-binding');
    const adjudicated = await verified(prepared.review, reviewed, input.arbitration.profile),
      reports = adjudicated.reports as { roleId: string; answer: ArtifactRef }[];
    requireContract(
      reports.length === 1 && reports[0]!.roleId === input.arbitration.roleId,
      'initial-arbitration-report-required',
    );
    const source = reports[0]!.answer,
      answer = read(source),
      proof = await reviewProof(registration, rpc)(source, requireScoped(answer.input));
    requireContract(
      proof !== null &&
        proof.snapshot.schemaVersion === 7 &&
        same(proof.snapshot.arbitration.trigger, prepared.manifest) &&
        same(proof.profile, input.arbitration.profile) &&
        !(trigger.sessions as string[]).includes(proof.session) &&
        proof.report.schemaVersion === 3,
      'initial-arbitration-independent-required',
    );
    const readiness = arbitrationReadiness(
      proof.report.decision,
      proof.report.coverage,
      object(trigger.target) as { roleId: string; findingId: string },
      [],
    );
    const manifest = save({
      kind: 'initial-arbitration-result',
      input,
      request: prepared.manifest,
      review: reviewed,
      answer: source,
      decision: proof.report.decision,
      ...readiness,
    });
    if (!readiness.ready) return { manifest, planning: null, preflight: null };
    const planning = parseReviewInput(trigger.planning),
      original = parseReviewRequest(read(planning.request), planning);
    requireContract(original.schemaVersion === 6, 'initial-planning-version');
    const originalReports = read(controlRef(trigger.reviewed)).reports as {
      roleId: string;
      answer: ArtifactRef;
      report: ReviewReport;
    }[];
    const followup: ReviewRequest = {
      ...original,
      schemaVersion: 4,
      roles: original.roles.map((role) => {
        const report = originalReports.find((r) => r.roleId === role.roleId);
        return {
          ...role,
          history: {
            complete: true,
            answers: [...role.history.answers, ...(report === undefined ? [] : [report.answer])],
          },
        };
      }),
      roleEvidence: original.roles.map((role) => ({
        roleId: role.roleId,
        evidence: role.applies === true ? [...original.evidence, prepared.manifest, manifest] : [],
        openFindings:
          originalReports
            .find((r) => r.roleId === role.roleId)
            ?.report.findings.filter((f) => f.blocking)
            .map((f) => f.id) ?? [],
      })),
    };
    const next: ReviewInput = {
      ...planning,
      reviewId: 'initial-replanning-' + manifest.sha256.slice(0, 32),
      request: save(followup),
    };
    const selection = await reviewActivities(registration, rpc, profile).prepareReviewPlan(next);
    requireContract(
      selection.decisions.every((r) => r.action !== 'blocked'),
      'initial-replanning-incomplete',
    );
    current(input, preflight);
    return {
      manifest,
      planning: next,
      preflight: save({
        ...before,
        planning: next,
        initialArbitration: manifest,
        originalPreflight: preflight,
      }),
    };
  }
  return { prepare, finish };
}
