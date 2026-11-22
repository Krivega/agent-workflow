import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { correctionFixture } from './correctionFixture.js';
import type { ArbitrationTaskInput } from '../../src/contracts/localTask.js';
export function arbitrationFixture() {
  const f = correctionFixture(2);
  writeFileSync(
    join(f.workspace, 'arbiter.md'),
    readFileSync(new URL('../../procedures/arbitration.md', import.meta.url)),
  );
  f.registration.project.roles.push({ id: 'arbiter', profile: 'arbiter.md' });
  const profile = { ...f.profile, effort: 'high' };
  const na = {
    ...f.correctionRequest.roles[0]!,
    roleId: 'arbiter',
    applies: false,
    reason: 'Independent arbitration only',
    paths: [],
  };
  const request = {
    ...f.correctionRequest,
    schemaVersion: 2 as const,
    evidence: [
      f.save({
        kind: 'accepted-arbitration-basis',
        value: 'Preserve original FAIL and all mandatory criteria',
      }),
    ],
    expectedFiles: [],
    roles: [...f.correctionRequest.roles, na],
  };
  if (f.correctionInput.admission.schemaVersion !== 3)
    throw new Error('substantial fixture required');
  const input: ArbitrationTaskInput = {
    ...f.correctionInput,
    schemaVersion: 5,
    admission: {
      ...f.correctionInput.admission,
      planning: f.save({ ...request, phase: 'planning' }),
      acceptance: f.save(request),
    },
    corrections: {
      ...f.correctionInput.corrections,
      checks: [...f.correctionInput.corrections.checks, { roleId: 'arbiter', commands: [] }],
    },
    arbitration: { roleId: 'arbiter', profile, compromiseFindings: [] },
  };
  Object.assign(f.host, { arbiter: { roleId: 'arbiter', profile } });
  return { ...f, service: f.makeService(), arbitrationInput: input, arbiterProfile: profile };
}
