import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { declareBackendFixture } from './backendPolicyFixture.js';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { ProcessEvidenceStore } from '../adapters/storage/processEvidenceStore.js';
import { enterStorageWorkspace, fixture, grant, signed } from './storageFixtures.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof childProcess>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) =>
    fsActual.readFileSync(...args),
  ),
}));
const fsActual = await vi.importActual<typeof fs>('node:fs');

it('refuses the direct live storage worker before reading a request or opening SQLite on an activated project', async () => {
  const root = fsActual.realpathSync(fsActual.mkdtempSync(join(tmpdir(), 'storage-backend-')));
  try {
    childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
    declareBackendFixture(root);
    fsActual.mkdirSync(join(root, '.git/agent-workflow'));
    fsActual.writeFileSync(
      join(root, '.git/agent-workflow/backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.resetModules();
    const reads = vi.mocked(fs.readFileSync).mockClear();
    await expect(import('../cli/storageWorker.js')).rejects.toThrow(
      'backend-consumer-not-qualified',
    );
    expect(reads.mock.calls.some(([path]) => path === 0)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    fsActual.rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each(['exit', 'malformed', 'error', 'stdin'] as const)(
  'keeps a lost mutation outcome unknown on %s',
  async (scenario) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const port = new ProcessEvidenceStore('/store', grant);
    const pending = port.execute(signed({ type: 'freeze' }, 1));
    if (scenario === 'malformed') {
      child.stdout.emit('data', Buffer.from('{bad'));
      child.emit('close', 0);
    }
    if (scenario === 'exit') child.emit('close', 1);
    if (scenario === 'error') child.emit('error', new Error('spawn failed'));
    if (scenario === 'stdin') child.stdin.emit('error', new Error('EPIPE'));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'unknown-outcome', operation_id: 'op-1' },
    });
  },
);

it('composes the worker using trusted launch context and returns only the serialized reply', async () => {
  const f = fixture();
  enterStorageWorkspace(f.parent);
  try {
    const input = {
      root: f.root,
      grant,
      request: { context: grant.context, command: { type: 'state' } },
    };
    vi.mocked(fs.readFileSync).mockImplementation(
      (path: fs.PathOrFileDescriptor, options: Parameters<typeof fs.readFileSync>[1]) =>
        path === 0 ? JSON.stringify(input) : fsActual.readFileSync(path, options),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await import('../cli/storageWorker.js');
    expect(output).toHaveBeenCalledWith(JSON.stringify(f.execute({ type: 'state' })));
  } finally {
    f.dispose();
  }
});

it('runs explicit maintenance in the worker and preserves unknown outcomes on process loss', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  });
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
  const pending = new ProcessEvidenceStore('/store', grant).administer(grant.context, {
    type: 'initialize',
  });
  child.emit('close', 1);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'unknown-outcome' } });
  const f = fixture();
  enterStorageWorkspace(f.parent);
  try {
    const input = {
      root: join(f.parent, 'created'),
      grant,
      request: { context: grant.context, command: { type: 'state' } },
      maintenance: { type: 'initialize' },
    };
    vi.mocked(fs.readFileSync).mockImplementation(
      (path: fs.PathOrFileDescriptor, options: Parameters<typeof fs.readFileSync>[1]) =>
        path === 0 ? JSON.stringify(input) : fsActual.readFileSync(path, options),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await import('../cli/storageWorker.js');
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, value: { status: 'initialized' } }),
    );
  } finally {
    f.dispose();
  }
});
