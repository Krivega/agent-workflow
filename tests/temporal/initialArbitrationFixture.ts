import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arbitrationFixture } from './arbitrationFixture.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import type { InitialArbitrationTaskInput } from '../../src/contracts/localTask.js';
export function initialArbitrationFixture() {
  const f = arbitrationFixture();
  f.fault.inject = false;
  f.state.initialConflict = true;
  writeFileSync(
    join(f.workspace, 'proposal.md'),
    'Alternative proposal: preserve surrounding whitespace. This conflicts with the accepted trimming contract; ask the independent arbiter which existing source governs. No mandatory criterion or check may be waived.\n',
  );
  const plan = {
    ...f.correctionPlan,
    basis: f.correctionPlan.basis.map((ref) => ({
      ...ref,
      hash: digest(readFileSync(join(f.workspace, ref.locator))),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(join(f.workspace, 'plan.json'), bytes);
  const input: InitialArbitrationTaskInput = {
    schemaVersion: 6,
    admission: {
      ...f.arbitrationInput.admission,
      schemaVersion: 3,
      planning: f.save({ ...f.read(f.arbitrationInput.admission.acceptance), phase: 'planning' }),
      plan: { path: 'plan.json', sha256: digest(bytes) },
    },
    executor: f.arbitrationInput.executor,
    baseline: f.arbitrationInput.baseline,
    arbitration: { roleId: 'arbiter', profile: f.arbiterProfile },
  };
  return { ...f, initialInput: input };
}
