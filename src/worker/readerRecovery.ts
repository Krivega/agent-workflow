import { lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, LocalProjectRegistration } from '../contracts/preparation.js';
import { taskGate, taskGateBinding } from '../adapters/project/taskGate.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { unstartedWriterStop } from '../adapters/codex/taskWriter.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { parseLocalTask, localTaskKey } from '../policy/localTask.js';
import { taskAdmissionsRelativePath, taskAdmissionIdentity } from '../policy/taskRecovery.js';
import type { ReaderInput } from '../contracts/reader.js';
import type { ReaderExecution } from '../contracts/readerControl.js';
import type { ReaderProjectHost } from './readerHost.js';
import { isDeepStrictEqual } from 'node:util';
import { taskCardProjection } from '../adapters/project/taskFiles.js';
import type { LocalTaskInput, TaskSnapshot } from '../contracts/localTask.js';
import type { TaskPermissionOwner } from '../contracts/taskRecovery.js';
import {
  taskPermissionBytes,
  takeTaskRecoveryLock,
} from '../adapters/project/taskPermissionLock.js';
import { inspectTaskAdmissions } from './taskRecovery.js';
import { exactFields, object, parseProject, requireContract, text } from '../contracts/project.js';
import { checkRegistration } from '../policy/preparation.js';
import { controlRef, readerKey, readerTarget, parseReaderInput } from '../policy/readerControl.js';
import { readerExecution } from '../policy/readerExecution.js';
import { readerBoundary } from '../adapters/codex/readerBoundary.js';
import { readerSession } from '../adapters/codex/readerSession.js';
import { recoverSentTurn, sentMessage } from '../adapters/codex/recoveredSend.js';
import {
  artifactStore,
  digest,
  privateDirectory,
  readPrivateFile,
  publishFile,
  syncDirectory,
} from '../adapters/artifacts/files.js';

function requireDead(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  throw new Error('reader-host-still-alive');
}

// Publish only STOP evidence for one revoked admission; ownership transfer is a separate operation.
export async function recoverUnstartedBaseline(
  registration: LocalProjectRegistration,
  root: string,
  task: LocalTaskInput,
  profile: ReaderExecution['profile'],
  expected: { snapshot: ArtifactRef; baseline: ArtifactRef },
) {
  const input = parseLocalTask(task);
  requireContract(input.schemaVersion === 12, 'task-recovery-input');
  checkRegistration(input.admission.preparation, registration);
  const files = taskFiles(registration.artifactRoot, { existingOnly: true });
  const source = files.binding(registration.workspaceRoot);
  const hostPath = join(root, 'host-owner');
  const recovery = takeTaskRecoveryLock(join(root, 'host-recovery-lock'));
  try {
    const former = taskPermissionBytes(hostPath);
    const host = object(JSON.parse(former.bytes.toString()));
    requireContract(
      host.tasks === true &&
        host.taskBindings === 3 &&
        Number.isSafeInteger(host.pid) &&
        Number(host.pid) > 1,
      'reader-host-owner-invalid',
    );
    const instance = text(host.id);
    const binding = taskGateBinding(input, source, profile, registration.artifactRoot, instance);
    const admission = join(
      root,
      taskAdmissionsRelativePath(instance, 3),
      digest(taskAdmissionIdentity(input)),
    );
    const grant = { sha256: digest(binding.grant), bytes: binding.grant.length };
    const permission = {
      source,
      directory: binding.directory,
      taskKey: localTaskKey(input),
      attempt: input.continuation.attempt,
      grant,
    };
    const decl = {
      schemaVersion: 1,
      host: { pid: host.pid, id: instance },
      input,
      gate: { directory: binding.directory, grant, mode: 'owned' },
    };
    function checkHost() {
      requireDead(Number(host.pid));
      const current = taskPermissionBytes(hostPath);
      requireContract(
        current.identity === former.identity &&
          current.bytes.equals(former.bytes) &&
          isDeepStrictEqual(JSON.parse(readPrivateFile(admission).toString()), decl),
        'task-recovery-admission-mismatch',
      );
    }
    checkHost();
    const owner = recovery.owner(registration.artifactRoot, {
      kind: 'unstarted-baseline-stop',
      permission,
      former: files.store.publish(former.bytes),
      expected,
    });
    const gate = taskGate(input, source, profile, registration.artifactRoot, owner.ref.id, owner);
    return await gate.recordRetainedStop(async (bytes) => {
      requireContract(bytes.equals(binding.grant), 'task-recovery-grant-mismatch');
      const read = (path: string) =>
        JSON.parse(readPrivateFile(join(binding.directory, path)).toString()) as unknown;
      const snapshot = JSON.parse(files.store.read(expected.snapshot).toString()) as TaskSnapshot;
      requireContract(
        isDeepStrictEqual(read('snapshot.json'), expected.snapshot) &&
          isDeepStrictEqual(snapshot.input, input) &&
          isDeepStrictEqual(snapshot.source, source),
        'task-recovery-snapshot-binding',
      );
      const writer = await unstartedWriterStop(
        snapshot,
        files,
        binding.directory,
        new NativeWriterProcesses(),
      );
      requireContract(
        isDeepStrictEqual(writer.baseline, controlRef(expected.baseline)),
        'task-baseline-stop-binding',
      );
      const writerRef = files.save(writer);
      const stopped = files.save({
        kind: 'task-stopped',
        input,
        confirmed: true,
        writer: writerRef,
        checksStopped: [],
      });
      const markers = [
        ['writer-stopped.json', writerRef],
        ['stopped.json', stopped],
      ] as const;
      return () => {
        checkHost();
        const allowed = new Set([
          'grant.json',
          'revoked.json',
          'permission.json',
          'permission-lock',
          'execution-admission.json',
          'substantial-preflight.json',
          'check-logs',
          'writer-effects',
          'snapshot.json',
          'checks-baseline-intent.json',
          'checks-baseline.json',
          ...markers.map(([name]) => name),
        ]);
        requireContract(
          readdirSync(binding.directory).every((name) => allowed.has(name)) &&
            readdirSync(join(binding.directory, 'writer-effects')).length === 0 &&
            isDeepStrictEqual(read('checks-baseline.json'), {
              status: 'FAIL',
              manifest: expected.baseline,
            }) &&
            isDeepStrictEqual(files.observeTree(snapshot.copy.root), writer.after),
          'task-recovery-operation-unknown',
        );
        files.bound(snapshot.copy);
        for (const [name, ref] of markers)
          if (existsSync(join(binding.directory, name)))
            requireContract(
              isDeepStrictEqual(read(name), ref),
              'task-recovery-writer-stop-binding',
            );
        for (const [name, ref] of markers)
          if (!existsSync(join(binding.directory, name)))
            publishFile(join(binding.directory, name), Buffer.from(JSON.stringify(ref)));
        return stopped;
      };
    });
  } finally {
    recovery.release();
  }
}

function matchesCompletedCard(
  store: ReturnType<typeof artifactStore>,
  observed: Awaited<ReturnType<typeof inspectTaskAdmissions>>['observed'][number],
  input: ReaderInput,
  original: string,
  current: string,
): boolean {
  const task = observed.admission.input;
  const done = object(observed.outcome);
  if (done.status !== 'done' || !isDeepStrictEqual(task.admission.preparation, input.preparation))
    return false;
  const ref = controlRef(done.result);
  const result = object(JSON.parse(store.read(ref).toString()));
  const snapshot = JSON.parse(store.read(controlRef(result.snapshot)).toString()) as TaskSnapshot;
  const version = snapshot.tree.files.find((file) => file.path === input.preparation.card)?.version;
  if (version?.content.sha256 !== original) return false;
  const { projection } = taskCardProjection(
    task,
    ref,
    snapshot.plan.criterion,
    version,
    store.read(version.content),
  );
  return (
    projection.after.content.sha256 === current &&
    store.read(controlRef(done.projection)).equals(Buffer.from(JSON.stringify(projection)))
  );
}

// Reclaim only the dead local host; this never grants RESUME or changes task permissions.
export async function recoverReaderHost(
  projects: ReaderProjectHost[],
  directory: string,
  profile: ReaderExecution['profile'],
  assignments: ReaderInput[],
  tasks?: LocalTaskInput[],
) {
  const root = privateDirectory(directory),
    lock = join(root, 'host-recovery-lock');
  const recoveryLock = takeTaskRecoveryLock(lock);
  const lockStat = lstatSync(lock),
    rootStat = lstatSync(root);
  let recoveryOwner: TaskPermissionOwner | null = null;
  let assertRecoveryReleased: (() => void) | null = null;
  try {
    requireContract(projects.length > 0, 'reader-recovery-inventory-required');
    const ownerFile = join(root, 'host-owner'),
      original = readPrivateFile(ownerFile),
      owner = object(JSON.parse(original.toString('utf8')));
    requireContract(
      owner.tasks !== true ||
        ((owner.taskBindings === 1 || owner.taskBindings === 2 || owner.taskBindings === 3) &&
          tasks !== undefined),
      'reader-recovery-writers-unsupported',
    );
    requireContract(owner.audits !== true, 'reader-recovery-auditors-unsupported');
    exactFields(owner, ['pid', 'id', ...(owner.tasks === true ? ['tasks', 'taskBindings'] : [])]);
    requireContract(
      Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.id === 'string',
      'reader-host-owner-invalid',
    );
    requireDead(Number(owner.pid));
    const ownerWitness = owner.taskBindings === 3 ? taskPermissionBytes(ownerFile) : null;
    function assertFormer() {
      requireDead(Number(owner.pid));
      const currentRoot = lstatSync(root),
        currentLock = lstatSync(lock);
      requireContract(
        realpathSync(root) === root &&
          realpathSync(lock) === lock &&
          currentRoot.dev === rootStat.dev &&
          currentRoot.ino === rootStat.ino &&
          currentLock.dev === lockStat.dev &&
          currentLock.ino === lockStat.ino &&
          readPrivateFile(ownerFile).equals(original),
        'reader-recovery-owner-changed',
      );
      if (recoveryOwner !== null) for (const verify of snapshots) verify();
      requireContract(ownerWitness !== null, 'reader-recovery-owner-witness-required');
      const current = taskPermissionBytes(ownerFile);
      requireContract(
        current.identity === ownerWitness.identity && current.bytes.equals(ownerWitness.bytes),
        'reader-recovery-owner-changed',
      );
    }
    requireContract(
      owner.tasks === true || tasks === undefined || tasks.length === 0,
      'task-recovery-inventory-undeclared',
    );
    const taskRecovery =
      owner.tasks === true
        ? await inspectTaskAdmissions(
            projects,
            root,
            { pid: Number(owner.pid), id: String(owner.id) },
            tasks!,
            owner.taskBindings === 1 ? 1 : owner.taskBindings === 2 ? 2 : 3,
          )
        : null;
    assertRecoveryReleased = () => {
      requireContract(recoveryOwner !== null, 'reader-recovery-current-owner-required');
      requireContract(taskRecovery !== null, 'task-recovery-inventory-required');
      taskRecovery.assertRecoveryReleased(recoveryOwner.ref);
    };
    const config = readerExecution(profile),
      inputs = assignments.map(parseReaderInput);
    const admissionKeys = inputs
      .map((input) => digest(JSON.stringify(readerTarget(input, readerKey(input)))))
      .sort();
    requireContract(
      new Set(admissionKeys).size === admissionKeys.length &&
        JSON.stringify(readdirSync(join(root, 'admissions')).sort()) ===
          JSON.stringify(admissionKeys),
      'reader-recovery-admission-incomplete',
    );
    requireContract(
      inputs.every((input) =>
        projects.some(
          (p) =>
            parseProject(p.registration.project).projectId === input.preparation.project.projectId,
        ),
      ),
      'reader-recovery-project-unregistered',
    );
    const expectedProjects = projects
      .map((p) => digest(parseProject(p.registration.project).projectId))
      .sort();
    requireContract(
      new Set(expectedProjects).size === expectedProjects.length &&
        JSON.stringify(
          readdirSync(root)
            .filter((name) => /^[a-f0-9]{64}$/u.test(name))
            .sort(),
        ) === JSON.stringify(expectedProjects),
      'reader-recovery-project-incomplete',
    );
    const proofs: {
      projectId: string;
      receipt: ReturnType<ReturnType<typeof artifactStore>['publish']>;
    }[] = [];
    const snapshots: (() => void)[] = [],
      staleLocks: string[] = [];
    for (const project of projects) {
      const { registration, rpc } = project;
      requireContract(
        registration.hostId === projects[0]!.registration.hostId &&
          registration.owner === projects[0]!.registration.owner,
        'reader-recovery-host-mismatch',
      );
      const id = parseProject(registration.project).projectId,
        permissions = join(root, digest(id), 'permissions'),
        store = artifactStore(registration.artifactRoot),
        gate = readerBoundary(permissions, store, registration.workspaceRoot, config);
      const assigned = inputs.filter((input) => input.preparation.project.projectId === id);
      const expected = assigned
        .map((input) => digest(JSON.stringify(readerTarget(input, readerKey(input)))))
        .sort();
      requireContract(
        new Set(expected).size === expected.length &&
          JSON.stringify(readdirSync(permissions).sort()) === JSON.stringify(expected),
        'reader-recovery-assignment-incomplete',
      );
      const observed = [];
      for (const input of assigned) {
        checkRegistration(input.preparation, registration);
        // Only the read-only recovery observation may follow the completed task's projection.
        const inspect = () =>
          gate.inspect(
            input,
            (original, current) =>
              taskRecovery?.observed.some((observed) =>
                matchesCompletedCard(store, observed, input, original, current),
              ) === true,
          );
        const snapshot = inspect(),
          stamp = JSON.stringify(snapshot),
          sessions = new Map<string, Record<string, unknown>>();
        const admission = readPrivateFile(
          join(root, 'admissions', digest(JSON.stringify(readerTarget(input, readerKey(input))))),
        );
        const expected = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            target: readerTarget(input, readerKey(input)),
            inputHash: digest(JSON.stringify(input)),
            permit: snapshot.permit,
          }),
        );
        requireContract(admission.equals(expected), 'reader-recovery-admission-mismatch');
        snapshots.push(() =>
          requireContract(JSON.stringify(inspect()) === stamp, 'reader-recovery-journal-changed'),
        );
        snapshots.push(() =>
          requireContract(
            readPrivateFile(
              join(
                root,
                'admissions',
                digest(JSON.stringify(readerTarget(input, readerKey(input)))),
              ),
            ).equals(admission),
            'reader-recovery-admission-changed',
          ),
        );
        for (const request of snapshot.requests.filter((r) => r.method === 'thread/start')) {
          requireContract(request.response !== null, 'reader-recovery-create-unknown');
          const created = readerSession(
            request.response,
            registration.workspaceRoot,
            config.profile,
          );
          const raw = await rpc.request('thread/read', {
            threadId: created.id,
            includeTurns: true,
          });
          const primary = store.publish(
            Buffer.from(
              JSON.stringify({
                kind: 'reader-recovery-observation',
                target: readerTarget(input, readerKey(input)),
                raw,
              }),
            ),
          );
          const thread = object(object(raw).thread);
          requireContract(
            thread.id === created.id &&
              thread.cwd === registration.workspaceRoot &&
              Array.isArray(thread.turns),
            'reader-recovery-history-unknown',
          );
          const turns = thread.turns.map(object);
          requireContract(
            new Set(turns.map((turn) => text(turn.id))).size === turns.length &&
              turns.every((turn) =>
                ['completed', 'failed', 'interrupted'].includes(String(turn.status)),
              ),
            'reader-recovery-turn-active',
          );
          sessions.set(created.id, thread);
          observed.push({
            target: readerTarget(input, readerKey(input)),
            permit: snapshot.permit,
            permission: snapshot.permission,
            primary,
          });
        }
        for (const request of snapshot.requests.filter((r) => r.method === 'turn/start')) {
          const id = text(request.params.threadId),
            thread = sessions.get(id);
          requireContract(thread !== undefined, 'reader-recovery-session-unknown');
          const turns = thread.turns as Record<string, unknown>[];
          if (request.response !== null) {
            const turnId = text(object(object(request.response).turn).id);
            requireContract(
              turns.some((turn) => turn.id === turnId),
              'reader-recovery-turn-unknown',
            );
          } else {
            const message = sentMessage(request.params.input);
            requireContract(
              recoverSentTurn({ thread }, id, message) !== null,
              'reader-recovery-send-unknown',
            );
          }
        }
        staleLocks.push(
          join(permissions, digest(JSON.stringify(readerTarget(input, readerKey(input)))), 'lock'),
        );
      }
      const receipt = store.publish(
        Buffer.from(JSON.stringify({ kind: 'reader-host-recovery', owner, config, observed })),
      );
      proofs.push({ projectId: id, receipt });
    }
    for (const verify of snapshots) await Promise.resolve(verify());
    await taskRecovery?.recheck();
    requireDead(Number(owner.pid));
    requireContract(readPrivateFile(ownerFile).equals(original), 'reader-host-owner-changed');
    if (taskRecovery?.needsCompletionOwner === true) {
      assertFormer();
      const store = artifactStore(projects[0]!.registration.artifactRoot);
      recoveryOwner = recoveryLock.owner(projects[0]!.registration.artifactRoot, {
        kind: 'task-completion-recovery',
        former: { root, owner: store.publish(original), identity: [rootStat.dev, rootStat.ino] },
        readers: proofs,
        tasks: taskRecovery.observed,
      });
      recoveryOwner.assertCurrent();
      assertFormer();
    }
    const receipt = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        owner,
        ...(recoveryOwner === null ? {} : { recoveryOwner: recoveryOwner.ref }),
        proofs,
        ...(taskRecovery === null ? {} : { tasks: taskRecovery.observed }),
      }),
    );
    const receiptPath = join(root, 'recovery-' + digest(original) + '-' + digest(receipt));
    try {
      publishFile(receiptPath, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      requireContract(
        readPrivateFile(receiptPath).equals(receipt),
        'reader-recovery-receipt-conflict',
      );
    }
    if (recoveryOwner !== null) {
      recoveryOwner.assertCurrent();
      assertFormer();
      taskPermissionBytes(receiptPath);
    }
    const released = taskRecovery?.releaseReservations(recoveryOwner ?? undefined, assertFormer);
    if (released !== undefined) await released;
    for (const path of staleLocks) if (existsSync(path)) rmdirSync(path);
    unlinkSync(ownerFile);
    syncDirectory(root);
    return { owner, proofs, ...(taskRecovery === null ? {} : { tasks: taskRecovery.observed }) };
  } finally {
    if (recoveryOwner !== null) {
      requireContract(assertRecoveryReleased !== null, 'reader-recovery-task-inspection-required');
      assertRecoveryReleased();
    }
    recoveryLock.release();
  }
}
