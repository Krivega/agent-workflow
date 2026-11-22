import { workflowFixture } from './workflowFixtures.js';
import type { RelaySeed } from '../core/relay.js';
import type { AgentSession } from '../core/dataRoute.js';
import type { Json } from '../core/evidence.js';
export async function relayFixture() {
  const f = await workflowFixture();
  const seed: RelaySeed = {
    schema_version: 1,
    id: 'relay',
    predecessor: f.executor,
    native_project_id: 'native',
    trigger: { thread: 'session', turn: 'turn', item: 'compact', mode: 'auto', evidence: f.proof },
    authority: f.proof,
    checkpoint: {
      local_run: f.executor as unknown as Json,
      workflow: {
        schema_version: 1,
        revision: 0,
        execution: null,
        readings: {},
        findings: ['original FAIL'],
        unknown: 'keep',
      },
    },
    snapshot: f.proof,
    progress: {
      active_stage: 'stage',
      estimate_ms: 60000,
      elapsed_ms: 125000,
      external_wait_ms: null,
      next_action: 'write marker',
      audit_checkpoint: 'audit-1',
      findings: ['original FAIL'],
      gates: ['validate'],
      pending_human: ['choice'],
      child_evidence: [f.proof],
      mapping: null,
    },
  };
  const successor: AgentSession = {
    id: 'successor',
    project_id: 'native',
    workspace: f.root,
    model: f.executor.spec.requested.model,
    effort: f.executor.spec.requested.effort,
    read_only: false,
    network: false,
    initial_turns: 0,
    forked_from: null,
    receipt: f.proof,
  };
  return { ...f, seed, successor };
}
