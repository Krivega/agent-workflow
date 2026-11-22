import type { MechanicalAdmissionInput, MechanicalMaterial } from '../contracts/mechanicalTask.js';
import type { FileVersion } from '../contracts/taskFiles.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../contracts/project.js';
import { controlRef } from './readerControl.js';
import { parsePreparation } from './preparation.js';

function source(value: unknown) {
  const v = object(value);
  exactFields(v, ['locator', 'hash']);
  return {
    locator: relativePath(v.locator),
    hash: controlRef({ sha256: v.hash, bytes: 0 }).sha256,
  };
}
function mode(value: unknown): number {
  requireContract(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0o777,
    'mechanical-mode-invalid',
  );
  return Number(value);
}
export function parseMechanicalAdmission(value: unknown): MechanicalAdmissionInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'preparation', 'plan', 'accepted', 'acceptance']);
  requireContract(v.schemaVersion === 2, 'mechanical-admission-schema');
  const plan = object(v.plan);
  exactFields(plan, ['path', 'sha256']);
  return {
    schemaVersion: 2,
    preparation: parsePreparation(v.preparation),
    plan: {
      path: relativePath(plan.path),
      sha256: controlRef({ sha256: plan.sha256, bytes: 0 }).sha256,
    },
    accepted: controlRef(v.accepted),
    acceptance: controlRef(v.acceptance),
  };
}
export function parseMechanicalMaterial(value: unknown): MechanicalMaterial {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'materialId',
    'requirement',
    'links',
    'linksComplete',
    'semanticDelta',
    'files',
    'checks',
    'criterion',
  ]);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'mechanical-material',
    'mechanical-material-schema',
  );
  requireContract(
    v.semanticDelta === false && v.linksComplete === true,
    'mechanical-needs-planning',
  );
  requireContract(
    Array.isArray(v.links) &&
      Array.isArray(v.files) &&
      v.files.length > 0 &&
      Array.isArray(v.checks) &&
      v.checks.length > 0,
    'mechanical-material-incomplete',
  );
  const links = v.links.map(source),
    checks = v.checks.map(identifier),
    files = v.files.map((raw) => {
      const f = object(raw);
      exactFields(f, ['path', 'before', 'after']);
      let before: FileVersion | null = null,
        after: MechanicalMaterial['files'][number]['after'] = null;
      if (f.before !== null) {
        const b = object(f.before);
        exactFields(b, ['content', 'mode']);
        before = { content: controlRef(b.content), mode: mode(b.mode) };
      }
      if (f.after !== null) {
        const a = object(f.after);
        exactFields(a, ['source', 'mode']);
        after = { source: source(a.source), mode: mode(a.mode) };
      }
      requireContract(before !== null || after !== null, 'mechanical-empty-change');
      return { path: relativePath(f.path), before, after };
    });
  requireContract(
    new Set(files.map((f) => f.path)).size === files.length &&
      new Set(links.map((l) => l.locator)).size === links.length &&
      new Set(checks).size === checks.length,
    'mechanical-duplicate-input',
  );
  return {
    schemaVersion: 1,
    kind: 'mechanical-material',
    materialId: identifier(v.materialId),
    requirement: source(v.requirement),
    links,
    linksComplete: true,
    semanticDelta: false,
    files,
    checks,
    criterion: text(v.criterion),
  };
}
