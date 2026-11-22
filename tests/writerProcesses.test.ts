import { execFile } from 'node:child_process';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFile(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  return { execFile };
});
const output = (text: string) =>
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: null, out: string, err: string) => void)(null, text, '');
    return {} as ReturnType<typeof execFile>;
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('tracks transitive descendants and refuses to signal a reused process identity', async () => {
  output('100 1 S start-a\n102 101 S start-c\n101 100 S start-b\n999 1 S foreign');
  const control = new NativeWriterProcesses();
  const identities = await control.descendants([100]);
  expect(identities.map((p) => p.pid)).toEqual([100, 102, 101]);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  output('100 1 S reused\n101 1 S start-b');
  expect(await control.alive(identities)).toEqual([{ pid: 101, parent: 100, started: 'start-b' }]);
  await expect(control.terminate(identities)).rejects.toThrow('writer-process-identity-lost');
  expect(kill).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const wait = control.wait(250);
  await vi.advanceTimersByTimeAsync(250);
  await wait;
});
it.each([
  { reason: 'missing', snapshot: '999 1 S foreign', observed: null },
  {
    reason: 'reused',
    snapshot: '100 7 S replacement\n999 1 S foreign',
    observed: { pid: 100, parent: 7, started: 'replacement' },
  },
])(
  'retains the public error and diagnoses a $reason identity without signalling',
  async (entry) => {
    output(entry.snapshot);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(
      new NativeWriterProcesses().terminate([{ pid: 100, parent: 1, started: 'original' }]),
    ).rejects.toMatchObject({
      message: 'writer-process-identity-lost',
      cause: {
        message: JSON.stringify({
          reason: entry.reason,
          expectedPID: 100,
          expectedStart: 'original',
          observed: entry.observed,
        }),
      },
    });
    expect(kill).not.toHaveBeenCalled();
  },
);
it('freezes and rescans a growing tree before killing it, including late transitive children', async () => {
  const control = new NativeWriterProcesses();
  vi.spyOn(control, 'wait').mockResolvedValue();
  output('100 1 S a\n999 1 S foreign');
  const initial = await control.descendants([100]);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 100 && signal === 'SIGSTOP')
      output('100 1 T a\n102 101 S c\n101 100 S b\n999 1 S foreign');
    if (pid === 101 && signal === 'SIGSTOP')
      output('100 1 T a\n102 101 T c\n101 100 T b\n999 1 S foreign');
    return true;
  });
  const stopped = await control.terminate(initial);
  expect(stopped.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
  const calls = kill.mock.calls.map(([pid, signal]) => [pid, signal]);
  expect(calls).toEqual([
    [100, 'SIGSTOP'],
    [102, 'SIGSTOP'],
    [101, 'SIGSTOP'],
    [100, 'SIGKILL'],
    [101, 'SIGKILL'],
    [102, 'SIGKILL'],
  ]);
});
it('fails closed and resumes only its own suspended processes when an identity vanishes', async () => {
  const control = new NativeWriterProcesses();
  vi.spyOn(control, 'wait').mockResolvedValue();
  output('100 1 S a\n101 100 S b\n999 1 S foreign');
  const initial = await control.descendants([100]);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 101 && signal === 'SIGSTOP') output('100 1 T a\n101 1 S reused\n999 1 S foreign');
    return true;
  });
  await expect(control.terminate(initial)).rejects.toThrow('writer-process-identity-lost');
  expect(kill.mock.calls).toEqual([
    [100, 'SIGSTOP'],
    [101, 'SIGSTOP'],
    [100, 'SIGCONT'],
  ]);
});
it('rejects denied or unconfirmed stops, preserving already stopped processes on failure', async () => {
  const control = new NativeWriterProcesses();
  vi.spyOn(control, 'wait').mockResolvedValue();
  output('100 1 T a\n101 100 S b\n999 1 S foreign');
  const initial = await control.descendants([100]);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  await expect(control.terminate(initial)).rejects.toThrow('denied');
  expect(kill.mock.calls).toEqual([[101, 'SIGSTOP']]);
  kill.mockImplementation(() => true);
  await expect(control.terminate(initial)).rejects.toThrow('writer-process-stop-unconfirmed');
  expect(kill).toHaveBeenLastCalledWith(101, 'SIGCONT');
  expect(kill).not.toHaveBeenCalledWith(100, 'SIGCONT');
  // ESRCH after a confirmed stop is harmless; an unconfirmed disappearance is rejected above.
  output('100 1 T a\n101 100 Z b\n999 1 S foreign');
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  expect(await control.terminate(initial)).toEqual(initial);
});
it('rejects unsafe PIDs and incomplete process observation', async () => {
  const control = new NativeWriterProcesses();
  for (const pid of [0, process.pid, NaN])
    await expect(control.descendants([pid])).rejects.toThrow('invalid-owned-process');
  output('broken');
  await expect(control.descendants([100])).rejects.toThrow('process-observation-invalid');
  for (const pid of [1, process.pid])
    await expect(control.terminate([{ pid, parent: 0, started: 'same' }])).rejects.toThrow(
      'invalid-owned-process',
    );
  output('100 1 S a\n' + process.pid + ' 100 S own');
  await expect(control.terminate([{ pid: 100, parent: 1, started: 'a' }])).rejects.toThrow(
    'invalid-owned-process',
  );
});
