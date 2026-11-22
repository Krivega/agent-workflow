import { parseArbitrationScope, parseArbitrationDecision } from './arbitration.js';
import type {
  ReviewInput,
  ReviewRequest,
  ReviewRole,
  ReviewSnapshot,
  ReviewReport,
} from '../contracts/review.js';
import type { ScopedReaderInput } from '../contracts/reader.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
} from '../contracts/project.js';
import { parsePreparation } from './preparation.js';
import { controlRef, parseReaderInput, scopedReader } from './readerControl.js';

function flag(value: unknown): boolean {
  requireContract(typeof value === 'boolean', 'review-boolean-required');
  return value;
}
function list(value: unknown): unknown[] {
  requireContract(Array.isArray(value), 'review-list-required');
  return value;
}
function paths(value: unknown): string[] {
  const items = list(value).map(relativePath);
  requireContract(new Set(items).size === items.length, 'review-duplicate-path');
  return items;
}
function wording(value: unknown): string {
  requireContract(typeof value === 'string' && value.trim().length > 0, 'review-text-required');
  return value;
}
function fileVersion(item: unknown) {
  const f = object(item);
  exactFields(f, ['path', 'sha256', 'bytes']);
  return { path: relativePath(f.path), ...controlRef({ sha256: f.sha256, bytes: f.bytes }) };
}
function phase(value: unknown): ReviewRequest['phase'] {
  requireContract(
    value === 'planning' || value === 'acceptance' || value === 'arbitration',
    'review-phase-invalid',
  );
  return value;
}
export function parseReviewInput(value: unknown): ReviewInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'preparation', 'reviewId', 'request']);
  requireContract(v.schemaVersion === 1, 'review-schema-unsupported');
  return {
    schemaVersion: 1,
    preparation: parsePreparation(v.preparation),
    reviewId: identifier(v.reviewId),
    request: controlRef(v.request),
  };
}
export function reviewKey(input: ReviewInput): string {
  const v = parseReviewInput(input);
  return `aw/review/${v.preparation.project.projectId}/${v.preparation.taskId}/${v.reviewId}`;
}
function role(value: unknown): ReviewRole {
  const v = object(value);
  exactFields(v, [
    'roleId',
    'applies',
    'reason',
    'paths',
    'complete',
    'attestedBy',
    'discoveryRule',
    'history',
  ]);
  requireContract(
    v.applies === true || v.applies === false || v.applies === null,
    'review-applicability-invalid',
  );
  const history = object(v.history);
  exactFields(history, ['complete', 'answers']);
  const complete = flag(v.complete);
  requireContract(
    typeof v.attestedBy === 'string' && typeof v.discoveryRule === 'string',
    'review-attestation-invalid',
  );
  if (complete) {
    wording(v.attestedBy);
    wording(v.discoveryRule);
  }
  const answers = list(history.answers).map(controlRef);
  requireContract(
    new Set(answers.map((a) => a.sha256)).size === answers.length,
    'review-duplicate-history',
  );
  return {
    roleId: identifier(v.roleId),
    applies: v.applies,
    reason: wording(v.reason),
    paths: paths(v.paths),
    complete,
    attestedBy: v.attestedBy,
    discoveryRule: v.discoveryRule,
    history: { complete: flag(history.complete), answers },
  };
}
export function parseReviewRequest(value: unknown, input: ReviewInput): ReviewRequest {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'phase',
    'scope',
    'sharedPaths',
    'roles',
    ...(v.schemaVersion === 2 ||
    v.schemaVersion === 3 ||
    v.schemaVersion === 4 ||
    v.schemaVersion === 5 ||
    v.schemaVersion === 7 ||
    v.schemaVersion === 6
      ? [
          'evidence',
          'expectedFiles',
          ...(v.schemaVersion === 4
            ? ['roleEvidence']
            : v.schemaVersion === 5 || v.schemaVersion === 7
              ? ['arbitration']
              : []),
        ]
      : []),
  ]);
  requireContract(
    v.schemaVersion === 1 ||
      v.schemaVersion === 2 ||
      v.schemaVersion === 3 ||
      v.schemaVersion === 4 ||
      v.schemaVersion === 5 ||
      v.schemaVersion === 7 ||
      v.schemaVersion === 6,
    'review-schema-unsupported',
  );
  requireContract(
    (v.schemaVersion === 5 || v.schemaVersion === 7) === (v.phase === 'arbitration'),
    'review-arbitration-version',
  );
  requireContract(v.schemaVersion !== 6 || v.phase === 'planning', 'review-conflict-phase');
  const roles = list(v.roles).map(role),
    declared = input.preparation.project.roles.map((r) => r.id);
  requireContract(
    roles.length === declared.length &&
      new Set(roles.map((r) => r.roleId)).size === roles.length &&
      roles.every((r) => declared.includes(r.roleId)),
    'review-role-selection-incomplete',
  );
  const arbitration =
    v.schemaVersion === 5 || v.schemaVersion === 7 ? parseArbitrationScope(v.arbitration) : null;
  if (arbitration !== null)
    requireContract(
      roles.filter((row) => row.applies === true).length === 1 &&
        roles.every(
          (row) =>
            row.complete &&
            row.history.complete &&
            row.history.answers.length === 0 &&
            row.applies !== null,
        ) &&
        declared.includes(arbitration.target.roleId) &&
        !roles.some((row) => row.applies === true && row.roleId === arbitration.target.roleId),
      'review-arbitration-selection',
    );
  const roleEvidence =
    v.schemaVersion === 4
      ? list(v.roleEvidence).map((raw) => {
          const entry = object(raw);
          exactFields(entry, ['roleId', 'evidence', 'openFindings']);
          return {
            roleId: identifier(entry.roleId),
            evidence: list(entry.evidence).map(controlRef),
            openFindings: list(entry.openFindings).map(wording),
          };
        })
      : undefined;
  if (roleEvidence !== undefined)
    requireContract(
      roleEvidence.length === declared.length &&
        new Set(roleEvidence.map((r) => r.roleId)).size === declared.length &&
        roleEvidence.every((r) => declared.includes(r.roleId)),
      'review-role-evidence-incomplete',
    );
  const extended =
    v.schemaVersion === 1
      ? null
      : {
          evidence: list(v.evidence).map(controlRef),
          expectedFiles: list(v.expectedFiles).map(fileVersion),
        };
  return {
    ...(extended === null
      ? { schemaVersion: 1 as const }
      : v.schemaVersion === 5 || v.schemaVersion === 7
        ? { schemaVersion: v.schemaVersion as 5 | 7, ...extended, arbitration: arbitration! }
        : v.schemaVersion === 4
          ? { schemaVersion: 4 as const, ...extended, roleEvidence: roleEvidence! }
          : { schemaVersion: v.schemaVersion as 2 | 3 | 6, ...extended }),
    phase: phase(v.phase),
    scope: wording(v.scope),
    sharedPaths: paths(v.sharedPaths),
    roles: declared.map((id) => roles.find((r) => r.roleId === id)!),
  };
}
export function parseReviewSnapshot(value: unknown, input: ScopedReaderInput): ReviewSnapshot {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'input',
    'phase',
    'scope',
    'sharedPaths',
    'selection',
    'files',
    ...(v.schemaVersion === 2 ||
    v.schemaVersion === 3 ||
    v.schemaVersion === 4 ||
    v.schemaVersion === 5 ||
    v.schemaVersion === 7 ||
    v.schemaVersion === 6
      ? [
          'evidence',
          ...(v.schemaVersion === 4
            ? ['openFindings']
            : v.schemaVersion === 5 || v.schemaVersion === 7
              ? ['arbitration']
              : []),
        ]
      : []),
  ]);
  requireContract(
    (v.schemaVersion === 1 ||
      v.schemaVersion === 2 ||
      v.schemaVersion === 3 ||
      v.schemaVersion === 4 ||
      v.schemaVersion === 5 ||
      v.schemaVersion === 7 ||
      v.schemaVersion === 6) &&
      v.kind === 'reader-review',
    'review-snapshot-invalid',
  );
  requireContract(
    (v.schemaVersion === 5 || v.schemaVersion === 7) === (v.phase === 'arbitration'),
    'review-arbitration-version',
  );
  requireContract(v.schemaVersion !== 6 || v.phase === 'planning', 'review-conflict-phase');
  const snapshotInput = parseReaderInput({ ...object(v.input), review: input.review });
  requireContract(
    JSON.stringify(snapshotInput) === JSON.stringify(parseReaderInput(input)),
    'review-snapshot-binding',
  );
  const selection = role(v.selection);
  requireContract(selection.roleId === input.roleId, 'review-snapshot-role');
  if (v.schemaVersion === 5 || v.schemaVersion === 7) {
    const arbitration = parseArbitrationScope(v.arbitration);
    requireContract(
      selection.applies === true &&
        selection.complete &&
        selection.history.complete &&
        selection.history.answers.length === 0 &&
        arbitration.target.roleId !== input.roleId,
      'review-arbitration-selection',
    );
  }
  const files = list(v.files).map(fileVersion);
  requireContract(
    files.length > 0 && new Set(files.map((f) => f.path)).size === files.length,
    'review-snapshot-files',
  );
  return {
    ...(v.schemaVersion === 2 ||
    v.schemaVersion === 3 ||
    v.schemaVersion === 4 ||
    v.schemaVersion === 5 ||
    v.schemaVersion === 7 ||
    v.schemaVersion === 6
      ? v.schemaVersion === 5 || v.schemaVersion === 7
        ? {
            schemaVersion: v.schemaVersion as 5 | 7,
            evidence: list(v.evidence).map(controlRef),
            arbitration: parseArbitrationScope(v.arbitration),
          }
        : v.schemaVersion === 4
          ? {
              schemaVersion: 4 as const,
              evidence: list(v.evidence).map(controlRef),
              openFindings: list(v.openFindings).map(wording),
            }
          : { schemaVersion: v.schemaVersion, evidence: list(v.evidence).map(controlRef) }
      : { schemaVersion: 1 as const }),
    kind: 'reader-review',
    input: {
      schemaVersion: 2,
      preparation: snapshotInput.preparation,
      roleId: snapshotInput.roleId,
      reviewId: input.reviewId,
    },
    phase: phase(v.phase),
    scope: wording(v.scope),
    sharedPaths: paths(v.sharedPaths),
    selection,
    files,
  };
}
export function parseReviewReport(
  value: unknown,
  input: ScopedReaderInput,
  snapshot: ReviewSnapshot,
): ReviewReport {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'roleId',
    'phase',
    'scope',
    'review',
    'verdict',
    'coverage',
    'findings',
    'limitations',
    ...(snapshot.schemaVersion === 4
      ? ['resolved']
      : snapshot.schemaVersion === 5 || snapshot.schemaVersion === 7
        ? ['decision']
        : snapshot.schemaVersion === 6
          ? ['conflicts']
          : []),
  ]);
  requireContract(
    v.schemaVersion ===
      (snapshot.schemaVersion === 6
        ? 4
        : snapshot.schemaVersion === 5 || snapshot.schemaVersion === 7
          ? 3
          : snapshot.schemaVersion === 4
            ? 2
            : 1) &&
      v.roleId === input.roleId &&
      v.phase === snapshot.phase &&
      v.scope === snapshot.scope &&
      JSON.stringify(controlRef(v.review)) === JSON.stringify(input.review),
    'review-report-binding',
  );
  requireContract(
    v.verdict === 'PASS' || v.verdict === 'FAIL' || v.verdict === 'NOT RUN',
    'review-verdict-invalid',
  );
  requireContract(v.coverage === 'complete' || v.coverage === 'partial', 'review-coverage-invalid');
  const findings = list(v.findings).map((item) => {
    const f = object(item);
    exactFields(f, ['id', 'blocking', 'text']);
    return { id: identifier(f.id), blocking: flag(f.blocking), text: wording(f.text) };
  });
  requireContract(
    new Set(findings.map((f) => f.id)).size === findings.length,
    'review-duplicate-finding',
  );
  requireContract(
    v.verdict !== 'PASS' || !findings.some((f) => f.blocking),
    'review-pass-with-blocker',
  );
  if (snapshot.schemaVersion === 5 || snapshot.schemaVersion === 7)
    requireContract(
      v.verdict === 'NOT RUN' && findings.length === 0,
      'arbitration-cannot-accept-or-close',
    );
  const conflicts =
    snapshot.schemaVersion === 6
      ? list(v.conflicts).map((item) => {
          const row = object(item);
          exactFields(row, ['findingId', 'sources']);
          const findingId = identifier(row.findingId),
            sources = list(row.sources).map(fileVersion);
          requireContract(
            v.verdict === 'FAIL' &&
              v.coverage === 'complete' &&
              findings.some((f) => f.id === findingId && f.blocking) &&
              sources.length >= 2 &&
              new Set(sources.map((s) => s.path)).size === sources.length &&
              sources.every((s) =>
                snapshot.files.some(
                  (f) => f.path === s.path && f.sha256 === s.sha256 && f.bytes === s.bytes,
                ),
              ),
            'review-conflict-unconfirmed',
          );
          return { findingId, sources };
        })
      : [];
  requireContract(
    new Set(conflicts.map((c) => c.findingId)).size === conflicts.length,
    'review-conflict-duplicate',
  );
  return {
    ...(snapshot.schemaVersion === 6
      ? { schemaVersion: 4 as const, conflicts }
      : snapshot.schemaVersion === 5 || snapshot.schemaVersion === 7
        ? { schemaVersion: 3 as const, decision: parseArbitrationDecision(v.decision) }
        : snapshot.schemaVersion === 4
          ? { schemaVersion: 2 as const, resolved: list(v.resolved).map(wording) }
          : { schemaVersion: 1 as const }),
    roleId: input.roleId,
    phase: snapshot.phase,
    scope: snapshot.scope,
    review: input.review,
    verdict: v.verdict,
    coverage: v.coverage,
    findings,
    limitations: list(v.limitations).map(wording),
  };
}
export function reviewChanges(before: ReviewSnapshot, after: ReviewSnapshot): string[] {
  const reasons: string[] = [];
  if (
    (before.schemaVersion === 6) !== (after.schemaVersion === 6) ||
    before.schemaVersion >= 3 !== after.schemaVersion >= 3
  )
    reasons.push('report-format-changed');
  if (
    JSON.stringify(before.schemaVersion !== 1 ? before.evidence : []) !==
    JSON.stringify(after.schemaVersion !== 1 ? after.evidence : [])
  )
    reasons.push('evidence-changed');
  if (before.phase !== after.phase || before.scope !== after.scope)
    reasons.push('review-target-changed');
  if (before.input.preparation.revision !== after.input.preparation.revision)
    reasons.push('requirements-changed');
  if (
    before.selection.applies !== after.selection.applies ||
    before.selection.reason !== after.selection.reason
  )
    reasons.push('role-obligation-changed');
  if (!before.selection.complete || !after.selection.complete) reasons.push('dependencies-unknown');
  if (before.selection.discoveryRule !== after.selection.discoveryRule)
    reasons.push('discovery-changed');
  const old = new Map(before.files.map((f) => [f.path, f]));
  for (const file of after.files) {
    const prior = old.get(file.path);
    if (prior === undefined || prior.sha256 !== file.sha256 || prior.bytes !== file.bytes)
      reasons.push(`input-changed:${file.path}`);
    old.delete(file.path);
  }
  for (const path of old.keys()) reasons.push(`input-removed:${path}`);
  return reasons;
}
export function requireScoped(input: unknown): ScopedReaderInput {
  const value = parseReaderInput(input);
  requireContract(scopedReader(value), 'review-scoped-reader-required');
  return value;
}
