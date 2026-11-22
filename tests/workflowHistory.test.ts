import { gzipSync } from 'node:zlib';
import { createExecution } from '../core/execution.js';
import {
  decodeWorkflowHistory,
  encodeWorkflowHistory,
} from '../adapters/storage/workflowJournal.js';
import { workflowFixture } from './workflowFixtures.js';
it('preserves empty legacy checkpoints without inventing history', () => {
  const empty = { schema_version: 1 as const, revision: 0, execution: null, readings: {} };
  expect(decodeWorkflowHistory(encodeWorkflowHistory(empty))).toEqual(empty);
});

it('rewrites a verified cached v1 payload as lossless v2 instead of preserving the legacy encoding', async () => {
  const f = await workflowFixture();
  try {
    const execution = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'proof', kind: 'check', applicable: true, reason: 'storage roundtrip' }],
      false,
      'substantial',
    );
    const payload = 'legacy UTF8 ёж'.repeat(6000);
    execution.history = [
      {
        id: 'legacy',
        payload: 'agent-workflow:gzip-history:1:' + gzipSync(payload).toString('base64'),
      },
    ];
    const old = {
      schema_version: 1 as const,
      revision: 1,
      execution,
      readings: {},
      history_payload_encoding: 1,
    };
    const cache = new Map<string, string>();
    const decoded = decodeWorkflowHistory(old, cache);
    expect(decoded.execution!.history[0]!.payload).toBe(payload);
    const stored = encodeWorkflowHistory(decoded, cache);
    expect(stored.execution!.history[0]!.payload).toMatch(/^agent-workflow:gzip-history:2:/u);
    expect(decodeWorkflowHistory(stored)).toEqual(decoded);
  } finally {
    await f.dispose();
  }
});
