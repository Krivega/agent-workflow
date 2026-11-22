import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';
import console from 'node:console';
import {
  boundedExecutor,
  boundedObservation,
  childEnvironment,
  assertCleanSdkHostEnvironment,
  runPgTemporal,
} from './t4-pg-temporal-runner.mjs';
import {
  assertAllExecutablePins,
  assertExecutablePin,
  extractPinnedTemporalArchive,
  observeExecutablePins,
  processSample,
  postgresTools,
} from './t4-pg-temporal-binaries.mjs';
import {
  acquireSdkResource,
  startOwnedSdkWorker,
  sdkAcquisitionProof,
  closeSdkResources,
  closeSdkAndServer,
  rootRemovalDecision,
} from './t4-pg-temporal-cleanup.mjs';
import { assertOwnedPostgres, assertServicesStopped } from './t4-pg-temporal-ownership.mjs';
import { parseConfig, preflight, temporaryServicePlan } from './t4-pg-temporal-plan.mjs';
import { sourceRetentionObservation } from './t4-pg-temporal-retention.mjs';
import { restoredServicePlan, savedRecoveryServicePlan } from './t4-pg-temporal-restore-plan.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function archiveBytes(paths) {
  const records = [];
  for (const entry of paths) {
    const path = typeof entry === 'string' ? entry : entry.path,
      type = typeof entry === 'string' ? '0' : entry.type,
      header = Buffer.alloc(512),
      content = type === '2' ? Buffer.alloc(0) : Buffer.from('fixture bytes; never executed');
    header.write(path);
    header.write('0000700\0', 100);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    if (typeof entry !== 'string' && entry.target) header.write(entry.target, 157, 100, 'utf8');
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    records.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}
function configFixture(grpcPort) {
  const config = JSON.parse(
    readFileSync(new URL('./t4-pg-temporal-recovery.config.example.json', import.meta.url), 'utf8'),
  );
  return { ...config, target: { ...config.target, grpcPort } };
}
function restorePlanFixture(root) {
  const config = configFixture(17239),
    destination = join(root, 'restore-proposed'),
    backup = join(root, 'restore-backup'),
    ref = (value) => ({ sha256: value.repeat(64), bytes: 1 });
  if (!existsSync(backup)) mkdirSync(backup);
  config.target.parent = root;
  config.recoverySet = { schemaVersion: 1, backup, manifest: ref('1'), snapshot: ref('2') };
  const source = temporaryServicePlan(config, destination, root).serverConfiguration;
  source.persistence.numHistoryShards = 16;
  source.persistence.datastores['t4-default'].sql.databaseName = 'original_default';
  source.persistence.datastores['t4-visibility'].sql.databaseName = 'original_visibility';
  const checked = {
    status: 'files-verified',
    manifest: config.recoverySet.manifest,
    snapshotRef: config.recoverySet.snapshot,
    snapshot: {
      versions: { temporal: 'pinned-source', postgresql: 'pinned-source' },
      cut: { id: 'source-cut', capturedAt: '2026-11-07T00:00:00.000Z', receipt: ref('3') },
      configuration: ref('4'),
      workerBuild: ref('5'),
      datastores: [
        {
          role: 'default',
          source: 'original-source',
          database: 'original_default',
          schemaVersion: '1.19|1.0',
          dump: ref('6'),
        },
        {
          role: 'visibility',
          source: 'original-source',
          database: 'original_visibility',
          schemaVersion: '1.14|0.1',
          dump: ref('7'),
        },
      ],
      workflows: [
        {
          namespace: 'original',
          workflowId: 'same-id',
          runId: 'same-run',
          history: ref('8'),
          result: ref('9'),
        },
      ],
      evidence: [{ id: 'FAIL', content: ref('a') }],
      workcopies: [{ id: 'original-owner', root: 'workspaces/original' }],
    },
  };
  return { config, source, checked, destination };
}
export function membershipPortRegression(parser = parseConfig) {
  assert.throws(() => parser(configFixture(57239)), /membership ports must fit signed smallint/u);
}
export async function safetySelfTest() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-t4-pg-safety-'))),
    failures = [];
  async function check(name, test) {
    try {
      await test();
      console.log(JSON.stringify({ name, status: 'PASS' }));
    } catch (error) {
      failures.push(name);
      console.log(JSON.stringify({ name, status: 'FAIL', error: String(error) }));
    }
  }
  try {
    const file = join(root, 'binary');
    writeFileSync(file, 'fixture executable; never executed', { mode: 0o700 });
    await check('saved-restore-plan-keeps-identity-and-distinct-physical-databases', () => {
      const { config, source, checked, destination } = restorePlanFixture(root);
      source.clusterMetadata.currentClusterName = 'исходный';
      source.clusterMetadata.masterClusterName = 'исходный';
      source.clusterMetadata.clusterInformation = {
        исходный: source.clusterMetadata.clusterInformation.t4,
      };
      const before = JSON.stringify({ config, source, checked }),
        plan = restoredServicePlan(config, destination, checked, source);
      assert.equal(plan.serverStarts, 0);
      assert.equal(plan.workerStarts, 0);
      assert.equal(plan.activationAllowed, false);
      assert.equal(plan.operationalRpo, 'UNKNOWN');
      assert.equal(plan.operationalRto, 'UNKNOWN');
      assert.deepEqual(
        plan.databases.map((entry) => entry.database),
        ['original_default', 'original_visibility'],
      );
      assert.ok(plan.databases.every((entry) => entry.commands.length === 3));
      assert.ok(
        plan.databases.every((entry) => entry.commands[2].includes('--single-transaction')),
      );
      assert.deepEqual(plan.readback, checked.snapshot.workflows);
      assert.deepEqual(plan.retained.workcopies, checked.snapshot.workcopies);
      assert.equal(plan.serverConfiguration.json.persistence.numHistoryShards, 16);
      const configurationBytes = Buffer.from(JSON.stringify(plan.serverConfiguration.json));
      assert.deepEqual(plan.serverConfiguration.content, {
        sha256: hash(configurationBytes),
        bytes: configurationBytes.length,
      });
      assert.equal(plan.serverConfiguration.json.clusterMetadata.currentClusterName, 'исходный');
      assert.equal(
        plan.serverConfiguration.json.persistence.datastores['t4-default'].sql.databaseName,
        'original_default',
      );
      assert.equal(plan.initialize[0][2], join(destination, 'postgres-target'));
      assert.equal(plan.postgresConfiguration.unix_socket_directories, join(destination, 'socket'));
      assert.equal(JSON.stringify({ config, source, checked }), before);
      assert.equal(existsSync(destination), false);
    });
    await check('saved-restore-plan-restores-shared-database-once', () => {
      const { config, source, checked, destination } = restorePlanFixture(root);
      checked.snapshot.datastores[1] = { ...checked.snapshot.datastores[0], role: 'visibility' };
      source.persistence.datastores['t4-visibility'].sql.databaseName = 'original_default';
      const plan = restoredServicePlan(config, destination, checked, source);
      assert.equal(plan.databases.length, 1);
      assert.equal(Object.keys(plan.serverConfiguration.json.persistence.datastores).length, 2);
    });
    await check('saved-restore-plan-rejects-unsafe-or-unsupported-before-writing', () => {
      for (const mutate of [
        (f) => {
          f.source.persistence.datastores['t4-default'].sql.databaseName = 'other';
        },
        (f) => {
          f.source.persistence.datastores['t4-default'].sql.tls = {};
        },
        (f) => {
          f.source.persistence.datastores.other = {};
        },
        (f) => {
          f.source.global.metrics = {};
        },
        (f) => {
          f.source.services.frontend.rpc.bindOnLocalHost = true;
        },
        (f) => {
          f.source.clusterMetadata.enableGlobalNamespace = true;
        },
        (f) => {
          f.checked.snapshot.datastores[0].schemaVersion = 'unknown';
        },
        (f) => {
          f.checked.snapshot.datastores[0].database = 'host=remote';
        },
        (f) => {
          f.checked.snapshotRef = { sha256: '0'.repeat(64), bytes: 1 };
        },
        (f) => {
          f.destination = join(root, 'restore-backup/child');
          f.config.target.parent = join(root, 'restore-backup');
        },
        (f) => {
          f.destination = root;
        },
      ]) {
        const f = restorePlanFixture(root);
        mutate(f);
        assert.throws(() => restoredServicePlan(f.config, f.destination, f.checked, f.source));
      }
      const f = restorePlanFixture(root);
      f.checked.snapshot.datastores[1] = {
        ...f.checked.snapshot.datastores[0],
        role: 'visibility',
        source: 'another-source',
      };
      f.source.persistence.datastores['t4-visibility'].sql.databaseName = 'original_default';
      assert.throws(
        () => restoredServicePlan(f.config, f.destination, f.checked, f.source),
        /collide/u,
      );
      assert.equal(existsSync(f.destination), false);
    });
    await check('saved-restore-entry-rejects-unverified-backup-before-writing', async () => {
      const f = restorePlanFixture(root);
      await assert.rejects(savedRecoveryServicePlan(f.config, f.destination));
      assert.equal(existsSync(f.destination), false);
    });
    await check('saved-restore-entry-verifies-real-file-backup-without-services', async () => {
      const { createBackup } = await import('../../dist/adapters/artifacts/backup.js'),
        f = restorePlanFixture(root),
        snapshot = f.checked.snapshot,
        sourceRoot = join(root, 'plan-source'),
        roots = Object.fromEntries(
          ['artifacts', 'receipts', 'projections', 'workspaces', 'build'].map((name) => [
            name,
            join(sourceRoot, name),
          ]),
        );
      mkdirSync(sourceRoot);
      for (const directory of Object.values(roots)) mkdirSync(directory);
      const put = (component, name, value) => {
        const bytes = Buffer.from(value),
          ref = { sha256: hash(bytes), bytes: bytes.length };
        writeFileSync(join(roots[component], name ?? ref.sha256), bytes);
        return ref;
      };
      snapshot.configuration = put('build', 'server.json', JSON.stringify(f.source));
      snapshot.workerBuild = put('build', 'worker.js', 'never executed');
      snapshot.cut.receipt = put('receipts', 'cut.json', '{"writers":"unknown"}');
      for (const entry of snapshot.datastores)
        entry.dump = put('artifacts', null, 'PGDMP\0fixture-' + entry.database);
      const history = (...types) =>
        put(
          'artifacts',
          null,
          JSON.stringify({
            events: types.map((eventType, index) => ({ eventType, eventId: String(index + 1) })),
          }),
        );
      snapshot.workflows[0].history = history(1, 2);
      snapshot.workflows[0].result = put('artifacts', null, '{"result":"FAIL"}');
      snapshot.workflows.push(
        {
          namespace: 'original',
          workflowId: 'failed-without-result',
          runId: 'failed-run',
          history: history(1, 3),
          result: null,
        },
        {
          namespace: 'original',
          workflowId: 'genuinely-open',
          runId: 'open-run',
          history: history('EVENT_TYPE_WORKFLOW_EXECUTION_STARTED'),
          result: null,
        },
      );
      snapshot.evidence[0].content = put('artifacts', null, '{"finding":"preserved"}');
      mkdirSync(join(roots.workspaces, 'original'));
      put('workspaces', 'original/file.txt', 'original workspace');
      snapshot.schemaVersion = 1;
      snapshot.kind = 'temporal-storage-snapshot';
      snapshot.backend = 'postgresql';
      function pinSnapshot(backup) {
        const snapshotRef = put('build', 'storage-snapshot.json', JSON.stringify(snapshot)),
          saved = createBackup({ schemaVersion: 2, roots, destination: backup });
        f.config.recoverySet = {
          schemaVersion: 1,
          backup,
          manifest: saved.manifest,
          snapshot: snapshotRef,
        };
      }
      const backup = join(root, 'plan-backup');
      pinSnapshot(backup);
      const plan = await savedRecoveryServicePlan(f.config, f.destination);
      assert.equal(plan.databases.length, 2);
      assert.equal(plan.serviceCommandsNotExecuted, true);
      assert.deepEqual(plan.source, f.config.recoverySet);
      assert.equal(existsSync(f.destination), false);
      const observed = snapshot.workflows.map(
          ({ namespace, workflowId, runId, history }, index) => ({
            namespace,
            workflowId,
            runId,
            history,
            state: index === 2 ? 'open' : 'closed',
            deleteAtMs: index === 2 ? null : Date.now() + 3_600_000,
          }),
        ),
        proofPath = join(root, 'archived-readback.json');
      async function readbackStatus() {
        const bytes = Buffer.from(
          JSON.stringify({
            kind: 't4-archived-readback/1',
            snapshot: f.config.recoverySet.snapshot,
            defaultDump: snapshot.datastores[0].dump,
            workflows: observed,
          }),
        );
        writeFileSync(proofPath, bytes);
        f.config.target.archivedReadback = {
          path: proofPath,
          content: { sha256: hash(bytes), bytes: bytes.length },
        };
        const readiness = await preflight(f.config);
        return readiness.checks.find(({ name }) => name === 'archived-readback-window').result
          .status;
      }
      assert.equal(await readbackStatus(), 'within-window');
      Object.assign(observed[1], { state: 'open', deleteAtMs: null });
      assert.equal(await readbackStatus(), 'blocked-unknown');
      writeFileSync(join(backup, 'blobs', snapshot.configuration.sha256), 'tampered');
      await assert.rejects(savedRecoveryServicePlan(f.config, f.destination));
      Object.assign(observed[1], { state: 'closed', deleteAtMs: Date.now() + 3_600_000 });
      snapshot.workflows[2].history = observed[2].history = history(1, 3, 6);
      pinSnapshot(join(root, 'plan-invalid-history-backup'));
      assert.equal(await readbackStatus(), 'blocked-unknown');
      assert.equal(existsSync(f.destination), false);
    });
    await check('fresh-source-retention-rejects-terminal-history-marked-running', () => {
      const namespace = {
          namespaceInfo: { name: 't4-recovery', id: '11111111-2222-3333-4444-555555555555' },
          config: { workflowExecutionRetentionTtl: { seconds: '86400' } },
        },
        execution = { workflowId: 'pending', runId: 'pending-run' },
        primary = {
          ...execution,
          namespace: 't4-recovery',
          description: { ...execution, status: 'RUNNING' },
          rawDescription: { workflowExecutionInfo: { execution, status: 1 } },
          history: { sha256: 'a'.repeat(64), bytes: 42 },
          result: null,
          pending: true,
        },
        timerSql =
          'COPY public.timer_tasks (shard_id, visibility_timestamp, task_id, data, data_encoding) FROM stdin;\n\\.\n';
      const observe = (...tail) =>
        sourceRetentionObservation(
          namespace,
          [
            {
              ...primary,
              original: {
                events: ['EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', ...tail].map((eventType) => ({
                  eventType,
                })),
              },
            },
          ],
          timerSql,
        );
      assert.equal(observe('EVENT_TYPE_WORKFLOW_TASK_COMPLETED').workflows[0].state, 'open');
      assert.throws(() => observe('EVENT_TYPE_WORKFLOW_EXECUTION_FAILED'), /closing event/u);
      assert.throws(
        () =>
          observe('EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED', 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED'),
        /after closure/u,
      );
    });
    const pins = observeExecutablePins([file]);
    await check('membership-smallint-overflow-rejected-by-parser', () =>
      membershipPortRegression(),
    );
    await check('membership-port-boundary-preserves-PG-high-port', () => {
      assert.equal(parseConfig(configFixture(32760)).target.postgresPort, 55438);
      for (const port of [32761, 32767, 57239])
        assert.throws(
          () => parseConfig(configFixture(port)),
          /membership ports must fit signed smallint/u,
        );
    });
    await check('invalid-membership-ports-rejected-before-native-entry', async () => {
      await assert.rejects(
        runPgTemporal(configFixture(57239)),
        /membership ports must fit signed smallint/u,
      );
    });
    await check('proposed-low-membership-range-is-exact', () => {
      const config = configFixture(17239),
        plan = temporaryServicePlan(
          config,
          '/private/tmp/aw-t4-next-review',
          '/private/tmp/aw-t4-next-review/tools',
        );
      assert.deepEqual(
        Object.values(plan.serverConfiguration.services).map(
          (service) => service.rpc.membershipPort,
        ),
        [17243, 17244, 17245, 17246],
      );
      assert.ok(
        Object.values(plan.serverConfiguration.services).every(
          (service) => service.rpc.membershipPort <= 32767,
        ),
      );
      assert.equal(config.target.postgresPort, 55438);
    });
    await check('outer-window-reserves-two-cleanup-stages-with-exact-boundary', () => {
      const config = configFixture(17239),
        minimum = config.budget.mainMs + 2 * config.budget.cleanupMs;
      config.budget.outerMs = minimum;
      assert.equal(parseConfig(config).budget.outerMs, minimum);
      const plan = temporaryServicePlan(
        config,
        '/private/tmp/aw-t4-two-stages',
        '/private/tmp/aw-t4-two-stages/tools',
      );
      assert.equal(plan.timeBoundary.minimumCleanupReserveMs, 2 * config.budget.cleanupMs);
      for (const outerMs of [minimum - 1, config.budget.mainMs + config.budget.cleanupMs])
        assert.throws(
          () => parseConfig({ ...config, budget: { ...config.budget, outerMs } }),
          /two cleanup stages/u,
        );
    });
    await check('loader-injection-env-not-inherited', () => {
      const original = {
          KEEP: 'yes',
          DYLD_INSERT_LIBRARIES: 'not-loaded',
          DYLD_LIBRARY_PATH: 'not-loaded',
          LD_PRELOAD: 'not-loaded',
          LD_LIBRARY_PATH: 'not-loaded',
          NODE_OPTIONS: 'not-loaded',
          NODE_PATH: 'not-loaded',
        },
        unchanged = { ...original },
        clean = childEnvironment(original, 55438);
      assert.equal(clean.KEEP, 'yes');
      assert.ok(!Object.keys(clean).some((key) => /^(DYLD_|LD_|NODE_)/u.test(key)));
      assert.deepEqual(original, unchanged);
      assert.throws(() => assertCleanSdkHostEnvironment(original), /clean loader/u);
      assertCleanSdkHostEnvironment(clean);
    });
    await check('on-time-SDK-acquisition-owned-and-closed', async () => {
      const state = {},
        handle = { close() {} };
      assert.equal(
        await acquireSdkResource(
          state,
          'connection',
          () => Promise.resolve(handle),
          () => 100,
          5,
        ),
        handle,
      );
      assert.equal(state.connection, handle);
      assert.deepEqual(state.acquisitions, {});
      assert.deepEqual(await closeSdkResources(state, 5), []);
      assert.equal(state.connection, null);
    });
    await check('late-SDK-connection-close-retains-unknown', async () => {
      let resolve,
        closeCalls = 0;
      const pending = new Promise((done) => {
          resolve = done;
        }),
        state = {},
        snapshots = [],
        handle = {
          close() {
            closeCalls++;
          },
        };
      await assert.rejects(
        acquireSdkResource(
          state,
          'connection',
          () => pending,
          () => 2,
          5,
          () => snapshots.push(sdkAcquisitionProof(state)),
        ),
        /deadline/u,
      );
      const record = state.acquisitions.connection;
      assert.equal(record.status, 'unknown');
      assert.ok(record.operation && record.observation);
      resolve(handle);
      await record.observation;
      await record.lateClose;
      assert.equal(closeCalls, 1);
      assert.equal(record.handle, handle);
      assert.equal(record.lateCloseStatus, 'closed');
      assert.ok(state.unknown.connectionAcquisition);
      assert.equal((await closeSdkResources(state, 5)).length, 1);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
      assert.ok(snapshots.some((snapshot) => snapshot.connection?.lateCloseStatus === 'closed'));
    });
    await check('late-Worker-create-close-error-retains-handle', async () => {
      let resolve,
        starts = 0;
      const pending = new Promise((done) => {
          resolve = done;
        }),
        state = {},
        snapshots = [],
        handle = {
          shutdown() {
            throw new Error('Not running. Current state: INITIALIZED');
          },
          run() {
            starts++;
          },
        };
      await assert.rejects(
        acquireSdkResource(
          state,
          'worker',
          () => pending,
          () => 2,
          5,
          () => snapshots.push(sdkAcquisitionProof(state)),
        ),
        /deadline/u,
      );
      resolve(handle);
      const record = state.acquisitions.worker;
      await record.observation;
      await record.lateClose;
      assert.equal(starts, 0);
      assert.equal(record.handle, handle);
      assert.match(record.lateCloseError, /INITIALIZED/u);
      assert.equal(record.lateCloseStatus, 'unknown');
      assert.ok(state.unknown.workerAcquisition && state.unknown.workerLateClose);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
      assert.ok(
        snapshots.some((snapshot) => /INITIALIZED/u.test(snapshot.worker?.lateCloseError ?? '')),
      );
    });
    await check('SDK-closes-share-one-window-and-services-stop-before-exhaustion', async () => {
      const own = Object.getOwnPropertyDescriptor(performance, 'now');
      let elapsed = 0,
        rejectWorker;
      Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
      try {
        const events = [],
          worker = {
            shutdown() {
              events.push('worker-shutdown');
            },
          },
          native = {
            close() {
              events.push('native-close');
              return new Promise(() => {});
            },
          },
          connection = {
            close() {
              events.push('connection-close');
            },
          },
          state = {
            worker,
            native,
            connection,
            workerRun: new Promise((_, reject) => {
              rejectWorker = reject;
            }),
          },
          outerRemaining = () => Math.max(0, 60 - elapsed);
        try {
          await closeSdkAndServer(
            state,
            () => Math.min(20, outerRemaining()),
            async () => {
              events.push('temporal-stop');
              globalThis.queueMicrotask(() => {
                elapsed = 20;
                rejectWorker(new Error('synthetic hung Worker at close deadline'));
              });
            },
          );
          assert.fail('unknown SDK shutdown must fail cleanup');
        } catch (error) {
          assert.match(String(error), /worker:/u);
        } finally {
          assert.equal(outerRemaining(), 40);
          events.push('postgres-stop');
        }
        assert.deepEqual(events, ['temporal-stop', 'worker-shutdown', 'postgres-stop']);
        assert.ok(state.unknown.worker && state.unknown.native && state.unknown.connection);
        assert.equal(state.native, native);
        assert.equal(state.connection, connection);
        assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
      } finally {
        if (own) Object.defineProperty(performance, 'now', own);
        else delete performance.now;
      }
    });
    await check('late-SDK-handle-after-outer-deadline-gets-no-new-close-window', async () => {
      let resolve,
        outerRemaining = 20,
        calls = 0;
      const state = {},
        pending = new Promise((done) => {
          resolve = done;
        });
      await assert.rejects(
        acquireSdkResource(
          state,
          'connection',
          () => pending,
          () => 1,
          () => outerRemaining,
        ),
        /deadline/u,
      );
      outerRemaining = 0;
      resolve({
        close() {
          calls++;
        },
      });
      const record = state.acquisitions.connection;
      await record.observation;
      await record.lateClose;
      assert.equal(calls, 0);
      assert.equal(record.lateCloseStatus, 'unknown');
      assert.match(record.lateCloseError, /late SDK close deadline exceeded/u);
      assert.ok(state.unknown.connectionLateClose);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
    });
    await check(
      'fulfilled-SDK-worker-after-work-deadline-before-timer-stays-owned-unknown',
      async () => {
        let remaining = 20,
          starts = 0;
        const state = {},
          handle = {
            shutdown() {
              throw new Error('INITIALIZED');
            },
            run() {
              starts++;
            },
          };
        await assert.rejects(
          acquireSdkResource(
            state,
            'worker',
            () => {
              remaining = 0;
              return Promise.resolve(handle);
            },
            () => remaining,
            () => 20,
          ),
          /deadline/u,
        );
        const record = state.acquisitions.worker;
        await record.lateClose;
        assert.equal(record.handle, handle);
        assert.equal(record.deadlineWon, true);
        assert.equal(record.status, 'late-result');
        assert.equal(state.worker, undefined);
        assert.equal(starts, 0);
        assert.ok(state.unknown.workerAcquisition && state.unknown.workerLateClose);
        assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
      },
    );
    await check('SDK-arrival-onChange-cannot-expire-then-adopt-the-handle', async () => {
      let remaining = 20,
        closes = 0;
      const state = {},
        handle = {
          close() {
            closes++;
          },
        };
      await assert.rejects(
        acquireSdkResource(
          state,
          'connection',
          () => Promise.resolve(handle),
          () => remaining,
          () => 20,
          () => {
            if (state.acquisitions.connection?.handle) remaining = 0;
          },
        ),
        /deadline/u,
      );
      const record = state.acquisitions.connection;
      await record.lateClose;
      assert.equal(record.handle, handle);
      assert.equal(record.deadlineWon, true);
      assert.equal(closes, 1);
      assert.ok(state.unknown.connectionAcquisition);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
    });
    await check('SDK-adoption-onChange-cannot-return-an-expired-owned-handle', async () => {
      let remaining = 20,
        closes = 0;
      const state = {},
        handle = {
          close() {
            closes++;
          },
        };
      await assert.rejects(
        acquireSdkResource(
          state,
          'connection',
          () => Promise.resolve(handle),
          () => remaining,
          () => 20,
          () => {
            if (state.connection === handle) remaining = 0;
          },
        ),
        /deadline/u,
      );
      const record = state.acquisitions.connection;
      await record.lateClose;
      assert.equal(record.handle, handle);
      assert.equal(record.deadlineWon, true);
      assert.equal(state.connection, undefined);
      assert.equal(closes, 1);
      assert.ok(state.unknown.connectionAcquisition);
    });
    await check('Worker-start-rechecks-clock-and-retains-an-unstarted-handle', async () => {
      let calls = 0;
      const worker = {
          run() {
            calls++;
            return Promise.resolve();
          },
          shutdown() {
            throw new Error('must remain owned');
          },
        },
        state = { worker, workerRun: null };
      assert.throws(() => startOwnedSdkWorker(state, () => 0), /Worker start deadline/u);
      assert.equal(calls, 0);
      assert.equal(state.worker, worker);
      assert.equal(state.workerRun, null);
      assert.ok(state.unknown.worker);
      assert.throws(() => startOwnedSdkWorker(state, () => 20), /ownership is unknown/u);
      assert.equal((await closeSdkResources(state, 5)).length, 1);
      assert.equal(state.worker, worker);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
      const onTime = { worker, workerRun: null };
      await startOwnedSdkWorker(onTime, () => 20);
      assert.equal(calls, 1);
      assert.throws(() => startOwnedSdkWorker(onTime, () => 20), /unstarted/u);
      const failedWorker = {
          run() {
            throw new Error('synthetic Worker start error');
          },
        },
        failed = { worker: failedWorker, workerRun: null };
      assert.throws(() => startOwnedSdkWorker(failed, () => 20), /synthetic Worker start error/u);
      assert.equal(failed.worker, failedWorker);
      assert.ok(failed.unknown.worker);
    });
    await check('expired-acquisition-microtask-cannot-start-a-resource', async () => {
      let remaining = 20,
        calls = 0;
      const state = {};
      await assert.rejects(
        acquireSdkResource(
          state,
          'connection',
          () => {
            calls++;
          },
          () => remaining,
          5,
          () => {
            remaining = 0;
          },
        ),
        /budget/u,
      );
      assert.equal(calls, 0);
      assert.equal(state.acquisitions.connection.status, 'rejected');
    });
    await check('all-process-observations-consume-the-same-outer-remainder', () => {
      let remaining = 9;
      const calls = [],
        observe = boundedObservation(
          () => remaining,
          (file, args, options) => {
            calls.push({ file, timeout: options.timeout });
            remaining -= 4;
            return { status: 0, stdout: '' };
          },
        );
      observe('/bin/ps', [], { timeout: 2000 });
      observe('/usr/sbin/lsof', [], { timeout: 2000 });
      remaining = 0;
      assert.throws(() => observe('/bin/ps', [], { timeout: 2000 }), /deadline/u);
      assert.deepEqual(calls, [
        { file: '/bin/ps', timeout: 9 },
        { file: '/usr/sbin/lsof', timeout: 5 },
      ]);
      const late = boundedObservation(
        () => remaining,
        () => {
          throw new Error('must not execute');
        },
      );
      assert.throws(() => late('/bin/ps', [], {}), /deadline/u);
      remaining = 1;
      let lateCalls = 0;
      const expiredResult = boundedObservation(
        () => remaining,
        () => {
          lateCalls++;
          remaining = 0;
          return { status: 0, stdout: '' };
        },
      );
      assert.throws(() => expiredResult('/bin/ps', [], {}), /exceeded deadline/u);
      assert.throws(() => expiredResult('/bin/ps', [], {}), /deadline exhausted/u);
      assert.equal(lateCalls, 1);
    });
    await check('command-budget-is-rechecked-after-executable-hash', () => {
      let reads = 0,
        calls = 0;
      const run = boundedExecutor(
        new Set([file]),
        () => (++reads === 1 ? 20 : 0),
        {},
        () => {
          calls++;
          return '';
        },
        pins,
      );
      assert.throws(() => run([file]), /after executable verification/u);
      assert.equal(calls, 0);
      let remaining = 20;
      const late = boundedExecutor(
        new Set([file]),
        () => remaining,
        {},
        () => {
          calls++;
          remaining = 0;
          return 'late native result';
        },
        pins,
      );
      assert.throws(() => late([file]), /after native command/u);
      assert.throws(() => late([file]), /budget exhausted/u);
      assert.equal(calls, 1);
    });
    await check('main-clock-starts-before-config-pins-and-SDK-imports', async () => {
      const own = Object.getOwnPropertyDescriptor(performance, 'now'),
        config = configFixture(17239);
      let elapsed = 0;
      Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
      try {
        config.authorization.evidence = 'synthetic deadline self-test; no service execution';
        Object.defineProperty(config.target, 'renderedConfiguration', {
          enumerable: true,
          get() {
            elapsed = config.budget.mainMs + 1;
            return null;
          },
        });
        await assert.rejects(
          runPgTemporal(config),
          /budget exhausted before executable verification/u,
        );
      } finally {
        if (own) Object.defineProperty(performance, 'now', own);
        else delete performance.now;
      }
    });
    await check('wrong-pin-before-version', () => {
      const calls = [],
        wrong = { [file]: { ...pins[file], sha256: '0'.repeat(64) } },
        run = boundedExecutor(
          new Set([file]),
          () => 500,
          {},
          (...args) => {
            calls.push(args);
            return 'bad';
          },
          wrong,
        );
      assert.throws(() => run([file, '--version']), /pin mismatch/u);
      assert.equal(calls.length, 0, 'wrong-pin bytes must never execute');
      const missing = boundedExecutor(
        new Set([file]),
        () => 500,
        {},
        () => {
          throw new Error('must not execute');
        },
        {},
      );
      assert.throws(() => missing([file, '--version']), /missing executable pin/u);
    });
    await check('launcher-allowlist-budget-and-native-errors', () => {
      let calls = 0;
      const execute = () => {
          calls++;
          throw new Error('native restore failed');
        },
        run = boundedExecutor(new Set([file]), () => 500, {}, execute, pins),
        expired = boundedExecutor(new Set([file]), () => 0, {}, execute, pins);
      assert.throws(() => run([join(root, 'unapproved')]), /unapproved/u);
      assert.throws(() => expired([file]), /budget/u);
      assert.equal(calls, 0);
      assert.throws(() => run([file]), /native restore failed/u);
      assert.equal(calls, 1);
    });
    await check('pin-rechecked-before-every-launch', () => {
      let calls = 0;
      const run = boundedExecutor(
        new Set([file]),
        () => 500,
        {},
        () => {
          calls++;
          return 'fixture';
        },
        pins,
      );
      assert.equal(run([file, '--version']), 'fixture');
      writeFileSync(file, 'changed bytes');
      assert.throws(() => run([file, 'start']), /pin mismatch/u);
      assert.equal(calls, 1);
    });
    await check('links-rejected-before-execution', () => {
      const alias = join(root, 'alias'),
        hard = join(root, 'hard');
      symlinkSync(file, alias);
      linkSync(file, hard);
      assert.throws(() => assertExecutablePin(alias, { [alias]: pins[file] }), /symlink/u);
      assert.throws(() => assertExecutablePin(file, pins), /single-link/u);
      rmSync(alias);
      rmSync(hard);
    });
    await check('PATH-cannot-select-ps', () => {
      const expected = observeExecutablePins(['/bin/ps']),
        calls = [];
      processSample(
        expected,
        (...args) => {
          calls.push(args);
          return { status: 0, stdout: '' };
        },
        { PATH: root },
      );
      assert.equal(calls[0][0], '/bin/ps');
      assert.deepEqual(calls[0][1], ['-axo', 'pid=,ppid=,rss=,time=']);
      assert.equal(calls.length, 1);
    });
    await check('unknown-worker-close-retains-reference-and-root', async () => {
      const worker = { shutdown() {} },
        pending = new Promise(() => {}),
        state = { worker, workerRun: pending };
      const errors = await closeSdkResources(state, 2);
      assert.equal(errors.length, 1);
      assert.equal(state.worker, worker);
      assert.equal(state.workerRun, pending);
      assert.ok(state.unknown.worker);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
    });
    await check('failed-native-close-retains-reference', async () => {
      const native = {
          close() {
            throw new Error('unknown close');
          },
        },
        state = { native };
      await closeSdkResources(state, 2);
      assert.equal(state.native, native);
      assert.ok(state.unknown.native);
      assert.equal(rootRemovalDecision(passProof(), state, true).allowed, false);
    });
    await check('serverError-retains-root', () => {
      const proof = passProof();
      proof.cleanup.serverError = 'unknown';
      assert.equal(rootRemovalDecision(proof, {}, true).allowed, false);
    });
    await check('earlyfailure-without-set-retains-root', () => {
      const proof = passProof();
      proof.status = 'FAIL';
      delete proof.recoverySet;
      assert.equal(rootRemovalDecision(proof, {}, true).allowed, false);
    });
    await check('only-full-proof-and-all-stops-allow-removal', () => {
      const proof = passProof();
      assert.equal(rootRemovalDecision(proof, {}, true).allowed, true);
      assert.equal(rootRemovalDecision(proof, {}, false).allowed, false);
      delete proof.cleanup.immutableRecoverySetVerified;
      assert.equal(rootRemovalDecision(proof, {}, true).allowed, false);
      assert.equal(rootRemovalDecision(passProof(), { worker: {} }, true).allowed, false);
      const unconfirmed = passProof();
      unconfirmed.cleanup.postgresStops[0].stop = null;
      assert.equal(rootRemovalDecision(unconfirmed, {}, true).allowed, false);
    });
    await check('postgres-identity-and-private-socket-required', () => {
      const data = join(root, 'cluster'),
        socket = join(root, 'socket'),
        port = 55438,
        pid = 42;
      mkdirSync(data);
      mkdirSync(socket);
      const identity = [pid, data, 0, port, socket, '127.0.0.1'].join('\n');
      writeFileSync(join(data, 'postmaster.pid'), identity);
      const observerPins = observeExecutablePins(['/bin/ps', '/usr/sbin/lsof']),
        calls = [];
      function execute(command, args) {
        calls.push([command, args]);
        if (command === '/bin/ps') return { status: 0, stdout: '42 1 100 0:00\n43 42 100 0:00' };
        return {
          status: 0,
          stdout:
            'p42\nn' +
            (args.includes('-d')
              ? file
              : args.includes('-U')
                ? join(socket, '.s.PGSQL.' + port)
                : '127.0.0.1:' + port) +
            '\n',
        };
      }
      assert.deepEqual(
        assertOwnedPostgres(data, socket, port, file, observerPins, {}, execute).descendants,
        [42, 43],
      );
      writeFileSync(join(data, 'postmaster.pid'), identity.replace(data, socket));
      calls.length = 0;
      assert.throws(
        () => assertOwnedPostgres(data, socket, port, file, observerPins, {}, execute),
        /data-directory/u,
      );
      assert.equal(
        calls.length,
        0,
        'mismatched endpoint must fail before observer or SQL execution',
      );
      writeFileSync(join(data, 'postmaster.pid'), identity);
      assert.throws(
        () =>
          assertOwnedPostgres(data, socket, port, file, observerPins, {}, (command, args) => {
            const actual = execute(command, args);
            return command === '/usr/sbin/lsof'
              ? { ...actual, stdout: actual.stdout.replace('p42', 'p99') }
              : actual;
          }),
        /PID mismatch/u,
      );
    });
    await check('living-orphan-descendant-and-listener-keep-unknown', () => {
      const observerPins = observeExecutablePins(['/bin/ps', '/usr/sbin/lsof']);
      assert.throws(
        () =>
          assertServicesStopped([42, 43], [57239], null, observerPins, {}, (command) =>
            command === '/bin/ps'
              ? { status: 0, stdout: '43 1 100 0:00' }
              : { status: 1, stdout: '' },
          ),
        /descendant/u,
      );
      assert.throws(
        () =>
          assertServicesStopped([42], [57239], null, observerPins, {}, (command) =>
            command === '/bin/ps' ? { status: 0, stdout: '' } : { status: 0, stdout: 'p99' },
          ),
        /listener remains/u,
      );
      assert.throws(
        () =>
          assertServicesStopped([42], [57239], null, observerPins, {}, () => ({
            status: null,
            stdout: '',
          })),
        /unavailable/u,
      );
      assert.equal(
        assertServicesStopped([42], [57239], null, observerPins, {}, (command) =>
          command === '/bin/ps' ? { status: 0, stdout: '' } : { status: 1, stdout: '' },
        ).listenersStopped,
        true,
      );
    });
    await check('stop-observer-diagnostics-keep-outcome-unknown', () => {
      const observerPins = observeExecutablePins(['/bin/ps', '/usr/sbin/lsof']);
      for (const failedProbe of ['process', 'TCP', 'Unix socket']) {
        assert.throws(
          () =>
            assertServicesStopped(
              [42],
              [55438],
              '/fixture/.s.PGSQL.55438',
              observerPins,
              {},
              (command, args) => {
                const probe =
                  command === '/bin/ps' ? 'process' : args.includes('-U') ? 'Unix socket' : 'TCP';
                return {
                  status: probe === 'TCP' ? 1 : 0,
                  stdout: '',
                  stderr:
                    probe === failedProbe ? 'observer could not inspect the process table' : '',
                };
              },
            ),
          new RegExp(failedProbe + ' stop observation unavailable', 'u'),
        );
      }
    });
    await check('pinned-archive-extracts-only-named-binaries', () => {
      const compressed = archiveBytes(['temporal-server', 'temporal-sql-tool', 'other-tool']),
        path = join(root, 'archive.gz'),
        destination = join(root, 'extracted');
      writeFileSync(path, compressed);
      const inventory = extractPinnedTemporalArchive(path, destination, hash(compressed));
      assert.equal(Object.keys(inventory.executablePins).length, 2);
      assert.equal(existsSync(join(destination, 'other-tool')), false);
      assert.equal(inventory.archive.content.sha256, hash(compressed));
    });
    await check('full-toolchain-requires-pinned-archive-inventory', () => {
      const compressed = archiveBytes(['temporal-server', 'temporal-sql-tool']),
        archive = join(root, 'full.gz'),
        destination = join(root, 'full-tools'),
        pg = join(root, 'pg');
      writeFileSync(archive, compressed);
      mkdirSync(pg);
      for (const name of postgresTools)
        writeFileSync(join(pg, name), 'fixture; never executed', { mode: 0o700 });
      const inventory = extractPinnedTemporalArchive(archive, destination, hash(compressed)),
        config = {
          executables: {
            postgresDirectory: pg,
            temporalServer: join(destination, 'temporal-server'),
            temporalSqlTool: join(destination, 'temporal-sql-tool'),
          },
          executablePins: {
            ...inventory.executablePins,
            ...observeExecutablePins(
              postgresTools.map((name) => join(pg, name)).concat('/bin/ps', '/usr/sbin/lsof'),
            ),
          },
          temporalBinaryInventory: inventory.binaryInventory,
        };
      assert.equal(Object.keys(assertAllExecutablePins(config, hash(compressed))).length, 11);
      assert.throws(
        () =>
          assertAllExecutablePins({ ...config, temporalBinaryInventory: null }, hash(compressed)),
        /inventory required/u,
      );
      assert.throws(() => assertAllExecutablePins(config, '0'.repeat(64)), /archive pin mismatch/u);
      assert.throws(
        () =>
          assertAllExecutablePins(
            {
              ...config,
              temporalBinaryInventory: {
                ...inventory.binaryInventory,
                content: { bytes: 0, sha256: '0'.repeat(64) },
              },
            },
            hash(compressed),
          ),
        /inventory pin mismatch/u,
      );
    });
    await check('exact-ignored-upstream-metadata-symlink-is-never-created', () => {
      const compressed = archiveBytes([
          'temporal-server',
          { path: 'config/development.yaml', target: 'development-sqlite.yaml', type: '2' },
          'temporal-sql-tool',
        ]),
        archive = join(root, 'metadata.gz'),
        destination = join(root, 'metadata-tools');
      writeFileSync(archive, compressed);
      const inventory = extractPinnedTemporalArchive(archive, destination, hash(compressed));
      assert.deepEqual(inventory.ignoredMetadata, [
        {
          path: 'config/development.yaml',
          target: 'development-sqlite.yaml',
          type: '2',
          bytes: 0,
          materialized: false,
        },
      ]);
      assert.equal(existsSync(join(destination, 'config')), false);
      assert.equal(Object.keys(inventory.executablePins).length, 2);
    });
    await check('wrong-target-metadata-link-rejected-before-publication', () => {
      const compressed = archiveBytes([
          'temporal-server',
          { path: 'config/development.yaml', target: '../development-sqlite.yaml', type: '2' },
          'temporal-sql-tool',
        ]),
        archive = join(root, 'wrong-link.gz'),
        destination = join(root, 'wrong-link-tools');
      writeFileSync(archive, compressed);
      assert.throws(
        () => extractPinnedTemporalArchive(archive, destination, hash(compressed)),
        /links/u,
      );
      assert.equal(existsSync(destination), false);
    });
    await check('selected-binary-link-rejected-before-publication', () => {
      const compressed = archiveBytes([
          { path: 'temporal-server', target: 'development-sqlite.yaml', type: '2' },
          'temporal-sql-tool',
        ]),
        archive = join(root, 'selected-link.gz'),
        destination = join(root, 'selected-link-tools');
      writeFileSync(archive, compressed);
      assert.throws(
        () => extractPinnedTemporalArchive(archive, destination, hash(compressed)),
        /links/u,
      );
      assert.equal(existsSync(destination), false);
    });
    await check('wrong-or-unsafe-archive-publishes-no-directory', () => {
      const compressed = archiveBytes(['../temporal-server', 'temporal-sql-tool']),
        path = join(root, 'bad.gz'),
        destination = join(root, 'rejected');
      writeFileSync(path, compressed);
      assert.throws(
        () => extractPinnedTemporalArchive(path, destination, '0'.repeat(64)),
        /archive pin mismatch/u,
      );
      assert.equal(existsSync(destination), false);
      assert.throws(
        () => extractPinnedTemporalArchive(path, destination, hash(compressed)),
        /unsafe tar path/u,
      );
      assert.equal(existsSync(destination), false);
    });
  } finally {
    rmSync(root, { recursive: true });
  }
  assert.deepEqual(failures, [], 'negative safety checks failed');
}
function passProof() {
  return {
    status: 'PASS',
    recoverySet: { backup: 'fixture' },
    serverStarts: 2,
    postgresStarts: 2,
    cleanup: {
      immutableRecoverySetVerified: true,
      evidenceVerified: true,
      temporalStops: [
        { code: 0, descendantsStopped: true, listenersStopped: true },
        { code: 0, descendantsStopped: true, listenersStopped: true },
      ],
      postgresStops: [
        { stop: 0, status: 3, descendantsStopped: true, listenersStopped: true },
        { stop: 0, status: 3, descendantsStopped: true, listenersStopped: true },
      ],
    },
  };
}
