import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseConfig, temporaryServicePlan } from './t4-pg-temporal-plan.mjs';

function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'unsupported source configuration');
}
function content(bytes) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.byteLength(bytes),
  };
}

export function restoredServicePlan(raw, root, checked, source) {
  const config = parseConfig(raw);
  assert.ok(config.recoverySet, 'saved recovery-set required');
  assert.ok(
    Object.values(config.executables).every((value) => value !== null),
    'existing executable paths required',
  );
  assert.equal(checked.status, 'files-verified');
  assert.deepEqual(checked.snapshotRef, config.recoverySet.snapshot);
  assert.deepEqual(checked.manifest, config.recoverySet.manifest);
  assert.equal(resolve(root), root, 'canonical new root required');
  assert.equal(
    dirname(root),
    realpathSync(config.target.parent),
    'root must be a direct child of target parent',
  );
  assert.ok(!existsSync(root), 'restore root must not exist');
  const backup = realpathSync(config.recoverySet.backup);
  assert.ok(
    !root.startsWith(backup + sep) && !backup.startsWith(root + sep),
    'restore root overlaps backup',
  );
  const snapshot = checked.snapshot,
    template = temporaryServicePlan(config, root, dirname(config.executables.temporalServer)),
    target = template.serverConfiguration,
    sqlKeys = Object.keys(target.persistence.datastores['t4-default'].sql);
  exact(source, Object.keys(target));
  exact(source.log, Object.keys(target.log));
  exact(source.global, Object.keys(target.global));
  exact(source.global.membership, Object.keys(target.global.membership));
  exact(source.global.pprof, Object.keys(target.global.pprof));
  exact(source.services, Object.keys(target.services));
  for (const [name, service] of Object.entries(target.services)) {
    exact(source.services[name], ['rpc']);
    exact(source.services[name].rpc, Object.keys(service.rpc));
  }
  exact(source.publicClient, ['hostPort']);
  exact(source.persistence, ['defaultStore', 'visibilityStore', 'numHistoryShards', 'datastores']);
  assert.ok(
    Number.isSafeInteger(source.persistence.numHistoryShards) &&
      source.persistence.numHistoryShards > 0,
  );
  assert.deepEqual(
    Object.keys(source.persistence.datastores).sort(),
    [...new Set([source.persistence.defaultStore, source.persistence.visibilityStore])].sort(),
    'additional datastores require a separate restore plan',
  );
  exact(source.clusterMetadata, Object.keys(target.clusterMetadata));
  const cluster = source.clusterMetadata.currentClusterName;
  assert.equal(
    source.clusterMetadata.enableGlobalNamespace,
    false,
    'global namespaces require a separate restore plan',
  );
  assert.equal(source.clusterMetadata.masterClusterName, cluster);
  exact(source.clusterMetadata.clusterInformation, [cluster]);
  exact(source.clusterMetadata.clusterInformation[cluster], [
    'enabled',
    'initialFailoverVersion',
    'rpcName',
    'rpcAddress',
  ]);
  assert.equal(source.clusterMetadata.clusterInformation[cluster].enabled, true);
  assert.equal(source.clusterMetadata.clusterInformation[cluster].rpcName, 'frontend');
  assert.deepEqual(source.dcRedirectionPolicy, { policy: 'noop' });
  target.clusterMetadata = JSON.parse(JSON.stringify(source.clusterMetadata));
  target.clusterMetadata.clusterInformation[cluster].rpcAddress =
    '127.0.0.1:' + config.target.grpcPort;
  target.persistence.numHistoryShards = source.persistence.numHistoryShards;
  target.persistence.defaultStore = source.persistence.defaultStore;
  target.persistence.visibilityStore = source.persistence.visibilityStore;
  target.persistence.datastores = Object.create(null);
  const physical = new Map(),
    pg = config.executables.postgresDirectory,
    socket = join(root, 'socket'),
    stage = join(root, 'restored'),
    connection = ['-h', socket, '-p', String(config.target.postgresPort), '-U', 'aw_t4'];
  for (const role of ['default', 'visibility']) {
    const entry = snapshot.datastores.find((item) => item.role === role),
      name = source.persistence[role + 'Store'],
      original = source.persistence.datastores[name];
    assert.ok(entry, 'missing logical datastore');
    exact(original, ['sql']);
    exact(original.sql, sqlKeys);
    assert.equal(original.sql.pluginName, 'postgres12', 'unsupported SQL plugin');
    assert.equal(original.sql.connectProtocol, 'tcp', 'unsupported SQL transport');
    assert.equal(
      original.sql.databaseName,
      entry.database,
      'source database differs from pinned snapshot',
    );
    assert.match(
      entry.database,
      /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u,
      'database requires a separately reviewed connection plan',
    );
    assert.match(
      entry.schemaVersion,
      /^\d+(?:\.\d+)*\|\d+(?:\.\d+)*$/u,
      'schema readback format is unknown',
    );
    const previous = physical.get(entry.database);
    if (previous) {
      assert.equal(
        previous.source,
        entry.source,
        'different source databases collide in one target',
      );
      assert.deepEqual(previous.dump, entry.dump);
      assert.equal(previous.schemaVersion, entry.schemaVersion);
    } else physical.set(entry.database, entry);
    target.persistence.datastores[name] = {
      sql: {
        ...original.sql,
        connectAddr: '127.0.0.1:' + config.target.postgresPort,
        user: 'aw_t4',
        password: '',
        maxConns: role === 'default' ? 4 : 2,
        maxIdleConns: 1,
        maxConnLifetime: '1m',
      },
    };
  }
  const databases = [...physical.values()].map((entry) => ({
    ...entry,
    commands: [
      [join(pg, 'pg_restore'), '--list', join(stage, 'artifacts', entry.dump.sha256)],
      [join(pg, 'createdb'), ...connection, '--', entry.database],
      [
        join(pg, 'pg_restore'),
        ...connection,
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '-d',
        entry.database,
        join(stage, 'artifacts', entry.dump.sha256),
      ],
    ],
    schemaReadback: {
      command: [
        join(pg, 'psql'),
        ...connection,
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
        '-d',
        entry.database,
        '-c',
        'SELECT curr_version,min_compatible_version FROM schema_version',
      ],
      expected: entry.schemaVersion,
    },
  }));
  const serialized = JSON.stringify(target);
  return {
    kind: 't4-saved-recovery-service-plan/1',
    operationMode: 'review-only',
    serviceCommandsNotExecuted: true,
    serverStarts: 0,
    modelStarts: 0,
    workerStarts: 0,
    activationAllowed: false,
    requiresReconciliation: true,
    source: config.recoverySet,
    cut: snapshot.cut,
    versions: snapshot.versions,
    versionChecks: [
      { command: [join(pg, 'postgres'), '--version'], expected: snapshot.versions.postgresql },
      {
        command: [config.executables.temporalServer, '--version'],
        expected: snapshot.versions.temporal,
      },
    ],
    requiredExecutablePins: config.executablePins,
    temporalBinaryInventory: config.temporalBinaryInventory,
    root,
    stage,
    proposedBudget: config.budget,
    serverConfiguration: {
      path: join(root, 'temporal.json'),
      content: content(serialized),
      json: target,
    },
    postgresConfiguration: template.proposedPostgresConfiguration,
    initialize: template.initializeFreshTargetAfterSourceStop,
    databases,
    serverStart: template.serverStart,
    stop: [template.stop[1]],
    readback: snapshot.workflows,
    retained: {
      evidence: snapshot.evidence,
      workcopies: snapshot.workcopies,
      workerBuild: snapshot.workerBuild,
    },
    operationalRpo: 'UNKNOWN',
    operationalRto: 'UNKNOWN',
    gates: [
      'New direct authorization for this pinned plan, existing binaries, new root, loopback ports, budgets and stop/export; no installations or production activation',
      'Verify executable/inventory pins before any execution; compare observed PostgreSQL/Temporal versions exactly with snapshot; do not upgrade schemas',
      'Reconcile source cut, external effects, owners and grants; staging copies never grant writer scope',
      'Stage the verified set, materialize only the reviewed target configuration; immutable backup remains closed to mutable service writes',
      'Use sanitized childEnvironment and boundedExecutor; require free ports and assertOwnedPostgres before every SQL-tool/service launch and SQL effect',
      'Run each distinct database restore once; require successful exit and exact schemaReadback stdout before starting Temporal',
      'Pin archivedReadback and recheck its complete retention window immediately before Temporal start; unknown or expired blocks start',
      'Use a read-only SDK Client to compare every original namespace/workflow/run/history/result; do not start Workers, query handlers, Signal, reset or Workflow.start',
      'Export commands, stdout/stderr, monotonic timings and resources; stop only owned PIDs and verify all descendants/listeners absent; retain root on FAIL or unknown',
    ],
  };
}

export async function savedRecoveryServicePlan(raw, root) {
  const config = parseConfig(raw);
  assert.ok(config.recoverySet, 'saved recovery-set required');
  const { verifyTemporalRecoverySet } = await import('../../dist/adapters/artifacts/backup.js'),
    checked = verifyTemporalRecoverySet(config.recoverySet),
    bytes = readFileSync(
      join(config.recoverySet.backup, 'blobs', checked.snapshot.configuration.sha256),
    );
  assert.deepEqual(
    content(bytes),
    checked.snapshot.configuration,
    'source configuration pin mismatch',
  );
  return restoredServicePlan(config, root, checked, JSON.parse(bytes.toString('utf8')));
}
