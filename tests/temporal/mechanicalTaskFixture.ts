import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import type { MechanicalMaterial } from '../../src/contracts/mechanicalTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { localTaskFixture } from './localTaskFixture.js';
import { runReview } from './localTaskRun.js';

export async function mechanicalTaskFixture(
  operation: 'replace' | 'create' | 'delete' | 'multiple' = 'replace',
) {
  const f = localTaskFixture(),
    files = taskFiles(f.registration.artifactRoot);
  mkdirSync(join(f.workspace, 'approved'));
  writeFileSync(join(f.workspace, 'approved/owner.cjs'), 'module.exports = name => name.trim();\n');
  if (operation === 'create' || operation === 'delete')
    writeFileSync(join(f.workspace, 'owner.cjs'), 'module.exports = name => name.trim();\n');
  const source = (locator: string) => ({
    locator,
    hash: digest(readFileSync(join(f.workspace, locator))),
  });
  const material: MechanicalMaterial = {
    schemaVersion: 1,
    kind: 'mechanical-material',
    materialId: 'approved-label',
    requirement: source('tasks/one.md'),
    links: ['accepted.md', 'consumer.cjs', 'smoke.cjs', 'validate.cjs'].map(source),
    linksComplete: true,
    semanticDelta: false,
    files: [
      {
        path: 'owner.cjs',
        before: files.version(f.workspace, 'owner.cjs'),
        after: { source: source('approved/owner.cjs'), mode: 0o644 },
      },
    ],
    checks: ['smoke', 'validate'],
    criterion: 'Apply exactly the accepted label implementation and retain its declared links',
  };
  if (operation === 'create')
    material.files = [
      {
        path: 'created.cjs',
        before: null,
        after: { source: source('approved/owner.cjs'), mode: 0o600 },
      },
    ];
  if (operation === 'delete') {
    writeFileSync(join(f.workspace, 'obsolete.txt'), 'obsolete');
    material.files = [
      { path: 'obsolete.txt', before: files.version(f.workspace, 'obsolete.txt'), after: null },
    ];
  }
  if (operation === 'multiple') {
    writeFileSync(join(f.workspace, 'extra.txt'), 'old');
    writeFileSync(join(f.workspace, 'approved/extra.txt'), 'new');
    material.files.push({
      path: 'extra.txt',
      before: files.version(f.workspace, 'extra.txt'),
      after: { source: source('approved/extra.txt'), mode: 0o644 },
    });
  }
  const bytes = Buffer.from(JSON.stringify(material));
  writeFileSync(join(f.workspace, 'material.json'), bytes);
  const planningInput = {
    schemaVersion: 1 as const,
    preparation: f.input.admission.preparation,
    reviewId: 'material-approved',
    request: f.save({
      ...f.review,
      phase: 'planning',
      scope: material.materialId,
      sharedPaths: [
        ...new Set([
          'material.json',
          ...material.files.flatMap((f) => (f.after === null ? [] : [f.after.source.locator])),
          ...material.files.filter((f) => f.before !== null).map((f) => f.path),
          ...material.links.map((l) => l.locator),
        ]),
      ],
    }),
  };
  const planning = await runReview(f, planningInput);
  const input: Extract<LocalTaskInput, { schemaVersion: 2 }> = {
    schemaVersion: 2,
    admission: {
      schemaVersion: 2,
      preparation: f.input.admission.preparation,
      plan: { path: 'material.json', sha256: digest(bytes) },
      accepted: planning.manifest,
      acceptance: f.save({
        ...f.review,
        scope: 'M1',
        sharedPaths: [
          'material.json',
          ...material.files.flatMap((f) => (f.after === null ? [] : [f.after.source.locator])),
          ...material.links.map((l) => l.locator),
        ],
        roles: f.review.roles.map((r) => ({
          ...r,
          paths: [
            ...new Set([
              'owner.cjs',
              ...material.files.filter((f) => f.after !== null).map((f) => f.path),
            ]),
          ],
        })),
      }),
    },
    baseline: 'smoke',
  };
  return { ...f, mechanicalInput: input, material, planning, planningInput, files };
}
