import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { LocalTaskInput, TaskSnapshot, TaskBinding } from '../../contracts/localTask.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { ProcessIdentity, WriterProcesses } from '../../contracts/writerProcesses.js';
import { object, requireContract, text } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest, readPrivateFile } from '../artifacts/files.js';
import { taskFiles } from './taskFiles.js';
import { inspectTaskWriter } from '../codex/taskWriter.js';

function identities(value: unknown): ProcessIdentity[] {
  requireContract(Array.isArray(value), 'task-recovery-check-stop-unknown');
  return value.map((value) => {
    const p = object(value);
    requireContract(
      Number.isSafeInteger(p.pid) &&
        Number(p.pid) > 1 &&
        Number.isSafeInteger(p.parent) &&
        Number(p.parent) >= 0,
      'task-recovery-check-stop-unknown',
    );
    return { pid: Number(p.pid), parent: Number(p.parent), started: text(p.started) };
  });
}

// Observe retained primary stop evidence without granting, publishing or releasing task work.
export async function inspectStoppedTask({
  input,
  source,
  artifacts,
  directory,
  grant,
  processes,
}: {
  input: LocalTaskInput;
  source: TaskBinding;
  artifacts: TaskBinding;
  directory: string;
  grant: Buffer;
  processes: WriterProcesses;
}) {
  const stamps = new Map<string, Buffer>();
  const inventories = new Map<string, string[]>();
  const retained = (path: string) => {
    const bytes = readPrivateFile(path);
    stamps.set(path, bytes);
    return object(JSON.parse(bytes.toString()));
  };
  const inventory = (path: string) => {
    const names = readdirSync(path).sort(),
      previous = inventories.get(path) ?? names;
    requireContract(same(names, previous), 'task-recovery-inventory-changed');
    inventories.set(path, names);
    return names;
  };
  const checks: (() => Promise<void>)[] = [];
  const copyChecks: (() => void)[] = [];
  if (existsSync(join(directory, 'grant.json'))) {
    retained(join(directory, 'grant.json'));
    requireContract(
      readPrivateFile(join(directory, 'grant.json')).equals(grant),
      'task-recovery-grant-mismatch',
    );
  }
  const revocation = retained(join(directory, 'revoked.json'));
  requireContract(
    revocation.schemaVersion === 1 && revocation.grant === digest(grant),
    'task-recovery-permission-active',
  );
  if (existsSync(join(directory, 'permission.json'))) {
    const permission = retained(join(directory, 'permission.json'));
    requireContract(
      permission.schemaVersion === 1 &&
        permission.grant === digest(grant) &&
        permission.active === false,
      'task-recovery-permission-active',
    );
  }
  const files = taskFiles(artifacts.root, { existingOnly: true }),
    store = files.store,
    done = join(directory, 'done.json'),
    stopped = join(directory, 'stopped.json');
  files.bound(artifacts);
  checks.push(async () => files.bound(artifacts));
  let outcome: unknown;
  let stop: Record<string, unknown> | null = null;
  let doneResult: Record<string, unknown> | null = null;
  if (existsSync(done)) {
    const completed = retained(done),
      result = object(JSON.parse(store.read(controlRef(completed.result)).toString()));
    requireContract(
      completed.status === 'done' &&
        result.kind === 'local-task-result' &&
        result.complete === true &&
        same(result.input, input),
      'task-recovery-result-binding',
    );
    outcome = completed;
    doneResult = result;
  } else {
    const ref = controlRef(retained(stopped));
    stop = object(JSON.parse(store.read(ref).toString()));
    requireContract(
      ['task-stopped', 'task-not-started'].includes(String(stop.kind)) &&
        stop.confirmed === true &&
        same(stop.input, input),
      'task-recovery-stop-unconfirmed',
    );
    outcome = ref;
  }
  inventory(directory);
  const scopes = [directory];
  const corrections = join(directory, 'corrections');
  if (existsSync(corrections))
    for (const name of inventory(corrections)) {
      requireContract(/^[1-9][0-9]*$/u.test(name), 'task-recovery-round-unknown');
      scopes.push(join(corrections, name));
    }
  const writers = [];
  const expectedWriters = new Map<string, ArtifactRef>();
  if (stop?.writer !== undefined) expectedWriters.set(directory, controlRef(stop.writer));
  if (stop?.rounds !== undefined) {
    requireContract(Array.isArray(stop.rounds), 'task-recovery-round-unknown');
    for (const value of stop.rounds) {
      const row = object(value);
      requireContract(
        Number.isSafeInteger(row.round) && Number(row.round) >= 0,
        'task-recovery-round-unknown',
      );
      const scope = row.round === 0 ? directory : join(corrections, String(row.round));
      requireContract(!expectedWriters.has(scope), 'task-recovery-round-unknown');
      expectedWriters.set(scope, controlRef(row.writer));
      const owned = identities(row.checks);
      const verify = async () =>
        requireContract((await processes.alive(owned)).length === 0, 'task-recovery-check-live');
      await verify();
      checks.push(verify);
    }
  }
  const doneSnapshot = doneResult === null ? null : controlRef(doneResult.snapshot),
    doneWriter = doneResult === null ? null : controlRef(object(doneResult.writer).stop),
    doneChecks = doneResult === null ? null : controlRef(doneResult.checks);
  let doneMatched = doneResult === null;
  const writerMarkers = [
    'writer-runtime.json',
    'runtime-identity.json',
    'writer-stopped.json',
    'writer-result.json',
  ];
  const checkMarkers = ['baseline', 'candidate', 'integrated'].flatMap((stage) => [
    'checks-' + stage + '-intent.json',
    'checks-' + stage + '.json',
  ]);
  checks.push(async () => files.bound(source));
  for (const directory of scopes) {
    const names = inventory(directory);
    const rechecks = [
      ...new Set(
        names
          .filter((name) => name.startsWith('recheck-'))
          .map((name) => {
            const match = /^(recheck-[a-f0-9]{64})(?:-intent)?\.json$/u.exec(name);
            requireContract(match !== null, 'task-recovery-check-stop-unknown');
            return match[1]!;
          }),
      ),
    ];
    const snapshotPath = join(directory, 'snapshot.json');
    if (!existsSync(snapshotPath)) {
      requireContract(
        rechecks.length === 0 &&
          [...writerMarkers, ...checkMarkers].every((name) => !existsSync(join(directory, name))) &&
          !expectedWriters.has(directory),
        'task-recovery-operation-unknown',
      );
      continue;
    }
    const snapshot = controlRef(retained(snapshotPath)),
      body = JSON.parse(store.read(snapshot).toString()) as TaskSnapshot;
    requireContract(
      same(body.input, input) && same(body.source, source),
      'task-recovery-snapshot-binding',
    );
    let expectedWriter = expectedWriters.get(directory);
    if (doneSnapshot !== null && same(snapshot, doneSnapshot)) {
      requireContract(expectedWriter === undefined, 'task-recovery-writer-stop-binding');
      expectedWriter = doneWriter!;
      doneMatched = true;
    }
    const hasWriter =
      expectedWriter !== undefined ||
      writerMarkers.some((name) => existsSync(join(directory, name))) ||
      (existsSync(join(directory, 'writer-effects')) &&
        readdirSync(join(directory, 'writer-effects')).length > 0);
    let stoppedWriter: ArtifactRef;
    if (body.schemaVersion === 2) {
      requireContract(
        expectedWriter !== undefined &&
          !writerMarkers
            .filter((name) => name !== 'writer-result.json')
            .some((name) => existsSync(join(directory, name))),
        'task-recovery-operation-unknown',
      );
      const proof = object(JSON.parse(store.read(expectedWriter).toString()));
      requireContract(
        proof.kind === 'task-mechanical-stopped' &&
          proof.confirmed === true &&
          same(proof.input, input),
        'task-recovery-writer-stop-binding',
      );
      const resultPath = join(directory, 'writer-result.json');
      if (existsSync(resultPath)) {
        const result = object(JSON.parse(store.read(controlRef(retained(resultPath))).toString())),
          writtenStop = object(JSON.parse(store.read(controlRef(result.stop)).toString()));
        requireContract(
          result.session === null &&
            writtenStop.kind === 'task-mechanical-stopped' &&
            writtenStop.confirmed === true &&
            same(writtenStop.input, input) &&
            same(writtenStop.after, proof.after) &&
            same(JSON.parse(store.read(controlRef(result.tree)).toString()), proof.after),
          'task-recovery-writer-stop-binding',
        );
      }
      stoppedWriter = expectedWriter;
    } else {
      requireContract(hasWriter, 'task-recovery-operation-unknown');
      const writer = await inspectTaskWriter(body, files, directory, processes);
      requireContract(writer.status === 'stopped', 'task-recovery-writer-stop-unknown');
      requireContract(
        expectedWriter === undefined || same(expectedWriter, writer.receipt),
        'task-recovery-writer-stop-binding',
      );
      stoppedWriter = writer.receipt;
      const saved = JSON.stringify(writer);
      checks.push(async () =>
        requireContract(
          JSON.stringify(await inspectTaskWriter(body, files, directory, processes)) === saved,
          'task-recovery-writer-changed',
        ),
      );
    }
    writers.push(stoppedWriter);
    copyChecks.push(() => {
      const proof = object(JSON.parse(store.read(stoppedWriter).toString()));
      files.bound(body.copy);
      requireContract(same(files.observeTree(body.copy.root), proof.after), 'task-late-writer');
      files.bound(body.copy);
    });
    expectedWriters.delete(directory);
    const expectedCheck = doneSnapshot !== null && same(snapshot, doneSnapshot) ? doneChecks : null;
    let matched = expectedCheck === null;
    for (const stem of ['checks-baseline', 'checks-candidate', 'checks-integrated', ...rechecks]) {
      const stage = stem.startsWith('checks-') ? stem.slice('checks-'.length) : 'integrated';
      const pending = join(directory, stem + '-intent.json'),
        resultPath = join(directory, stem + '.json');
      if (!existsSync(pending) && !existsSync(resultPath)) continue;
      requireContract(
        existsSync(pending) && existsSync(resultPath),
        'task-recovery-check-stop-unknown',
      );
      retained(pending);
      const checked = retained(resultPath),
        manifest = object(JSON.parse(store.read(controlRef(checked.manifest)).toString()));
      if (stage === 'integrated' && same(controlRef(checked.manifest), expectedCheck))
        matched = true;
      requireContract(
        manifest.kind === 'task-checks' &&
          same(manifest.input, input) &&
          same(manifest.snapshot, snapshot) &&
          manifest.stage === stage &&
          Array.isArray(manifest.outcomes) &&
          manifest.outcomes.length > 0,
        'task-recovery-check-stop-unknown',
      );
      for (const value of manifest.outcomes) {
        const proof = object(JSON.parse(store.read(controlRef(object(value).proof)).toString())),
          stopped = object(proof.stop),
          owned = identities(stopped.processes);
        requireContract(
          proof.kind === 'task-check' &&
            same(proof.input, input) &&
            proof.stage === stage &&
            stopped.confirmed === true,
          'task-recovery-check-stop-unknown',
        );
        const verify = async () =>
          requireContract((await processes.alive(owned)).length === 0, 'task-recovery-check-live');
        await verify();
        checks.push(verify);
      }
    }
    requireContract(matched, 'task-recovery-check-stop-unknown');
  }
  requireContract(expectedWriters.size === 0 && doneMatched, 'task-recovery-operation-unknown');
  if (stop !== null) {
    const owned = stop.checksStopped === undefined ? [] : identities(stop.checksStopped);
    const verify = async () =>
      requireContract((await processes.alive(owned)).length === 0, 'task-recovery-check-live');
    await verify();
    checks.push(verify);
  }
  function assertUnchanged() {
    files.bound(artifacts);
    files.bound(source);
    for (const [path, names] of inventories)
      requireContract(same(readdirSync(path).sort(), names), 'task-recovery-inventory-changed');
    for (const [path, bytes] of stamps)
      requireContract(readPrivateFile(path).equals(bytes), 'task-recovery-journal-changed');
    for (const verify of copyChecks) verify();
  }
  async function recheck() {
    assertUnchanged();
    for (const verify of checks) await verify();
    assertUnchanged();
  }
  await recheck();
  return { outcome, writers, recheck, assertUnchanged };
}
