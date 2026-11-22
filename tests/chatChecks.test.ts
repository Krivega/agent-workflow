import * as fs from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  runChatCheck,
  validateChatCheck,
  verifyChatCheck,
} from '../adapters/project/chatChecks.js';
import type { ChatCheckRequest } from '../adapters/project/chatChecks.js';
import { localFixture } from './localFixtures.js';
const faults = vi.hoisted(() => ({ intentRace: false, intentCode: 'EEXIST' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.intentRace && String(args[0]).endsWith('.intent.json')) {
        faults.intentRace = false;
        throw Object.assign(new Error('raced intent'), { code: faults.intentCode });
      }
      return actual.writeFile(...args);
    }),
    unlink: vi.fn(actual.unlink),
  };
});
let f: Awaited<ReturnType<typeof localFixture>>;
let external: string;
beforeEach(async () => {
  f = await localFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'chat-check-'));
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
});
function request(
  id = 'probe',
  script = "console.log('out');console.error('err')",
): ChatCheckRequest {
  return {
    id,
    command: { file: process.execPath, args: ['-e', script] },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'scope-owner',
  };
}
it('captures a real process, full output, unchanged inputs and stable receipt without rerunning the effect', async () => {
  const r = request();
  const proof = await runChatCheck(f.root, external, r);
  expect(proof).toMatchObject({
    exit_code: 0,
    signal: null,
    check: { id: 'probe', verdict: 'PASS' },
  });
  expect(proof.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(await runChatCheck(f.root, external, r)).toEqual(proof);
  await expect(
    runChatCheck(f.root, external, { ...r, command: { ...r.command, args: ['-v'] } }),
  ).rejects.toThrow('chat-check-conflict');
  await writeFile(proof.check.evidence.locator, 'tampered');
  await expect(runChatCheck(f.root, external, r)).rejects.toThrow('workflow-input-changed');
});
it('retains a real FAIL and invalidates exit zero if an input changed or disappeared during validation', async () => {
  expect(
    (await runChatCheck(f.root, external, request('fail', 'process.exitCode=1'))).check.verdict,
  ).toBe('FAIL');
  const changed = await runChatCheck(
    f.root,
    external,
    request('changed', "require('fs').writeFileSync('source.txt','changed')"),
  );
  expect(changed).toMatchObject({ exit_code: 0, check: { verdict: 'NOT RUN' } });
  const removed = await runChatCheck(
    f.root,
    external,
    request('removed', "require('fs').unlinkSync('source.txt')"),
  );
  expect(removed.after.complete).toBe(false);
  expect(removed.check.verdict).toBe('NOT RUN');
});
it('does not replay an unknown effect, an invalid ID, or a failed process start', async () => {
  await writeFile(resolve(external, 'probe.intent.json'), '{}');
  await expect(runChatCheck(f.root, external, request())).rejects.toThrow(
    'chat-check-outcome-unknown',
  );
  await rm(resolve(external, 'probe.intent.json'));
  await expect(runChatCheck(f.root, external, request('../escape'))).rejects.toThrow(
    'chat-check-id-invalid',
  );
  await expect(
    runChatCheck(f.root, external, {
      ...request('missing'),
      command: { file: '/missing-executable', args: [] },
    }),
  ).rejects.toThrow('ENOENT');
  await expect(
    runChatCheck(f.root, external, {
      ...request('missing'),
      command: { file: '/missing-executable', args: [] },
    }),
  ).rejects.toThrow('chat-check-outcome-unknown');
});

it('runs the canonical project validate and rejects a mislabeled or noncanonical command', async () => {
  for (const command of [
    { file: process.execPath, args: ['-v'] },
    { file: 'yarn', args: [] },
    { file: 'yarn', args: ['other'] },
  ])
    await expect(
      runChatCheck(f.root, external, { ...request('validate'), command }),
    ).rejects.toThrow('chat-validate-command-required');
  expect(
    (
      await runChatCheck(f.root, external, {
        ...request('validate'),
        command: { file: 'yarn', args: ['validate'] },
      })
    ).check.verdict,
  ).toBe('PASS');
});
it('executes the registered validation argv and rejects another command for the same check', async () => {
  const command = { file: 'npm', args: ['run', 'validate'] };
  const allowed = [command];
  const task = { ...request('validate'), command };
  expect(() => validateChatCheck(task)).toThrow('chat-validate-command-required');
  expect((await runChatCheck(f.root, external, task, undefined, allowed)).check.verdict).toBe(
    'PASS',
  );
  await expect(
    runChatCheck(
      f.root,
      external,
      { ...task, command: { ...command, args: ['run', 'other'] } },
      undefined,
      allowed,
    ),
  ).rejects.toThrow('chat-validate-command-required');
});
it('preserves a real intent write failure without starting the command', async () => {
  vi.mocked(fs.writeFile).mockRejectedValueOnce(
    Object.assign(new Error('disk failure'), { code: 'EIO' }),
  );
  await expect(runChatCheck(f.root, external, request())).rejects.toThrow('disk failure');
});

it('corrects the same gate with a new operation while retaining the original FAIL proof', async () => {
  const first = await runChatCheck(f.root, external, {
    ...request('round1', 'process.exitCode=1'),
    criterion: 'probe',
  });
  const second = await runChatCheck(f.root, external, { ...request('round2'), criterion: 'probe' });
  expect(first.check.id).toBe(second.check.id);
  expect(first.check.verdict).toBe('FAIL');
  expect(second.check.verdict).toBe('PASS');
  expect(await verifyChatCheck(f.root, external, first.check)).toEqual(first);
  expect(await verifyChatCheck(f.root, external, second.check)).toEqual(second);
  await expect(
    verifyChatCheck(f.root, external, {
      ...second.check,
      evidence: { ...second.check.evidence, locator: '/other.log' },
    }),
  ).rejects.toThrow('chat-check-evidence-outside-root');
  await expect(
    runChatCheck(f.root, external, { ...request(), criterion: '../bad' }),
  ).rejects.toThrow('chat-check-criterion-invalid');
});

it('blocks a new operation ID for an unknown gate and serializes overlapping processes', async () => {
  const old = { ...request('round1'), criterion: 'probe' };
  await writeFile(resolve(external, 'round1.intent.json'), JSON.stringify({ request: old }));
  await expect(
    runChatCheck(f.root, external, { ...request('round2'), criterion: 'probe' }),
  ).rejects.toThrow('chat-check-outcome-unknown');
  await rm(resolve(external, 'round1.intent.json'));
  await writeFile(resolve(external, 'probe.check.lock'), JSON.stringify({ operation: 'round1' }));
  await expect(
    runChatCheck(f.root, external, { ...request('round2'), criterion: 'probe' }),
  ).rejects.toThrow('chat-check-outcome-unknown');
});

it('retains unknown locks on an intent race and recovers a known receipt before clearing only its own lock', async () => {
  faults.intentRace = true;
  await expect(runChatCheck(f.root, external, request('raced'))).rejects.toThrow(
    'chat-check-outcome-unknown',
  );
  await rm(resolve(external, 'raced.check.lock'));
  vi.mocked(fs.unlink).mockRejectedValueOnce(
    Object.assign(new Error('unlink failure'), { code: 'EIO' }),
  );
  await expect(runChatCheck(f.root, external, request())).rejects.toThrow('unlink failure');
  expect((await runChatCheck(f.root, external, request())).check.verdict).toBe('PASS');
  await writeFile(resolve(external, 'probe.check.lock'), JSON.stringify({ operation: 'other' }));
  expect((await runChatCheck(f.root, external, request())).check.verdict).toBe('PASS');
});

it('preserves an intent I/O failure after reserving the gate without launching a process', async () => {
  faults.intentRace = true;
  faults.intentCode = 'EIO';
  await expect(runChatCheck(f.root, external, request('intent-io'))).rejects.toThrow(
    'raced intent',
  );
  faults.intentCode = 'EEXIST';
});

it('reuses only a verified PASS with identical inputs, command and runtime without a second process', async () => {
  const initial = request('original');
  initial.criterion = 'probe';
  const proof = await runChatCheck(f.root, external, initial);
  const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
  const files = new FileWorkflowInputs(f.root, external);
  const reuse = await files.ref(resolve(external, 'original.json'));
  const next = { ...initial, id: 'next', reuse };
  const reused = await runChatCheck(f.root, external, next);
  expect(reused).toEqual({ ...proof, reused_from: reuse });
  await expect(fs.stat(resolve(external, 'next.intent.json'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
  await f.file('source.txt', 'changed');
  expect((await runChatCheck(f.root, external, next)).operation_id).toBe('next');
  expect(
    (
      await runChatCheck(f.root, external, {
        ...next,
        id: 'command',
        command: { file: process.execPath, args: ['-v'] },
      })
    ).operation_id,
  ).toBe('command');
  await expect(
    runChatCheck(f.root, external, { ...next, id: 'corrupt', reuse: { ...reuse, hash: 'wrong' } }),
  ).rejects.toThrow('workflow-input-changed');
});

it('invalidates reuse when the environment changes and resolves commands without PATH conservatively', async () => {
  const initial = request('probe');
  const proof = await runChatCheck(f.root, external, initial);
  const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
  const { reusableChatCheck } = await import('../adapters/project/chatChecks.js');
  const files = new FileWorkflowInputs(f.root, external);
  const reuse = await files.ref(resolve(external, 'probe.json'));
  expect(
    await reusableChatCheck(f.root, external, { ...initial, reuse }, proof.before),
  ).toMatchObject({ reused_from: reuse });
  vi.stubEnv('AGENT_CHECK_ENV_TEST', 'changed');
  try {
    expect(
      await reusableChatCheck(f.root, external, { ...initial, reuse }, proof.before),
    ).toBeNull();
    vi.stubEnv('PATH', undefined);
    expect(
      await reusableChatCheck(
        f.root,
        external,
        { ...initial, reuse, command: { file: 'missing-binary', args: [] } },
        proof.before,
      ),
    ).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('does not reuse a PASS over a reserved criterion with an unknown outcome', async () => {
  const initial = { ...request('original'), criterion: 'probe' };
  await runChatCheck(f.root, external, initial);
  const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
  const reuse = await new FileWorkflowInputs(f.root, external).ref(
    resolve(external, 'original.json'),
  );
  const lock = resolve(external, 'probe.check.lock');
  await writeFile(lock, JSON.stringify({ operation: 'interrupted-before-intent' }));
  await expect(runChatCheck(f.root, external, { ...initial, id: 'reuse', reuse })).rejects.toThrow(
    'chat-check-outcome-unknown',
  );
  expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toEqual({
    operation: 'interrupted-before-intent',
  });
});

it.each(['bin', ''])(
  'invalidates reuse after replacing the actual executable in relative PATH %j',
  async (path) => {
    const executable = resolve(f.root, path, 'aw-check-tool');
    await fs.mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    vi.stubEnv('PATH', path);
    try {
      const initial = {
        ...request('original'),
        criterion: 'probe',
        command: { file: 'aw-check-tool', args: [] },
      };
      expect((await runChatCheck(f.root, external, initial)).check.verdict).toBe('PASS');
      const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
      const reuse = await new FileWorkflowInputs(f.root, external).ref(
        resolve(external, 'original.json'),
      );
      await writeFile(executable, '#!/bin/sh\nexit 1\n');
      expect(
        await runChatCheck(f.root, external, { ...initial, id: 'changed', reuse }),
      ).toMatchObject({ operation_id: 'changed', check: { verdict: 'FAIL' } });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('does not reuse evidence across working directories or a dependency changed while reading the proof', async () => {
  const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
  const { reusableChatCheck } = await import('../adapters/project/chatChecks.js');
  const initial = request();
  const proof = await runChatCheck(f.root, external, initial);
  const inputs = new FileWorkflowInputs(f.root, external);
  const reuse = await inputs.ref(resolve(external, 'probe.json'));
  const secondRoot = resolve(f.root, 'other-root');
  await fs.mkdir(secondRoot);
  await writeFile(resolve(secondRoot, 'source.txt'), 'source revision 1');
  expect(
    await reusableChatCheck(secondRoot, external, { ...initial, reuse }, proof.before),
  ).toBeNull();
  await f.file('source.txt', 'changed after manifest capture');
  expect(await reusableChatCheck(f.root, external, { ...initial, reuse }, proof.before)).toBeNull();
});

it.each(['PATH', 'symlink'])(
  'invalidates reuse when %s selects identical bytes at another path',
  async (selection) => {
    const first = resolve(f.root, 'bin1/aw-check-tool');
    const second = resolve(f.root, 'bin2/aw-check-tool');
    const link = resolve(f.root, 'aw-check-tool');
    for (const file of [first, second]) {
      await fs.mkdir(dirname(file));
      await writeFile(
        file,
        `#!${process.execPath}\nprocess.exit(__filename.includes('/bin1/') ? 1 : 0);\n`,
        { mode: 0o700 },
      );
    }
    if (selection === 'PATH') await fs.chmod(first, 0o600);
    else await fs.symlink(second, link);
    vi.stubEnv('PATH', 'bin1:bin2');
    try {
      const initial = {
        ...request('original'),
        criterion: 'probe',
        command: { file: selection === 'PATH' ? 'aw-check-tool' : link, args: [] },
        discovery: {
          files: ['source.txt', 'bin1/aw-check-tool', 'bin2/aw-check-tool'],
          directories: [],
        },
      };
      expect((await runChatCheck(f.root, external, initial)).check.verdict).toBe('PASS');
      const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
      const reuse = await new FileWorkflowInputs(f.root, external).ref(
        resolve(external, 'original.json'),
      );
      if (selection === 'PATH') await fs.chmod(first, 0o700);
      else {
        await fs.unlink(link);
        await fs.symlink(first, link);
      }
      expect(
        await runChatCheck(f.root, external, { ...initial, id: 'changed-path', reuse }),
      ).toMatchObject({
        operation_id: 'changed-path',
        check: { verdict: 'FAIL' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('treats an executable that can run but cannot be fingerprinted as unknown', async () => {
  const file = resolve(f.root, 'execute-only');
  await fs.copyFile('/usr/bin/true', file);
  await fs.chmod(file, 0o100);
  const initial = { ...request(), command: { file, args: [] } };
  const proof = await runChatCheck(f.root, external, initial);
  expect(proof).toMatchObject({ runtime_hash: null, exit_code: 0, check: { verdict: 'NOT RUN' } });
  const { FileWorkflowInputs } = await import('../adapters/project/workflowInputs.js');
  const reuse = await new FileWorkflowInputs(f.root, external).ref(resolve(external, 'probe.json'));
  expect(
    await runChatCheck(f.root, external, { ...initial, id: 'unknown-repeat', reuse }),
  ).toMatchObject({ operation_id: 'unknown-repeat', check: { verdict: 'NOT RUN' } });
  const forged = { ...proof, check: { ...proof.check, verdict: 'PASS' as const } };
  await writeFile(resolve(external, 'probe.json'), JSON.stringify(forged));
  await expect(verifyChatCheck(f.root, external, forged.check)).rejects.toThrow(
    'chat-check-proof-mismatch',
  );
});

it('skips directories in PATH and fingerprints the fallback executable used by spawn', async () => {
  await fs.mkdir(resolve(f.root, 'bin1/aw-check-tool'), { recursive: true });
  await fs.mkdir(resolve(f.root, 'bin2'));
  await writeFile(resolve(f.root, 'bin2/aw-check-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  vi.stubEnv('PATH', 'bin1:bin2');
  try {
    expect(
      (
        await runChatCheck(f.root, external, {
          ...request(),
          command: { file: 'aw-check-tool', args: [] },
        })
      ).check.verdict,
    ).toBe('PASS');
  } finally {
    vi.unstubAllEnvs();
  }
});
