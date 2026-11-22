import { requireWorkflow, textField } from './connection.js';
import type { CouncilRole, ReviewFinding } from './council.js';
import type { InputRef } from './localRun.js';

export interface Finding extends ReviewFinding {
  owner: CouncilRole;
  original_fail: InputRef;
  rounds: {
    correction_id: string;
    evidence: InputRef[];
    reviewers: CouncilRole[];
    verdicts?: { reviewer: CouncilRole; verdict: 'PASS' | 'FAIL'; evidence: InputRef }[];
  }[];
  resolution: { condition: string; evidence: InputRef; reviewer: CouncilRole } | null;
}
export function recordRoundVerdict(
  finding: Finding,
  correction: string,
  reviewer: CouncilRole,
  verdict: 'PASS' | 'FAIL',
  evidence: InputRef,
): Finding {
  const next = recordCorrection(finding, correction, reviewer, evidence);
  const round = next.rounds.find((r) => r.correction_id === correction)!;
  const previous = round.verdicts?.find((v) => v.reviewer === reviewer);
  requireWorkflow(
    previous === undefined ||
      (previous.verdict === verdict &&
        previous.evidence.locator === evidence.locator &&
        previous.evidence.hash === evidence.hash),
    'round-verdict-conflict',
  );
  if (!previous) round.verdicts = [...(round.verdicts ?? []), { reviewer, verdict, evidence }];
  return next;
}
export function recordFinding(
  findings: Finding[],
  finding: ReviewFinding,
  owner: CouncilRole,
  evidence: InputRef,
): Finding[] {
  const previous = findings.find((f) => f.id === finding.id);
  if (previous) {
    requireWorkflow(
      previous.scope === finding.scope && previous.condition === finding.condition,
      'finding-identity-conflict',
    );
    return findings;
  }
  return [
    ...findings,
    { ...structuredClone(finding), owner, original_fail: evidence, rounds: [], resolution: null },
  ];
}
export function recordCorrection(
  finding: Finding,
  correction: string,
  reviewer: CouncilRole,
  evidence: InputRef,
): Finding {
  requireWorkflow(finding.resolution === null, 'finding-already-resolved');
  textField(correction);
  const next = structuredClone(finding);
  const round = next.rounds.find((r) => r.correction_id === correction);
  if (round) {
    if (!round.reviewers.includes(reviewer)) {
      round.reviewers.push(reviewer);
      round.evidence.push(evidence);
    }
  } else
    next.rounds.push({ correction_id: correction, evidence: [evidence], reviewers: [reviewer] });
  return next;
}
export function resolveFinding(
  finding: Finding,
  condition: string,
  evidence: InputRef,
  reviewer: CouncilRole,
  verdict: 'PASS' | 'FAIL',
): Finding {
  requireWorkflow(finding.resolution === null, 'finding-already-resolved');
  requireWorkflow(
    condition === finding.condition && verdict === 'PASS' && reviewer === finding.owner,
    'resolution-condition-not-met',
  );
  requireWorkflow(
    finding.rounds.some(
      (r) =>
        r.reviewers.includes(reviewer) &&
        r.evidence.some((ref) => ref.locator === evidence.locator && ref.hash === evidence.hash),
    ),
    'resolution-evidence-missing',
  );
  return { ...finding, resolution: { condition, evidence, reviewer } };
}
