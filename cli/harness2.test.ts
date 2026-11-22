import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const bridge = vi.hoisted(() => vi.fn());
vi.mock('../adapters/codex/harness2Bridge.js', () => ({ harness2Bridge: bridge }));
const argv = [...process.argv];
afterEach(() => {
  process.argv = argv;
  vi.resetAllMocks();
});

it.each([undefined, 'request.json'])(
  'keeps the CLI on the refusal path with request %s',
  async (file) => {
    vi.resetModules();
    process.argv = file ? ['node', 'script', file] : ['node', 'script'];
    bridge.mockRejectedValue(new Error('h2-new-model-runs-disabled'));
    await expect(import('./harness2.js')).rejects.toThrow('h2-new-model-runs-disabled');
    expect(bridge).toHaveBeenCalledWith(file ?? '', expect.any(AbortSignal));
  },
);

it('rejects the installed entry before a native process or task write', () => {
  const root = mkdtempSync(join(tmpdir(), 'h2-entry-disabled-'));
  try {
    const binary = join(root, 'native-probe');
    writeFileSync(binary, '#!/bin/sh\necho launched > native-started\n', { mode: 0o700 });
    const request = join(root, 'request.json');
    writeFileSync(request, JSON.stringify({ root, output: root, binary }));
    const before = readdirSync(root).map((name) => [name, readFileSync(join(root, name), 'utf8')]);
    const result = spawnSync(process.execPath, [resolve('cli/harness2-entry.mjs'), request], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('h2-new-model-runs-disabled');
    expect(readdirSync(root).map((name) => [name, readFileSync(join(root, name), 'utf8')])).toEqual(
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
