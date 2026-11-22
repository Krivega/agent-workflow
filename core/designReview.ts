import { object, requireWorkflow, textField } from './connection.js';
import type { InputManifest } from './evidence.js';
import { targetEvidenceInputs } from './evidence.js';
import type { InputRef } from './localRun.js';

export interface DesignAssessment {
  verdict: 'PASS' | 'FAIL' | 'NOT RUN' | 'N/A';
  coverage: 'complete' | 'partial';
  reason: string;
  evidence: {
    kind: 'proposal' | 'screens' | 'interaction';
    artifacts: InputRef[];
    observation: string;
  }[];
}
export type DesignReview = Record<'ui' | 'ux', DesignAssessment>;

export function designEvidenceApplicable(design: DesignReview, inputs: InputManifest): boolean {
  return (
    inputs.complete &&
    Object.values(design).every((assessment) =>
      assessment.evidence.every((proof) =>
        proof.artifacts.every((ref) =>
          inputs.inputs.some((input) => input.locator === ref.locator && input.hash === ref.hash),
        ),
      ),
    )
  );
}

export function confirmDesignReview(
  phase: 'planning' | 'acceptance',
  answer: {
    design?: DesignReview;
    verdict: DesignAssessment['verdict'];
    coverage: DesignAssessment['coverage'];
    target: { inputs: InputManifest; evidence_inputs?: InputManifest };
  },
): void {
  requireWorkflow(answer.design !== undefined, 'design-review-required');
  const inputs = targetEvidenceInputs(answer.target);
  const design = object(answer.design);
  const assessments = ['ui', 'ux'].map((area) => {
    const assessment = object(design[area]);
    requireWorkflow(
      typeof assessment.verdict === 'string' &&
        ['PASS', 'FAIL', 'NOT RUN', 'N/A'].includes(assessment.verdict) &&
        typeof assessment.coverage === 'string' &&
        ['complete', 'partial'].includes(assessment.coverage),
      'invalid-design-assessment',
    );
    textField(assessment.reason);
    requireWorkflow(Array.isArray(assessment.evidence), 'design-evidence-required');
    const evidence = assessment.evidence.map((entry) => {
      const proof = object(entry);
      requireWorkflow(
        typeof proof.kind === 'string' &&
          ['proposal', 'screens', 'interaction'].includes(proof.kind) &&
          Array.isArray(proof.artifacts) &&
          proof.artifacts.length > 0,
        'invalid-design-evidence',
      );
      textField(proof.observation);
      for (const item of proof.artifacts as unknown[]) {
        const ref = object(item);
        textField(ref.locator);
        requireWorkflow(
          typeof ref.hash === 'string' && /^[a-f0-9]{64}$/u.test(ref.hash),
          'invalid-design-artifact-hash',
        );
        requireWorkflow(
          inputs.complete &&
            inputs.inputs.some((input) => input.locator === ref.locator && input.hash === ref.hash),
          'design-artifact-outside-target',
        );
      }
      return proof.kind;
    });
    if (assessment.verdict === 'PASS') {
      const kind = phase === 'planning' ? 'proposal' : area === 'ui' ? 'screens' : 'interaction';
      requireWorkflow(
        assessment.coverage === 'complete' && evidence.includes(kind),
        'design-proof-incomplete',
      );
    }
    if (assessment.verdict === 'N/A')
      requireWorkflow(assessment.coverage === 'complete', 'design-na-incomplete');
    return assessment;
  });
  requireWorkflow(
    assessments.some((assessment) => assessment.verdict !== 'N/A'),
    'design-role-not-applicable',
  );
  const coverage = assessments.every((assessment) => assessment.coverage === 'complete')
    ? 'complete'
    : 'partial';
  const verdict = assessments.some((assessment) => assessment.verdict === 'FAIL')
    ? 'FAIL'
    : assessments.some((assessment) => assessment.verdict === 'NOT RUN')
      ? 'NOT RUN'
      : 'PASS';
  requireWorkflow(
    answer.verdict === verdict && answer.coverage === coverage,
    'design-summary-mismatch',
  );
}
