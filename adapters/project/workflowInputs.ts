import { lstat, readdir, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { compareInputs, logicalInputs, type InputManifest } from '../../core/evidence.js';
import { localLocator, object, requireWorkflow, textField } from '../../core/connection.js';
import type { WorkflowInputs } from '../../ports/workflowJournal.js';
import type { InputRef, LocalRun } from '../../core/localRun.js';
import { contentHash, projectPath } from './projectFiles.js';
import { privateFileSource } from '../storage/storeFiles.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stableJson } from '../../core/equality.js';
import { artifactDependencies } from '../storage/artifactDependencies.js';

const git = promisify(execFile);

export interface Discovery {
  files: string[];
  directories: string[];
  repository?: true;
}
export class FileWorkflowInputs implements WorkflowInputs {
  constructor(
    private readonly root: string,
    private readonly evidenceRoot: string | null = null,
  ) {}
  private path(locator: string) {
    if (isAbsolute(locator)) {
      requireWorkflow(this.evidenceRoot !== null, 'external-evidence-not-authorized');
      return projectPath(this.evidenceRoot, relative(this.evidenceRoot, locator));
    }
    return projectPath(this.root, locator);
  }
  async dependencies(refs: InputRef[]): Promise<InputRef[]> {
    return this.dependencyGraph(refs);
  }
  async restore(before: InputManifest, after: InputManifest): Promise<InputManifest> {
    return logicalInputs(before, after, await this.dependencies(after.inputs));
  }
  private async dependencyGraph(refs: InputRef[], original = new Map<string, string>()) {
    const dependencies = new Map<string, InputRef>();
    for (const ref of refs) {
      const path = original.has(ref.locator)
        ? resolve(this.root, ref.locator)
        : await this.path(ref.locator);
      const graph = artifactDependencies(
        { locator: path, hash: ref.hash },
        (path) => {
          const root = path.startsWith(resolve(this.root) + sep) ? this.root : this.evidenceRoot;
          requireWorkflow(root !== null, 'external-evidence-not-authorized');
          localLocator(relative(root, path));
          requireWorkflow(realpathSync(path) === path, 'unsafe-project-path');
        },
        original.get(ref.locator),
      );
      for (const dependency of graph) {
        const name = relative(this.root, dependency.locator);
        const locator = name.startsWith('..' + sep) ? dependency.locator : name;
        dependencies.set(locator, { locator, hash: dependency.hash });
      }
    }
    return [...dependencies.values()];
  }
  async ref(locator: string): Promise<InputRef> {
    return { locator, hash: privateFileSource(await this.path(locator)).hash };
  }
  async verify(refs: InputRef[], projection?: LocalRun['projection']) {
    const unique = new Map(refs.map((ref) => [JSON.stringify([ref.locator, ref.hash]), ref]));
    if (projection != null && unique.size > 0) {
      const manifest: InputManifest = {
        complete: true,
        attested_by: 'Projection references',
        discovery_rule: JSON.stringify({ version: 2, kind: 'explicit' }),
        inputs: [...unique.values()],
      };
      requireWorkflow(
        compareInputs(manifest, await this.current(manifest, projection)) === 'applicable',
        'workflow-input-changed',
      );
      return;
    }
    for (const ref of unique.values())
      requireWorkflow((await this.ref(ref.locator)).hash === ref.hash, 'workflow-input-changed');
  }
  private async directory(locator: string): Promise<string[]> {
    localLocator(locator);
    const root = await realpath(this.root);
    const directory = resolve(root, locator);
    requireWorkflow(
      (await realpath(directory)) === directory && directory.startsWith(root + sep),
      'unsafe-discovery-path',
    );
    requireWorkflow((await lstat(directory)).isDirectory(), 'not-discovery-directory');
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = `${locator}/${entry.name}`;
      if (entry.isDirectory()) result.push(...(await this.directory(child)));
      else result.push(child);
    }
    return result;
  }
  async capture(discovery: Discovery, attestedBy: string): Promise<InputManifest> {
    return this.snapshot(discovery, attestedBy);
  }
  private async snapshot(
    discovery: Discovery,
    attestedBy: string,
    projected = new Map<string, InputRef | null>(),
  ): Promise<InputManifest> {
    textField(attestedBy);
    const files = new Set(discovery.files);
    if (discovery.repository) {
      const options = { cwd: this.root, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
      const { stdout } = await git(
        'git',
        ['ls-files', '-t', '--cached', '--others', '--deleted', '--exclude-standard', '-z'],
        options,
      );
      const entries = stdout.split('\0').filter(Boolean);
      // Git reports a deleted tracked path both as cached and as removed.
      const missing = new Set(
        entries.filter((entry) => entry.startsWith('R ')).map((entry) => entry.slice(2)),
      );
      for (const entry of entries) {
        const name = entry.slice(2);
        if (!missing.has(name)) files.add(name);
      }
    }
    for (const directory of discovery.directories)
      for (const name of await this.directory(directory)) files.add(name);
    for (const name of projected.keys()) files.add(name);
    const inputs = (
      await Promise.all(
        [...files]
          .sort()
          .map(async (name) => (projected.has(name) ? projected.get(name)! : this.ref(name))),
      )
    ).filter((ref) => ref !== null);
    requireWorkflow(inputs.length > 0, 'empty-input-manifest');
    return {
      complete: true,
      attested_by: attestedBy,
      discovery_rule:
        discovery.directories.length === 0 && !discovery.repository
          ? JSON.stringify({ version: 2, kind: 'explicit' })
          : discovery.repository
            ? stableJson(discovery)
            : JSON.stringify(discovery),
      inputs,
    };
  }
  private async projectionInputs(
    manifest: InputManifest,
    projection: NonNullable<LocalRun['projection']>,
  ) {
    const projected = new Map<string, InputRef | null>();
    for (const change of projection.plan.changes) {
      localLocator(change.locator);
      const before = change.before === null ? null : contentHash(change.before);
      const after = change.after === null ? null : contentHash(change.after);
      let actual: string | null;
      try {
        actual = (await this.ref(change.locator)).hash;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
        actual = null;
      }
      requireWorkflow(
        actual === after || (projection.result.status === 'pending' && actual === before),
        'projection-input-conflict',
      );
      const original = manifest.inputs.find((ref) => ref.locator === change.locator);
      if (original !== undefined) {
        requireWorkflow(original.hash === before, 'projection-input-base-mismatch');
        projected.set(change.locator, original);
      } else if (change.before === null) projected.set(change.locator, null);
    }
    return projected;
  }
  async current(
    manifest: InputManifest,
    projection?: LocalRun['projection'],
  ): Promise<InputManifest> {
    try {
      const source = object(JSON.parse(manifest.discovery_rule) as unknown);
      const explicit = source.version === 2 && source.kind === 'explicit';
      requireWorkflow(
        source.version === undefined ||
          (explicit && Object.keys(source).every((key) => ['version', 'kind'].includes(key))),
        'invalid-discovery',
      );
      requireWorkflow(
        explicit || (Array.isArray(source.files) && Array.isArray(source.directories)),
        'invalid-discovery',
      );
      requireWorkflow(
        source.repository === undefined || source.repository === true,
        'invalid-discovery',
      );
      const current = await this.snapshot(
        explicit
          ? { files: manifest.inputs.map((ref) => ref.locator), directories: [] }
          : {
              files: (source.files as unknown[]).map(textField),
              directories: (source.directories as unknown[]).map(textField),
              ...(source.repository === true ? { repository: true as const } : {}),
            },
        manifest.attested_by,
        projection == null ? undefined : await this.projectionInputs(manifest, projection),
      );
      const graph = await this.dependencyGraph(
        current.inputs,
        new Map(
          projection?.plan.changes.flatMap((change) =>
            change.before === null ? [] : [[change.locator, change.before] as const],
          ),
        ),
      );
      return logicalInputs(
        manifest,
        { ...current, discovery_rule: manifest.discovery_rule, complete: manifest.complete },
        graph,
      );
    } catch {
      // A missing/corrupt/unreadable input is uncertainty, never an empty successful comparison.
      return { ...manifest, complete: false };
    }
  }
}
