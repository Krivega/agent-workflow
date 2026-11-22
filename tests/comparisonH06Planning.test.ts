import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { h06PlanningDirectory } from './comparisonH06Planning.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-planning-'));
  for (const name of ['work', 'reviews', 'other']) mkdirSync(join(root, name));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses stale requirements and missing, changed or mixed-directory snapshots before admission', () => {
  const snapshot = (directory: string, role: string) => {
    const locator = join(directory, `selection-${role}-fixture.json`);
    writeFileSync(locator, role);
    return { locator, hash: digest(role) };
  };
  const architect = snapshot(join(root, 'reviews'), 'architect');
  const reviewer = snapshot(join(root, 'other'), 'reviewer');
  const workspace = join(root, 'work');
  const run = (
    selection: Record<string, { trigger: boolean; requirements: (typeof architect)[] }>,
    pinned: (typeof architect)[],
    revision = 0,
  ) => {
    const bytes = JSON.stringify({
      requirements_revision: revision,
      council_selection: {},
      council: { selection },
    });
    writeFileSync(join(workspace, 'plan.json'), bytes);
    return h06PlanningDirectory(
      workspace,
      join(root, 'attempt'),
      { locator: 'plan.json', hash: digest(bytes) },
      pinned.map((ref) => ({ path: ref.locator, sha256: ref.hash })),
    );
  };
  const active = (ref: typeof architect) => ({ trigger: true, requirements: [ref] });
  const selection = { architect: active(architect) };
  expect(() => run(selection, [architect], 2)).toThrow('h06-package-initial-requirements-revision');
  expect(() => run({ architect: active(reviewer) }, [reviewer])).toThrow(
    'h06-package-planning-snapshot',
  );
  expect(() => run(selection, [{ ...architect, hash: '0'.repeat(64) }])).toThrow(
    'h06-package-planning-snapshot-unpinned',
  );
  expect(() => run({ ...selection, reviewer: active(reviewer) }, [architect, reviewer])).toThrow(
    'h06-package-planning-directory',
  );
  const tooBroad = snapshot(root, 'architect');
  expect(() => run({ architect: active(tooBroad) }, [tooBroad])).toThrow(
    'h06-package-planning-directory',
  );
  const shared = snapshot(join(root, 'reviews'), 'reviewer');
  expect(run({ ...selection, reviewer: active(shared) }, [architect, shared])).toBe(
    join(root, 'reviews'),
  );
  writeFileSync(architect.locator, 'changed');
  expect(() => run(selection, [architect])).toThrow('h04-pin-changed');
});
