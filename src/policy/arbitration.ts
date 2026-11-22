import type { ArbitrationDecision, ArbitrationScope } from '../contracts/review.js';
import { object, exactFields, identifier, requireContract } from '../contracts/project.js';
import { controlRef } from './readerControl.js';
import { readerExecution } from './readerExecution.js';
export function parseArbitrationScope(value: unknown): ArbitrationScope {
  const raw = object(value);
  exactFields(raw, ['target', 'trigger', 'profile']);
  const target = object(raw.target);
  exactFields(target, ['roleId', 'findingId']);
  return {
    target: { roleId: identifier(target.roleId), findingId: identifier(target.findingId) },
    trigger: controlRef(raw.trigger),
    profile: readerExecution(
      object(raw.profile) as unknown as Parameters<typeof readerExecution>[0],
    ).profile,
  };
}
export function parseArbitrationDecision(value: unknown): ArbitrationDecision {
  const raw = object(value);
  exactFields(raw, [
    'kind',
    'mandatoryDefect',
    'direction',
    'exception',
    'residualRisk',
    'dissent',
    'condition',
  ]);
  requireContract(Array.isArray(raw.dissent), 'arbitration-dissent-required');
  const dissent = raw.dissent.map(wording);
  if (raw.kind === 'no-decision') {
    requireContract(
      raw.direction === null &&
        raw.exception === null &&
        raw.residualRisk === null &&
        raw.mandatoryDefect === null,
      'arbitration-no-decision-invalid',
    );
    return {
      kind: 'no-decision',
      mandatoryDefect: null,
      direction: null,
      exception: null,
      residualRisk: null,
      dissent,
      condition: wording(raw.condition),
    };
  }
  requireContract(
    typeof raw.mandatoryDefect === 'boolean',
    'arbitration-mandatory-status-required',
  );
  requireContract(raw.condition === null, 'arbitration-condition-invalid');
  if (raw.kind === 'compromise')
    return {
      kind: 'compromise',
      mandatoryDefect: raw.mandatoryDefect,
      direction: wording(raw.direction),
      exception: wording(raw.exception),
      residualRisk: wording(raw.residualRisk),
      dissent,
      condition: null,
    };
  requireContract(
    raw.kind === 'direction' && raw.exception === null && raw.residualRisk === null,
    'arbitration-direction-invalid',
  );
  return {
    kind: 'direction',
    mandatoryDefect: raw.mandatoryDefect,
    direction: wording(raw.direction),
    exception: null,
    residualRisk: null,
    dissent,
    condition: null,
  };
}

export function arbitrationReadiness(
  decision: ArbitrationDecision,
  coverage: 'complete' | 'partial',
  target: ArbitrationScope['target'],
  allowed: ArbitrationScope['target'][],
) {
  if (coverage !== 'complete' || decision.kind === 'no-decision')
    return { ready: false, reason: 'arbitration-no-decision' };
  if (decision.kind === 'compromise') {
    if (decision.mandatoryDefect)
      return { ready: false, reason: 'mandatory-defect-cannot-be-waived' };
    if (!allowed.some((row) => row.roleId === target.roleId && row.findingId === target.findingId))
      return { ready: false, reason: 'compromise-requires-explicit-human-scope' };
  }
  return { ready: true, reason: 'post-arbitration-working-check-and-affected-review-required' };
}

function wording(value: unknown): string {
  requireContract(
    typeof value === 'string' && value.trim().length > 0,
    'arbitration-text-required',
  );
  return value;
}
