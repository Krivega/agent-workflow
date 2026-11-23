import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export function snapshotProjects(path) {
  const bytes = readFileSync(path);
  const catalog = JSON.parse(bytes);
  assert(catalog.version === 1 && Array.isArray(catalog.projects));
  const binding = createHash('sha256').update(bytes).digest('hex');
  const projects = new Map();
  assert(Number.isSafeInteger(catalog.generatedAt) && catalog.generatedAt > 0);
  projects.observedAt = new Date(catalog.generatedAt).toISOString();
  for (const { id, tasks } of catalog.projects) {
    assert(typeof id === 'string' && identifier.test(id) && !projects.has(id));
    assert(tasks === null || Array.isArray(tasks));
    const rows = new Map();
    for (const row of tasks ?? []) {
      assert(typeof row.id === 'string' && identifier.test(row.id) && !rows.has(row.id));
      if (row.status !== null) {
        assert(['running', 'done', 'cancelled', 'failed'].includes(row.status));
        assert(
          typeof row.confirmedAt === 'string' &&
            new Date(row.confirmedAt).toISOString() === row.confirmedAt,
        );
      }
      rows.set(row.id, row);
    }
    projects.set(id, {
      snapshot: true,
      binding,
      tasks() {
        if (tasks === null) throw Error('project-unavailable');
        return [...rows.keys()];
      },
      read(workflowId) {
        const row = rows.get(workflowId.split('/')[3]);
        assert(row && row.status !== null);
        return { ...row, workflowId };
      },
    });
  }
  return projects;
}
