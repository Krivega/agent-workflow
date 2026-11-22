import {
  mkdtempSync,
  rmSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  TransportJournal,
  readDeliveryReceipt,
  deliveryReceiptPath,
  nativeCreationProof,
  diagnosticBytes,
  diagnosticRecords,
} from '../adapters/codex/transportJournal.js';
import { rejectedSend } from '../adapters/codex/rejectedSend.js';
import { saveManaged } from '../adapters/storage/managedChatFiles.js';
import { digest } from '../adapters/storage/storeCodec.js';
import * as codec from '../adapters/storage/storeCodec.js';
import { saveChatArtifact, readChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import * as managed from '../adapters/storage/managedChatFiles.js';
import * as files from '../adapters/storage/storeFiles.js';
let root: string, journal: string, transport: TransportJournal;
beforeEach(() => {
  root = realpathSync(mkdtempSync(resolve(tmpdir(), 'transport-retention-')));
  journal = resolve(root, 'rpc.jsonl');
  transport = new TransportJournal(journal);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function send(id = 1) {
  return {
    id,
    method: 'turn/start',
    params: {
      threadId: 'session',
      input: [
        { type: 'text', text: 'Workflow delivery id: "delivery"\n' + 'request '.repeat(10000) },
      ],
    },
  };
}
const rejection = { id: 1, error: { code: -32602, data: { input_error_code: 'input_too_large' } } };
const write = (direction: 'send' | 'recv' | 'stderr', value: unknown, target = transport) =>
  target.write(direction, value, JSON.stringify(value));
it('retains the first exact creation response and reports an absent primary receipt', () => {
  const operation = 'coder:first:create';
  expect(nativeCreationProof(journal, operation)).toBeNull();
  const created = new TransportJournal(journal, operation);
  const response = { id: 1, result: { thread: { id: 'session' } } };
  write('send', { id: 1, method: 'thread/start', params: {} }, created);
  write('recv', response, created);
  expect(nativeCreationProof(journal, operation)!.response).toEqual(response);
});
it('keeps only bounded metadata while legacy transcripts and their artifacts remain exact', () => {
  const legacy = saveChatArtifact(root, 'old-native-proof', { text: 'original '.repeat(10000) });
  const bytes = JSON.stringify({ direction: 'recv', data_ref: legacy }) + '\n';
  writeFileSync(journal, bytes);
  const files = readdirSync(root);
  const large = {
    id: 1,
    result: { thread: { turns: [{ text: 'large native history '.repeat(10000) }] } },
  };
  for (let i = 0; i < 300; i++) write('recv', large);
  write('stderr', 'я'.repeat(10000));
  const stored = readFileSync(journal + '.diagnostics.json');
  const parsed = JSON.parse(stored.toString()) as { records: unknown[] };
  expect(stored.length).toBeLessThanOrEqual(diagnosticBytes);
  expect(parsed.records.length).toBeLessThanOrEqual(diagnosticRecords);
  expect(stored.toString()).not.toContain('large native history');
  expect(readFileSync(journal, 'utf8')).toBe(bytes);
  expect(readChatArtifact(legacy)).toEqual({ text: 'original '.repeat(10000) });
  expect(readdirSync(root).filter((name) => !files.includes(name))).toEqual([
    'rpc.jsonl.diagnostics.json',
  ]);
  const resumed = new TransportJournal(journal);
  write('recv', null, resumed);
});
it('coalesces only identical durable diagnostics and rechecks replaced, missing or changed bytes', () => {
  const data = { id: 1, result: {} };
  const raw = JSON.stringify(data);
  const path = journal + '.diagnostics.json';
  saveManaged(
    path,
    {
      schema_version: 2,
      records: Array.from({ length: diagnosticRecords }, () => ({
        direction: 'recv',
        bytes: Buffer.byteLength(raw),
        hash: digest(raw),
        id: 1,
      })),
    },
    false,
  );
  const resumed = new TransportJournal(journal);
  write('recv', data, resumed);
  const save = vi.spyOn(managed, 'saveManaged');
  const read = vi.spyOn(files, 'readPrivateFile');
  const canonical = vi.spyOn(codec, 'canonical');
  write('recv', data, resumed);
  expect(canonical).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith(path);
  read.mockReturnValueOnce(Buffer.from('changed bytes'));
  write('recv', data, resumed);
  expect(save).toHaveBeenCalledTimes(1);
  writeFileSync(path, 'external replacement');
  write('recv', data, resumed);
  expect(save).toHaveBeenCalledTimes(2);
  unlinkSync(path);
  write('recv', data, resumed);
  expect(save).toHaveBeenCalledTimes(3);
});
it('persists every delivery attempt even when its diagnostic snapshot stays identical', () => {
  const data = send();
  const raw = JSON.stringify(data);
  saveManaged(
    journal + '.diagnostics.json',
    {
      schema_version: 2,
      records: Array.from({ length: diagnosticRecords }, () => ({
        direction: 'send',
        bytes: Buffer.byteLength(raw),
        hash: digest(raw),
        id: 1,
        method: 'turn/start',
      })),
    },
    false,
  );
  const resumed = new TransportJournal(journal);
  write('send', data, resumed);
  const save = vi.spyOn(managed, 'saveManaged');
  write('send', data, resumed);
  expect(readDeliveryReceipt(journal, 'session', 'delivery')!.attempts).toBe(2);
  expect(save.mock.calls.map(([path]) => path)).toEqual([
    deliveryReceiptPath(journal, 'session', 'delivery'),
  ]);
});
it('enforces the byte limit across restarts and rejects an invalid diagnostic format', () => {
  saveManaged(
    journal + '.diagnostics.json',
    { schema_version: 2, records: [{ preview: 'x'.repeat(diagnosticBytes - 100) }] },
    false,
  );
  const resumed = new TransportJournal(journal);
  resumed.write('stderr', 'я'.repeat(1000), 'я'.repeat(1000));
  expect(readFileSync(journal + '.diagnostics.json').length).toBeLessThanOrEqual(diagnosticBytes);
  for (const invalid of [
    { schema_version: 3, records: [] },
    { schema_version: 2, records: null },
    { schema_version: 2, records: Array.from({ length: 129 }, () => ({})) },
    { schema_version: 2, records: [{ large: 'x'.repeat(diagnosticBytes) }] },
  ]) {
    saveManaged(journal + '.diagnostics.json', invalid, false);
    expect(() => new TransportJournal(journal)).toThrow('transport-diagnostics-corrupt');
  }
});
it('recovers only a single observed rejection from short durable delivery receipts', async () => {
  write('send', send());
  write('recv', rejection);
  expect(await rejectedSend(journal, 'session', 'delivery')).toMatchObject({
    receipt: {
      outcome: 'rejected',
      attempts: 1,
      responses: 1,
      request_hash: digest(JSON.stringify(send())),
    },
  });
  const path = deliveryReceiptPath(journal, 'session', 'delivery');
  expect(readFileSync(path).length).toBeLessThan(1024);
  expect(readFileSync(path, 'utf8')).not.toContain('request request');
  write('recv', rejection);
  expect(await rejectedSend(journal, 'session', 'delivery')).toBeNull();
});
it('keeps repeated deliveries, cross-process responses and old/new collisions unknown', async () => {
  write('send', send());
  expect(await rejectedSend(journal, 'session', 'delivery')).toBeNull();
  const restarted = new TransportJournal(journal);
  write('send', send(), restarted);
  write('recv', rejection, restarted);
  expect(await rejectedSend(journal, 'session', 'delivery')).toBeNull();
  expect(readDeliveryReceipt(journal, 'session', 'delivery')!.attempts).toBe(2);
  unlinkSync(deliveryReceiptPath(journal, 'session', 'delivery'));
  write('send', send());
  write('recv', rejection);
  writeFileSync(journal, JSON.stringify({ direction: 'send', data: send() }) + '\n');
  expect(await rejectedSend(journal, 'session', 'delivery')).toBeNull();
  writeFileSync(journal, '');
  expect(await rejectedSend(journal, 'session', 'delivery')).not.toBeNull();
  write('send', send(), restarted);
  write('recv', rejection);
  expect(readDeliveryReceipt(journal, 'session', 'delivery')!.outcome).toBe('unknown');
});
it.each([
  { id: 1, result: {} },
  { id: 1 },
  { id: 1, error: null },
  { id: 1, error: { code: -1 } },
  { id: 1, error: { code: -32602, data: {} } },
  { id: 1, result: {}, error: { code: -32602, data: { input_error_code: 'input_too_large' } } },
])('keeps non-specific or contradictory responses unknown for retry: %j', async (response) => {
  write('send', send());
  write('recv', response);
  expect(await rejectedSend(journal, 'session', 'delivery')).toBeNull();
});
it('does not treat unrelated or malformed requests as delivery evidence', () => {
  for (const value of [
    null,
    [],
    { id: 'other' },
    { id: 1, method: 'read' },
    { id: 1, method: 'turn/start', params: null },
    { ...send(), params: { threadId: 1, input: [] } },
    { ...send(), params: { threadId: 'session', input: null } },
    { ...send(), params: { threadId: 'session', input: [] } },
    { ...send(), params: { threadId: 'session', input: [null] } },
    { ...send(), params: { threadId: 'session', input: [{ type: 'image' }] } },
    { ...send(), params: { threadId: 'session', input: [{ type: 'text', text: 3 }] } },
    { ...send(), params: { threadId: 'session', input: [{ type: 'text', text: 'foreign' }] } },
    {
      ...send(),
      params: {
        threadId: 'session',
        input: [{ type: 'text', text: 'Workflow delivery id: "\\x"\n' }],
      },
    },
  ])
    write('send', value);
  write('recv', { id: 1, result: {} });
  write('recv', { method: 'notification' });
  write('stderr', { id: 1 });
  expect(existsSync(journal + '.deliveries')).toBe(false);
});
it('fails closed when durable receipt data is missing or corrupted', () => {
  write('send', send());
  const path = deliveryReceiptPath(journal, 'session', 'delivery');
  const receipt = readDeliveryReceipt(journal, 'session', 'delivery')!;
  unlinkSync(path);
  expect(() => write('recv', rejection)).toThrow('delivery-receipt-missing');
  for (const patch of [
    { schema_version: 2 },
    { session: 'foreign' },
    { delivery: 'foreign' },
    { connection: null },
    { rpc_id: 1.5 },
    { request_hash: ['a'.repeat(64)] },
    { request_hash: 'bad' },
    { attempts: 0 },
    { attempts: 1.5 },
    { responses: -1 },
    { responses: 1.5 },
    { outcome: 'other' },
    { responses: 1 },
    { responses: 1, response_hash: 'bad' },
    { error_code: 'bad' },
    { input_error_code: 'foreign' },
  ]) {
    writeFileSync(path, JSON.stringify({ ...receipt, ...patch }));
    expect(() => write('send', send())).toThrow('delivery-receipt-corrupt');
  }
});

it.each([true, false])(
  'retains an exact prewritten creation response blob, matching=%s',
  (matching) => {
    const operation = 'coder:fixture:create';
    const target = new TransportJournal(journal, operation);
    write('recv', { id: 99, result: {} }, target);
    write('send', { id: 8, method: 'thread/start', params: {} }, target);
    const response = { id: 8, result: { thread: { id: 'original' } } };
    const raw = JSON.stringify(response);
    const blob = resolve(journal + '.creations', 'response-' + digest(raw) + '.json');
    writeFileSync(blob, matching ? raw : 'foreign', { mode: 0o600 });
    if (matching) {
      write('recv', response, target);
      expect(nativeCreationProof(journal, operation)!.response).toEqual(response);
    } else {
      expect(() => write('recv', response, target)).toThrow('creation-receipt-conflict');
      expect(nativeCreationProof(journal, operation)!.response).toBeNull();
      expect(readFileSync(blob, 'utf8')).toBe('foreign');
    }
  },
);
it('retains separate creation operations in an already existing private receipt directory', () => {
  const first = new TransportJournal(journal, 'first'),
    second = new TransportJournal(journal, 'second');
  write('send', { id: 1, method: 'thread/start', params: {} }, first);
  write('send', { id: 2, method: 'thread/start', params: {} }, second);
  expect(nativeCreationProof(journal, 'first')!.receipt.rpc_id).toBe(1);
  expect(nativeCreationProof(journal, 'second')!.receipt.rpc_id).toBe(2);
});
