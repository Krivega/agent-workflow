import assert from 'node:assert/strict';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { createPreparationWorker } from '../../dist/worker/host.js';
import { startPreparation } from '../../dist/client/preparation.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import { startLocalAdmission } from '../../dist/client/localAdmission.js';
import { localPlanningRisks } from '../../dist/policy/localPlanning.js';
import { preparationActivities } from '../../dist/activities/preparation.js';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';

// This command explicitly starts a temporary local service; unit validation never starts it.
mkdirSync(resolve('tmp'), { recursive: true });
mkdirSync(resolve('tmp/temporal-downloads'), { recursive: true });
const root = realpathSync(mkdtempSync(resolve('tmp/temporal-preparation-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment;
try {
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      executable: {
        type: 'cached-download',
        downloadDir: resolve('tmp/temporal-downloads'),
        version: 'v1.9.1',
      },
      dbFilename: join(root, 'temporal.sqlite'),
    },
  });
  const project = JSON.parse(
    readFileSync(new URL('../../examples/neutral/project.json', import.meta.url), 'utf8'),
  );
  const workspace = join(root, 'neutral');
  mkdirSync(join(workspace, 'tasks'), { recursive: true });
  mkdirSync(join(workspace, 'profiles'));
  writeFileSync(join(workspace, 'RULES.md'), 'Rules');
  writeFileSync(join(workspace, 'profiles/reviewer.md'), 'Profile');
  writeFileSync(join(workspace, 'tasks/example.md'), 'Task');
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot: join(root, 'artifacts'),
    commands: { syntax: { executable: 'node', args: ['--check', 'main.js'] } },
  };
  const input = {
    schemaVersion: 1,
    taskId: 'ordinary',
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    revision: 1,
    card: 'tasks/example.md',
  };
  bindTaskBackendClient(environment.client, registration);
  const workflowsPath = resolve('dist/workflows/localAdmission.js');
  const taskQueue = 'preparation-test';
  const worker = await createPreparationWorker(
    environment.nativeConnection,
    taskQueue,
    workflowsPath,
    registration,
  );
  let history;
  const localHistories = [];
  await worker.runUntil(async () => {
    const handle = await startPreparation(environment.client, input, taskQueue);
    const result = await handle.result();
    assert.equal(result.status, 'prepared');
    assert.match(
      artifactStore(registration.artifactRoot).read(result.manifest).toString(),
      /"kind":"preparation"/u,
    );
    history = await handle.fetchHistory();
    await assert.rejects(startPreparation(environment.client, input, taskQueue));
    await assert.rejects(
      startPreparation(environment.client, { ...input, revision: 2 }, taskQueue),
    );
    const missing = await startPreparation(
      environment.client,
      { ...input, taskId: 'missing', card: 'tasks/missing.md' },
      taskQueue,
    );
    await assert.rejects(missing.result());
    for (const name of ['accepted.md', 'owner.js', 'consumer.js'])
      writeFileSync(join(workspace, name), name);
    const ref = (locator) => ({ locator, hash: digest(readFileSync(join(workspace, locator))) });
    const localPlan = {
      schema_version: 1,
      requirement: ref('tasks/example.md'),
      basis: [ref('accepted.md')],
      owner: ref('owner.js'),
      consumers: [ref('consumer.js')],
      consumers_complete: true,
      paths: ['owner.js'],
      risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, false])),
      reason: 'Local accepted contract',
      checks: ['syntax'],
      criterion: 'The existing criterion holds',
    };
    const bytes = Buffer.from(JSON.stringify(localPlan));
    writeFileSync(join(workspace, 'plan.json'), bytes);
    const store = artifactStore(registration.artifactRoot);
    const acceptance = store.publish(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          phase: 'acceptance',
          scope: 'B1',
          sharedPaths: [],
          roles: [
            {
              roleId: 'reviewer',
              applies: true,
              reason: 'Independent local acceptance',
              paths: ['owner.js', 'consumer.js'],
              complete: true,
              attestedBy: 'qualification',
              discoveryRule: 'declared',
              history: { complete: true, answers: [] },
            },
          ],
        }),
      ),
    );
    const localInput = {
      schemaVersion: 1,
      preparation: { ...input, taskId: 'b1-admission' },
      plan: { path: 'plan.json', sha256: digest(bytes) },
      acceptance,
    };
    const local = await startLocalAdmission(environment.client, localInput, taskQueue);
    assert.equal((await local.result()).status, 'admitted');
    localHistories.push({ history: await local.fetchHistory(), workflowId: local.workflowId });
    await assert.rejects(startLocalAdmission(environment.client, localInput, taskQueue));
    writeFileSync(join(workspace, 'owner.js'), 'changed');
    const stale = await startLocalAdmission(
      environment.client,
      { ...localInput, preparation: { ...localInput.preparation, taskId: 'b1-stale' } },
      taskQueue,
    );
    await assert.rejects(stale.result());
    localHistories.push({ history: await stale.fetchHistory(), workflowId: stale.workflowId });
  });
  await Worker.runReplayHistory({ workflowsPath }, history);
  for (const captured of localHistories)
    await Worker.runReplayHistory({ workflowsPath }, captured.history, captured.workflowId);
  // A new Worker executes the same immutable build after the former one stops.
  const restarted = await createPreparationWorker(
    environment.nativeConnection,
    taskQueue,
    workflowsPath,
    registration,
  );
  await restarted.runUntil(async () => {
    const handle = await startPreparation(
      environment.client,
      { ...input, taskId: 'after-restart' },
      taskQueue,
    );
    assert.equal((await handle.result()).status, 'prepared');
  });
  const direct = await preparationActivities(registration).prepareProject(input);
  assert.equal(direct.status, 'prepared');
  console.log(
    'PASS: local Temporal preparation, missing input, duplicate/conflicting start, replay, Worker restart, B1 admission/stale source; zero model calls',
  );
} finally {
  await environment?.teardown();
  rmSync(root, { recursive: true, force: true });
}
