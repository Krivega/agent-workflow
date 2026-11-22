import type { CoordinationSeed } from '../core/coordination.js';
import { applyLocalEvent, startLocalRun } from '../core/localRun.js';
import { workflowFixture } from './workflowFixtures.js';
import { event, loadedRun } from './localFixtures.js';
export async function coordinationFixture() {
  const f = await workflowFixture();
  const profile = {
    model: 'fixture',
    effort: 'high',
    permissions: ['read', 'coordinate'] as ('read' | 'coordinate')[],
  };
  let run = loadedRun(
    startLocalRun({ ...f.spec, coordinator: true, requested: profile, effective: profile }, 1),
  );
  run = applyLocalEvent(run, event(run, { type: 'READY' }));
  const seed: CoordinationSeed = {
    schema_version: 1,
    run,
    children: ['a', 'b'].map((id) => ({
      id,
      scope: { workspace: f.root, paths: [`${id}.txt`] },
      writer: id,
      read_only: false,
      dependencies: [],
      criterion: `${id} criterion`,
      authority: f.proof,
      native_project_id: 'native',
      profile: { model: 'fixture', effort: 'high' },
    })),
    integration: {
      executor: 'integrator',
      scope: { workspace: f.root, paths: ['common.txt'] },
      authority: f.proof,
    },
    poll_interval_ms: 210_000,
  };
  const check = {
    id: 'validate',
    verdict: 'PASS' as const,
    reason: 'test double',
    evidence: f.proof,
    inputs: f.target.inputs,
  };
  const result = (id: string) => ({
    scope: seed.children.find((c) => c.id === id)!.scope,
    criterion: `${id} criterion`,
    inputs: f.target.inputs,
    evidence: f.proof,
    acceptance: check,
  });
  return { ...f, seed, check, result };
}
