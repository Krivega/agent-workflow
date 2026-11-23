import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  archivePrefix,
  compactArchive,
  decodeArchivedJson,
  eventPayload,
  expandArchive,
  hasArchive,
  archiveHashes,
  readArchive,
} from '../adapters/storage/archiveJson.js';
import { encodeSharedJson } from '../adapters/storage/sharedJson.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { StoreFiles } from '../adapters/storage/storeFiles.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { ProcessEvidenceStore } from '../adapters/storage/processEvidenceStore.js';
import { exportStore, restoreStore } from '../adapters/storage/storeBackup.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { saveManaged, readManaged } from '../adapters/storage/managedChatFiles.js';
import {
  encodeChatArtifact,
  saveChatArtifact,
  readChatArtifact,
} from '../adapters/storage/sharedArtifacts.js';
import type { Council } from '../core/council.js';
import { createExecution, applyExecution } from '../core/execution.js';
import { validateCheckpoint } from '../adapters/storage/workflowValidation.js';
import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { enterStorageWorkspace, fixture, grant } from './storageFixtures.js';
import { workflowFixture, executionEvent, designReviewFixture } from './workflowFixtures.js';
import type { Json, TechnicalState, StoreRequest, Change, StoreCommand } from '../core/evidence.js';

function legacyCouncil(council: Council): Council {
  return {
    ...council,
    history: council.history.map((entry) => ({
      role: entry.role,
      session: entry.session,
      answer: structuredClone(council.advisers[entry.role]!.answer!),
    })),
  };
}
function memory() {
  const blobs = new Map<string, string>();
  const publish = (text: string) => {
    const hash = digest(text);
    blobs.set(hash, text);
    return hash;
  };
  const read = (hash: string) => {
    const text = blobs.get(hash);
    if (text === undefined) throw new Error('missing');
    return text;
  };
  return { blobs, publish, read };
}
it('separates exact historical bodies from the current view and publishes no old body on the next save', async () => {
  const f = await workflowFixture();
  try {
    const execution = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'proof', kind: 'check', applicable: true, reason: 'archive' }],
      false,
      'substantial',
    );
    f.target.inputs.discovery_rule = 'large shared manifest '.repeat(4000);
    execution.target = structuredClone(f.target);
    execution.planning = legacyCouncil(f.council('planning'));
    execution.planning.history[0]!.answer.design = designReviewFixture('planning', f.proof);
    const legacy = structuredClone(execution.planning.history[0]!);
    delete legacy.answer.binding;
    execution.planning.history.push(legacy);
    execution.history = [{ id: 'literal', payload: '\ufeff\ud800\udfff FAIL '.repeat(9000) }];
    const value = {
      execution,
      council: execution.planning,
      literals: [
        { id: 'literal', payload: '', archive: { hash: 'a'.repeat(64) } },
        ['ref', 'literal'],
        null,
        false,
        7,
      ],
    };
    const m = memory();
    const packed = compactArchive(value);
    expect(archiveHashes(value)).toEqual([]);
    expect(encodeChatArtifact(f.root, { literal: true })).toBe('{"literal":true}\n');
    for (const blob of packed.blobs) expect(m.publish(blob.content)).toBe(blob.hash);
    const text = archivePrefix + encodeSharedJson(packed.value, m.publish);
    expect(hasArchive(value)).toBe(false);
    expect(hasArchive(packed.value)).toBe(true);
    expect(decodeArchivedJson(text, m.read)).toEqual(value);
    const read = vi.fn(m.read);
    expect(decodeArchivedJson(text, read, false)).toEqual(packed.value);
    const current = packed.value as unknown as typeof value;
    expect(
      read.mock.calls.some(([hash]) => hash === current.execution.history[0]!.archive!.hash),
    ).toBe(false);
    expect(compactArchive(current).blobs).toEqual([]);
    validateCheckpoint({
      schema_version: 1,
      revision: 1,
      execution: current.execution,
      readings: {},
    });
    for (const payload of [
      JSON.stringify({ council: current.council, values: [null, false, 'text'] }),
      '"archive": broken',
      JSON.stringify({ archive: 'literal' }),
    ]) {
      const event = compactArchive({
        ...current.execution,
        history: [
          {
            id: 'new',
            payload,
            dependencies: current.council.history.map((entry) => entry.archive!.hash),
          },
        ],
      });
      for (const blob of event.blobs) m.publish(blob.content);
      expect(expandArchive(event.value, m.read)).toMatchObject({
        history: [{ id: 'new', payload }],
      });
    }
    expect(readManaged(join(f.root, 'missing'))).toBeNull();
    const path = join(f.root, 'managed.json');
    saveManaged(path, value, true, true);
    expect(readManaged(path)).toEqual(packed.value);
    expect(readManaged(path, { archive: true })).toEqual(value);
    const destination = join(f.root, 'portable');
    mkdirSync(destination);
    const source = vi.fn(m.read);
    const planning = {
      ...current.council,
      history: [...current.council.history, execution.planning.history[0]!],
    };
    const planned = applyExecution(
      current.execution,
      executionEvent(current.execution, { type: 'PLAN', council: planning }),
    );
    expect(planned.history.at(-1)!.dependencies).toHaveLength(2);
    const replanned = applyExecution(
      planned,
      executionEvent(planned, { type: 'REPLAN', target: f.target }),
    );
    replanned.history[0]!.archive!.hash = 'changed';
    replanned.history.at(-2)!.dependencies![0] = 'changed';
    expect(planned.history[0]!.archive!.hash).toBe(current.execution.history[0]!.archive!.hash);
    expect(planned.history.at(-1)!.dependencies![0]).not.toBe('changed');
    const linked = compactArchive({ ...current, execution: planned });
    for (const blob of linked.blobs) m.publish(blob.content);
    const portable = saveChatArtifact(destination, 'copied', linked.value, true, source);
    expect(readChatArtifact(portable)).toEqual(expandArchive(linked.value, m.read));
    expect(source).toHaveBeenCalled();
    source.mockClear();
    expect(saveChatArtifact(destination, 'copied', linked.value, true, source)).toEqual(portable);
    expect(source).not.toHaveBeenCalled();
    const missing = join(f.root, 'missing-source');
    mkdirSync(missing);
    expect(() => saveChatArtifact(missing, 'copy', current, true)).toThrow(
      'chat-archive-source-required',
    );
    expect(() => saveChatArtifact(missing, 'copy', current, true, () => 'damaged')).toThrow(
      'chat-artifact-conflict',
    );
    expect(decodeArchivedJson(JSON.stringify(value.literals), m.read)).toEqual(value.literals);
    const mixed = {
      ...current.execution,
      history: [...current.execution.history, { id: 'inline', payload: 'legacy' }],
    };
    expect(expandArchive(mixed, m.read)).toEqual({
      ...execution,
      history: [...execution.history, { id: 'inline', payload: 'legacy' }],
    });
    const wrong = structuredClone(current);
    wrong.council.history[0]!.answer.verdict = 'NOT RUN';
    expect(() => expandArchive(wrong, m.read)).toThrow('corrupt');
    saveManaged(join(f.root, 'literal.json'), {
      schema_version: 2,
      task_id: 'literal',
      reviewer_sessions: {},
      history: [null],
    });
    expect(readManaged(join(f.root, 'literal.json'), { archive: true })).toEqual({
      schema_version: 2,
      task_id: 'literal',
      reviewer_sessions: {},
      history: [null],
    });
  } finally {
    await f.dispose();
  }
});

it('rejects malformed references, damaged bodies, wrong kinds and invalid lossless event payloads', () => {
  const m = memory();
  expect(() => readArchive('../outside', m.read)).toThrow('corrupt');
  expect(() => readArchive('a'.repeat(64), () => '{}')).toThrow('corrupt');
  for (const value of [null, [], false, 2, { dependencies: 7 }]) {
    const hash = m.publish(JSON.stringify(value));
    expect(() => readArchive(hash, m.read)).toThrow('corrupt');
  }
  for (const body of [
    { kind: 'unknown', payload: 'text' },
    { kind: 'execution-event', payload: 2 },
    ...['not json', '123', 'null'].map((text) => ({
      kind: 'execution-event',
      payload: gzipSync(text).toString('base64'),
    })),
    { kind: 'execution-event', payload: 'damaged' },
    { kind: 'execution-event', payload: gzipSync(Buffer.from([255])).toString('base64') },
  ])
    expect(() => eventPayload(body)).toThrow('corrupt');
  const literal = { id: 'literal', payload: '', archive: { hash: 'invalid' } };
  expect(compactArchive(literal).value).toEqual(literal);
  expect(expandArchive(literal, m.read)).toEqual(literal);
});

it('keeps old archive blobs unread during new commits, replays one event, and backs up all historical roots', async () => {
  const f = await workflowFixture(),
    db = fixture();
  const requests: StoreRequest[] = [];
  try {
    db.claim();
    expect(
      db.mutate(
        { type: 'checkpoint', state: { local_run: f.executor as unknown as Json }, effects: [] },
        1,
      ).ok,
    ).toBe(true);
    const store = {
      execute: async (request: StoreRequest) => {
        requests.push(request);
        return db.store.execute(request);
      },
    };
    const journal = new TaskWorkflowJournal(store, grant.context, 1, false);
    const original = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'proof', kind: 'check', applicable: true, reason: 'archive' }],
      false,
      'substantial',
    );
    original.history = [{ id: 'FAIL-old', payload: 'FAIL \ud800'.repeat(9000) }];
    await beginExecution(original, journal);
    const event = executionEvent(original, {
      type: 'PLAN',
      council: legacyCouncil(f.council('planning')),
    });
    if (event.type !== 'PLAN') throw new Error('fixture event must be PLAN');
    const run = await advanceExecution(event, journal, f.inputs);
    const head = await journal.read();
    validateCheckpoint(head);
    expect(head.execution!.history.every((entry) => entry.archive && entry.payload === '')).toBe(
      true,
    );
    const roots = new Set(head.execution!.history.map((entry) => entry.archive!.hash));
    for (const entry of head.execution!.planning!.history) roots.add(entry.archive!.hash);
    const read = vi.spyOn(StoreFiles.prototype, 'readBlob');
    try {
      const next = {
        ...head,
        revision: head.revision + 1,
        execution: {
          ...head.execution!,
          history: [
            ...head.execution!.history,
            {
              id: 'linked-history',
              payload: JSON.stringify({ council: head.execution!.planning }),
              dependencies: head.execution!.planning!.history.map((entry) => entry.archive!.hash),
            },
          ],
        },
      };
      await journal.save(head, next, 'only-current-revision');
      expect(read.mock.calls.some(([hash]) => roots.has(hash))).toBe(false);
      const saved = await journal.read();
      await journal.save(saved, { ...saved, revision: saved.revision + 1 }, 'no-new-events');
      const commit = requests.at(-1)!;
      expect(commit.command).toMatchObject({ type: 'mutate', change: { blobs: [] } });
    } finally {
      read.mockRestore();
    }
    expect(await advanceExecution(event, journal, f.inputs)).toEqual(
      (await journal.read()).execution,
    );
    await expect(
      advanceExecution(
        { ...event, council: { ...event.council, phase: 'acceptance' } },
        journal,
        f.inputs,
      ),
    ).rejects.toThrow('execution-event-conflict');
    expect(() => applyExecution(run, event)).toThrow('execution-history-read-required');
    const missingReader = {
      ensureReady: journal.ensureReady.bind(journal),
      read: journal.read.bind(journal),
      save: journal.save.bind(journal),
    };
    await expect(advanceExecution(event, missingReader, f.inputs)).rejects.toThrow(
      'execution-history-reader-required',
    );
    const complete = await journal.read({ archive: true });
    await journal.save(
      { ...complete, revision: complete.revision - 1 },
      complete,
      'repeated-full-view',
    );
    expect(complete.execution!.history[0]).toEqual(original.history[0]);
    enterStorageWorkspace(db.parent);
    const ipc = new ProcessEvidenceStore(db.root, grant);
    const archive = await ipc.execute({
      context: grant.context,
      command: { type: 'archive', hash: run.history[0]!.archive!.hash },
    });
    expect(archive.ok).toBe(true);
    expect(
      archive.ok &&
        'value' in archive.value &&
        eventPayload(archive.value.value as Record<string, unknown>),
    ).toBe(original.history[0]!.payload);
    const state = db.execute({ type: 'state', archive: 'current' });
    expect(state.ok).toBe(true);
    const revision = (state as { ok: true; value: TechnicalState }).value.revision;
    expect(db.mutate({ type: 'freeze' }, revision).ok).toBe(true);
    const backup = join(db.parent, 'backup'),
      restored = join(db.parent, 'restored');
    await exportStore(db.root, backup, grant);
    restoreStore(backup, restored, grant);
    const reopened = new TaskWorkflowJournal(
      { execute: async (r) => new SqliteEvidenceStore(restored, grant, () => 100).execute(r) },
      grant.context,
      1,
      false,
    );
    expect(await reopened.read({ archive: true })).toEqual(complete);
    const root = run.history[0]!.archive!.hash;
    const before = readFileSync(join(restored, 'blobs', root));
    writeFileSync(join(restored, 'blobs', root), 'corrupt');
    expect(await reopened.read()).toEqual(await journal.read());
    await expect(reopened.readEvent(root)).rejects.toThrow('workflow-archive-unavailable');
    await expect(reopened.read({ archive: true })).rejects.toThrow('workflow-store-unavailable');
    await expect(exportStore(restored, join(db.parent, 'bad-backup'), grant)).rejects.toThrow();
    writeFileSync(join(restored, 'blobs', root), before);
    expect(readdirSync(join(backup, 'blobs'))).toContain(root);
  } finally {
    db.dispose();
    await f.dispose();
  }
});
it('rejects unknown archive protocols, invalid chunks, dangling roots and insufficient permissions atomically', () => {
  const db = fixture();
  try {
    db.claim();
    expect(
      db.execute({ type: 'state', archive: 'future' } as unknown as StoreCommand),
    ).toMatchObject({ ok: false, error: { code: 'invalid-context' } });
    const invalid = [
      { archive_version: 2 },
      { blobs: {} },
      { blobs: [null] },
      { blobs: [{ hash: 'a'.repeat(64), content: 'corrupt' }] },
    ];
    for (const fields of invalid)
      expect(
        db.mutate(
          { type: 'checkpoint', state: null, effects: [], ...fields } as unknown as Change,
          1,
        ).ok,
      ).toBe(false);
    const literal = {
      schema_version: 2,
      task_id: 'literal',
      reviewer_sessions: {},
      history: [{ id: 'literal', payload: '', archive: { hash: 'c'.repeat(64) } }],
    };
    expect(
      db.mutate({ type: 'checkpoint', state: literal, effects: [], archive_version: 1 }, 1).ok,
    ).toBe(false);
    expect(db.execute({ type: 'state' })).toMatchObject({
      ok: true,
      value: { revision: 1, checkpoint: null },
    });
    expect(db.mutate({ type: 'checkpoint', state: literal, effects: [] }, 1).ok).toBe(true);
    expect(db.execute({ type: 'state' })).toMatchObject({
      ok: true,
      value: { checkpoint: literal },
    });
    expect(
      new SqliteEvidenceStore(db.root, { ...grant, permissions: ['manage'] }, () => 100).execute({
        context: grant.context,
        command: { type: 'archive', hash: 'a'.repeat(64) },
      }),
    ).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  } finally {
    db.dispose();
  }
});
