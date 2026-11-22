import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';

function closeBudget(cleanupMs, label = 'SDK cleanup deadline exceeded') {
  let initial;
  try {
    initial = typeof cleanupMs === 'function' ? cleanupMs() : cleanupMs;
  } catch {
    initial = 0;
  }
  const deadline = performance.now() + Math.max(0, initial);
  return () => {
    const outer = typeof cleanupMs === 'function' ? cleanupMs() : Infinity,
      remaining = Math.floor(Math.min(deadline - performance.now(), outer));
    assert.ok(remaining > 0, label);
    return remaining;
  };
}
async function boundedClose(operation, remaining, label = 'SDK cleanup deadline exceeded') {
  const ms = remaining();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        remaining();
        return operation();
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
    remaining();
    return value;
  } finally {
    clearTimeout(timer);
  }
}
export function sdkAcquisitionProof(state) {
  return Object.fromEntries(
    Object.entries(state.acquisitions ?? {}).map(([name, item]) => [
      name,
      {
        status: item.status,
        deadlineWon: item.deadlineWon,
        lateCloseStatus: item.lateCloseStatus ?? null,
        error: item.error ?? null,
        lateCloseError: item.lateCloseError ?? null,
        observationError: item.observationError ?? null,
      },
    ]),
  );
}
export async function acquireSdkResource(
  state,
  name,
  operation,
  remaining,
  cleanupMs,
  onChange = () => {},
) {
  const ms = Math.floor(remaining());
  assert.ok(ms > 0, 'run budget exhausted before SDK acquisition');
  const deadline = performance.now() + ms,
    workRemaining = () => Math.min(remaining(), deadline - performance.now());
  state.unknown ??= {};
  state.acquisitions ??= {};
  assert.ok(!state[name] && !state.acquisitions[name], 'SDK resource already owned or pending');
  const prior = state[name],
    record = { status: 'pending', deadlineWon: false, handle: null };
  state.acquisitions[name] = record;
  function changed() {
    try {
      onChange();
    } catch (error) {
      record.observationError = String(error);
      state.unknown[name + 'AcquisitionObservation'] = String(error);
    }
  }
  function markDeadline() {
    record.deadlineWon = true;
    state.unknown[name + 'Acquisition'] = 'SDK acquisition deadline exceeded';
  }
  function retainLateHandle(handle) {
    markDeadline();
    record.handle = handle;
    record.status = 'late-result';
    if (record.lateClose) return;
    record.lateCloseStatus = 'pending';
    record.lateClose = boundedClose(
      () => {
        if (name === 'worker') {
          // A late INITIALIZED Worker must never be started merely to dispose it.
          handle.shutdown();
          throw new Error(
            'late Worker shutdown request is not confirmed termination; handle retained',
          );
        }
        return handle.close();
      },
      closeBudget(cleanupMs, 'late SDK close deadline exceeded'),
      'late SDK close deadline exceeded',
    ).then(
      () => {
        record.lateCloseStatus = 'closed';
        changed();
      },
      (error) => {
        record.lateCloseStatus = 'unknown';
        record.lateCloseError = String(error);
        state.unknown[name + 'LateClose'] = String(error);
        changed();
      },
    );
  }
  let timer;
  record.operation = Promise.resolve().then(() => {
    assert.ok(workRemaining() > 0, 'run budget exhausted before SDK acquisition');
    return operation();
  });
  record.observation = record.operation.then(
    (handle) => {
      record.handle = handle;
      if (record.deadlineWon || workRemaining() <= 0) retainLateHandle(handle);
      else record.status = 'acquired';
      changed();
      return handle;
    },
    (error) => {
      record.status = record.deadlineWon ? 'late-rejected' : 'rejected';
      record.error = String(error);
      if (record.deadlineWon) state.unknown[name + 'LateAcquisition'] = String(error);
      changed();
      throw error;
    },
  );
  record.observation.catch(() => {});
  changed();
  try {
    const handle = await Promise.race([
      record.observation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            markDeadline();
            record.status = record.handle === null ? 'unknown' : 'late-result';
            changed();
            reject(new Error('SDK acquisition deadline exceeded'));
          },
          Math.max(0, Math.floor(workRemaining())),
        );
      }),
    ]);
    if (record.deadlineWon || workRemaining() <= 0) {
      retainLateHandle(handle);
      throw new Error('SDK acquisition deadline exceeded');
    }
    state[name] = handle;
    delete state.acquisitions[name];
    changed();
    if (record.deadlineWon || workRemaining() <= 0) {
      state[name] = prior;
      state.acquisitions[name] = record;
      retainLateHandle(handle);
      throw new Error('SDK acquisition deadline exceeded');
    }
    return handle;
  } catch (error) {
    record.error ??= String(error);
    state.unknown[name + 'Acquisition'] ??= String(error);
    changed();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export function startOwnedSdkWorker(state, remaining) {
  assert.ok(state.worker && !state.workerRun, 'owned unstarted SDK Worker required');
  state.unknown ??= {};
  assert.ok(
    !state.unknown.worker && !state.unknown.workerAcquisition && !state.acquisitions?.worker,
    'SDK Worker ownership is unknown',
  );
  if (!(remaining() > 0)) {
    state.unknown.worker = 'Worker start deadline exceeded; INITIALIZED handle retained';
    throw new Error(state.unknown.worker);
  }
  try {
    state.workerRun = state.worker.run();
    return state.workerRun;
  } catch (error) {
    state.unknown.worker = String(error);
    throw error;
  }
}

export async function closeSdkResources(state, cleanupMs) {
  const errors = Object.keys(state.acquisitions ?? {}).map(
    (name) => name + ': SDK acquisition outcome remains unknown',
  );
  const remaining = closeBudget(cleanupMs);
  state.unknown ??= {};
  async function close(name, operation) {
    if (!state[name]) return;
    if (state.unknown[name]) {
      errors.push(name + ': previous cleanup outcome unknown');
      return;
    }
    try {
      await boundedClose(operation, remaining);
      state[name] = null;
      if (name === 'worker') state.workerRun = null;
    } catch (error) {
      state.unknown[name] = String(error);
      errors.push(name + ': ' + String(error));
    }
  }
  await close('worker', async () => {
    state.worker.shutdown();
    await state.workerRun;
  });
  await close('native', () => state.native.close());
  await close('connection', () => state.connection.close());
  return errors;
}
export async function closeSdkAndServer(state, cleanupMs, stopServer) {
  const closing = closeSdkResources(state, cleanupMs);
  let serverError;
  try {
    await stopServer();
  } catch (error) {
    serverError = error;
  }
  const errors = await closing;
  if (serverError) throw serverError;
  assert.equal(errors.length, 0, errors.join('\n'));
}
export function rootRemovalDecision(proof, state, proofSavedAndVerified) {
  const reasons = [];
  if (proof.status !== 'PASS') reasons.push('run is not PASS');
  if (!proof.recoverySet || proof.cleanup.immutableRecoverySetVerified !== true)
    reasons.push('complete recovery set is not verified');
  if (proof.cleanup.evidenceVerified !== true || !proofSavedAndVerified)
    reasons.push('complete exported evidence is not verified');
  if (
    ['child', 'activePg', 'worker', 'native', 'connection', 'workerRun'].some(
      (name) => state[name] != null,
    ) ||
    Object.keys(state.unknown ?? {}).length > 0 ||
    Object.keys(state.acquisitions ?? {}).length > 0
  )
    reasons.push('owned resource or unknown cleanup outcome remains');
  if (Object.keys(proof.cleanup).some((key) => /error|unknown/iu.test(key)))
    reasons.push('cleanup failure or unknown outcome recorded');
  if (
    !proof.serverStarts ||
    proof.cleanup.temporalStops?.length !== proof.serverStarts ||
    proof.cleanup.temporalStops.some(
      (stop) => stop.descendantsStopped !== true || stop.listenersStopped !== true,
    )
  )
    reasons.push('all Temporal stops are not confirmed');
  if (
    !proof.postgresStarts ||
    proof.cleanup.postgresStops?.length !== proof.postgresStarts ||
    proof.cleanup.postgresStops.some(
      (stop) =>
        stop.stop !== 0 ||
        stop.status !== 3 ||
        stop.descendantsStopped !== true ||
        stop.listenersStopped !== true,
    )
  )
    reasons.push('all PostgreSQL stops are not confirmed');
  return { allowed: reasons.length === 0, reasons };
}
