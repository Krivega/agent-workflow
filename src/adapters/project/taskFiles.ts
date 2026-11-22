import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  fsyncSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type {
  TaskBinding,
  TaskTree,
  TaskSnapshot,
  TaskIntegration,
  FileVersion,
  LocalTaskInput,
} from '../../contracts/localTask.js';
import { localTaskKey } from '../../policy/localTask.js';
import { relativePath, requireContract } from '../../contracts/project.js';
import { taskPathAllowed, taskPrivatePath, taskDelta } from '../../policy/localTask.js';
import {
  artifactStore,
  privateDirectory,
  publishFile,
  readPrivateFile,
  syncDirectory,
  digest,
} from '../artifacts/files.js';

export function taskCardProjection(
  input: LocalTaskInput,
  result: ArtifactRef,
  criterion: string,
  before: FileVersion,
  original: Buffer,
) {
  const card = Buffer.from(
    original.toString('utf8') +
      `\n<!-- agent-workflow:${localTaskKey(input)} -->\nРезультат: DONE\nКритерий: ${criterion}\nДоказательство: ${result.sha256}\n<!-- /agent-workflow -->\n`,
  );
  const after = { content: { sha256: digest(card), bytes: card.length }, mode: before.mode };
  return { card, projection: { kind: 'task-card-projection', input, before, after, result } };
}

export function taskFiles(artifactRoot: string, options: { existingOnly?: boolean } = {}) {
  const store = artifactStore(artifactRoot, options);
  function binding(root: string): TaskBinding {
    requireContract(realpathSync(root) === root, 'task-workspace-alias');
    const stat = lstatSync(root);
    requireContract(stat.isDirectory(), 'task-workspace-invalid');
    return { root, dev: String(stat.dev), ino: String(stat.ino) };
  }
  function bound(value: TaskBinding) {
    requireContract(same(binding(value.root), value), 'task-workspace-changed');
  }
  function path(root: string, name: string, create = false): string {
    relativePath(name);
    binding(root);
    let current = root;
    for (const part of name.split('/').slice(0, -1)) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        requireContract(stat.isDirectory() && !stat.isSymbolicLink(), 'task-path-unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return resolve(root, name);
        mkdirSync(current, { mode: 0o700 });
        syncDirectory(dirname(current));
      }
    }
    return join(root, name);
  }
  function readVersion(root: string, name: string, retain: boolean): FileVersion | null {
    const file = path(root, name);
    let before;
    try {
      before = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    requireContract(
      before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
      'task-file-unsafe',
    );
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = readFileSync(fd),
        after = fstatSync(fd),
        now = lstatSync(file);
      requireContract(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          now.ino === after.ino &&
          now.dev === after.dev,
        'task-file-changed',
      );
      return {
        content: retain ? store.publish(bytes) : { sha256: digest(bytes), bytes: bytes.length },
        mode: before.mode & 0o777,
      };
    } finally {
      closeSync(fd);
    }
  }
  function version(root: string, name: string) {
    return readVersion(root, name, true);
  }
  function observeVersion(root: string, name: string) {
    return readVersion(root, name, false);
  }
  function readTree(root: string, retain: boolean): TaskTree {
    const result: TaskTree = { files: [], directories: [] };
    binding(root);
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(root, directory)).sort()) {
        const name = directory ? directory + '/' + entry : entry,
          stat = lstatSync(join(root, name));
        requireContract(!stat.isSymbolicLink(), 'task-path-unsafe');
        if (stat.isDirectory()) {
          result.directories.push({ path: name, mode: stat.mode & 0o777 });
          walk(name);
        } else {
          const file = readVersion(root, name, retain);
          requireContract(file !== null, 'task-file-missing');
          result.files.push({ path: name, version: file });
        }
      }
    };
    walk('');
    result.files.sort((a, b) => a.path.localeCompare(b.path));
    result.directories.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }
  function tree(root: string) {
    return readTree(root, true);
  }
  function observeTree(root: string) {
    return readTree(root, false);
  }
  function captureVersions(root: string, paths: string[], retain: boolean): TaskTree {
    const result: TaskTree = { files: [], directories: [] },
      found = new Set<string>();
    const add = (name: string) => {
      relativePath(name);
      requireContract(!taskPrivatePath(name), 'task-private-input');
      const stat = lstatSync(path(root, name));
      requireContract(!stat.isSymbolicLink(), 'task-path-unsafe');
      if (stat.isDirectory()) {
        if (result.directories.some((directory) => directory.path === name)) return;
        result.directories.push({ path: name, mode: stat.mode & 0o777 });
        for (const child of readdirSync(join(root, name)).sort()) add(name + '/' + child);
      } else found.add(name);
    };
    for (const name of paths) {
      try {
        add(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (found.size > 0) {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '--quiet', '-z', '--stdin'], {
          cwd: root,
          stdio: 'pipe',
          input: [...found].join('\0') + '\0',
        });
        throw new Error('task-ignored-input');
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
      }
    }
    for (const name of [...found].sort()) {
      const file = readVersion(root, name, retain);
      requireContract(file !== null, 'task-file-missing');
      result.files.push({ path: name, version: file });
    }
    const parents = new Set(result.directories.map((d) => d.path));
    for (const file of result.files) {
      let parent = dirname(file.path);
      while (parent !== '.') {
        if (!parents.has(parent)) {
          parents.add(parent);
          result.directories.push({
            path: parent,
            mode: lstatSync(path(root, parent)).mode & 0o777,
          });
        }
        parent = dirname(parent);
      }
    }
    result.files.sort((a, b) => a.path.localeCompare(b.path));
    result.directories.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }
  function capture(root: string, paths: string[]): TaskTree {
    return captureVersions(root, paths, true);
  }
  function observeCapture(root: string, paths: string[]): TaskTree {
    return captureVersions(root, paths, false);
  }
  function replace(root: string, name: string, after: FileVersion | null) {
    const target = path(root, name, after !== null);
    if (after === null) {
      unlinkSync(target);
      syncDirectory(dirname(target));
      return;
    }
    const temporary = join(dirname(target), '.task-' + randomUUID());
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        writeFileSync(fd, store.read(after.content));
        chmodSync(temporary, after.mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
      syncDirectory(dirname(target));
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the failed replacement. */
      }
      throw error;
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  function copy(
    source: TaskBinding,
    original: TaskTree,
    directory: string,
  ): { binding: TaskBinding; tree: TaskTree } {
    bound(source);
    privateDirectory(directory);
    const pin = directory + '.binding.json';
    let target: TaskBinding;
    try {
      target = JSON.parse(readPrivateFile(pin).toString()) as TaskBinding;
      bound(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      target = binding(directory);
      publishFile(pin, Buffer.from(JSON.stringify(target)));
    }
    requireContract(target.root === directory, 'task-copy-binding');
    for (const directoryEntry of original.directories) {
      path(directory, directoryEntry.path + '/.entry', true);
      chmodSync(join(directory, directoryEntry.path), directoryEntry.mode);
    }
    for (const file of original.files) {
      bound(source);
      bound(target);
      requireContract(same(version(source.root, file.path), file.version), 'task-source-changed');
      const existing = version(directory, file.path);
      requireContract(existing === null || same(existing, file.version), 'task-copy-conflict');
      if (existing === null) replace(directory, file.path, file.version);
    }
    const copied = tree(directory);
    requireContract(same(copied.files, original.files), 'task-copy-conflict');
    return { binding: target, tree: copied };
  }
  function sourceCurrent(snapshot: TaskSnapshot, intent: TaskIntegration | null = null) {
    bound(snapshot.source);
    bound(snapshot.copy);
    for (const directory of snapshot.tree.directories)
      requireContract(
        (lstatSync(path(snapshot.source.root, directory.path)).mode & 0o777) === directory.mode,
        'task-source-directory-changed',
      );
    for (const file of snapshot.tree.files) {
      const current = version(snapshot.source.root, file.path),
        change = intent?.changes.find((c) => c.path === file.path);
      requireContract(
        same(current, file.version) || (change !== undefined && same(current, change.after)),
        'task-source-conflict',
      );
    }
    const actual = capture(snapshot.source.root, snapshot.plan.paths),
      expected = new Set([
        ...snapshot.tree.files.map((f) => f.path),
        ...(intent?.changes.map((c) => c.path) ?? []),
      ]);
    requireContract(
      actual.files.every((f) => expected.has(f.path)) &&
        actual.directories.every((d) =>
          snapshot.tree.directories.some((before) => same(before, d)),
        ),
      'task-discovery-changed',
    );
  }
  function candidate(snapshot: TaskSnapshot): TaskTree {
    bound(snapshot.copy);
    const current = tree(snapshot.copy.root);
    const paths = [
      ...new Set([...snapshot.tree.files.map((f) => f.path), ...current.files.map((f) => f.path)]),
    ];
    const fixed = [
      snapshot.input.admission.plan.path,
      ...(snapshot.input.schemaVersion !== 2 ? [snapshot.input.executor.path] : []),
      snapshot.plan.requirement.locator,
      ...snapshot.plan.basis.map((f) => f.locator),
      snapshot.input.admission.preparation.card,
      ...snapshot.input.admission.preparation.project.rules,
      ...snapshot.input.admission.preparation.project.roles.map((r) => r.profile),
    ];
    for (const name of paths) {
      const before = snapshot.tree.files.find((f) => f.path === name)?.version ?? null,
        after = current.files.find((f) => f.path === name)?.version ?? null;
      if (!same(before, after))
        requireContract(
          taskPathAllowed(snapshot.plan.paths, name) &&
            !fixed.includes(name) &&
            !taskPrivatePath(name),
          'task-change-outside-scope',
        );
    }
    requireContract(same(current.directories, snapshot.tree.directories), 'task-directory-change');
    return current;
  }
  async function integration(
    snapshot: TaskSnapshot,
    intent: TaskIntegration,
    exclusive: (run: () => void) => void,
    probe: (name: string) => void = () => {},
  ) {
    requireContract(
      same(intent.source, snapshot.source) && same(intent.copy, snapshot.copy),
      'task-integration-binding',
    );
    const final = JSON.parse(store.read(intent.candidate).toString()) as TaskTree;
    requireContract(same(candidate(snapshot), final), 'task-candidate-changed');
    requireContract(
      same(intent.changes, taskDelta(snapshot.tree, final)),
      'task-integration-plan-changed',
    );
    sourceCurrent(snapshot, intent);
    for (const change of intent.changes)
      requireContract(
        same(version(snapshot.source.root, change.path), change.before) ||
          same(version(snapshot.source.root, change.path), change.after),
        'task-integration-conflict',
      );
    for (const change of intent.changes) {
      await new Promise<void>((done) => setImmediate(done));
      exclusive(() => {
        sourceCurrent(snapshot, intent);
        bound(snapshot.copy);
        requireContract(same(tree(snapshot.copy.root), final), 'task-candidate-changed');
        probe(change.path);
        const current = version(snapshot.source.root, change.path);
        if (same(current, change.after)) return;
        requireContract(same(current, change.before), 'task-integration-conflict');
        replace(snapshot.source.root, change.path, change.after);
      });
    }
    exclusive(() => {
      sourceCurrent(snapshot, intent);
      for (const change of intent.changes)
        requireContract(
          same(version(snapshot.source.root, change.path), change.after),
          'task-integration-conflict',
        );
    });
  }
  function save(value: unknown): ArtifactRef {
    return store.publish(Buffer.from(JSON.stringify(value)));
  }
  return {
    store,
    binding,
    bound,
    version,
    observeVersion,
    tree,
    observeTree,
    capture,
    observeCapture,
    copy,
    sourceCurrent,
    candidate,
    integration,
    replace,
    save,
  };
}
