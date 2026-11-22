import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { briefChatResult, fullChatResult, chatFailureGuidance } from '../cli/chatOutput.js';
import { readChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { compactArchive } from '../adapters/storage/archiveJson.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { createExecution } from '../core/execution.js';
import type { InputRef } from '../core/localRun.js';
import { workflowFixture } from './workflowFixtures.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
it.each(['checks-chat', 'preflight-checks-chat'])(
  'keeps the %s packet reference and startup scope visible',
  (command) => {
    const result = { ready: true, scope: 'startup-only', plan: f.proof, proofs: [f.proof] };
    expect(briefChatResult(command, result, { evidence_root: f.root })).toEqual({
      command,
      ...result,
    });
  },
);
it('keeps failure verdicts and role blockers visible in brief output with the original check proof', () => {
  const request = { evidence_root: f.root };
  const check = {
    operation_id: 'failed-check',
    check: { verdict: 'FAIL', reason: 'observed failure' },
  };
  writeFileSync(resolve(f.root, 'failed-check.json'), JSON.stringify(check));
  const brief = briefChatResult('check-chat', check, request) as { details: InputRef };
  expect(brief).toMatchObject({ verdict: 'FAIL', reason: 'observed failure' });
  expect(readChatArtifact(brief.details)).toEqual(check);
  const council = f.council('acceptance');
  council.advisers = {};
  const roleOutput = briefChatResult('council-chat', council, request) as { blockers: string[] };
  expect(roleOutput.blockers).toContain('architect:NOT RUN');
  expect(briefChatResult('project-chat', f.executor, request)).toMatchObject({ completed: true });
  const status = {
    local: f.executor,
    execution: { status: 'not-started', blockers: ['execution-not-started'] },
    control: null,
    ownership: {},
    resume_required: true,
    coordination: null,
  };
  expect(briefChatResult('status-chat', status, request)).toMatchObject({
    control: null,
    blockers: ['execution-not-started'],
  });
  expect(
    briefChatResult(
      'status-chat',
      { ...status, coordination: { status: 'paused', revision: 2, history: ['large'] } },
      request,
    ),
  ).toMatchObject({ coordination: { status: 'paused', revision: 2 } });
  const message = briefChatResult('project-chat', f.executor, {
    ...request,
    message: { id: 'message-result' },
  }) as { details: InputRef };
  expect(readChatArtifact(message.details)).toMatchObject({ operation: 'message-result' });
});
it('stores only short operation receipts for Store-backed commands instead of growing full diagnostic snapshots', () => {
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'check', kind: 'check', applicable: true, reason: 'check' }],
    false,
    'substantial',
  );
  const payload = 'large old historical body '.repeat(100000);
  run.history = [{ id: 'old', payload }];
  for (let i = 0; i < 20; i++) {
    run.revision = i;
    const result = briefChatResult('execution-chat', run, {
      evidence_root: f.root,
      operation: 'op-' + i,
    }) as { details: InputRef };
    const bytes = readFileSync(result.details.locator);
    expect(bytes.length).toBeLessThan(2048);
    expect(readChatArtifact(result.details)).toMatchObject({
      schema_version: 2,
      purpose: 'operation-result',
      operation: 'op-' + i,
      state: null,
      outcome: { command: 'execution-chat', status: 'planning' },
    });
  }
  const files = readdirSync(f.root).filter((name) => name.startsWith('receipt-execution-chat-'));
  expect(files).toHaveLength(20);
  expect(files.reduce((n, name) => n + readFileSync(resolve(f.root, name)).length, 0)).toBeLessThan(
    20000,
  );
  expect(run.history[0]!.payload).toBe(payload);
});
it('links to the exact original check proof, including reuse, without producing another snapshot', () => {
  const proof = {
    operation_id: 'check-one',
    check: { verdict: 'PASS', reason: 'observed' },
    raw: 'original '.repeat(10000),
  };
  const path = resolve(f.root, 'check-one.json');
  writeFileSync(path, JSON.stringify(proof));
  const original = readFileSync(path);
  const result = briefChatResult(
    'check-chat',
    { ...proof, reused_from: f.proof },
    { evidence_root: f.root },
  );
  expect(result).toMatchObject({
    reused_from: f.proof,
    details: { locator: path, hash: digest(original) },
  });
  expect(readFileSync(path)).toEqual(original);
  expect(readdirSync(f.root).some((name) => name.startsWith('result-check-chat'))).toBe(false);
});
it('preserves standalone Council continuation and explicitly expands legacy history without creating a diagnostic export', () => {
  const council = f.council('planning');
  const answer = council.advisers.architect!.answer!;
  council.history = [{ role: 'architect', session: 'session', answer }];
  const packed = compactArchive(council);
  const pool = resolve(f.root, 'shared-json');
  mkdirSync(pool);
  for (const blob of packed.blobs) writeFileSync(resolve(pool, blob.hash), blob.content);
  const request = { evidence_root: f.root };
  const files = readdirSync(f.root);
  expect(fullChatResult(packed.value, request)).toEqual(council);
  expect(readdirSync(f.root)).toEqual(files);
  const result = briefChatResult('council-chat', council, request) as { details: InputRef };
  expect(readChatArtifact(result.details)).toMatchObject({
    phase: 'planning',
    advisers: council.advisers,
  });
  const root = (packed.value as unknown as typeof council).history[0]!.archive!.hash;
  writeFileSync(resolve(pool, root), 'corrupted');
  expect(() => fullChatResult(packed.value, request)).toThrow('chat-artifact-conflict');
  const content = 'AWJSON1\n["ref","../escape"]',
    hash = digest(content);
  writeFileSync(resolve(pool, hash), content);
  const bad = {
    ...council,
    history: [{ role: 'architect', session: 'session', answer, archive: { hash } }],
  };
  expect(() => fullChatResult(bad, request)).toThrow('chat-artifact-conflict');
});

it('shows the next safe action for refusal, uncertainty and a completed task', () => {
  expect(chatFailureGuidance('invalid-task-chat-option', 'request.json')).toMatchObject({
    status: 'refused',
    reason: 'invalid-task-chat-option',
    details: { locator: 'request.json' },
  });
  const unknown = chatFailureGuidance('app-server-timeout', 'request.json');
  expect(unknown.status).toBe('unknown');
  expect(unknown.next_action).toContain('не запускать повтор');
  const output = briefChatResult(
    'project-chat',
    { status: 'completed' },
    { evidence_root: f.root },
  );
  expect(output).toMatchObject({
    reason: null,
    next_action: 'Дополнительное действие не требуется.',
  });
  expect(
    briefChatResult('control-chat', { control: { status: 'paused' } }, { evidence_root: f.root }),
  ).toMatchObject({ next_action: 'Ожидать явного продолжения.' });
  expect(
    briefChatResult('control-chat', { control: { status: 'stopping' } }, { evidence_root: f.root }),
  ).toMatchObject({ next_action: 'Подтвердить остановку принадлежащих задаче исполнителей.' });
});

it('preserves unknown native audit outcomes and keeps unsafe protocol failures uncertain', () => {
  expect(chatFailureGuidance('invalid-app-server-message', 'request.json').status).toBe('unknown');
  const output = briefChatResult(
    'observe-audit-chat',
    { outcome: 'unknown' },
    { evidence_root: f.root },
  );
  expect(output).toMatchObject({
    outcome: 'unknown',
    reason: 'audit-attempt-outcome-unknown',
  });
  expect(
    briefChatResult(
      'observe-audit-chat',
      { outcome: 'not-started', session: null },
      { evidence_root: f.root },
    ),
  ).toMatchObject({ outcome: 'not-started', reason: null });
});

it('reports paused control and a NOT RUN check before suggesting further work', async () => {
  const request = { evidence_root: f.root };
  const status = {
    local: f.executor,
    execution: { status: 'implementing', blockers: [] },
    control: { status: 'paused' },
    ownership: {},
    resume_required: true,
    coordination: null,
  };
  expect(briefChatResult('status-chat', status, request)).toMatchObject({
    reason: 'paused',
    next_action: 'Ожидать явного продолжения.',
  });
  expect(briefChatResult('status-chat', { ...status, control: null }, request)).toMatchObject({
    reason: null,
  });
  expect(briefChatResult('project-chat', {}, request)).toMatchObject({ status: null });
  expect(
    briefChatResult(
      'status-chat',
      {
        ...status,
        control: null,
        execution: { status: 'review', blockers: ['Проверены отказ и unknown:not-passed'] },
      },
      request,
    ),
  ).toMatchObject({ next_action: 'Устранить условие: Проверены отказ и unknown:not-passed' });
  const proof = {
    operation_id: 'not-run',
    check: { verdict: 'NOT RUN', reason: 'outcome unknown' },
  };
  await f.file('not-run.json', JSON.stringify(proof));
  const output = briefChatResult('check-chat', proof, request);
  expect(output).toMatchObject({ verdict: 'NOT RUN', reason: 'outcome unknown' });
  expect(JSON.stringify(output)).toContain('не запускать повтор');
});

it('keeps checkpoint identity, revised requirements and the last result visible in a short status', () => {
  const checkpoint = { locator: 'store#state', revision: 31, generation: 2 };
  const result = { summary: 'Observed result', evidence: [f.proof], limitations: ['bounded'] };
  const status = {
    local: f.executor,
    execution: { status: 'implementing', blockers: ['check:FAIL'], result },
    control: null,
    messages: { requirements_revision: 4 },
    checkpoint,
    pending_operations: [{ id: 'original', outcome: 'unknown' }],
    ownership: {},
    resume_required: false,
    coordination: null,
  };
  expect(briefChatResult('status-chat', status, { evidence_root: f.root })).toMatchObject({
    checkpoint,
    requirements_revision: 4,
    last_result: result,
    pending_operations: status.pending_operations,
    blockers: ['check:FAIL'],
  });
});
