import { requireWorkflow, textField } from './connection.js';

export interface StageTiming {
  id: string;
  estimate_ms: number;
  elapsed_ms: number | null;
  external_wait_ms: number | null;
  samples: { id: string; epoch: string; monotonic_ms: number; external: boolean }[];
  checkpoint: string;
  audited: string[];
}
export function createTiming(id: string, estimate: number, checkpoint: string): StageTiming {
  [id, checkpoint].forEach(textField);
  requireWorkflow(
    Number.isSafeInteger(estimate) && estimate > 0 && estimate <= 3_600_000,
    'invalid-stage-estimate',
  );
  return {
    id,
    estimate_ms: estimate,
    elapsed_ms: 0,
    external_wait_ms: 0,
    samples: [],
    checkpoint,
    audited: [],
  };
}
// Only monotonic samples within one process epoch establish a duration. Restart gaps stay unknown.
export function sampleTiming(
  timing: StageTiming,
  sample: StageTiming['samples'][number],
): StageTiming {
  [sample.id, sample.epoch].forEach(textField);
  requireWorkflow(
    Number.isFinite(sample.monotonic_ms) && sample.monotonic_ms >= 0,
    'invalid-monotonic-time',
  );
  const duplicate = timing.samples.find((s) => s.id === sample.id);
  if (duplicate) {
    requireWorkflow(
      duplicate.epoch === sample.epoch &&
        duplicate.monotonic_ms === sample.monotonic_ms &&
        duplicate.external === sample.external,
      'time-sample-conflict',
    );
    return timing;
  }
  const next = structuredClone(timing);
  const previous = next.samples.at(-1);
  if (previous) {
    if (previous.epoch !== sample.epoch || sample.monotonic_ms < previous.monotonic_ms) {
      next.elapsed_ms = null;
      next.external_wait_ms = null;
    } else {
      const field = previous.external ? 'external_wait_ms' : 'elapsed_ms';
      if (next[field] !== null) next[field] += sample.monotonic_ms - previous.monotonic_ms;
    }
  }
  next.samples.push(sample);
  return next;
}
export type AuditTrigger =
  { kind: 'overrun' } | { kind: 'doubt' | 'no-progress'; evidence_id: string };
export function knownElapsed(timing: StageTiming): number {
  let total = 0;
  for (let index = 1; index < timing.samples.length; index += 1) {
    const previous = timing.samples[index - 1]!;
    const current = timing.samples[index]!;
    if (
      previous.epoch === current.epoch &&
      !previous.external &&
      current.monotonic_ms >= previous.monotonic_ms
    )
      total += current.monotonic_ms - previous.monotonic_ms;
  }
  return total;
}
export function auditKey(timing: StageTiming, trigger: AuditTrigger): string {
  if (trigger.kind === 'overrun')
    requireWorkflow(
      (timing.elapsed_ms ?? knownElapsed(timing)) >= timing.estimate_ms * 2,
      'audit-threshold-not-reached',
    );
  else textField(trigger.evidence_id);
  return `${timing.id}:${timing.checkpoint}:${trigger.kind}:${trigger.kind === 'overrun' ? '' : trigger.evidence_id}`;
}
export function claimAudit(timing: StageTiming, trigger: AuditTrigger): StageTiming {
  const key = auditKey(timing, trigger);
  requireWorkflow(!timing.audited.includes(key), 'audit-already-handled');
  // Claim before the external session; unknown outcome cannot launch a second auditor.
  return { ...structuredClone(timing), audited: [...timing.audited, key] };
}
