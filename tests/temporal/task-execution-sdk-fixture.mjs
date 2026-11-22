import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import process from 'node:process';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => assert.deepEqual(left, right);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve, released: false };
}

// Only the Activity ports are synthetic. Workflow scheduling and cancellation remain the SDK's.
export function sdkFixture(directory, id, options, api, context) {
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, 'artifacts'));
  execFileSync('git', ['init', '--quiet', '--template='], {
    cwd: directory,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    timeout: 5000,
  });
  const events = [],
    gates = new Map(),
    journal = new Map();
  const began = performance.now();
  const state = {
    id,
    active: new Set(),
    calls: [],
    returns: [],
    holds: [],
    writers: [],
    cancelled: new Set(),
    stopCalls: 0,
    stopConfirmed: false,
    revoked: false,
    resumeEntered: false,
    resumeCancelled: false,
    continuations: 0,
    done: null,
  };
  function event(kind, data = {}) {
    const item = {
      sequence: events.length + 1,
      elapsedMs: performance.now() - began,
      kind,
      ...data,
    };
    events.push(item);
    writeFileSync(join(directory, 'trace.json'), JSON.stringify(events, null, 2));
    return item;
  }
  function save(value) {
    const bytes = Buffer.from(JSON.stringify(value)),
      ref = { sha256: hash(bytes), bytes: bytes.length };
    writeFileSync(join(directory, 'artifacts', ref.sha256), bytes);
    return ref;
  }
  function read(ref) {
    const bytes = readFileSync(join(directory, 'artifacts', ref.sha256));
    assert.equal(hash(bytes), ref.sha256);
    assert.equal(bytes.length, ref.bytes);
    return JSON.parse(bytes.toString());
  }
  function gate(name) {
    if (!gates.has(name)) gates.set(name, deferred());
    return gates.get(name);
  }
  function release(name) {
    const value = gate(name);
    value.released = true;
    value.resolve();
    event('release', { name });
  }
  async function barrier(name) {
    const current = context(),
      signal = current.cancellationSignal;
    const cancelled = () => {
      state.cancelled.add(name);
      if (name === 'resume') state.resumeCancelled = true;
      event('sdk-cancellation-observed', { name });
    };
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    const heartbeat = () => {
      try {
        current.heartbeat({ fixture: id, barrier: name });
      } catch {
        /* Late completion intentionally ignores cancellation. */
      }
    };
    const timer = setInterval(heartbeat, 50);
    heartbeat();
    try {
      await gate(name).promise;
    } finally {
      clearInterval(timer);
      signal.removeEventListener('abort', cancelled);
    }
    return current;
  }
  const project = {
    schemaVersion: 1,
    projectId: id,
    workspaceId: 'sdk-copy',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['validate'],
  };
  const preparation = {
    schemaVersion: 1,
    project,
    taskId: 'one',
    hostId: 'sdk-fixture',
    owner: 'synthetic-human',
    generation: 1,
    revision: 1,
    card: 'tasks/one.md',
  };
  mkdirSync(join(directory, 'tasks'));
  writeFileSync(
    join(directory, 'RULES.md'),
    'Synthetic SDK fixture; no models or external writers.\n',
  );
  writeFileSync(
    join(directory, 'reviewer.md'),
    'Synthetic review Activity ports; no native role execution.\n',
  );
  writeFileSync(
    join(directory, preparation.card),
    '# Synthetic SDK task\nPreserve stop, held state, command identity and the original history across continuation.\n',
  );
  const registration = {
    project,
    hostId: preparation.hostId,
    owner: preparation.owner,
    generation: preparation.generation,
    workspaceRoot: realpathSync(directory),
  };
  const initial = api.parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation,
      plan: { path: 'plan.json', sha256: hash('synthetic-plan') },
      planning: save({ kind: 'synthetic-planning-input' }),
      acceptance: save({ kind: 'synthetic-acceptance-input' }),
    },
    executor: { path: 'executor.md', sha256: hash('synthetic-executor') },
    baseline: 'validate',
    continuation: { attempt: 0, previous: null },
  });
  writeFileSync(join(directory, 'input-schema11.json'), JSON.stringify(initial, null, 2));
  const attempt = (input) => api.parseLocalTask(input).continuation.attempt;
  function call(name, input) {
    const item = { name, attempt: attempt(input) };
    state.calls.push(item);
    event('activity-start', item);
    return item;
  }
  async function work(name, input, value) {
    const item = call(name, input),
      key = name + '-a' + item.attempt;
    state.active.add(key);
    try {
      if (item.attempt === 0 && options.stage === name) {
        event('late-result-published', { name, value: save(value) });
        await barrier('activity');
      }
      const returned = event('normal-activity-return', {
        ...item,
        sdkCancellationObserved: state.cancelled.has('activity'),
      });
      state.returns.push(returned);
      return value;
    } finally {
      state.active.delete(key);
    }
  }
  function review(input, phase) {
    return {
      schemaVersion: 1,
      preparation: input.admission.preparation,
      reviewId: phase + '-a' + attempt(input),
      request: save({ phase, synthetic: true }),
    };
  }
  function receipt(command, revision) {
    return {
      commandId: command.commandId,
      hash: command.hash,
      revision: revision + 1,
      authorization: save({ synthetic: true, command }),
    };
  }
  function retained(command) {
    const previous = journal.get(command.commandId);
    if (!previous) return null;
    same(previous.command, command);
    return previous.ack;
  }
  function retain(command, ack) {
    journal.set(command.commandId, { command, ack });
    writeFileSync(
      join(directory, 'synthetic-command-journal.json'),
      JSON.stringify([...journal.values()], null, 2),
    );
  }
  const activities = {
    prepareSubstantialPlanning: async (input) => {
      call('planning', input);
      return review(input, 'planning');
    },
    prepareReviewPlan: async () => ({ manifest: save({ synthetic: true }), decisions: [] }),
    finishReview: async () => ({ complete: true, manifest: save({ syntheticReview: true }) }),
    prepareLocalTask: async (input) => {
      call('prepare', input);
      return save({ syntheticSnapshot: true, input });
    },
    async checkLocalTask(input, _snapshot, stage) {
      return work(stage, input, {
        status: 'PASS',
        manifest: save({ syntheticCheck: true, stage, input }),
      });
    },
    async writeLocalTask(input) {
      state.writers.push(attempt(input));
      return work('writer', input, {
        session: id + '-a' + attempt(input),
        answer: save({ syntheticWriter: true }),
        stop: save({ syntheticWriterStop: true }),
        tree: save({ syntheticTree: true }),
      });
    },
    planLocalIntegration: async (input) => {
      call('plan-integration', input);
      assert.equal(state.revoked, false);
      return save({ syntheticIntent: true, input });
    },
    integrateLocalTask: async (input) => {
      call('integration', input);
      assert.equal(state.revoked, false);
      return save({ syntheticIntegration: true, input });
    },
    prepareLocalAcceptance: async (input) => {
      call('acceptance', input);
      return review(input, 'acceptance');
    },
    async finishLocalTask(input) {
      state.done = {
        status: 'done',
        result: save({ syntheticResult: true, input }),
        projection: save({ syntheticProjection: true }),
      };
      return work('finish', input, state.done);
    },
  };
  const controls = {
    prepareTaskExecution: async (input) => {
      call('admission', input);
      return save({ syntheticAdmission: true, input });
    },
    captureTaskExecutionBudget: async () => ({
      limit: 16,
      used: state.writers.length,
      manifest: save({ syntheticBudget: true, used: state.writers.length }),
    }),
    findTaskExecutionCommand: async (_input, command) => retained(command),
    async interruptTaskExecution(input, command, revision) {
      api.taskExecutionCommand(input, command, revision);
      const old = retained(command);
      if (old) return old;
      assert.equal(state.done, null, 'synthetic DONE already committed');
      api.taskInterruption(read(command.payload));
      state.revoked = true;
      const ack = receipt(command, revision);
      retain(command, ack);
      event('interruption-committed', { action: command.action, revision: ack.revision });
      if (options.loseResponse && !state.lostResponse) {
        state.lostResponse = true;
        throw new Error('synthetic lost Activity response after command receipt was retained');
      }
      return ack;
    },
    async stopLocalTask() {
      state.stopCalls++;
      event('physical-stop-port-entered', { synthetic: true });
      if (state.stopCalls === 1) await gate('stop').promise;
      state.stopConfirmed = true;
      const stopped = save({ syntheticStop: true, confirmed: true });
      state.stop = stopped;
      state.stopEvent = event('physical-stop-port-confirmed', { synthetic: true });
      return stopped;
    },
    async holdTaskExecution(input, progress, stopped) {
      same(stopped, state.stop);
      assert.equal(state.stopConfirmed, true);
      assert.equal(state.active.size, 0, 'held before actual Activity function drain');
      if (state.done) {
        event('synthetic-committed-DONE-retained', { stopSequence: state.stopEvent.sequence });
        return state.done;
      }
      const heldEvent = event('held-published', {
        attempt: attempt(input),
        phase: progress.phase,
        stopSequence: state.stopEvent.sequence,
      });
      state.holds.push(heldEvent);
      return { status: 'held', held: save({ syntheticHeld: true, input, progress, stopped }) };
    },
    async resumeTaskExecution(input, held, command, revision) {
      api.taskExecutionCommand(input, command, revision);
      const old = retained(command);
      if (old) return { input: state.next, ack: old };
      const payload = api.parseTaskExecutionResume(read(command.payload));
      same(payload.held, held);
      api.checkTaskExecutionResume(input, payload);
      if (options.pendingResume) {
        state.resumeEntered = true;
        event('resume-control-pending');
        const current = await barrier('resume');
        if (current.cancellationSignal.aborted) {
          event('resume-effect-denied-after-SDK-cancellation');
          await current.cancelled;
          throw new Error('cancelled Context must reject');
        }
      }
      state.revoked = false;
      state.continuations++;
      const ack = receipt(command, revision);
      state.next = api.parseLocalTask({
        ...input,
        admission: payload.admission,
        continuation: { attempt: command.attempt, previous: ack.authorization },
      });
      retain(command, ack);
      event('resume-committed', { attempt: command.attempt });
      return { input: state.next, ack };
    },
    saveTaskExecutionCheckpoint: async (checkpoint) => {
      event('actual-CAN-checkpoint-port', { syntheticStorage: true });
      return save(checkpoint);
    },
    loadTaskExecutionCheckpoint: async (input, ref) => {
      const checkpoint = read(ref);
      same(checkpoint.initial, input);
      event('actual-CAN-load-port', { syntheticStorage: true });
      return { ...checkpoint, stop: state.stop };
    },
  };
  function command(action, revision, input = initial, held = null, requirements = false) {
    const admission = requirements
      ? {
          ...input.admission,
          preparation: {
            ...input.admission.preparation,
            revision: input.admission.preparation.revision + 1,
          },
          plan: { ...input.admission.plan, sha256: hash('synthetic clarified requirements') },
          planning: save({ syntheticPlanning: 'clarified requirements' }),
          acceptance: save({ syntheticAcceptance: 'clarified requirements' }),
        }
      : input.admission;
    const payload =
      action === 'resume'
        ? { schemaVersion: 1, kind: 'task-execution-resume', held, admission }
        : {
            schemaVersion: 1,
            kind: 'task-interruption',
            reason: 'explicit synthetic SDK ' + action,
          };
    return api.makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId: action + '-' + revision,
      target: api.taskControlTarget(input),
      expectedRevision: revision,
      author: input.admission.preparation.owner,
      action,
      attempt: attempt(input) + (action === 'resume' ? 1 : 0),
      source: save({ syntheticHumanSource: true, payload }),
      payload: save(payload),
    });
  }
  return {
    initial,
    registration,
    state,
    events,
    activities,
    controls,
    command,
    release,
    save,
    releaseAll() {
      for (const name of gates.keys()) release(name);
      release('stop');
    },
    summary() {
      return {
        calls: state.calls,
        writers: state.writers,
        holds: state.holds,
        continuations: state.continuations,
        activeActivities: [...state.active],
        synthetic: true,
      };
    },
  };
}
