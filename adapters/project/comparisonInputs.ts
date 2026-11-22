import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localLocator, object, requireWorkflow, textField } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import { canonical, digest } from '../storage/storeCodec.js';
import { readPrivateFile, safeDirectory, writePrivateFile } from '../storage/storeFiles.js';
import { projectPath } from './projectFiles.js';

const exec = promisify(execFile);
export interface ComparisonSnapshot {
  schema_version: 1;
  origin: { root: string; revision: string | null };
  files: { locator: string; hash: string; content: string }[];
}
const requiredFiles = ['AGENTS.md', 'package.json', 'yarn.lock'];
const standaloneGuides = [
  'CODER.md',
  'COORDINATION.md',
  'CURRENT-CHAT.md',
  'DIAGRAMS.md',
  'EXECUTION.md',
  'FINALIZATION.md',
  'LOCAL-WORKFLOW.md',
  'MIGRATION.md',
  'PORTABILITY.md',
  'README.md',
  'RELAY.md',
  'STORAGE.md',
  'SUPERVISION.md',
];
const legacyDirectories = ['tools/agent-workflow', 'docs', '.agents'];
export const engineDirectories = [
  'adapters',
  'application',
  'cli',
  'comparison',
  'core',
  'ports',
  'src',
  'roles',
  'procedures',
  'project',
];
const standaloneDirectories = [...legacyDirectories, ...engineDirectories];
const clientPath = 'adapters/codex/currentChatHost.ts';

export function comparisonToolRoot(root: string) {
  return existsSync(resolve(root, clientPath)) ? root : resolve(root, 'tools/agent-workflow');
}
function discovery(root: string) {
  return comparisonToolRoot(root) === root
    ? {
        files: [
          ...requiredFiles,
          ...standaloneGuides.filter((name) => existsSync(resolve(root, name))),
        ],
        directories: standaloneDirectories,
      }
    : { files: requiredFiles, directories: legacyDirectories };
}

export async function freezeComparisonSnapshot(
  root: string,
  revision: string | null,
  directory: string,
): Promise<InputRef> {
  requireWorkflow((await realpath(root)) === root, 'comparison-source-root-alias');
  let locators: string[];
  let expected: Map<string, string> | null = null;
  if (revision === null) {
    const manifest = await new FileWorkflowInputs(root).capture(
      discovery(root),
      'comparison snapshot',
    );
    requireWorkflow(manifest.complete, 'comparison-source-incomplete');
    locators = manifest.inputs.map((entry) => entry.locator);
    expected = new Map(manifest.inputs.map((entry) => [entry.locator, entry.hash]));
  } else {
    requireWorkflow(/^[a-f0-9]{40}$/u.test(revision), 'comparison-source-revision-unpinned');
    const listing = await exec(
      'git',
      [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        revision,
        '--',
        ...requiredFiles,
        ...standaloneGuides,
        ...standaloneDirectories,
      ],
      { cwd: root },
    );
    const paths = listing.stdout.split('\0').filter(Boolean);
    locators = paths.includes(clientPath)
      ? paths
      : paths.filter(
          (path) =>
            requiredFiles.includes(path) ||
            legacyDirectories.some((directory) => path.startsWith(directory + '/')),
        );
    requireWorkflow(
      requiredFiles.every((name) => locators.includes(name)),
      'comparison-source-incomplete',
    );
  }
  const entries: ComparisonSnapshot['files'] = [];
  for (const locator of locators.sort()) {
    localLocator(locator);
    const bytes =
      revision === null
        ? readPrivateFile(resolve(root, locator))
        : (
            await exec('git', ['show', `${revision}:${locator}`], {
              cwd: root,
              encoding: 'buffer',
              maxBuffer: 16 * 1024 * 1024,
            })
          ).stdout;
    entries.push({ locator, hash: digest(bytes), content: bytes.toString('base64') });
    requireWorkflow(
      expected === null || expected.get(locator) === digest(bytes),
      'comparison-source-changed',
    );
  }
  if (revision === null) {
    const current = await new FileWorkflowInputs(root).capture(
      discovery(root),
      'comparison snapshot',
    );
    requireWorkflow(
      current.complete &&
        current.inputs.length === entries.length &&
        current.inputs.every((entry) => expected!.get(entry.locator) === entry.hash),
      'comparison-source-changed',
    );
  }
  const snapshot: ComparisonSnapshot = {
    schema_version: 1,
    origin: { root, revision },
    files: entries,
  };
  const bytes = canonical(snapshot) + '\n';
  const ref = {
    locator: resolve(directory, `snapshot-${digest(bytes)}.json`),
    hash: digest(bytes),
  };
  try {
    writePrivateFile(ref.locator, bytes);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    requireWorkflow(
      readPrivateFile(ref.locator).toString('utf8') === bytes,
      'comparison-source-changed',
    );
  }
  return ref;
}

export async function materializeComparisonSnapshot(
  ref: InputRef,
  destination: string,
  modules: string,
) {
  const bytes = readPrivateFile(ref.locator);
  requireWorkflow(digest(bytes) === ref.hash, 'comparison-source-changed');
  const snapshot = object(JSON.parse(bytes.toString('utf8'))) as unknown as ComparisonSnapshot;
  requireWorkflow(
    snapshot.schema_version === 1 && Array.isArray(snapshot.files) && snapshot.files.length > 0,
    'comparison-source-incomplete',
  );
  safeDirectory(dirname(destination));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  safeDirectory(destination);
  for (const entry of snapshot.files) {
    localLocator(entry.locator);
    requireWorkflow(typeof entry.content === 'string', 'comparison-source-incomplete');
    const content = Buffer.from(entry.content, 'base64');
    requireWorkflow(digest(content) === entry.hash, 'comparison-source-changed');
    const path = resolve(destination, entry.locator);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    safeDirectory(dirname(path));
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(readPrivateFile(path).equals(content), 'comparison-workspace-changed');
    }
  }
  requireWorkflow((await realpath(modules)) === modules, 'comparison-runtime-alias');
  const linked = resolve(destination, 'node_modules');
  try {
    await symlink(modules, linked, 'dir');
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    requireWorkflow((await realpath(linked)) === modules, 'comparison-runtime-alias');
  }
}

export async function verifyComparisonClient(root: string, binary: string) {
  const version = textField(
    (await exec(binary, ['--version'], { cwd: root })).stdout.trim().split(' ').at(-1),
  );
  const module = pathToFileURL(resolve(comparisonToolRoot(root), clientPath)).href;
  const code = `import { isSupportedChatClientVersion } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(isSupportedChatClientVersion(${JSON.stringify(version)})));`;
  const result = await exec(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: root },
  );
  requireWorkflow(result.stdout === 'true', 'comparison-common-client-unsupported');
  return version;
}

export async function verifyComparisonSnapshot(ref: InputRef, root: string) {
  const bytes = readPrivateFile(ref.locator);
  requireWorkflow(digest(bytes) === ref.hash, 'comparison-source-changed');
  const snapshot = object(JSON.parse(bytes.toString('utf8'))) as unknown as ComparisonSnapshot;
  const current = await new FileWorkflowInputs(root).capture(
    discovery(root),
    'comparison immutable inputs',
  );
  requireWorkflow(
    current.inputs.length === snapshot.files.length &&
      current.inputs.every((entry) =>
        snapshot.files.some(
          (expected) => expected.locator === entry.locator && expected.hash === entry.hash,
        ),
      ),
    'comparison-workspace-changed',
  );
}

export async function verifyComparisonMaterial(
  root: string,
  files: Record<string, string>,
  mutable: string[],
) {
  const base = safeDirectory(root);
  requireWorkflow(base === root, 'unsafe-project-path');
  const version = (stat: Stats) => [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ];
  for (const [locator, content] of Object.entries(files)) {
    const path = await projectPath(base, locator);
    requireWorkflow(path === resolve(base, locator), 'unsafe-project-path');
    safeDirectory(dirname(path));
    const before = lstatSync(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      requireWorkflow(opened.isFile() && opened.nlink === 1, 'unsafe-project-file');
      safeDirectory(base);
      safeDirectory(dirname(path));
      requireWorkflow(
        isDeepStrictEqual(version(before), version(opened)) &&
          isDeepStrictEqual(version(lstatSync(path)), version(opened)),
        'comparison-material-changed',
      );
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      safeDirectory(base);
      safeDirectory(dirname(path));
      requireWorkflow(
        isDeepStrictEqual(version(opened), version(after)) &&
          isDeepStrictEqual(version(after), version(lstatSync(path))),
        'comparison-material-changed',
      );
      requireWorkflow(
        mutable.includes(locator) || bytes.equals(Buffer.from(content, 'utf8')),
        'comparison-material-changed',
      );
    } finally {
      closeSync(fd);
    }
  }
}
