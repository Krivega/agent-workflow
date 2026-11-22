import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AppServerRpc } from './appServerTransport.js';
import {
  harness2Bridge,
  harness2Request,
  modelCall,
  type Harness2Request,
} from './harness2Bridge.js';

const request: Harness2Request = {
  root: '/unused/project',
  output: '/unused/evidence',
  binary: '/unused/codex',
  mcpNames: ['test-server'],
  prompt: 'task',
  rules: 'read-only',
  instructionSources: [],
  model: 'gpt-6-astra',
  effort: 'high',
};

it('still validates historical request artifacts without launching a model', () => {
  expect(harness2Request.parse(request)).toEqual(request);
  expect(() => harness2Request.parse({ ...request, mcpNames: ['bad.name'] })).toThrow();
  expect(() => harness2Request.parse({ ...request, model: 'other' })).toThrow();
  expect(() => harness2Request.parse({ ...request, unexpected: true })).toThrow();
});

it.each([false, true])(
  'refuses direct model calls before any RPC, cancelled=%s',
  async (cancelled) => {
    const rpc = {
      request: vi.fn<AppServerRpc['request']>(),
      completed: vi.fn<AppServerRpc['completed']>(),
    };
    const controller = new AbortController();
    if (cancelled) controller.abort();
    await expect(modelCall(rpc, request, controller.signal)).rejects.toThrow(
      'h2-new-model-runs-disabled',
    );
    expect(rpc.request).not.toHaveBeenCalled();
    expect(rpc.completed).not.toHaveBeenCalled();
  },
);

it('refuses bridge requests before reading inputs or changing existing task artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h2-disabled-'));
  try {
    const file = join(root, 'request.json');
    const original = JSON.stringify({ ...request, root, output: root });
    writeFileSync(file, original);
    writeFileSync(join(root, 'FAIL.json'), '{"outcome":"unknown"}');
    const before = readdirSync(root).map((name) => [name, readFileSync(join(root, name), 'utf8')]);
    for (const input of [file, join(root, 'missing.json')]) {
      await expect(harness2Bridge(input, new AbortController().signal)).rejects.toThrow(
        'h2-new-model-runs-disabled',
      );
    }
    expect(readdirSync(root).map((name) => [name, readFileSync(join(root, name), 'utf8')])).toEqual(
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
