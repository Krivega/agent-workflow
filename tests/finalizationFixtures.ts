import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { workflowFixture } from './workflowFixtures.js';
import { body, fixture, grant, signed } from './storageFixtures.js';
import { FinalizationArchive } from '../adapters/storage/finalizationArchive.js';
import { ControllerFinalizationJournal } from '../adapters/storage/finalizationJournal.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import type {
  FinalizationLog,
  FinalizationSeed,
  FinalizationAction,
} from '../core/finalization.js';
import { replayFinalization } from '../core/finalization.js';
import { advanceFinalization, beginFinalization } from '../application/finalizationWorkflow.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import type { Json } from '../core/evidence.js';

export async function finalizationFixture() {
  const f = await workflowFixture(),
    db = fixture();
  db.claim();
  db.mutate({ type: 'write', id: 'original-fail', body }, 1);
  const result = {
    summary: 'fixture accepted result',
    evidence: ['original-fail'],
    limitations: ['fixture'],
  };
  const checkpoint = {
    local_run: f.executor,
    workflow: { schema_version: 1, execution: { schema_version: 2, status: 'done', result } },
    unknown: 'preserve',
  };
  db.mutate({ type: 'checkpoint', state: checkpoint as unknown as Json, effects: [] }, 2);
  await f.file('done.json', JSON.stringify({ kind: 'done', result }));
  await f.file(
    'stopped.json',
    JSON.stringify({
      kind: 'producers-stopped',
      project_id: 'project',
      task_id: 'task',
      complete: true,
      remaining: 0,
    }),
  );
  const paths = {
    source: db.root,
    archive: resolve(db.parent, 'archive'),
    restored: resolve(db.parent, 'restored'),
    receipts: resolve(db.parent, 'receipts'),
  };
  mkdirSync(paths.receipts, { mode: 0o700 });
  const authority = {
    kind: 'test-cleanup-authority',
    disposable: true,
    source: db.root,
    operator: 'tester',
    policy_version: 'disposable/1',
    grace_ms: 10,
  };
  await f.file('cleanup-authority.json', JSON.stringify(authority));
  const seed: FinalizationSeed = {
    schema_version: 1,
    id: 'finalize',
    run: f.executor,
    authority: f.proof,
    done: await f.ref('done.json'),
    stopped: await f.ref('stopped.json'),
    significant: [{ id: 'original-fail', revision: 1 }],
    policy: {
      mode: 'test-cleanup',
      version: 'disposable/1',
      operator: 'tester',
      authority: await f.ref('cleanup-authority.json'),
      grace_ms: 10,
    },
  };
  let clock = 100;
  const archive = new FinalizationArchive(f.root, db.parent, paths, grant, () => clock);
  const inputs = new FileWorkflowInputs(f.root, db.parent);
  const context = { ...grant.context, task_id: 'controller', run_id: 'controller' };
  const controllerRoot = resolve(db.parent, 'controller');
  initializeStore(controllerRoot, context);
  const controllerDb = new SqliteEvidenceStore(controllerRoot, { ...grant, context }, () => clock);
  controllerDb.execute(
    signed({ type: 'claim', lease_until: 1000 }, 0, 0, 'claim', { ...grant, context }),
  );
  const store = {
    execute: async (r: Parameters<SqliteEvidenceStore['execute']>[0]) => controllerDb.execute(r),
  };
  const journal = new ControllerFinalizationJournal(store, context, 1);
  const current = async () => replayFinalization((await journal.read())!);
  const send = async (action: FinalizationAction) => {
    const s = await current();
    return advanceFinalization(
      { ...action, id: 'step-' + s.revision, revision: s.revision },
      journal,
      archive,
    );
  };
  const start = async () => {
    await beginFinalization(seed, journal, archive);
    const manifest = await archive.freeze(seed);
    await send({ type: 'CATALOG', manifest });
    return manifest;
  };
  const restored = async () => {
    const manifest = await start();
    await send({ type: 'EXPORT', ...(await archive.export(manifest)) });
    await send({ type: 'RESTORE', ...(await archive.restore(manifest)) });
    return manifest;
  };
  const archived = async () => {
    const manifest = await restored();
    await send({
      type: 'ARCHIVE',
      authority: f.proof,
      ...(await archive.archive(seed, await current(), f.proof)),
    });
    return manifest;
  };
  const reserved = async () => {
    const manifest = await archived();
    clock = 110;
    await send({
      type: 'RESERVE_CLEANUP',
      operator: 'tester',
      now: 110,
      authority: await f.ref('cleanup-authority.json'),
    });
    return manifest;
  };
  return {
    ...f,
    db,
    paths,
    seed,
    archive,
    inputs,
    journal,
    current,
    send,
    start,
    restored,
    archived,
    reserved,
    context,
    store,
    controllerDb,
    checkpoint,
    authority,
    setClock: (n: number) => {
      clock = n;
    },
    log: async () => (await journal.read()) as FinalizationLog,
    dispose: async () => {
      db.dispose();
      await f.dispose();
    },
  };
}
