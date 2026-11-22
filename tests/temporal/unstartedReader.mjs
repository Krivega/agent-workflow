import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactStore } from '../../dist/adapters/artifacts/files.js';
import { readerBoundary } from '../../dist/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../dist/policy/readerExecution.js';
import { preparationActivities } from '../../dist/activities/preparation.js';
import { readerActivities } from '../../dist/activities/reader.js';
import { readerControlActivities } from '../../dist/activities/readerControl.js';
import { readerKey } from '../../dist/policy/readerControl.js';
import { NativeWriterProcesses } from '../../dist/adapters/codex/writerProcesses.js';

assert.equal(process.argv.length, 2);
assert.equal(
  execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  'codex-cli 0.154.0',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = realpathSync(mkdtempSync(join(root, 'tmp/temporal-unstarted-reader-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-unstarted-reader-')));
const store = artifactStore(join(evidence, 'artifacts'));
const record = (name, value) =>
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(value), { mode: 0o600 });
mkdirSync(join(workspace, 'tasks'));
for (const path of ['RULES.md', 'reviewer.md', 'tasks/one.md'])
  writeFileSync(
    join(workspace, path),
    'Create-only native stop qualification. No model turn is authorized.',
  );
const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
const project = {
  schemaVersion: 1,
  projectId: 'neutral-unstarted',
  workspaceId: 'fixture',
  rules: ['RULES.md'],
  cardRoot: 'tasks',
  roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
  checks: ['syntax'],
};
const preparation = {
  schemaVersion: 1,
  project,
  taskId: 'one',
  hostId: 'local',
  owner: 'qualification',
  generation: 1,
  revision: 1,
  card: 'tasks/one.md',
};
const input = { preparation, roleId: 'reviewer' };
const registration = {
  project,
  hostId: 'local',
  owner: 'qualification',
  generation: 1,
  workspaceRoot: workspace,
  artifactRoot: join(evidence, 'artifacts'),
  commands: { syntax: { executable: process.execPath, args: ['--check'] } },
};
const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
const port = new StdioAppServer(
  'codex',
  [
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.multi_agent=false',
    'app-server',
    '--stdio',
  ],
  workspace,
  join(evidence, 'rpc.jsonl'),
);
let attemptedTurns = 0,
  confirmed = false;
const rpc = {
  async request(method, params) {
    if (method === 'turn/start') {
      attemptedTurns++;
      throw new Error('No model turn is authorized in create-only qualification');
    }
    return port.request(method, params);
  },
  async completed() {
    throw new Error('No model turn can require completion');
  },
};
const processes = new NativeWriterProcesses();
try {
  await port.initialize();
  const boundary = readerBoundary(
    join(evidence, 'permissions'),
    store,
    workspace,
    readerExecution(profile),
  );
  const controls = readerControlActivities(registration, rpc, boundary, {
    async verify() {
      throw new Error('No human commands in create-only qualification');
    },
  });
  const permit = await controls.registerReader(input, readerKey(input));
  const epoch = { permit, revision: 0, attempt: 0 };
  const prepared = await preparationActivities(registration).prepareProject(preparation);
  const models = readerActivities(
    registration,
    rpc,
    profile,
    join(evidence, 'effects'),
    boundary.boundary,
  );
  const session = await models.createReader(input, prepared, epoch);
  const revision = await controls.freezeReader(input, permit);
  const stopped = await controls.stopReader(input, permit, revision);
  const receipt = JSON.parse(store.read(stopped.receipt).toString());
  assert.equal(receipt.confirmed, true);
  const observations = receipt.observations.map((ref) => JSON.parse(store.read(ref).toString()));
  assert.equal(observations.filter((value) => value.kind === 'reader-unstarted-stop').length, 1);
  await assert.rejects(models.loadReader(input, prepared, session, epoch));
  assert.equal(attemptedTurns, 0);
  record('report', {
    status: 'PASS',
    nativeModelStarts: 0,
    profile,
    session,
    receipt: stopped.receipt,
    observations,
    lateLoadRejected: true,
  });
  confirmed = true;
  console.log(
    JSON.stringify({
      status: 'PASS',
      evidence,
      nativeModelStarts: 0,
      session: session.id,
      lateLoadRejected: true,
    }),
  );
} catch (error) {
  record('failure', { status: 'FAIL', error: String(error), attemptedTurns, nativeModelStarts: 0 });
  throw error;
} finally {
  const owned = await processes.descendants([port.pid]);
  port.close();
  for (let i = 0; i < 100 && (await processes.alive(owned)).length; i++) await processes.wait(50);
  const alive = await processes.alive(owned);
  if (alive.length) await processes.terminate(alive);
  assert.equal((await processes.alive(owned)).length, 0);
  if (confirmed) rmSync(workspace, { recursive: true, force: true });
  record('cleanup', {
    controlledStop: confirmed,
    owned,
    alive: await processes.alive(owned),
    workspaceRemoved: confirmed,
    nativeModelStarts: 0,
  });
}
