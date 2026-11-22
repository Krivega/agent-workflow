import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import type { Client } from '@temporalio/client';
import { digest, publishFile, readPrivateFile } from '../src/adapters/artifacts/files.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import { taskGateBinding } from '../src/adapters/project/taskGate.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import {
  controlRef,
  parseReaderInput,
  readerTarget,
  scopedReader,
} from '../src/policy/readerControl.js';
import { parseReviewInput, parseReviewRequest, parseReviewSnapshot } from '../src/policy/review.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

/** Inspect only the current H06 planning Reader or the bound cold Writer failure. */
export async function assertH06NativeReaderNotBlocked(
  client: Client,
  started: H04Pin,
  runId: string,
  workDeadlineMs: number,
  signal: AbortSignal,
) {
  const time = () => {
    signal.throwIfAborted();
    requireContract(
      Number.isSafeInteger(workDeadlineMs) && Date.now() < workDeadlineMs,
      'h06-temporal-reader-deadline',
    );
  };
  time();
  const {
    start,
    input: initial,
    workflowId,
    evidence,
    artifactRoot,
  } = readH06NativeTemporalStart(started);
  requireContract(start.hostRoot === join(evidence, 'temporal-host'), 'h06-temporal-reader-host');
  const query = async (id: string, run: string | undefined, name: string) => {
    time();
    let value: unknown;
    try {
      value = await client.connection.withAbortSignal(signal, () =>
        client.connection.withDeadline(workDeadlineMs, () =>
          client.workflow.getHandle(id, run, { followRuns: false }).query<unknown>(name),
        ),
      );
    } catch {
      time();
      return null;
    }
    time();
    return object(value);
  };
  const status = await query(workflowId, runId, 'localTaskStatus');
  if (status === null) return;
  requireContract(status.runId === runId, 'h06-temporal-reader-task-run');
  const heldFailure =
    status.phase === 'waiting-human' &&
    status.waiting === true &&
    status.attempt === 2 &&
    status.revision === 4 &&
    typeof status.error === 'string' &&
    status.error.length > 0 &&
    status.held !== null;
  if (!heldFailure && (status.phase !== 'planning' || status.waiting !== false)) return;
  requireContract(
    Number.isSafeInteger(status.attempt) && Number(status.attempt) >= 0,
    'h06-temporal-reader-attempt',
  );
  const files = taskFiles(artifactRoot, { existingOnly: true });
  const gate = taskGateBinding(
    initial,
    files.binding(String(start.workspaceRoot)),
    start.profile as Parameters<typeof taskGateBinding>[2],
    artifactRoot,
    identifier(object(start.hostOwner).id),
  );
  const directory = join(dirname(gate.directory), String(status.attempt));
  const preflightPath = join(directory, 'substantial-preflight.json');
  if (!existsSync(preflightPath)) return;
  const read = (ref: unknown) => object(JSON.parse(files.store.read(controlRef(ref)).toString()));
  const preflight = read(JSON.parse(readPrivateFile(preflightPath).toString()));
  const input = parseLocalTask(preflight.input);
  requireContract(
    preflight.kind === 'substantial-preflight' &&
      input.schemaVersion === 11 &&
      input.continuation.attempt === status.attempt &&
      taskGateBinding(
        input,
        files.binding(String(start.workspaceRoot)),
        start.profile as Parameters<typeof taskGateBinding>[2],
        artifactRoot,
        identifier(object(start.hostOwner).id),
      ).directory === directory &&
      input.admission.preparation.revision === status.requirementsRevision &&
      same(
        { ...input.admission.preparation, revision: initial.admission.preparation.revision },
        initial.admission.preparation,
      ) &&
      same(input.admission.plan, initial.admission.plan),
    'h06-temporal-reader-preflight',
  );
  if (heldFailure) {
    const heldPath = join(directory, 'execution-held.json'),
      stoppedPath = join(directory, 'stopped.json');
    if (!existsSync(heldPath) || !existsSync(stoppedPath)) return;
    const held = controlRef(status.held),
      record = read(held);
    if (
      record.kind !== 'task-execution-held' ||
      !same(record.input, input) ||
      record.command !== null ||
      record.reason !== status.error ||
      !same(controlRef(JSON.parse(readPrivateFile(heldPath).toString())), held)
    )
      return;
    const progress = object(record.progress),
      stopped = controlRef(record.stopped),
      stop = read(stopped);
    if (
      progress.phase !== 'writing' ||
      !same(controlRef(progress.snapshot), controlRef(status.snapshot)) ||
      !same(controlRef(JSON.parse(readPrivateFile(stoppedPath).toString())), stopped) ||
      stop.confirmed !== true ||
      !same(stop.input, input)
    )
      return;
    const current = await query(workflowId, runId, 'localTaskStatus');
    if (
      current === null ||
      ![
        'runId',
        'phase',
        'waiting',
        'attempt',
        'requirementsRevision',
        'revision',
        'error',
        'stopFailure',
        'held',
        'snapshot',
      ].every((key) => same(current[key], status[key]))
    )
      return;
    time();
    publishFile(
      join(evidence, 'task-failure-2.json'),
      Buffer.from(
        JSON.stringify({
          kind: 'h06-native-task-held',
          started,
          task: { workflowId, runId, attempt: status.attempt },
          held,
          error: status.error,
          status,
          observedAtUnixMs: Date.now(),
        }),
      ),
    );
    throw new Error(`h06-temporal-task-held: ${status.error}`);
  }
  const planning = parseReviewInput(preflight.planning);
  requireContract(
    same(planning.preparation, input.admission.preparation),
    'h06-temporal-reader-planning',
  );
  const request = parseReviewRequest(read(planning.request), planning);
  requireContract(request.phase === 'planning', 'h06-temporal-reader-phase');
  requireContract(
    request.schemaVersion === 3 && request.evidence.length > 0,
    'h06-temporal-reader-planning',
  );
  const source = parseReviewRequest(read(input.admission.planning), {
    ...planning,
    request: input.admission.planning,
  });
  const tree = object(preflight.tree);
  requireContract(Array.isArray(tree.files), 'h06-temporal-reader-planning');
  const expectedFiles = tree.files.map((raw) => {
    const file = object(raw);
    return { path: text(file.path), ...controlRef(object(file.version).content) };
  });
  const originalEvidence = source.schemaVersion === 1 ? [] : source.evidence;
  const proposal = read(request.evidence.at(-1)!);
  requireContract(
    same({ ...source, schemaVersion: 3, evidence: request.evidence, expectedFiles }, request) &&
      same(request.evidence.slice(0, originalEvidence.length), originalEvidence) &&
      proposal.kind === 'substantial-proposal' &&
      same(proposal.input, input) &&
      same(proposal.plan, preflight.plan),
    'h06-temporal-reader-planning',
  );
  const admissions = join(String(start.hostRoot), 'admissions');
  if (!existsSync(admissions)) return;
  for (const name of readdirSync(admissions).sort()) {
    if (!/^[a-f0-9]{64}$/u.test(name)) continue;
    const admission = object(JSON.parse(readPrivateFile(join(admissions, name)).toString()));
    exactFields(admission, ['schemaVersion', 'target', 'inputHash', 'permit']);
    const target = object(admission.target);
    if (
      target.projectId !== planning.preparation.project.projectId ||
      target.taskId !== planning.preparation.taskId
    )
      continue;
    requireContract(
      admission.schemaVersion === 1 && digest(JSON.stringify(target)) === name,
      'h06-temporal-reader-admission',
    );
    const observed = await query(text(target.workflowId), undefined, 'readerStatus');
    if (observed === null) continue;
    requireContract(
      observed.schemaVersion === 1 && same(observed.target, target),
      'h06-temporal-reader-status',
    );
    if (
      observed.mode !== 'blocked' ||
      typeof observed.error !== 'string' ||
      observed.error.length === 0
    )
      continue;
    const readerRunId = identifier(observed.runId);
    const reader = await query(text(target.workflowId), readerRunId, 'readerInput');
    if (reader === null) continue;
    const readerInput = parseReaderInput(reader);
    requireContract(
      same(readerTarget(readerInput, text(target.workflowId)), target) &&
        digest(JSON.stringify(readerInput)) === admission.inputHash &&
        same(
          { ...readerInput.preparation, revision: initial.admission.preparation.revision },
          initial.admission.preparation,
        ),
      'h06-temporal-reader-binding',
    );
    if (
      !scopedReader(readerInput) ||
      readerInput.reviewId !==
        digest(
          JSON.stringify([planning.reviewId, readerInput.roleId, request.phase, request.scope]),
        )
    )
      continue;
    requireContract(
      same(readerInput.preparation, planning.preparation),
      'h06-temporal-reader-preparation',
    );
    const snapshot = parseReviewSnapshot(read(readerInput.review), readerInput);
    requireContract(
      snapshot.phase === request.phase &&
        snapshot.scope === request.scope &&
        same(
          snapshot.selection,
          request.roles.find((role) => role.roleId === readerInput.roleId),
        ),
      'h06-temporal-reader-review',
    );
    requireContract(
      same(controlRef(observed.permit), controlRef(admission.permit)),
      'h06-temporal-reader-status',
    );
    const confirmed = await query(text(target.workflowId), readerRunId, 'readerStatus');
    if (confirmed === null) return;
    requireContract(
      confirmed.schemaVersion === 1 &&
        confirmed.runId === readerRunId &&
        same(confirmed.target, target) &&
        same(controlRef(confirmed.permit), controlRef(admission.permit)),
      'h06-temporal-reader-status',
    );
    if (!same(confirmed, observed)) return;
    const current = await query(workflowId, runId, 'localTaskStatus');
    if (current === null) return;
    requireContract(current.runId === runId, 'h06-temporal-reader-task-run');
    if (
      current.phase !== 'planning' ||
      current.waiting !== false ||
      current.attempt !== status.attempt ||
      current.requirementsRevision !== status.requirementsRevision
    )
      return;
    const receipt = {
      kind: 'h06-native-reader-blocked',
      schemaVersion: 1,
      started,
      task: { workflowId, runId, attempt: status.attempt },
      reader: {
        target,
        runId: readerRunId,
        inputHash: admission.inputHash,
        permit: admission.permit,
      },
      error: observed.error,
      status: observed,
      observedAtUnixMs: Date.now(),
    };
    time();
    publishFile(
      join(evidence, `reader-failure-${status.attempt}-${name}.json`),
      Buffer.from(JSON.stringify(receipt)),
    );
    throw new Error(`h06-temporal-reader-blocked: ${observed.error}`, {
      cause: new Error(observed.error),
    });
  }
}

/** Abort and join the read-only observer on every result, failure and cancellation path. */
export async function withH06NativeReaderFailure<T>(
  client: Client,
  started: H04Pin,
  runId: string,
  workDeadlineMs: number,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const owned = new AbortController();
  const live = AbortSignal.any([signal, owned.signal]);
  const observer = (async () => {
    for (;;) {
      await assertH06NativeReaderNotBlocked(client, started, runId, workDeadlineMs, live);
      await wait(150, undefined, { signal: live });
    }
  })();
  try {
    return await Promise.race([client.connection.withAbortSignal(live, () => run(live)), observer]);
  } finally {
    owned.abort();
    await observer.catch(() => {});
  }
}
