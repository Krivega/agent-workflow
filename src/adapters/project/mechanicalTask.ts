import { isDeepStrictEqual as same } from 'node:util';
import type { TaskSnapshot, TaskTree, WriterResult } from '../../contracts/localTask.js';
import type { taskFiles } from './taskFiles.js';
import type { taskGate } from './taskGate.js';
import { taskDelta } from '../../policy/localTask.js';
import { requireContract } from '../../contracts/project.js';

export function confirmMechanicalTree(body: TaskSnapshot, tree: TaskTree) {
  requireContract(body.schemaVersion === 2, 'mechanical-snapshot-required');
  const actual = taskDelta(body.tree, tree).sort((a, b) => a.path.localeCompare(b.path));
  requireContract(same(actual, body.mechanical.changes), 'mechanical-delta-changed');
}
export async function applyMechanicalTask(
  body: TaskSnapshot,
  files: ReturnType<typeof taskFiles>,
  gate: ReturnType<typeof taskGate>,
): Promise<WriterResult> {
  requireContract(body.schemaVersion === 2, 'mechanical-snapshot-required');
  gate.assert();
  files.sourceCurrent(body);
  requireContract(same(files.tree(body.copy.root), body.tree), 'task-premature-write');
  for (const change of body.mechanical.changes) {
    await new Promise<void>((done) => setImmediate(done));
    gate.exclusive(() => {
      files.bound(body.copy);
      files.sourceCurrent(body);
      requireContract(
        same(files.version(body.copy.root, change.path), change.before),
        'mechanical-copy-conflict',
      );
      files.replace(body.copy.root, change.path, change.after);
    });
  }
  gate.assert();
  const tree = files.candidate(body);
  confirmMechanicalTree(body, tree);
  const answer = files.save({
    kind: 'mechanical-application',
    input: body.input,
    mechanical: body.mechanical,
    modelStarts: 0,
  });
  const stop = files.save({
    kind: 'task-mechanical-stopped',
    input: body.input,
    confirmed: true,
    session: null,
    processes: [],
    before: tree,
    after: tree,
  });
  return { session: null, answer, stop, tree: files.save(tree) };
}
