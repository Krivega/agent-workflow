import { beforeEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture.js';
import { ControlledReaderWorkflow } from '../../src/workflows/controlledReader.js';
import { readerKey } from '../../src/policy/readerControl.js';
import type { ReaderCommand } from '../../src/contracts/readerControl.js';
import type { ReaderInput } from '../../src/contracts/reader.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  conditions: [] as { p: () => boolean; resolve: () => void }[],
  id: '',
  done: true,
  conditionFailure: null as Error | null,
  controls: {
    registerReader: vi.fn(),
    applyReaderCommand: vi.fn(),
    stopReader: vi.fn(),
    freezeReader: vi.fn(),
  },
  models: {
    prepareControlledReader: vi.fn(),
    createReader: vi.fn(),
    loadReader: vi.fn(),
    answerReader: vi.fn(),
  },
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type: string) => Object.assign(new Error(message), { type }),
  },
  defineUpdate: (name: string) => name,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (...args: unknown[]) => unknown) =>
    sdk.handlers.set(name, handler),
  workflowInfo: () => ({ workflowId: sdk.id, taskQueue: 'models' }),
  proxyActivities: (options: { taskQueue?: string }) =>
    options.taskQueue ? sdk.controls : sdk.models,
  allHandlersFinished: () => sdk.done,
  condition: (p: () => boolean) => {
    if (sdk.conditionFailure) {
      const error = sdk.conditionFailure;
      sdk.conditionFailure = null;
      return Promise.reject(error);
    }
    return p()
      ? Promise.resolve()
      : new Promise<void>((resolve) => sdk.conditions.push({ p, resolve }));
  },
  isCancellation: (e: Error) => e.message === 'cancelled',
  CancellationScope: class {
    reject: (e: Error) => void = () => {};
    run<T>(fn: () => Promise<T>) {
      return Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          this.reject = reject;
        }),
      ]);
    }
    cancel() {
      this.reject(new Error('cancelled'));
    }
    static nonCancellable<T>(fn: () => Promise<T>) {
      return fn();
    }
  },
}));
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 12; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const c of sdk.conditions.splice(0))
      if (c.p()) c.resolve();
      else sdk.conditions.push(c);
  }
}
function status() {
  return sdk.handlers.get('readerStatus')!() as {
    mode: string;
    revision: number;
    phase: string;
    error: string;
    session: string | null;
  };
}
async function command(c: unknown) {
  const p = Promise.resolve(sdk.handlers.get('readerControl')!(c));
  void p.catch(() => {});
  await flush();
  return p;
}
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
  sdk.conditions = [];
  sdk.done = true;
  sdk.conditionFailure = null;
});
function setup() {
  const f = controlFixture();
  sdk.id = readerKey(f.input);
  sdk.controls.registerReader.mockResolvedValue(f.permit);
  sdk.controls.applyReaderCommand.mockImplementation(
    async (_input: unknown, _permit: unknown, c: ReaderCommand) => ({
      commandId: c.commandId,
      hash: c.hash,
      revision: c.expectedRevision + 1,
      authorization: f.proof,
    }),
  );
  sdk.controls.stopReader.mockResolvedValue({ status: 'stopped', receipt: f.proof });
  sdk.controls.freezeReader.mockResolvedValue(1);
  sdk.models.prepareControlledReader.mockResolvedValue({ status: 'prepared', manifest: f.proof });
  sdk.models.createReader.mockResolvedValue({ id: 'session', creation: f.proof });
  sdk.models.loadReader.mockResolvedValue(f.proof);
  sdk.models.answerReader.mockResolvedValue(f.proof);
  return f;
}
describe('controlled reader Workflow', () => {
  it('requires an explicit new attempt and repeats LOAD after confirmed native compaction', async () => {
    const f = setup();
    sdk.models.answerReader.mockRejectedValueOnce(
      new Error('reader-context-compacted:' + 'a'.repeat(64)),
    );
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    expect(status().mode).toBe('blocked');
    await command(f.command());
    await flush();
    await expect(command(f.command('resume', 1, 0))).rejects.toThrow(
      'reader-reload-attempt-required',
    );
    await command(f.command('resume', 1, 1));
    await flush();
    expect((await run).status).toBe('answered');
    expect(sdk.models.loadReader).toHaveBeenCalledTimes(2);
    expect(sdk.models.answerReader).toHaveBeenCalledTimes(2);
  });
  it('rejects both concurrent copies of a denied command without failing a workflow task', async () => {
    const f = setup(),
      active = deferred<unknown>(),
      verification = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(active.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    sdk.controls.applyReaderCommand.mockReturnValueOnce(verification.promise);
    const handler = sdk.handlers.get('readerControl')!;
    const failures = Promise.all([
      Promise.resolve(handler(f.command())).catch((e: unknown) => e),
      Promise.resolve(handler(f.command())).catch((e: unknown) => e),
    ]);
    verification.reject(new Error('denied'));
    await flush();
    expect(await failures).toMatchObject([
      { type: 'ReaderCommandRejected' },
      { type: 'ReaderCommandRejected' },
    ]);
    expect(status().revision).toBe(0);
    await command(f.command('cancel'));
    await flush();
    await run;
  });
  it('recovers a lost authorization Activity response by retrying the same logical command', async () => {
    const f = setup(),
      active = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(active.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    sdk.controls.applyReaderCommand.mockImplementationOnce(
      async (input: ReaderInput, permit: ArtifactRef, c: ReaderCommand) => {
        await f.controls.applyReaderCommand(input, permit, c);
        throw new Error('response-lost');
      },
    );
    await expect(command(f.command())).rejects.toThrow('response-lost');
    expect(status().revision).toBe(0);
    sdk.controls.applyReaderCommand.mockImplementation(
      (input: ReaderInput, permit: ArtifactRef, c: ReaderCommand) =>
        f.controls.applyReaderCommand(input, permit, c),
    );
    expect(await command(f.command())).toMatchObject({ revision: 1 });
    await flush();
    expect(status().mode).toBe('paused');
    expect(f.authority.verify).toHaveBeenCalledTimes(1);
    await command(f.command('cancel', 1));
    await flush();
    await run;
  });
  it('rejects malformed input and a foreign workflow ID as application failures', async () => {
    const f = setup();
    await expect(ControlledReaderWorkflow({ ...f.input, roleId: 'foreign' })).rejects.toThrow(
      'reader-role-not-declared',
    );
    sdk.id = 'foreign';
    await expect(ControlledReaderWorkflow(f.input)).rejects.toThrow('reader-workflow-id-mismatch');
  });
  it('keeps a normal route and immutable input query deterministic', async () => {
    const f = setup();
    expect(await ControlledReaderWorkflow(f.input)).toEqual({
      status: 'answered',
      answer: f.proof,
    });
    expect(sdk.handlers.get('readerInput')!()).toEqual(f.input);
    expect(status()).toMatchObject({ mode: 'answered', phase: 'answering', session: 'session' });
    expect(sdk.models.loadReader).toHaveBeenCalledWith(
      f.input,
      { status: 'prepared', manifest: f.proof },
      { id: 'session', creation: f.proof },
      { permit: f.permit, revision: 0, attempt: 0 },
    );
    await expect(command(f.command('cancel'))).rejects.toThrow('reader-control-terminal');
  });
  it('separates accepted pause from physical stop, deduplicates commands and resumes an explicit attempt', async () => {
    const f = setup(),
      load = deferred<unknown>(),
      stop = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(load.promise);
    sdk.controls.stopReader.mockReturnValueOnce(stop.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    expect(status().phase).toBe('loading');
    const verification = deferred<unknown>();
    sdk.controls.applyReaderCommand.mockReturnValueOnce(verification.promise);
    const handler = sdk.handlers.get('readerControl')!,
      first = handler(f.command()),
      duplicate = handler(f.command());
    await expect(handler({ ...f.command(), hash: 'b'.repeat(64) })).rejects.toThrow(
      'reader-command-id-conflict',
    );
    verification.resolve({
      commandId: 'pause',
      hash: f.command().hash,
      revision: 1,
      authorization: f.proof,
    });
    await flush();
    expect(await first).toEqual(await duplicate);
    expect(sdk.controls.applyReaderCommand).toHaveBeenCalledTimes(1);
    expect(status().mode).toBe('pausing');
    await expect(command(f.command('resume', 1))).rejects.toThrow('reader-resume-not-stopped');
    stop.resolve({ status: 'stopped', receipt: f.proof });
    await flush();
    expect(status().mode).toBe('paused');
    expect(await command(f.command())).toEqual(await first);
    await expect(command({ ...f.command(), hash: 'b'.repeat(64) })).rejects.toThrow(
      'reader-command-id-conflict',
    );
    await expect(command(f.command('cancel', 0))).rejects.toThrow('reader-command-stale');
    await expect(command({ ...f.command('cancel', 1), author: 'foreign' })).rejects.toThrow(
      'reader-command-target-mismatch',
    );
    await command(f.command('resume', 1, 1));
    await flush();
    expect(await run).toEqual({ status: 'answered', answer: f.proof });
    expect(sdk.models.loadReader.mock.calls[1]![3]).toMatchObject({ revision: 2, attempt: 1 });
    load.resolve(f.proof);
  });
  it('discards a late completed phase while an authorized command is being verified', async () => {
    const f = setup(),
      load = deferred<unknown>(),
      verify = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(load.promise);
    sdk.controls.applyReaderCommand.mockReturnValueOnce(verify.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    const c = f.command('cancel'),
      pending = sdk.handlers.get('readerControl')!(c);
    load.resolve(f.proof);
    await flush();
    expect(sdk.models.answerReader).not.toHaveBeenCalled();
    verify.resolve({ commandId: c.commandId, hash: c.hash, revision: 1, authorization: f.proof });
    await pending;
    await flush();
    expect(await run).toEqual({ status: 'cancelled', stop: f.proof });
    expect(sdk.models.answerReader).not.toHaveBeenCalled();
  });
  it('waits for registration before control and never starts a model after early cancel', async () => {
    const f = setup(),
      registration = deferred<unknown>();
    sdk.controls.registerReader.mockReturnValueOnce(registration.promise);
    const run = ControlledReaderWorkflow(f.input);
    const c = command(f.command('cancel'));
    await flush();
    expect(sdk.controls.applyReaderCommand).not.toHaveBeenCalled();
    registration.resolve(f.permit);
    await flush();
    await c;
    expect((await run).status).toBe('cancelled');
    expect(sdk.models.createReader).not.toHaveBeenCalled();
  });
  it('does not turn stop failure into paused, and signal only reconciles primary state', async () => {
    const f = setup(),
      active = deferred<unknown>();
    sdk.models.createReader.mockReturnValueOnce(active.promise);
    sdk.controls.stopReader.mockRejectedValueOnce(
      new Error('Activity task failed', {
        cause: new Error('unknown'),
      }),
    );
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    await command(f.command('cancel'));
    await flush();
    expect(status()).toMatchObject({ mode: 'blocked', error: 'Error: unknown' });
    expect(sdk.models.createReader).toHaveBeenCalledTimes(1);
    sdk.handlers.get('readerReconcile')!();
    await flush();
    expect((await run).status).toBe('cancelled');
  });
  it('allows cancel to supersede an unknown pause and checks stop acknowledgements', async () => {
    const f = setup(),
      active = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(active.promise);
    sdk.controls.stopReader.mockResolvedValueOnce({ status: 'unknown' });
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    await command(f.command());
    await flush();
    expect(status().mode).toBe('blocked');
    await command(f.command('cancel', 1));
    await flush();
    expect((await run).status).toBe('cancelled');
  });
  it('keeps rejected authority and invalid acknowledgement from changing the revision', async () => {
    const f = setup(),
      active = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(active.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    sdk.controls.applyReaderCommand.mockRejectedValueOnce(new Error('denied'));
    await expect(command(f.command())).rejects.toThrow('denied');
    for (const bad of [
      { commandId: 'other', hash: f.command().hash, revision: 1 },
      { commandId: 'pause', hash: 'x', revision: 1 },
      { commandId: 'pause', hash: f.command().hash, revision: 2 },
    ]) {
      sdk.controls.applyReaderCommand.mockResolvedValueOnce(bad);
      await expect(command(f.command())).rejects.toThrow('reader-command-receipt-invalid');
    }
    expect(status().revision).toBe(0);
    await command(f.command('cancel'));
    await flush();
    await run;
  });
  it('blocks registration or model failure until explicit reconciliation', async () => {
    const f = setup();
    sdk.controls.registerReader.mockRejectedValueOnce('not registered');
    sdk.models.prepareControlledReader.mockRejectedValueOnce(new Error('missing input'));
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    expect(status()).toMatchObject({
      mode: 'blocked',
      phase: 'registering',
      error: 'not registered',
    });
    sdk.handlers.get('readerReconcile')!();
    await flush();
    expect(status()).toMatchObject({ mode: 'blocked', phase: 'preparing' });
    sdk.handlers.get('readerReconcile')!();
    await flush();
    expect((await run).status).toBe('answered');
  });
  it('keeps paused state on a reconciliation signal and waits for update handlers before completion', async () => {
    const f = setup(),
      active = deferred<unknown>();
    sdk.models.loadReader.mockReturnValueOnce(active.promise);
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    await command(f.command());
    await flush();
    sdk.handlers.get('readerReconcile')!();
    await flush();
    expect(status().mode).toBe('paused');
    sdk.done = false;
    await command(f.command('cancel', 1));
    await flush();
    expect(status().mode).toBe('cancelled');
    sdk.done = true;
    await flush();
    await run;
  });
  it('uses a noncancellable safety stop for raw SDK cancellation, retaining unknown until reconciliation', async () => {
    const f = setup();
    sdk.models.loadReader.mockRejectedValueOnce(new Error('cancelled'));
    sdk.controls.freezeReader.mockRejectedValueOnce(new Error('offline'));
    const run = ControlledReaderWorkflow(f.input);
    await flush();
    expect(status().mode).toBe('blocked');
    sdk.handlers.get('readerReconcile')!();
    await flush();
    expect((await run).status).toBe('cancelled');
    expect(sdk.controls.freezeReader).toHaveBeenCalledTimes(2);
  });
  it('registers during safety cancellation if no permit exists and preserves unrelated failures', async () => {
    const f = setup();
    sdk.controls.registerReader.mockRejectedValueOnce(new Error('missing'));
    sdk.conditionFailure = new Error('cancelled');
    expect((await ControlledReaderWorkflow(f.input)).status).toBe('cancelled');
    setup();
    sdk.conditionFailure = new Error('SDK broken');
    await expect(ControlledReaderWorkflow(f.input)).rejects.toThrow('SDK broken');
  });
});
