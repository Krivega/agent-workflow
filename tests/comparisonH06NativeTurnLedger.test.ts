import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { canonical } from '../adapters/storage/storeCodec.js';
import { digest } from '../src/adapters/artifacts/files.js';
import { object } from '../src/contracts/project.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';

let fixture: string;
let directory: string;
const operationId = 'h06-qualification';
const operation = 'task-implement-' + 'a'.repeat(64) + '-a0';

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'h06-turn-ledger-')));
  directory = join(fixture, 'turn-ledger');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function ledger(mode: 'create' | 'reopen' = 'create', maxManagedStarts = 3, legacy?: true) {
  return openH06NativeTurnLedger(directory, {
    mode,
    operationId,
    maxManagedStarts,
    ...(legacy === true ? { legacy } : {}),
  });
}

function turn(role: 'writer' | 'reader' = 'writer', body = 'work') {
  const session = 'thread';
  return {
    role,
    root: fixture,
    journal: join(fixture, 'journal.jsonl'),
    session,
    params: {
      threadId: session,
      input: [
        {
          type: 'text',
          text: role === 'writer' ? `Workflow operation: ${operation}\n${body}` : body,
        },
      ],
    },
  };
}

function accepted(request = turn(), id = 'turn-1') {
  return { ...request, turnId: id, response: { turn: { id, status: 'inProgress', items: [] } } };
}

it('publishes a pre-dispatch receipt and accepts one native reply tied to its exact bytes', async () => {
  const host = ledger();
  const request = turn();
  const { params, ...scope } = request;
  expect(host.inspect()).toMatchObject({ status: 'RECORDED', used: 0, admissions: [] });
  await host.admitTurn(request);

  const pending = host.inspect();
  expect(pending).toMatchObject({
    status: 'UNKNOWN',
    used: 1,
    admissions: [
      {
        scope: {
          ...scope,
          operation,
          paramsHash: digest(canonical(params)),
        },
        response: null,
      },
    ],
  });
  const receipt = pending.admissions[0]!.pin;
  expect(JSON.parse(readH04Pin(receipt).toString())).toMatchObject({ index: 1, operationId });
  await host.recordTurn(accepted(request));

  const completed = ledger('reopen').inspect();
  expect(completed).toMatchObject({
    status: 'RECORDED',
    used: 1,
    admissions: [{ response: { turnId: 'turn-1' } }],
  });
  expect(JSON.parse(readH04Pin(completed.admissions[0]!.response!.pin).toString())).toMatchObject({
    admission: receipt,
    response: accepted().response,
    responseHash: digest(canonical(accepted().response)),
  });
  await expect(host.recordTurn(accepted(request))).rejects.toThrow('response-unbound');
});

it('blocks the same Writer operation across a different process, session, root and prompt', async () => {
  const host = ledger();
  await host.admitTurn(turn());
  await host.recordTurn(accepted());
  const other = ledger('reopen');
  const different = turn('writer', 'changed');
  different.session = 'new-thread';
  different.params.threadId = 'new-thread';
  different.journal = join(fixture, 'other.jsonl');
  different.root = join(fixture, 'other-copy');
  await expect(other.admitTurn(different)).rejects.toThrow('duplicate');
  expect(other.inspect().used).toBe(1);
});

it('shares a hard cap across reopen and refuses changed configuration or directory recreation', async () => {
  const first = ledger('create', 2);
  await first.admitTurn(turn());
  await first.recordTurn(accepted());
  const next = ledger('reopen', 2);
  const reader = turn('reader');
  await next.admitTurn(reader);
  await next.recordTurn(accepted(reader, 'turn-2'));
  await expect(ledger('reopen', 2).admitTurn(turn('reader', 'different'))).rejects.toThrow('cap');
  await expect(next.admitTurn(reader)).rejects.toThrow('duplicate');
  expect(() => ledger('reopen', 3)).toThrow('binding');
  expect(() => ledger('create', 2)).toThrow('EEXIST');
  expect(() => ledger('create', 0)).toThrow('cap');
  renameSync(directory, join(fixture, 'retained'));
  expect(() => ledger('reopen', 2)).toThrow('ENOENT');
  mkdirSync(directory);
  expect(() => first.inspect()).toThrow('root-changed');
});

it('keeps an unresolved dispatch fail-closed across hosts and binds the response to its caller', async () => {
  const first = ledger();
  const current = turn();
  await first.admitTurn(current);
  const next = ledger('reopen');
  await expect(next.admitTurn(turn('reader'))).rejects.toThrow('outcome-unknown');
  await expect(next.recordTurn(accepted(current))).rejects.toThrow('response-unbound');
  await expect(first.recordTurn(accepted(turn('writer', 'altered')))).rejects.toThrow(
    'response-unbound',
  );
  await expect(first.recordTurn({ ...accepted(current), turnId: 'mismatch' })).rejects.toThrow(
    'response-turn',
  );
  expect(next.inspect().status).toBe('UNKNOWN');
  await first.recordTurn(accepted(current));
  expect(next.inspect().status).toBe('RECORDED');
});

it('keeps at most one unresolved admission when separate hosts race for a start', async () => {
  const first = ledger();
  const next = ledger('reopen');
  const started = await Promise.allSettled([
    first.admitTurn(turn()),
    next.admitTurn(turn('reader')),
  ]);
  expect(started.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
  expect(first.inspect().used).toBe(1);
});

it('preserves Legacy delivery identity across ports and rejects an older usage snapshot', async () => {
  const first = ledger('create', 3, true);
  const delivery = (id: string, session = 'thread') => ({
    ...turn('reader'),
    role: 'legacy-writer' as const,
    session,
    params: {
      threadId: session,
      input: [{ type: 'text', text: `Workflow delivery id: ${JSON.stringify(id)}\n${session}` }],
    },
  });
  const load = delivery('coder:writer-warm:load');
  await first.admitTurn(load, 0);
  await first.recordTurn({ ...load, turnId: 'turn-1', response: accepted().response });
  expect(() => ledger('reopen')).toThrow('binding');
  const reopened = ledger('reopen', 3, true);
  await expect(reopened.admitTurn(turn())).rejects.toThrow('variant');
  expect(reopened.inspect().admissions[0]!.scope).toMatchObject({
    role: 'legacy-writer',
    operation: 'coder:writer-warm:load',
    paramsHash: digest(canonical(load.params)),
  });
  await expect(reopened.admitTurn(delivery('coder:writer-warm:load', 'other'), 1)).rejects.toThrow(
    'duplicate',
  );
  const implementation = delivery('coder:writer-warm:implementation');
  await expect(reopened.admitTurn(implementation, 0)).rejects.toThrow('admission-changed');
  await expect(reopened.admitTurn(delivery('coder:writer-warm:unexpected'), 1)).rejects.toThrow(
    'legacy-delivery',
  );
  await reopened.admitTurn(implementation, 1);
  expect(reopened.inspect().status).toBe('UNKNOWN');
});

it('rejects a native turn ID already observed on the same thread', async () => {
  const host = ledger();
  await host.admitTurn(turn());
  await host.recordTurn(accepted());
  const reader = turn('reader');
  await host.admitTurn(reader);
  await expect(host.recordTurn(accepted(reader))).rejects.toThrow('response-unbound');
  expect(host.inspect().status).toBe('UNKNOWN');
});

it('rejects out-of-scope input before reserving a turn', async () => {
  const host = ledger();
  const request = turn();
  await expect(host.admitTurn({ ...request, role: 'unknown' as 'reader' })).rejects.toThrow(
    'scope-role',
  );
  for (const root of ['relative', '/tmp/../tmp']) {
    await expect(host.admitTurn({ ...request, root })).rejects.toThrow('scope-path');
  }
  for (const params of [
    { threadId: 'different', input: [] },
    { threadId: request.session },
    { threadId: request.session, input: [] },
  ]) {
    await expect(host.admitTurn({ ...request, params })).rejects.toThrow('params');
  }
  for (const item of [
    { type: 'image', text: 'data' },
    { type: 'text', text: 1 },
  ]) {
    await expect(
      host.admitTurn({ ...request, params: { ...request.params, input: [item] } }),
    ).rejects.toThrow('message');
  }
  for (const text of [
    `prefix\nWorkflow operation: ${operation}\nwork`,
    'Workflow operation: invented\nwork',
  ]) {
    await expect(
      host.admitTurn({
        ...request,
        params: { ...request.params, input: [{ type: 'text', text }] },
      }),
    ).rejects.toThrow('writer-operation');
  }
  expect(host.inspect().used).toBe(0);
});

function replace(name: string, value: object) {
  writeFileSync(join(directory, name), canonical(value) + '\n');
}

it('detects reordered, altered, and unrecognized ledger records during readback', async () => {
  const host = ledger();
  await host.admitTurn(turn());
  const admissionFile = '1-admission.json';
  const receipt = host.inspect().admissions[0]!.pin;
  const original = object(JSON.parse(readH04Pin(receipt).toString()));
  const scope = object(original.scope);
  writeFileSync(receipt.path, JSON.stringify(original));
  expect(() => host.inspect()).toThrow('record-bytes');
  replace(admissionFile, { ...original, scope: { ...scope, operation: 'changed' } });
  expect(() => host.inspect()).toThrow('scope-role');
  replace(admissionFile, { ...original, scope: { ...scope, paramsHash: 'changed' } });
  expect(() => host.inspect()).toThrow('scope-digest');
  replace(admissionFile, { ...original, key: 'changed' });
  expect(() => host.inspect()).toThrow('admission');
  replace(admissionFile, original);

  replace('2-admission.json', original);
  expect(() => host.inspect()).toThrow('order');
  rmSync(join(directory, '2-admission.json'));
  replace('unrecognized.json', {});
  expect(() => host.inspect()).toThrow('unexpected-records');
  rmSync(join(directory, 'unrecognized.json'));

  await host.recordTurn(accepted());
  const response = host.inspect().admissions[0]!.response!.pin;
  const parsed = object(JSON.parse(readH04Pin(response).toString()));
  replace('1-response.json', { ...parsed, responseHash: 'changed' });
  expect(() => host.inspect()).toThrow('response');
});
