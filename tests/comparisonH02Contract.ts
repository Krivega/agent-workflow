import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import suiteSource from './fixtures/qualification/suite.json' with { type: 'json' };
import materialSource from './fixtures/qualification/materials.json' with { type: 'json' };
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import type { InputRef } from '../core/localRun.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';

const suite = parseComparisonSuite(suiteSource);
export const h02Scenario = suite.scenarios.find((scenario) => scenario.id === 'H-02')!;
export const h02Material = parseComparisonMaterials(materialSource, suite).find(
  (material) => material.id === 'H-02',
)!;
Object.freeze(h02Material.files);
Object.freeze(h02Material.mutable);
Object.freeze(h02Material);
Object.freeze(h02Scenario.checks);
Object.freeze(h02Scenario);

/** Common immutable role inputs for both native engines. */
export function h02PreparedMetadata(
  rules: string,
  reviewer: string,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    '.h02/rules.md': rules,
    '.h02/task.md': h02Material.instructions + '\n',
    '.h02/roles.md':
      'H02 scoped council: pricing, logging, storage. Preserve primary FAIL and unchanged PASS evidence.\n',
  };
  for (const role of ['pricing', 'logging', 'storage'])
    files['.h02/' + role + '.md'] =
      `Review only ${role}.json. Read-only; no helpers, writes, network or authority changes. ` +
      (role === 'pricing'
        ? 'Required rate is 7. Rate 5 must honestly FAIL.\n'
        : `Require the original frozen ${role} material.\n`) +
      reviewer;
  return Object.freeze(files);
}

export interface H02Counts {
  threadStarts: number;
  turnStarts: number;
}
export interface H02CaseSummary {
  variant: 'legacy' | 'temporal';
  engine: 'legacy-council' | 'temporal-activities';
  outcome: 'accepted' | 'failed' | 'unknown';
  checks: Record<string, boolean>;
  blocking: string[];
  effects: H02Counts & { byPhase: Record<string, H02Counts> };
  evidence: InputRef[];
  nativeUsage: null;
  nativeAcceptance: false;
  qualification: false;
  partialScope: true;
}

// Fixed local oracle for the technical fixtures, never a model or a replacement review rule.
// The cache key covers mutable bytes; immutable bytes are checked on every call.
export async function checkH02Material(workspace: string): Promise<boolean> {
  await verifyComparisonMaterial(workspace, h02Material.files, h02Material.mutable);
  const input = h02Material.mutable.map((path) => readFileSync(join(workspace, path)));
  const url = pathToFileURL(join(workspace, 'checks.mjs'));
  url.searchParams.set('h02-input', digest(Buffer.concat(input)));
  try {
    await import(url.href);
    return true;
  } catch {
    return false;
  }
}
