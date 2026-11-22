import { describe, it, expect, vi } from 'vitest';
import * as corrections from './correctionFixture.js';
import {
  parseArbitrationDecision,
  parseArbitrationScope,
  arbitrationReadiness,
} from '../../src/policy/arbitration.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { arbitrationFixture } from './arbitrationFixture.js';
import type { ArbitrationDecision } from '../../src/contracts/review.js';

it('rejects a non-substantial correction fixture before preparing arbitration', () => {
  const fixture = corrections.correctionFixture(2);
  Reflect.set(fixture.correctionInput.admission, 'schemaVersion', 2);
  const source = vi.spyOn(corrections, 'correctionFixture').mockReturnValue(fixture);
  try {
    expect(() => arbitrationFixture()).toThrow('substantial fixture required');
  } finally {
    source.mockRestore();
  }
});
const target = { roleId: 'reviewer', findingId: 'F1' },
  direction: ArbitrationDecision = {
    kind: 'direction',
    mandatoryDefect: true,
    direction: 'Fix exactly F1',
    exception: null,
    residualRisk: null,
    dissent: [],
    condition: null,
  },
  compromise: ArbitrationDecision = {
    kind: 'compromise',
    mandatoryDefect: false,
    direction: 'Apply the checked exception to F1',
    exception: 'Only F1',
    residualRisk: 'Dissent remains',
    dissent: ['F1 originally rejected'],
    condition: null,
  },
  held: ArbitrationDecision = {
    kind: 'no-decision',
    mandatoryDefect: null,
    direction: null,
    exception: null,
    residualRisk: null,
    dissent: [],
    condition: 'Need exact input',
  };
describe('arbitration policy', () => {
  it('requires explicit scope and preserves mandatory defects, unknowns and dissent', () => {
    expect(
      parseArbitrationDecision({ ...direction, direction: 'x'.repeat(4096) }).direction,
    ).toHaveLength(4096);
    expect(() => parseArbitrationDecision({ ...direction, direction: '  ' })).toThrow(
      'arbitration-text-required',
    );
    for (const d of [direction, compromise, held]) expect(parseArbitrationDecision(d)).toEqual(d);
    expect(arbitrationReadiness(direction, 'complete', target, []).ready).toBe(true);
    expect(arbitrationReadiness(compromise, 'complete', target, [target]).ready).toBe(true);
    expect(arbitrationReadiness(compromise, 'complete', target, [])).toMatchObject({
      ready: false,
      reason: 'compromise-requires-explicit-human-scope',
    });
    expect(
      arbitrationReadiness({ ...compromise, mandatoryDefect: true }, 'complete', target, [target]),
    ).toMatchObject({ ready: false, reason: 'mandatory-defect-cannot-be-waived' });
    expect(arbitrationReadiness(held, 'complete', target, [target]).ready).toBe(false);
    expect(arbitrationReadiness(direction, 'partial', target, []).ready).toBe(false);
    expect(
      arbitrationReadiness(compromise, 'complete', target, [
        { roleId: 'other', findingId: 'F1' },
        { roleId: 'reviewer', findingId: 'F2' },
      ]).ready,
    ).toBe(false);
    for (const bad of [
      { ...direction, condition: 'invented' },
      { ...held, direction: 'override' },
      { ...direction, kind: 'override' },
      { ...compromise, exception: null },
      { ...direction, mandatoryDefect: null },
      { ...direction, dissent: null },
    ])
      expect(() => parseArbitrationDecision(bad)).toThrow();
  });
  it('validates the immutable input before dependent models and supports a complete scope', () => {
    const f = arbitrationFixture(),
      input = f.arbitrationInput;
    expect(parseLocalTask(input)).toEqual(input);
    for (const arbitration of [
      { ...input.arbitration, roleId: 'missing' },
      { ...input.arbitration, profile: { ...input.arbitration.profile, clientVersion: 'other' } },
      { ...input.arbitration, compromiseFindings: null },
      { ...input.arbitration, compromiseFindings: [{ roleId: 'arbiter', findingId: 'F1' }] },
      { ...input.arbitration, compromiseFindings: [target, target] },
    ])
      expect(() => parseLocalTask({ ...input, arbitration })).toThrow();
    expect(() =>
      parseLocalTask({ ...input, corrections: { ...input.corrections, maxRounds: 1 } }),
    ).toThrow('task-arbitration-two-corrections-required');
    const scope = { target, trigger: f.proof, profile: f.arbiterProfile };
    expect(parseArbitrationScope(scope)).toEqual(scope);
  });
});
