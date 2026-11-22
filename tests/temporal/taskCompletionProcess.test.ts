import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { acceptance, runReview, throughIntegration } from './localTaskRun.js';
import { createTaskHumanState, closeTaskHuman } from '../../src/policy/taskHuman.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { object } from '../../src/contracts/project.js';
import { controlRef } from '../../src/policy/readerControl.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as permission from '../../src/adapters/project/taskPermissionLock.js';
import { recoverReaderHost } from '../../src/worker/readerRecovery.js';
import type { TaskHumanFinishRequest } from '../../src/contracts/taskHuman.js';

afterEach(() => vi.restoreAllMocks());
const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(directory, '../..');
const childPath = join(directory, 'taskCompletionProcessChild.mjs');
const limit = 128 * 1024;
const workMs = 45_000;
const cleanupMs = 10_000;
const processMarker = 'TD056_OWNED_UNIT_PROCESS_V1';
const modulePaths = [
  'src/worker/readerHost.ts',
  'src/worker/readerRecovery.ts',
  'src/worker/taskRecovery.ts',
  'src/adapters/project/taskPermissionLock.ts',
  'src/adapters/project/taskHumanCompletionGate.ts',
  'src/adapters/project/stoppedTask.ts',
  'src/activities/taskHumanCompletion.ts',
  'src/activities/taskHuman.ts',
  'src/activities/localTask.ts',
];
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = {
  child: ChildProcessWithoutNullStreams;
  command: string;
  record: Promise<Record<string, unknown>>;
  exited: Promise<Exit>;
  stdout: () => string;
  stderr: () => string;
  fault: () => Error | null;
};
function observeProcess(owned: Owned) {
  assert.ok(owned.child.pid);
  const text = execFileSync(
    'ps',
    ['-ww', '-p', String(owned.child.pid), '-o', 'pid=,ppid=,lstart=,args='],
    {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 16 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  const match = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(
    text,
  );
  assert.ok(match, 'owned process identity missing');
  assert.equal(match[4], owned.command, 'owned process command changed');
  return { pid: Number(match[1]), parent: Number(match[2]), started: match[3], command: match[4] };
}
function startChild(
  role: 'hold' | 'recover',
  path: string,
  nonce: string,
  deadline: number,
): Owned {
  const args = [childPath, role, path, digest(readFileSync(path)), nonce, processMarker];
  const command = [process.execPath, ...args].join(' ');
  assert.ok(Date.now() < deadline, 'owned process deadline expired before spawn');
  const child = spawn(process.execPath, args, {
    cwd: resolve(packageRoot, '../..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '',
    pending = '',
    first = true,
    fault: Error | null = null;
  let accept!: (row: Record<string, unknown>) => void, reject!: (error: Error) => void;
  const record = new Promise<Record<string, unknown>>((yes, no) => {
    accept = yes;
    reject = no;
  });
  void record.catch(() => {});
  const fail = (error: Error) => {
    fault ??= error;
    reject(error);
    child.kill('SIGKILL');
  };
  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString();
    pending += bytes.toString();
    if (Buffer.byteLength(output) > limit) return fail(new Error('owned child stdout limit'));
    let at: number;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (!line) continue;
      try {
        assert.ok(first, 'one protocol record per child');
        first = false;
        const row = object(JSON.parse(line) as unknown);
        assert.equal(
          row.kind,
          role === 'hold' ? 'td056-unit-child-ready/1' : 'td056-unit-child-recovered/1',
        );
        assert.equal(row.nonce, nonce);
        assert.equal(row.pid, child.pid);
        accept(row);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.stderr.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
    if (Buffer.byteLength(errors) > limit) fail(new Error('owned child stderr limit'));
  });
  child.once('error', fail);
  const timer = setTimeout(
    () => fail(new Error('owned process deadline')),
    Math.max(1, deadline - Date.now()),
  );
  const exited = new Promise<Exit>((done) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (first)
        reject(new Error('owned child exited before its protocol record: ' + errors.slice(-3000)));
      done({ code, signal });
    });
  });
  return {
    child,
    command,
    record,
    exited,
    stdout: () => output,
    stderr: () => errors,
    fault: () => fault,
  };
}
async function cleanup(children: Set<Owned>) {
  for (const owned of children) {
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.exited,
        new Promise<never>((_, no) => {
          timer = setTimeout(() => no(new Error('owned child cleanup unconfirmed')), cleanupMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
function privatePin(path: string) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
  );
  return { path, bytes: stat.size, sha256: digest(readFileSync(path)) };
}
async function sealedFixture() {
  const f = await taskHumanLocalFixture(false);
  await f.service.executionControls.prepareTaskExecution(f.input);
  const manifest = await f.service.humanActivities.prepareTaskHuman(f.input);
  const planning = await f.service.activities.prepareSubstantialPlanning(f.input);
  const approved = await runReview(f, planning);
  const run = await throughIntegration(f, f.input, approved.manifest);
  const reviewed = await acceptance(f, run);
  expect(reviewed.complete).toBe(true);
  const stopped = await f.service.controls.stopLocalTask(f.input);
  const request: TaskHumanFinishRequest = {
    schemaVersion: 1,
    kind: 'task-human-finish',
    input: f.input,
    state: closeTaskHuman(createTaskHumanState(manifest), 0),
    expectedRevision: 0,
    technical: {
      input: f.input,
      snapshot: run.snapshot,
      packet: run.packet,
      acceptance: reviewed.manifest,
      stopped,
      records: [
        planning.request,
        approved.manifest,
        run.snapshot,
        run.intent,
        run.integration,
        run.checked.manifest,
        run.packet.request,
        reviewed.manifest,
      ],
    },
  };
  const attempt = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    digest(localTaskKey(f.input)),
    'execution-attempts/0',
  );
  const reservation = join(f.workspace, '.git/agent-workflow/source-reservation');
  const pointer = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    digest(localTaskKey(f.input)),
    'human-completion',
    run.snapshot.sha256 + '.json',
  );
  const actualLock = permission.taskPermissionLock;
  let stoppedBeforeAcquire = false;
  const fault = vi.spyOn(permission, 'taskPermissionLock').mockImplementation((scope, owner) => {
    const lock = actualLock(scope, owner);
    return {
      ...lock,
      acquire() {
        if (!stoppedBeforeAcquire && scope.directory === attempt && existsSync(pointer)) {
          stoppedBeforeAcquire = true;
          throw new Error('unit preparation stops before real completion acquire');
        }
        lock.acquire();
      },
    };
  });
  try {
    await expect(f.service.humanActivities.finishTaskHuman(request)).rejects.toThrow(
      'unit preparation stops before real completion acquire',
    );
  } finally {
    fault.mockRestore();
  }
  expect(stoppedBeforeAcquire).toBe(true);
  expect(existsSync(reservation)).toBe(false);
  expect(existsSync(join(attempt, 'permission-lock'))).toBe(false);
  expect(existsSync(join(attempt, 'completion-intent.json'))).toBe(false);
  expect(existsSync(join(attempt, 'done.json'))).toBe(false);
  const seal = controlRef(JSON.parse(readFileSync(pointer, 'utf8')) as unknown);
  expect(f.read(seal)).toMatchObject({ kind: 'task-human-completion-seal', request });
  const answers = f.read(reviewed.manifest).answers;
  assert.ok(Array.isArray(answers));
  const sessions = answers.map((value: unknown) => {
    const answer = controlRef(object(value).answer);
    const session = f.read(answer).session;
    assert.ok(typeof session === 'string');
    return session;
  });
  assert.ok(
    sessions.length > 0 && sessions.length <= 8 && new Set(sessions).size === sessions.length,
  );
  const rows = [];
  for (const threadId of sessions) {
    const params = { threadId, includeTurns: true };
    const response = await f.rpc.request('thread/read', params);
    assert.equal(object(object(response).thread).id, threadId);
    rows.push({ params, response, sha256: digest(Buffer.from(JSON.stringify(response))) });
  }
  const readsPath = join(f.root, 'synthetic-reader-history.json');
  const readsBytes = Buffer.from(
    JSON.stringify({ kind: 'SYNTHETIC_FIXTURE_READER_HISTORY_NOT_NATIVE_AUTHORITY', rows }),
  );
  assert.ok(readsBytes.length <= 1024 * 1024);
  writeFileSync(readsPath, readsBytes, { flag: 'wx', mode: 0o600 });
  const syntheticReads = { ...privatePin(readsPath), count: rows.length };
  return { ...f, request, attempt, reservation, seal, syntheticReads };
}

describe(
  'physical loss of an owned completion process without actual SDK workers (synthetic technical ports)',
  { timeout: 60_000 },
  () => {
    it.each([false, true])(
      'recovers one real dead owner with permission lock=%s, without another Writer or duplicate projection',
      async (withLock) => {
        const deadline = Date.now() + workMs;
        const children = new Set<Owned>();
        try {
          const f = await sealedFixture();
          const nonce = randomUUID();
          const card = join(f.workspace, f.input.admission.preparation.card);
          const closedPins = ['grant.json', 'permission.json', 'revoked.json', 'stopped.json'].map(
            (name) => privatePin(join(f.attempt, name)),
          );
          const beforeCard = readFileSync(card);
          const hostRoot = join(f.root, 'real-process-host');
          const descriptor = {
            kind: 'td056-owned-process-unit-fixture/1',
            syntheticPorts: true,
            packageRoot,
            childPath,
            nodeExecPath: process.execPath,
            nonce,
            deadline,
            syncWaitMs: 5000,
            withLock,
            registration: f.registration,
            profile: f.profile,
            input: f.input,
            request: f.request,
            seal: f.seal,
            syntheticPrincipal: f.declaration.admission.principal,
            syntheticReads: f.syntheticReads,
            hostRoot,
            modelQueue: f.taskQueue.slice(0, -'.control'.length),
            controlQueue: f.taskQueue,
            reservation: f.reservation,
            lockPath: join(f.attempt, 'permission-lock'),
            card,
            cardBeforeHash: digest(beforeCard),
            closedPins,
            modulePins: [
              ...modulePaths.flatMap((path) => [
                join(packageRoot, path),
                join(packageRoot, path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js')),
              ]),
              childPath,
            ].map((path) => ({ path, sha256: digest(readFileSync(path)) })),
          };
          const path = join(f.root, 'owned-process-fixture.json');
          writeFileSync(path, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
          const first = startChild('hold', path, nonce, deadline);
          children.add(first);
          const ready = await first.record;
          assert.ok(first.child.pid);
          const identity = observeProcess(first);
          expect(identity.parent).toBe(process.pid);
          expect(ready.pid).toBe(identity.pid);
          const ownerPath = join(hostRoot, 'host-owner');
          const ownerBytes = readFileSync(ownerPath);
          const owner = object(JSON.parse(ownerBytes.toString()) as unknown);
          expect(owner).toEqual(ready.owner);
          expect(owner.pid).toBe(first.child.pid);
          expect(owner.taskBindings).toBe(3);
          const admissionPath = join(
            hostRoot,
            'task-admissions-v2',
            String(owner.id),
            digest(taskAdmissionIdentity(f.input)),
          );
          const admissionBytes = readFileSync(admissionPath);
          const admission = object(JSON.parse(admissionBytes.toString()) as unknown);
          expect(admission.host).toEqual({ pid: first.child.pid, id: owner.id });
          expect(admission.input).toEqual(f.input);
          expect(object(admission.gate)).toMatchObject({ directory: f.attempt, mode: 'retained' });
          privatePin(ownerPath);
          privatePin(admissionPath);
          privatePin(f.reservation);
          const token = readFileSync(f.reservation);
          expect(digest(token)).toBe(ready.tokenHash);
          expect(object(JSON.parse(token.toString()) as unknown)).toMatchObject({
            schemaVersion: 2,
            taskAdmission: taskAdmissionIdentity(f.input),
            ownerPid: first.child.pid,
            seal: f.seal,
          });
          if (withLock) privatePin(descriptor.lockPath);
          const oldLock = withLock ? readFileSync(descriptor.lockPath) : null;
          expect(oldLock === null ? null : digest(oldLock)).toBe(ready.lockHash);
          for (const pin of closedPins) expect(digest(readFileSync(pin.path))).toBe(pin.sha256);
          await expect(
            recoverReaderHost(
              [
                {
                  registration: f.registration,
                  rpc: f.rpc,
                  authority: f.authority,
                  localTasks: f.host,
                },
              ],
              hostRoot,
              f.profile,
              [],
              [f.input],
            ),
          ).rejects.toThrow('reader-host-still-alive');
          expect(readFileSync(ownerPath)).toEqual(ownerBytes);
          expect(readFileSync(f.reservation)).toEqual(token);
          expect(readFileSync(card)).toEqual(beforeCard);
          expect(observeProcess(first)).toEqual(identity);
          expect(first.child.kill('SIGKILL')).toBe(true);
          expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' });
          expect(first.fault()).toBeNull();
          children.delete(first);
          assert.throws(
            () => process.kill(identity.pid, 0),
            (error: unknown) => object(error).code === 'ESRCH',
          );
          expect(readFileSync(f.reservation)).toEqual(token);
          if (withLock) expect(readFileSync(descriptor.lockPath)).toEqual(oldLock);
          else expect(existsSync(descriptor.lockPath)).toBe(false);
          const recoveredPath = join(f.root, 'owned-process-recovery.json');
          writeFileSync(
            recoveredPath,
            JSON.stringify({
              ...descriptor,
              formerPid: identity.pid,
              previousBudget: controlRef(ready.budget),
            }),
            { flag: 'wx', mode: 0o600 },
          );
          const second = startChild('recover', recoveredPath, nonce, deadline);
          children.add(second);
          const result = await second.record;
          expect(second.child.pid).not.toBe(identity.pid);
          expect(result.pid).toBe(second.child.pid);
          expect(await second.exited).toEqual({ code: 0, signal: null });
          expect(second.fault()).toBeNull();
          children.delete(second);
          expect(result.formerPid).toBe(identity.pid);
          expect(existsSync(f.reservation)).toBe(false);
          expect(existsSync(descriptor.lockPath)).toBe(false);
          expect(existsSync(ownerPath)).toBe(false);
          expect(readFileSync(card)).not.toEqual(beforeCard);
          expect(digest(readFileSync(card))).toBe(result.cardHash);
          const outcome = object(result.outcome);
          expect(f.read(controlRef(outcome.result)).humanCompletion).toEqual(f.seal);
          for (const pin of closedPins) expect(digest(readFileSync(pin.path))).toBe(pin.sha256);
          for (const row of [ready, result]) {
            expect(object(row.counters)).toMatchObject({
              capturedWorkerCreates: 2,
              actualWorkerCreates: 0,
              actualConnections: 0,
              actualRuntimes: 0,
              forbiddenRpcCalls: 0,
              writerStarts: 0,
            });
          }
          expect(object(ready.counters).syntheticReadCalls).toBe(0);
          expect(object(result.counters).syntheticReadCalls).toBe(f.syntheticReads.count);
          expect(object(result.counters).capturedWorkerShutdowns).toBe(2);
          expect(readdirSync(hostRoot).some((name) => name.startsWith('recovery-'))).toBe(true);
          expect(Date.now()).toBeLessThan(deadline);
        } finally {
          await cleanup(children);
        }
      },
    );
  },
);
