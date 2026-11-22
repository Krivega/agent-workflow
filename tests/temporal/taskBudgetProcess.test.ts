import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import { object } from '../../src/contracts/project.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { controlRef } from '../../src/policy/readerControl.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-budget-process-')));
  roots.push(root);
  return root;
}
function child(
  mode: 'reserve-kill' | 'recover' | 'capture',
  root: string,
  previous: ArtifactRef | null = null,
) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/taskBudgetProcess.mjs', import.meta.url)),
      mode,
      root,
      JSON.stringify(previous),
    ],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGTERM', maxBuffer: 128 * 1024 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(mode === 'reserve-kill' ? null : 0);
  expect(result.signal, result.stderr).toBe(mode === 'reserve-kill' ? 'SIGKILL' : null);
  const output = object(JSON.parse(result.stdout));
  expect(output.mode).toBe(mode);
  expect(output.pid).toBeGreaterThan(1);
  console.info(
    'TASK_BUDGET_PROCESS ' +
      JSON.stringify({ status: result.status, signal: result.signal, timeoutMs: 5000, output }),
  );
  return output;
}

describe(
  'physical budget reservation after the reserving Node process dies',
  { timeout: 15000 },
  () => {
    it('retains the unknown reservation and original checkpoint identity across a real SIGKILL and fresh adapter process', () => {
      const root = directory(),
        dead = child('reserve-kill', root),
        before = object(dead.budget),
        checkpoint = controlRef(before.manifest),
        saved = readFileSync(join(root, 'artifacts', checkpoint.sha256));
      expect(before).toMatchObject({ limit: 2, used: 1 });
      expect({ sha256: digest(saved), bytes: saved.length }).toEqual(checkpoint);
      expect(JSON.parse(saved.toString())).toEqual(dead.record);
      expect(readdirSync(join(root, 'credits')).sort()).toEqual(['0.credit', 'limit']);
      const resumed = child('recover', root, checkpoint),
        record = object(resumed.record),
        original = object(dead.record),
        first = readFileSync(join(root, 'credits/0.credit'));
      expect(resumed.pid).not.toBe(dead.pid);
      expect(resumed.before).toEqual(before);
      expect(resumed.duplicate).toEqual(before);
      expect(resumed.after).toMatchObject({ limit: 2, used: 2 });
      expect(resumed.exhausted).toEqual(resumed.after);
      expect(resumed.changedLimit).toBe('reader-model-budget-conflict');
      expect(resumed.exhaustion).toBe('reader-model-budget-exhausted');
      expect(record).toMatchObject({
        kind: 'task-model-budget',
        directory: original.directory,
        binding: original.binding,
        limit: 2,
        limitRef: original.limitRef,
        credits: [
          {
            index: 0,
            key: digest('first-operation'),
            hash: digest('unknown-first-request'),
            ref: dead.firstCredit,
          },
          { index: 1, key: digest('second-operation'), hash: digest('second-request') },
        ],
      });
      expect({ sha256: digest(first), bytes: first.length }).toEqual(dead.firstCredit);
      expect(readFileSync(join(root, 'artifacts', checkpoint.sha256))).toEqual(saved);
      expect(readdirSync(join(root, 'credits')).sort()).toEqual(['0.credit', '1.credit', 'limit']);
    });
    it.each(['limit', 'rewind', 'binding'])(
      'rejects a physical %s change in a fresh process instead of publishing a reset checkpoint',
      (defect) => {
        const root = directory(),
          dead = child('reserve-kill', root),
          checkpoint = controlRef(object(dead.budget).manifest),
          credits = join(root, 'credits'),
          artifacts = readdirSync(join(root, 'artifacts')).sort();
        if (defect === 'limit')
          writeFileSync(join(credits, 'limit'), JSON.stringify({ schemaVersion: 1, limit: 3 }));
        if (defect === 'rewind') unlinkSync(join(credits, '0.credit'));
        if (defect === 'binding') {
          renameSync(credits, credits + '-retained');
          mkdirSync(credits);
          for (const name of ['limit', '0.credit'])
            renameSync(join(credits + '-retained', name), join(credits, name));
        }
        expect(child('capture', root, checkpoint).error).toBe('task-budget-rewound');
        expect(readdirSync(join(root, 'artifacts')).sort()).toEqual(artifacts);
      },
    );
  },
);
