import { saveChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rejectedSend } from '../adapters/codex/rejectedSend.js';

let directory: string, journal: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(resolve(tmpdir(), 'rejected-send-')));
  journal = resolve(directory, 'transport.jsonl');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function request(id = 1) {
  return {
    direction: 'send',
    data: {
      id,
      method: 'turn/start',
      params: {
        threadId: 'adviser',
        input: [{ type: 'text', text: 'Workflow delivery id: "delivery"\nrequest' }],
      },
    },
  };
}
function rejection(id = 1) {
  return {
    direction: 'recv',
    data: { id, error: { code: -32602, data: { input_error_code: 'input_too_large' } } },
  };
}
async function observe(records: unknown[]) {
  await writeFile(journal, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rejectedSend(journal, 'adviser', 'delivery');
}
it('correlates one explicit input-size rejection even when RPC IDs restart later', async () => {
  const sent = request(),
    failed = rejection();
  expect(
    await observe([
      { direction: 'stderr', data: 'diagnostic' },
      { direction: 'send', data: { method: 'initialized' } },
      sent,
      failed,
      { direction: 'recv', data: { method: 'turn/completed' } },
      { direction: 'send', data: { id: 1, method: 'initialize' } },
      { direction: 'recv', data: { id: 1, result: {} } },
    ]),
  ).toEqual({ journal, request: sent.data, response: failed.data });
});
it('keeps missing journals unknown and propagates other read errors', async () => {
  expect(await rejectedSend(journal, 'adviser', 'delivery')).toBeNull();
  await expect(rejectedSend(directory, 'adviser', 'delivery')).rejects.toThrow();
});
it.each([
  [],
  [request()],
  [rejection()],
  [request(), rejection(2)],
  [request(), rejection(), rejection()],
  [request(), rejection(), request(2), rejection(2)],
  [request(), { direction: 'recv', data: { id: 1, result: {} } }],
  [request(), { direction: 'recv', data: { id: 1 } }],
  [request(), { direction: 'recv', data: { id: 1, error: { code: -32600 } } }],
  [request(), { direction: 'recv', data: { id: 1, error: { code: -32602 } } }],
  [request(), { direction: 'recv', data: { id: 1, error: { code: -32602, data: {} } } }],
])(
  'does not retry an unknown, ambiguous, accepted or different failure: %j',
  async (...records: unknown[]) => {
    if (records.length === 0) {
      await writeFile(journal, 'malformed');
      await expect(rejectedSend(journal, 'adviser', 'delivery')).rejects.toThrow();
    } else expect(await observe(records)).toBeNull();
  },
);
it.each(['method', 'session', 'input', 'type', 'text', 'marker'])(
  'does not accept a rejection for a different %s',
  async (kind) => {
    const sent = request();
    if (kind === 'method') sent.data.method = 'thread/start';
    if (kind === 'session') sent.data.params.threadId = 'other';
    if (kind === 'input') Object.assign(sent.data.params, { input: null });
    if (kind === 'type') sent.data.params.input[0]!.type = 'image';
    if (kind === 'text') Object.assign(sent.data.params.input[0]!, { text: null });
    if (kind === 'marker') sent.data.params.input[0]!.text = 'foreign';
    expect(await observe([sent, rejection()])).toBeNull();
  },
);

it('recovers a rejected large send from the new hashed journal representation', async () => {
  const sent = request(),
    failed = rejection();
  sent.data.params.input[0]!.text += 'x'.repeat(70000);
  const data_ref = saveChatArtifact(directory, 'message', sent.data);
  expect(await observe([{ direction: 'send', data_ref }, failed])).toEqual({
    journal,
    request: sent.data,
    response: failed.data,
  });
  await expect(
    observe([{ direction: 'send', data_ref: { ...data_ref, hash: 'wrong' } }, failed]),
  ).rejects.toThrow('chat-artifact-conflict');
});
