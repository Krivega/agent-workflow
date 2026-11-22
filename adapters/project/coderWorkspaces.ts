import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localLocator, object, requireWorkflow } from '../../core/connection.js';
import { localPathAllowed } from '../../core/localPlanning.js';
import { sameValue } from '../../core/equality.js';
import { coderProtectedPath } from '../../core/coder.js';
import type {
  CoderBaseline,
  CoderBrief,
  CoderCopy,
  CoderIntegration,
  CoderRoot,
  CoderRun,
  CoderVersion,
} from '../../core/coder.js';
import type { CoderWorkspaces } from '../../ports/coder.js';
import { requiredProcedures } from '../../core/localRun.js';
import type { InputRef } from '../../core/localRun.js';
import { canonical, digest } from '../storage/storeCodec.js';
import { safeDirectory, syncDirectory, writePrivateFile } from '../storage/storeFiles.js';
import { writerScopeHash } from './writerScope.js';

const exec = promisify(execFile);
export type CoderFileProbe = (
  boundary: 'before-step' | 'after-step' | 'before-receipt',
  path: string,
) => void;
export class FileCoderWorkspaces implements CoderWorkspaces {
  private readonly artifacts: string;
  private readonly copies: string;
  constructor(
    private readonly source: string,
    evidence: string,
    private readonly authorize: (
      brief: CoderBrief,
      phase: CoderRun['status'] | null,
    ) => Promise<void>,
    private readonly probe: CoderFileProbe = () => {},
  ) {
    this.artifacts = resolve(evidence, 'coder-artifacts');
    this.copies = resolve(evidence, 'coder-workspaces');
  }
  private async storage() {
    await mkdir(this.artifacts, { recursive: true, mode: 0o700 });
    safeDirectory(this.artifacts);
    syncDirectory(dirname(this.artifacts));
  }
  private async sync(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async bytes(path: string): Promise<Buffer> {
    requireWorkflow((await realpath(path)) === path, 'unsafe-coder-path');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      requireWorkflow(before.isFile() && before.nlink === 1, 'unsafe-coder-file');
      const bytes = await handle.readFile(),
        after = await handle.stat();
      const actual = await lstat(path);
      requireWorkflow(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          actual.dev === after.dev &&
          actual.ino === after.ino &&
          (await realpath(path)) === path,
        'coder-file-changed-during-read',
      );
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async immutable(bytes: Buffer): Promise<InputRef> {
    await this.storage();
    const hash = digest(bytes),
      locator = resolve(this.artifacts, hash);
    try {
      writePrivateFile(locator, bytes);
    } catch (error) {
      requireWorkflow(
        (error as { code?: string }).code === 'EEXIST' && (await this.bytes(locator)).equals(bytes),
        'coder-artifact-conflict',
      );
      await this.sync(locator);
      syncDirectory(this.artifacts);
    }
    return { locator, hash };
  }
  private proof(value: unknown) {
    return this.immutable(Buffer.from(canonical(value) + '\n'));
  }
  private async read(ref: InputRef) {
    const bytes = await this.bytes(ref.locator);
    requireWorkflow(digest(bytes) === ref.hash, 'coder-artifact-changed');
    return bytes;
  }
  private async root(path: string): Promise<CoderRoot> {
    requireWorkflow((await realpath(path)) === path, 'coder-root-alias');
    safeDirectory(path);
    const stat = await lstat(path);
    return { root: path, dev: stat.dev, ino: stat.ino };
  }
  private async bound(binding: CoderRoot) {
    requireWorkflow(
      sameValue(await this.root(binding.root), binding),
      'coder-root-binding-changed',
    );
  }
  private async path(root: string, locator: string, create: boolean): Promise<string> {
    localLocator(locator);
    safeDirectory(root);
    let current = root;
    for (const part of locator.split('/').slice(0, -1)) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        requireWorkflow(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe-coder-path');
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
        if (!create) return resolve(root, locator);
        await mkdir(current, { mode: 0o700 });
        safeDirectory(current);
      }
      if (create) syncDirectory(dirname(current));
    }
    return resolve(root, locator);
  }
  private async version(
    root: string,
    locator: string,
    installed?: InputRef,
  ): Promise<CoderVersion | null> {
    const path = await this.path(root, locator, false);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    requireWorkflow(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      'unsafe-coder-file',
    );
    const bytes = await this.bytes(path);
    if (installed !== undefined)
      requireWorkflow(
        (stat.mode & 0o7777) === 0o644 && digest(bytes) === installed.hash,
        'coder-package-input-changed',
      );
    return { content: await this.immutable(bytes), mode: stat.mode & 0o777 };
  }
  private async files(root: string, directory = ''): Promise<string[]> {
    const result: string[] = [];
    for (const name of (await readdir(resolve(root, directory))).sort()) {
      const path = directory === '' ? name : `${directory}/${name}`;
      const stat = await lstat(resolve(root, path));
      requireWorkflow(!stat.isSymbolicLink(), 'unsafe-coder-path');
      if (stat.isDirectory()) result.push(...(await this.files(root, path)));
      else {
        requireWorkflow(stat.isFile() && stat.nlink === 1, 'unsafe-coder-file');
        result.push(path);
      }
    }
    return result.sort();
  }
  private async directories(root: string, directory = ''): Promise<CoderCopy['directories']> {
    const result: CoderCopy['directories'] = [];
    for (const name of (await readdir(resolve(root, directory))).sort()) {
      const path = directory === '' ? name : `${directory}/${name}`,
        stat = await lstat(resolve(root, path));
      requireWorkflow(!stat.isSymbolicLink(), 'unsafe-coder-path');
      if (stat.isDirectory())
        result.push({ path, mode: stat.mode & 0o777 }, ...(await this.directories(root, path)));
    }
    return result;
  }
  private async copyable(path: string) {
    localLocator(path);
    requireWorkflow(
      !path
        .split('/')
        .some(
          (part) =>
            ['.git', '.codex', '.aws', '.ssh', '.gnupg', 'node_modules'].includes(part) ||
            /^\.env(?:\.|$)/iu.test(part) ||
            /\.(?:pem|key|p12|pfx)$/iu.test(part),
        ),
      'private-coder-input',
    );
    try {
      await exec('git', ['check-ignore', '--no-index', '--quiet', '--', path], {
        cwd: this.source,
      });
    } catch (error) {
      requireWorkflow((error as { code?: number }).code === 1, 'coder-ignore-unknown');
      return;
    }
    throw new Error('ignored-coder-input');
  }
  async capture(brief: CoderBrief): Promise<CoderBaseline> {
    await this.authorize(brief, null);
    requireWorkflow(brief.source_root === this.source, 'coder-source-root-mismatch');
    requireWorkflow(
      brief.copy_root === resolve(this.copies, brief.id),
      'coder-copy-outside-owned-root',
    );
    const source = await this.root(this.source),
      paths = new Set(
        [...brief.files, ...brief.rules, ...brief.procedures].map((ref) => ref.locator),
      );
    for (const scope of brief.paths) {
      const path = await this.path(this.source, scope, false);
      try {
        const stat = await lstat(path);
        if (stat.isDirectory())
          for (const file of await this.files(this.source, scope)) paths.add(file);
        else paths.add(scope);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    }
    const runtime = 'node_modules/@krivega/agent-workflow';
    const installedInputs = new Map(
      [
        ...brief.rules.filter((rule) => rule.locator === runtime + '/roles/coder.md'),
        ...brief.procedures.filter(
          (p) =>
            requiredProcedures('role', 'coder').includes(p.id) &&
            p.locator === runtime + '/procedures/' + p.id + '.md',
        ),
      ].map((ref) => [ref.locator, ref]),
    );
    const files: CoderBaseline['files'] = [];
    for (const path of [...paths].sort()) {
      const installed = installedInputs.get(path);
      if (installed === undefined) await this.copyable(path);
      const version = await this.version(this.source, path, installed);
      requireWorkflow(version !== null, 'coder-input-missing');
      files.push({ path, version });
    }
    for (const ref of [...brief.files, ...brief.rules, ...brief.procedures])
      requireWorkflow(
        files.some((file) => file.path === ref.locator && file.version.content.hash === ref.hash),
        'coder-source-version-mismatch',
      );
    await this.bound(source);
    return {
      source,
      files,
      evidence: await this.proof({ kind: 'coder-baseline', brief, source, files }),
    };
  }
  async copy(run: CoderRun): Promise<CoderCopy> {
    requireWorkflow(
      run.brief.copy_root === resolve(this.copies, run.brief.id),
      'coder-copy-outside-owned-root',
    );
    await this.authorize(run.brief, 'copying');
    await this.bound(run.baseline.source);
    await this.storage();
    const directory = run.brief.copy_root,
      bindingPath = resolve(this.artifacts, `copy-${run.brief.id}.json`);
    let binding: CoderRoot;
    try {
      binding = object(
        JSON.parse((await this.bytes(bindingPath)).toString('utf8')),
      ) as unknown as CoderRoot;
      await this.bound(binding);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      safeDirectory(dirname(directory));
      syncDirectory(dirname(this.copies));
      await mkdir(directory, { mode: 0o700 });
      syncDirectory(dirname(directory));
      binding = await this.root(directory);
      writePrivateFile(bindingPath, canonical(binding));
    }
    requireWorkflow(binding.root === directory, 'coder-copy-binding-mismatch');
    for (const file of run.baseline.files) {
      await this.authorize(run.brief, 'copying');
      await this.bound(binding);
      const current = await this.version(directory, file.path);
      if (current !== null) {
        requireWorkflow(sameValue(current, file.version), 'coder-copy-conflict');
        continue;
      }
      const target = await this.path(directory, file.path, true),
        bytes = await this.read(file.version.content);
      requireWorkflow(digest(bytes) === file.version.content.hash, 'coder-artifact-changed');
      const temporary = resolve(dirname(target), `.coder-${randomUUID()}`);
      try {
        await copyFile(
          file.version.content.locator,
          temporary,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
        requireWorkflow((await this.bytes(temporary)).equals(bytes), 'coder-copy-changed');
        await chmod(temporary, file.version.mode);
        await this.sync(temporary);
        requireWorkflow((await this.version(directory, file.path)) === null, 'coder-copy-conflict');
        await rename(temporary, target);
        syncDirectory(dirname(target));
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        });
      }
    }
    const directories = await this.directories(directory);
    const copy = {
      binding,
      directories,
      evidence: await this.proof({
        kind: 'coder-copy',
        baseline: run.baseline.evidence,
        binding,
        directories,
      }),
    };
    await this.verifyCopy({ ...run, copy });
    return copy;
  }
  async verifyCopy(run: CoderRun): Promise<void> {
    requireWorkflow(run.copy !== null, 'coder-copy-missing');
    await this.bound(run.copy.binding);
    const files = await this.files(run.brief.copy_root);
    requireWorkflow(
      sameValue(await this.directories(run.brief.copy_root), run.copy.directories),
      'coder-premature-write',
    );
    requireWorkflow(
      sameValue(files, run.baseline.files.map((file) => file.path).sort()),
      'coder-premature-write',
    );
    for (const file of run.baseline.files)
      requireWorkflow(
        sameValue(await this.version(run.brief.copy_root, file.path), file.version),
        'coder-premature-write',
      );
  }
  private async stopped(run: CoderRun): Promise<void> {
    requireWorkflow(
      run.stopped !== null && run.copy !== null && run.session !== null,
      'coder-stop-unconfirmed',
    );
    await this.bound(run.baseline.source);
    await this.bound(run.copy.binding);
    const proof = object(JSON.parse((await this.read(run.stopped)).toString('utf8'))),
      owned = object(proof.owned);
    requireWorkflow(
      proof.kind === 'writers-stopped' &&
        proof.thread === run.session.id &&
        proof.active_turn === false &&
        proof.remaining_terminals === 0 &&
        proof.remaining_processes === 0 &&
        proof.before_hash === proof.after_hash &&
        owned.tree === run.brief.copy_root &&
        Array.isArray(owned.markers) &&
        owned.markers.every((path) => typeof path === 'string') &&
        (await writerScopeHash(owned.markers as string[], run.brief.copy_root)) ===
          proof.after_hash,
      'coder-copy-after-stop',
    );
  }
  async integration(run: CoderRun): Promise<CoderIntegration> {
    await this.authorize(run.brief, 'released');
    await this.stopped(run);
    requireWorkflow(run.result?.outcome === 'PASS', 'coder-result-not-passed');
    const files = new Set([
      ...(await this.files(run.brief.copy_root)),
      ...run.baseline.files.map((file) => file.path),
    ]);
    const changes: CoderIntegration['changes'] = [];
    await this.sourceInputs(run);
    for (const path of [...files].sort()) {
      const before = run.baseline.files.find((file) => file.path === path)?.version ?? null;
      const after = await this.version(run.brief.copy_root, path);
      if (sameValue(before, after)) continue;
      requireWorkflow(!coderProtectedPath(run.brief, path), 'coder-protected-change');
      await this.copyable(path);
      requireWorkflow(localPathAllowed(run.brief.paths, path), 'coder-change-outside-scope');
      requireWorkflow(
        sameValue(await this.version(this.source, path), before),
        'coder-source-conflict',
      );
      changes.push({ path, before, after });
    }
    const directories = await this.directories(run.brief.copy_root);
    for (const before of run.copy!.directories) {
      const after = directories.find((dir) => dir.path === before.path);
      requireWorkflow(
        after === undefined
          ? localPathAllowed(run.brief.paths, before.path)
          : before.mode === after.mode,
        'coder-directory-change-unsupported',
      );
    }
    for (const after of directories)
      requireWorkflow(
        run.copy!.directories.some((dir) => dir.path === after.path) ||
          changes.some(
            (change) => change.after !== null && change.path.startsWith(after.path + '/'),
          ),
        'coder-directory-outside-scope',
      );
    const body = {
      operation: `coder:${run.brief.id}:integrate`,
      project_id: run.brief.project_id,
      task_id: run.brief.task_id,
      parent_run_id: run.brief.parent_run_id,
      generation: run.brief.generation,
      source: run.baseline.source,
      copy: run.copy!.binding,
      result: run.result.evidence,
      stopped: run.stopped!,
      changes,
    };
    return { ...body, evidence: await this.proof({ kind: 'coder-integration-intent', ...body }) };
  }
  async integrate(run: CoderRun): Promise<InputRef> {
    requireWorkflow(run.integration !== null, 'coder-integration-intent-missing');
    const intent = run.integration;
    const { evidence, ...body } = intent;
    requireWorkflow(
      sameValue(JSON.parse((await this.read(evidence)).toString('utf8')), {
        kind: 'coder-integration-intent',
        ...body,
      }),
      'coder-integration-intent-changed',
    );
    const precondition = async (temporary?: string) => {
      await this.authorize(run.brief, 'integrating');
      await this.stopped(run);
      await this.sourceInputs(run, intent, temporary);
    };
    await precondition();
    for (const change of intent.changes) {
      const current = await this.version(this.source, change.path);
      requireWorkflow(
        sameValue(current, change.before) || sameValue(current, change.after),
        'coder-integration-conflict',
      );
      if (change.after !== null) await this.read(change.after.content);
    }
    for (const change of intent.changes) {
      await precondition();
      this.probe('before-step', change.path);
      const current = await this.version(this.source, change.path);
      const target = await this.path(this.source, change.path, change.after !== null);
      if (sameValue(current, change.after)) {
        if (change.after !== null) await this.sync(target);
        syncDirectory(dirname(target));
        continue;
      }
      requireWorkflow(sameValue(current, change.before), 'coder-integration-conflict');
      if (change.after === null) await unlink(target);
      else {
        const temporary = resolve(dirname(target), `.coder-${randomUUID()}`);
        try {
          await writeFile(temporary, await this.read(change.after.content), {
            flag: 'wx',
            mode: change.after.mode,
          });
          await chmod(temporary, change.after.mode);
          await this.sync(temporary);
          await precondition(relative(this.source, temporary));
          requireWorkflow(
            sameValue(
              await this.version(this.source, relative(this.source, temporary)),
              change.after,
            ),
            'coder-integration-temporary-changed',
          );
          requireWorkflow(
            sameValue(await this.version(this.source, change.path), change.before),
            'coder-integration-conflict',
          );
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
          });
        }
      }
      syncDirectory(dirname(target));
      this.probe('after-step', change.path);
    }
    await precondition();
    for (const change of intent.changes)
      requireWorkflow(
        sameValue(await this.version(this.source, change.path), change.after),
        'coder-integration-conflict',
      );
    this.probe('before-receipt', '');
    return this.proof({
      kind: 'coder-integrated',
      intent: intent.evidence,
      operation: intent.operation,
      changes: intent.changes,
    });
  }
  private async sourceInputs(
    run: CoderRun,
    intent?: CoderIntegration,
    temporary?: string,
  ): Promise<void> {
    for (const file of run.baseline.files) {
      const change = intent?.changes.find((entry) => entry.path === file.path);
      const current = await this.version(this.source, file.path);
      requireWorkflow(
        sameValue(current, file.version) ||
          (change !== undefined && sameValue(current, change.after)),
        'coder-source-conflict',
      );
    }
    const expected = new Set([
      ...run.baseline.files.map((file) => file.path),
      ...(intent?.changes.map((change) => change.path) ?? []),
      ...(temporary === undefined ? [] : [temporary]),
    ]);
    for (const scope of run.brief.paths) {
      const path = await this.path(this.source, scope, false);
      try {
        const stat = await lstat(path);
        const files = stat.isDirectory() ? await this.files(this.source, scope) : [scope];
        requireWorkflow(
          files.every((file) => expected.has(file)),
          'coder-source-discovery-changed',
        );
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    }
  }
}
