import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { ReviewActivities, ReviewSnapshot, ReviewDecision } from '../contracts/review.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { object, requireContract, exactFields, identifier } from '../contracts/project.js';
import { checkRegistration } from '../policy/preparation.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import { controlRef } from '../policy/readerControl.js';
import { supportedReaderClient } from '../policy/readerExecution.js';
import {
  parseReviewInput,
  parseReviewRequest,
  requireScoped,
  reviewChanges,
} from '../policy/review.js';
import { artifactStore, digest, readProjectFile } from '../adapters/artifacts/files.js';
import { reviewProof } from '../adapters/codex/reviewProof.js';
import { checkReviewCommands, scopedReviewInputs } from '../adapters/codex/reviewInputs.js';

export function reviewActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
): ReviewActivities {
  requireContract(supportedReaderClient(profile.clientVersion), 'unsupported-codex-client');
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const store = artifactStore(registration.artifactRoot),
    save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  const read = (ref: ArtifactRef) =>
    object(JSON.parse(store.read(ref).toString('utf8')) as unknown);
  const prior = reviewProof(registration, rpc);

  return {
    async prepareReviewPlan(value) {
      const input = parseReviewInput(value);
      checkRegistration(input.preparation, registration);
      backend.require(
        input.preparation.project.projectId,
        input.preparation.taskId,
        'temporal',
        'worker',
        input.preparation.card,
      );
      checkReviewCommands(registration, input);
      const request = parseReviewRequest(read(input.request), input);
      if (request.schemaVersion !== 1) {
        for (const ref of request.evidence) store.read(ref);
        requireContract(
          request.expectedFiles.length > 0 &&
            new Set(request.expectedFiles.map((f) => f.path)).size === request.expectedFiles.length,
          'review-packet-files-incomplete',
        );
        for (const file of request.expectedFiles) {
          const bytes = readProjectFile(registration.workspaceRoot, file.path);
          requireContract(
            digest(bytes) === file.sha256 && bytes.length === file.bytes,
            'review-packet-stale',
          );
        }
      }
      if (request.schemaVersion === 5 || request.schemaVersion === 7)
        requireContract(same(request.arbitration.profile, profile), 'arbitration-profile-mismatch');
      const candidates = request.roles.map((selection) => {
        const reviewId = digest(
          JSON.stringify([input.reviewId, selection.roleId, request.phase, request.scope]),
        );
        const base = {
          schemaVersion: 2 as const,
          preparation: input.preparation,
          roleId: selection.roleId,
          reviewId,
        };
        const needed =
          selection.applies !== false ||
          selection.history.answers.length > 0 ||
          !selection.history.complete;
        const role = input.preparation.project.roles.find((r) => r.id === selection.roleId)!;
        const paths = needed
          ? [
              ...new Set([
                ...input.preparation.project.rules,
                role.profile,
                input.preparation.card,
                ...request.sharedPaths,
                ...selection.paths,
              ]),
            ]
          : [];
        const files = paths.map((path) => {
          const bytes = readProjectFile(registration.workspaceRoot, path);
          if (request.schemaVersion !== 1)
            requireContract(
              request.expectedFiles.some(
                (f) => f.path === path && f.sha256 === digest(bytes) && f.bytes === bytes.length,
              ),
              'review-packet-input-missing',
            );
          return { path, sha256: digest(bytes), bytes: bytes.length };
        });
        const snapshot: ReviewSnapshot = {
          ...(request.schemaVersion === 5 || request.schemaVersion === 7
            ? {
                schemaVersion: request.schemaVersion,
                evidence: request.evidence,
                arbitration: request.arbitration,
              }
            : request.schemaVersion === 4
              ? {
                  schemaVersion: 4 as const,
                  evidence: request.roleEvidence.find((r) => r.roleId === selection.roleId)!
                    .evidence,
                  openFindings: request.roleEvidence.find((r) => r.roleId === selection.roleId)!
                    .openFindings,
                }
              : request.schemaVersion !== 1
                ? { schemaVersion: request.schemaVersion, evidence: request.evidence }
                : { schemaVersion: 1 as const }),
          kind: 'reader-review',
          input: base,
          phase: request.phase,
          scope: request.scope,
          sharedPaths: request.sharedPaths,
          selection,
          files,
        };
        return { snapshot, input: needed ? { ...base, review: save(snapshot) } : null };
      });
      // All required files exist before any primary reconciliation or dependent model dispatch.
      const decisions: ReviewDecision[] = [],
        sessions = new Map<string, string>();
      for (const candidate of candidates) {
        const { snapshot, input: reader } = candidate,
          selection = snapshot.selection;
        let previous: Awaited<ReturnType<typeof prior>> = null;
        for (const [index, ref] of selection.history.answers.entries()) {
          previous = await prior(ref, reader!);
          if (previous !== null) {
            requireContract(
              same(
                previous.snapshot.selection.history.answers,
                selection.history.answers.slice(0, index),
              ),
              'review-history-chain-incomplete',
            );
            const assigned = sessions.get(previous.session);
            requireContract(
              assigned === undefined || assigned === selection.roleId,
              'review-history-independent-session-required',
            );
            sessions.set(previous.session, selection.roleId);
          }
        }
        if (snapshot.schemaVersion === 4)
          requireContract(
            same([...snapshot.openFindings].sort(), [...(previous?.openFindings ?? [])].sort()),
            'review-open-findings-incomplete',
          );
        const reasons: string[] = [];
        let action: ReviewDecision['action'];
        if (selection.applies === null) {
          action = 'blocked';
          reasons.push('applicability-unknown');
        } else if (
          selection.applies === false &&
          selection.history.complete &&
          (selection.history.answers.length === 0 ||
            (previous?.report.verdict === 'PASS' && previous.report.coverage === 'complete'))
        ) {
          action = 'not-applicable';
          reasons.push('role-not-applicable');
        } else {
          if (!selection.history.complete) reasons.push('history-incomplete');
          if (previous === null)
            reasons.push(
              selection.history.answers.length === 0 ? 'no-prior-review' : 'legacy-unqualified',
            );
          else {
            if (previous.report.verdict !== 'PASS') reasons.push('open-failure');
            if (previous.report.coverage !== 'complete') reasons.push('partial-review');
            if (!same(previous.profile, profile)) reasons.push('model-profile-changed');
            reasons.push(...reviewChanges(previous.snapshot, snapshot));
          }
          if (!selection.complete && !reasons.includes('dependencies-unknown'))
            reasons.push('dependencies-unknown');
          action = reasons.length === 0 ? 'reuse' : 'review';
          if (action === 'reuse') reasons.push('complete-pass-with-unchanged-inputs');
        }
        decisions.push({
          roleId: selection.roleId,
          action,
          reasons,
          input: reader,
          answer: action === 'reuse' ? selection.history.answers.at(-1)! : null,
        });
      }
      for (const candidate of candidates)
        if (candidate.input !== null) scopedReviewInputs(registration, candidate.input);
      return {
        manifest: save({ schemaVersion: 1, kind: 'reader-review-plan', input, request, decisions }),
        decisions,
      };
    },
    async finishReview(value) {
      const raw = object(value);
      exactFields(raw, ['schemaVersion', 'input', 'plan', 'answers']);
      requireContract(raw.schemaVersion === 1, 'review-completion-schema');
      const input = parseReviewInput(raw.input);
      checkRegistration(input.preparation, registration);
      backend.require(
        input.preparation.project.projectId,
        input.preparation.taskId,
        'temporal',
        'worker',
        input.preparation.card,
      );
      const planRef = controlRef(raw.plan),
        plan = read(planRef);
      requireContract(
        plan.schemaVersion === 1 &&
          plan.kind === 'reader-review-plan' &&
          same(plan.input, input) &&
          Array.isArray(plan.decisions),
        'review-completion-plan',
      );
      requireContract(Array.isArray(raw.answers), 'review-completion-answers');
      const answers = raw.answers.map((item) => {
        const a = object(item);
        exactFields(a, ['roleId', 'answer']);
        return {
          roleId: identifier(a.roleId),
          answer: a.answer === null ? null : controlRef(a.answer),
        };
      });
      const rows = plan.decisions as ReviewDecision[];
      requireContract(
        answers.length === rows.length &&
          new Set(answers.map((a) => a.roleId)).size === answers.length &&
          rows.every((r) => answers.some((a) => a.roleId === r.roleId)),
        'review-completion-answers',
      );
      const sessions = new Set<string>(),
        reports: unknown[] = [];
      let complete = true;
      for (const row of rows) {
        const answer = answers.find((a) => a.roleId === row.roleId)!.answer;
        if (row.action === 'not-applicable') {
          requireContract(answer === null, 'review-completion-unexpected-answer');
          continue;
        }
        if (row.action === 'blocked' || answer === null) {
          complete = false;
          continue;
        }
        const current = requireScoped(row.input),
          source = await prior(answer, current);
        requireContract(source !== null, 'review-completion-unqualified');
        requireContract(
          !sessions.has(source.session),
          'review-history-independent-session-required',
        );
        sessions.add(source.session);
        const saved = read(answer);
        requireContract(
          row.action !== 'review' || same(saved.input, current),
          'review-completion-target-mismatch',
        );
        if (row.action === 'reuse')
          requireContract(same(answer, row.answer), 'review-completion-reuse-mismatch');
        const { snapshot } = scopedReviewInputs(registration, current);
        requireContract(
          same(source.profile, profile) &&
            reviewChanges(source.snapshot, snapshot).filter(
              (reason) => row.action !== 'review' || reason !== 'dependencies-unknown',
            ).length === 0,
          'review-completion-stale',
        );
        if (
          source.report.verdict !== 'PASS' ||
          source.report.coverage !== 'complete' ||
          !snapshot.selection.complete ||
          !snapshot.selection.history.complete
        )
          complete = false;
        reports.push({ roleId: row.roleId, source: row.action, answer, report: source.report });
      }
      for (const row of rows) if (row.input !== null) scopedReviewInputs(registration, row.input);
      backend.require(
        input.preparation.project.projectId,
        input.preparation.taskId,
        'temporal',
        'worker',
        input.preparation.card,
      );
      return {
        manifest: save({
          schemaVersion: 1,
          kind: 'reader-review-result',
          input,
          plan: planRef,
          answers,
          reports,
          complete,
        }),
        complete,
      };
    },
  };
}
