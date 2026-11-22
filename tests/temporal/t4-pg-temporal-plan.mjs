import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { historyToJSON } from '@temporalio/common/proto-utils';
import { terminalWorkflowEvent } from './t4-pg-temporal-retention.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const temporalAcquisition = {
  version: '1.32.0',
  platform: 'darwin',
  architecture: 'arm64',
  url: 'https://github.com/temporalio/temporal/releases/download/v1.32.0/temporal_1.32.0_darwin_arm64.tar.gz',
  sha256: 'f95748376241f5941327fa4c4e8e76641e8c4a9acabf77de9c86eb3d8238f4d7',
  archiveBytesApproximate: 91800000,
  executables: ['temporal-server', 'temporal-sql-tool'],
  scope: 'proposed isolated acquisition only; never global install or daemon registration',
};
function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'unexpected fields');
}
function localPath(value) {
  assert.ok(
    typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/u.test(value),
    'absolute local path required',
  );
  return resolve(value);
}
function artifact(value) {
  exact(value, ['sha256', 'bytes']);
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(value.bytes) && value.bytes >= 0);
  return value;
}
export function parseConfig(raw) {
  exact(raw, [
    'schemaVersion',
    'recoverySet',
    'executables',
    'executablePins',
    'temporalBinaryInventory',
    'target',
    'budget',
    'authorization',
    ...(Object.hasOwn(raw, 'resumePending') ? ['resumePending'] : []),
  ]);
  assert.equal(raw.schemaVersion, 1);
  if (Object.hasOwn(raw, 'resumePending')) {
    assert.equal(typeof raw.resumePending, 'boolean');
    if (raw.resumePending)
      assert.equal(raw.recoverySet, null, 'resume requires fresh synthetic source/target');
  }
  if (raw.recoverySet !== null) {
    exact(raw.recoverySet, ['schemaVersion', 'backup', 'manifest', 'snapshot']);
    assert.equal(raw.recoverySet.schemaVersion, 1);
    localPath(raw.recoverySet.backup);
    artifact(raw.recoverySet.manifest);
    artifact(raw.recoverySet.snapshot);
  }
  exact(raw.executables, ['postgresDirectory', 'temporalServer', 'temporalSqlTool']);
  for (const value of Object.values(raw.executables)) if (value !== null) localPath(value);
  assert.ok(
    raw.executablePins &&
      typeof raw.executablePins === 'object' &&
      !Array.isArray(raw.executablePins),
  );
  for (const [path, pin] of Object.entries(raw.executablePins)) {
    localPath(path);
    if (pin !== null) artifact(pin);
  }
  if (raw.temporalBinaryInventory !== null) {
    exact(raw.temporalBinaryInventory, ['path', 'content']);
    localPath(raw.temporalBinaryInventory.path);
    artifact(raw.temporalBinaryInventory.content);
  }
  exact(raw.target, [
    'parent',
    'postgresPort',
    'grpcPort',
    'renderedConfiguration',
    ...(Object.hasOwn(raw.target, 'archivedReadback') ? ['archivedReadback'] : []),
  ]);
  localPath(raw.target.parent);
  for (const value of [raw.target.postgresPort, raw.target.grpcPort])
    assert.ok(
      Number.isSafeInteger(value) && value >= 1024 && value <= 65535,
      'unprivileged port required',
    );
  assert.ok(
    raw.target.grpcPort + 7 <= 32767,
    'PostgreSQL membership ports must fit signed smallint',
  );
  assert.notEqual(raw.target.postgresPort, raw.target.grpcPort);
  if (raw.target.renderedConfiguration !== null) {
    exact(raw.target.renderedConfiguration, ['path', 'content']);
    localPath(raw.target.renderedConfiguration.path);
    artifact(raw.target.renderedConfiguration.content);
  }
  if (raw.target.archivedReadback != null) {
    assert.ok(raw.recoverySet !== null, 'archived readback requires a recovery set');
    exact(raw.target.archivedReadback, ['path', 'content']);
    localPath(raw.target.archivedReadback.path);
    artifact(raw.target.archivedReadback.content);
  }
  exact(raw.budget, [
    'mainMs',
    'outerMs',
    'cleanupMs',
    'maxObservedDiskBytes',
    'postgresSharedBuffersMb',
    'postgresMaxConnections',
    'temporalMaxObservedRssBytes',
  ]);
  for (const value of Object.values(raw.budget))
    assert.ok(Number.isSafeInteger(value) && value > 0, 'positive resource budget required');
  assert.ok(
    raw.budget.outerMs >= raw.budget.mainMs + 2 * raw.budget.cleanupMs &&
      raw.budget.outerMs <= raw.budget.mainMs + 600000,
    'bounded outer window with two cleanup stages required',
  );
  assert.ok(
    raw.budget.mainMs <= 1_800_000 && raw.budget.cleanupMs <= 60_000,
    'bounded window required',
  );
  assert.ok(
    raw.budget.postgresSharedBuffersMb <= 256 && raw.budget.postgresMaxConnections <= 64,
    'bounded PostgreSQL settings required',
  );
  exact(raw.authorization, [
    'evidence',
    'sourceQuiescenceVerified',
    'writerReconciliationVerified',
  ]);
  assert.ok(raw.authorization.evidence === null || typeof raw.authorization.evidence === 'string');
  assert.equal(typeof raw.authorization.sourceQuiescenceVerified, 'boolean');
  assert.equal(typeof raw.authorization.writerReconciliationVerified, 'boolean');
  return raw;
}
function tool(path) {
  if (path === null || !existsSync(path)) return false;
  return (
    lstatSync(path).isFile() &&
    lstatSync(realpathSync(path)).isFile() &&
    (lstatSync(path).mode & 0o100) !== 0
  );
}
export function preparationPlan(raw, observations = {}) {
  const config = parseConfig(raw),
    blockers = [];
  if (config.recoverySet === null)
    blockers.push(
      'recovery-set-required: pinned source cut, database exports, artifacts, projections, workcopies and versions are missing',
    );
  else {
    if (observations.filesVerified !== true) blockers.push('recovery-set-not-verified');
    const readback = observations.archivedReadback?.status;
    if (readback === 'blocked-deadline') blockers.push('archived-readback-deadline-too-close');
    else if (readback !== 'within-window') blockers.push('archived-readback-window-unconfirmed');
  }
  for (const name of ['postgres', 'temporalServer', 'temporalSqlTool'])
    if (observations[name] !== true) blockers.push('executable-not-present: ' + name);
  if (observations.executablePinsVerified !== true)
    blockers.push('executable-pins-not-verified-before-execution');
  if (observations.toolVersionsVerified !== true)
    blockers.push('tool-versions-not-observed: executable presence is not compatibility');
  if (
    config.target.renderedConfiguration === null ||
    observations.targetConfigurationVerified !== true
  )
    blockers.push(
      'reviewed-target-configuration-required: localhost-only listeners and source datastore topology',
    );
  if (config.authorization.evidence === null || config.authorization.evidence.includes('REPLACE'))
    blockers.push('new-direct-service-authorization-required: historical budgets are closed');
  if (!config.authorization.sourceQuiescenceVerified)
    blockers.push(
      'source-quiescence-not-established: dump signatures and matching hashes do not establish a consistent cut',
    );
  if (!config.authorization.writerReconciliationVerified)
    blockers.push(
      'writer-and-grant-reconciliation-required: coordinate with T3; never recreate an owner from receipts',
    );
  return {
    schemaVersion: 1,
    status: blockers.length ? 'blocked' : 'prepared',
    operationMode: 'prepare-only',
    activationAllowed: false,
    serverStarts: 0,
    modelStarts: 0,
    blockers,
    requestedBudget: config.budget,
    approvedBudget: null,
    proposedAcquisition: temporalAcquisition,
    missingQualification: [
      'actual PostgreSQL restore and schema checks',
      'Temporal namespace/workflow/run IDs and protobuf histories/results',
      'same-backend in-flight continuation with T3 primary grants/effect reconciliation',
      'measured monotonic RPO/RTO and PostgreSQL/Temporal resources',
    ],
    sequence: [
      'Record source server/PostgreSQL/schema/Worker versions and the actual default/visibility datastore topology; no inferred database count',
      'Quiesce source writers/Workers/Temporal and establish the same cut; preserve unknown external effects and original grants without adopting them',
      'Create actual native dumps for the configured physical databases and pin both logical default/visibility stores to the declared cut; preserve all evidence/workcopy roots',
      'Verify the recovery-set before writing, stage into a new private destination; retain the immutable native dumps and materialize separate mutable database/workcopy targets',
      'After new explicit service authorization: initdb only in a new owned temporary directory; bind PostgreSQL and Temporal to localhost with the reviewed settings',
      'Restore each distinct physical database exactly once, fail on pg_restore/SQL/schema mismatch; no DROP of source or unrelated database',
      'Recheck the pinned archive readback window immediately before starting Temporal; then read every pinned namespace/workflow/run/history/result without models',
      'Keep activation blocked until T3 verifies current grants/writers/unknown effects and same-backend continuation; preserve FAIL/findings/Result and stale evidence',
      'Export raw proof, commands/logs, observed PID/RSS/CPU/disk, monotonic RPO/RTO and all failed checks; stop only owned services and verify their absence',
      'Remove only newly created temporary working copies after evidence export; preserve dumps/backup/proof and all source storage',
    ],
    cleanup: {
      postgres: 'pg_ctl -D <owned-temporary-root>/postgres -m immediate -w stop; verify status=3',
      temporal:
        'SIGTERM exact spawned PID, bounded wait then SIGKILL only that owned process; verify exit and listeners',
      files:
        'no live source deletion; incomplete sets remain non-activatable; no retry without budget',
    },
    limits: [
      'requested budgets are review inputs, not authorization',
      'observed disk/RSS checks are not OS quotas or hard RSS caps',
      'no cross-engine migration, workflow reset/import, owner reconstruction, background service or automatic retention',
    ],
  };
}
export function temporaryServicePlan(raw, root, toolsRoot) {
  const config = parseConfig(raw);
  localPath(root);
  localPath(toolsRoot);
  const pg = config.executables.postgresDirectory;
  assert.ok(pg !== null, 'PostgreSQL binaries must be supplied');
  const base = config.target.grpcPort;
  assert.ok(
    base <= 65528 && !(config.target.postgresPort >= base && config.target.postgresPort < base + 8),
    'service port range overlaps',
  );
  const services = {};
  for (const [index, name] of ['frontend', 'history', 'matching', 'worker'].entries())
    services[name] = {
      rpc: {
        grpcPort: base + index,
        membershipPort: base + 4 + index,
        bindOnIP: '127.0.0.1',
        ...(name === 'frontend' ? { httpPort: 0 } : {}),
      },
    };
  const sql = (databaseName, maxConns) => ({
    sql: {
      pluginName: 'postgres12',
      databaseName,
      connectAddr: '127.0.0.1:' + config.target.postgresPort,
      connectProtocol: 'tcp',
      user: 'aw_t4',
      password: '',
      maxConns,
      maxIdleConns: 1,
      maxConnLifetime: '1m',
    },
  });
  const server = {
    log: { stdout: true, level: 'warn' },
    persistence: {
      defaultStore: 't4-default',
      visibilityStore: 't4-visibility',
      numHistoryShards: 4,
      datastores: { 't4-default': sql('t4_temporal', 4), 't4-visibility': sql('t4_visibility', 2) },
    },
    global: {
      membership: { maxJoinDuration: '10s', broadcastAddress: '127.0.0.1' },
      pprof: { port: 0, host: '127.0.0.1' },
    },
    services,
    clusterMetadata: {
      enableGlobalNamespace: false,
      failoverVersionIncrement: 10,
      masterClusterName: 't4',
      currentClusterName: 't4',
      clusterInformation: {
        t4: {
          enabled: true,
          initialFailoverVersion: 1,
          rpcName: 'frontend',
          rpcAddress: '127.0.0.1:' + base,
        },
      },
    },
    dcRedirectionPolicy: { policy: 'noop' },
    publicClient: { hostPort: '127.0.0.1:' + base },
  };
  const data = join(root, 'postgres-source'),
    serverConfig = join(root, 'temporal.json'),
    sqlTool = config.executables.temporalSqlTool ?? join(toolsRoot, 'temporal-sql-tool'),
    temporalServer = config.executables.temporalServer ?? join(toolsRoot, 'temporal-server'),
    schemas = [
      ['t4_temporal', 'postgresql/v12/temporal'],
      ['t4_visibility', 'postgresql/v12/visibility'],
    ];
  const create = [],
    restore = [],
    dumps = [];
  for (const [database, schema] of schemas) {
    const connection = [
        '--plugin',
        'postgres12',
        '--ep',
        '127.0.0.1',
        '-p',
        String(config.target.postgresPort),
        '-u',
        'aw_t4',
        '--db',
        database,
      ],
      file = join(root, database + '.pgdump');
    create.push(
      [sqlTool, ...connection, 'create'],
      [sqlTool, ...connection, 'setup-schema', '-v', '0.0'],
      [sqlTool, ...connection, 'update-schema', '--schema-name', schema],
    );
    dumps.push([
      join(pg, 'pg_dump'),
      '-h',
      join(root, 'socket'),
      '-p',
      String(config.target.postgresPort),
      '-U',
      'aw_t4',
      '-Fc',
      '-d',
      database,
      '-f',
      file,
    ]);
    restore.push(
      [
        join(pg, 'createdb'),
        '-h',
        join(root, 'socket'),
        '-p',
        String(config.target.postgresPort),
        '-U',
        'aw_t4',
        database,
      ],
      [
        join(pg, 'pg_restore'),
        '-h',
        join(root, 'socket'),
        '-p',
        String(config.target.postgresPort),
        '-U',
        'aw_t4',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '-d',
        database,
        join(root, 'restored/artifacts', '<' + database + '-dump-sha256>'),
      ],
    );
  }
  return {
    operationMode: 'proposed-fresh-isolated-pg-temporal-source-and-restore',
    proposedBudget: config.budget,
    proposedOuterWindowMinutes: config.budget.outerMs / 60000,
    timeBoundary: {
      clock: 'one monotonic start at runner entry, before executable pins and SDK imports',
      work: 'every command, SDK operation, acquisition and observer uses the remaining main deadline',
      cleanup:
        'one absolute outer deadline; SDK closes and first owned Temporal stop/observations share one cleanupMs stage; a second cleanupMs stage is reserved for PostgreSQL stop/observations; additional Temporal fallback uses only the original outer remainder',
      minimumCleanupReserveMs: 2 * config.budget.cleanupMs,
      exhausted:
        'no new native command, SDK acquisition/RPC or process observer after its deadline; preserve UNKNOWN/error and working root without inventing STOP',
      synchronousIo:
        'deadline checks surround filesystem verification/export; forced interruption of synchronous filesystem I/O is not qualified',
    },
    budgetAuthority:
      'proposal only; historical permission/budget is closed; no expansion of earlier grants',
    serverStarts: 0,
    modelStarts: 0,
    resumePending: config.resumePending === true,
    sourceWorkloadProvider:
      config.resumePending === true
        ? 'test-only fresh source/target fixture: restore one pending workflow, then exactly one Signal completes its original result; no Activities/models, real writer or grant restoration'
        : 'test-only SDK fixture: two completed histories preserving PASS/FAIL/findings/Result plus one query-only pending workflow; no Activities/models, no production T3 writer or grant restoration, no import from SQLite/legacy',
    primaryRetentionReadback: {
      namespace: 'primary DescribeNamespace response retained by hash before source stop',
      runs: 'primary Describe/complete history/result per exact namespace/workflow/run; open state never inferred from null result alone',
      deletionDeadline:
        'after source stop, read only timer_tasks from the actual immutable default native dump using pinned pg_restore --data-only --table=timer_tasks --file=-; bind Proto3 DeleteHistoryEvent task type 16, namespace ID, workflow/run, task ID and payload visibility_time to SQL visibility_timestamp; never derive from age or assumed TTL',
      window:
        'each closed deleteAtMs must be strictly later than now + budget.outerMs after export and again immediately before target Server start; missing/ambiguous/inconsistent data fails closed',
      export: [
        'source-namespace-response.json',
        'source-timer-tasks.json',
        'source-retention-observation.json',
        'archived-readback.json',
      ],
    },
    acquisition: {
      ...temporalAcquisition,
      destination: toolsRoot,
      commandsNotExecuted: [
        [
          'curl',
          '--fail',
          '--location',
          '--output',
          join(root, 'temporal.tar.gz'),
          temporalAcquisition.url,
        ],
        ['shasum', '-a', '256', join(root, 'temporal.tar.gz')],
        [
          process.execPath,
          join(packageRoot, 'tests/temporal/t4-pg-temporal-recovery.mjs'),
          '--extract-archive',
          'NEW-AUTHORIZED-OPERATOR-CONFIG.json',
          join(root, 'temporal.tar.gz'),
          toolsRoot,
        ],
      ],
      requiredArchiveHash: temporalAcquisition.sha256,
      extractionParent: dirname(toolsRoot),
      extractionParentPrerequisite:
        'new private canonical parent directory must be created only within approved acquisition scope; destination itself must not exist',
      executionPrerequisite:
        'strict extraction publishes binary-inventory.json; merge those refs into reviewed executablePins before any --version or service execution',
    },
    serverConfiguration: server,
    configurationPath: serverConfig,
    proposedPostgresConfiguration: {
      listen_addresses: '127.0.0.1',
      port: config.target.postgresPort,
      shared_buffers: config.budget.postgresSharedBuffersMb + 'MB',
      max_connections: config.budget.postgresMaxConnections,
      work_mem: '1MB',
      maintenance_work_mem: '16MB',
      max_parallel_workers: 0,
      max_worker_processes: 0,
      autovacuum: false,
      max_wal_size: '128MB',
      min_wal_size: '32MB',
      fsync: true,
      unix_socket_directories: join(root, 'socket'),
    },
    initialize: [
      [join(pg, 'initdb'), '-D', data, '-A', 'trust', '-U', 'aw_t4', '--no-locale', '-E', 'UTF8'],
      [
        join(pg, 'pg_ctl'),
        '-D',
        data,
        '-p',
        join(pg, 'postgres'),
        '-l',
        join(root, 'postgres-source.log'),
        '-w',
        'start',
      ],
    ],
    initializeFreshTargetAfterSourceStop: [
      [
        join(pg, 'initdb'),
        '-D',
        join(root, 'postgres-target'),
        '-A',
        'trust',
        '-U',
        'aw_t4',
        '--no-locale',
        '-E',
        'UTF8',
      ],
      [
        join(pg, 'pg_ctl'),
        '-D',
        join(root, 'postgres-target'),
        '-p',
        join(pg, 'postgres'),
        '-l',
        join(root, 'postgres-target.log'),
        '-w',
        'start',
      ],
    ],
    endpointIsolation:
      'native PG tools use only private Unix socket; SQL-tool and Temporal use owned loopback TCP, verified via postmaster PID/data-dir/socket/executable/listeners immediately before launch and SQL effects; no endpoint ownership guarantee is inferred from free port alone',
    binaryPinPrerequisite:
      'all native tools and fixed observers must match canonical regular single-link config refs before any execution and at each launch',
    schemaCreate: create,
    serverStart: [temporalServer, '--config-file', serverConfig, '--allow-no-auth', 'start'],
    dumpAfterQuiescence: dumps,
    restoreIntoFreshOwnedClusterOnly: restore,
    stop: [data, join(root, 'postgres-target')].map((ownedData) => [
      join(pg, 'pg_ctl'),
      '-D',
      ownedData,
      '-m',
      'immediate',
      '-w',
      'stop',
    ]),
    cleanupKeeper:
      'remove temporary root only after full PASS, complete immutable recovery/evidence verification and confirmed SDK/PG/Temporal stops including observed descendants/listeners; any FAIL/unknown retains root and data',
    requiredTransition:
      'Stop own source services; preserve completed source cut; initdb a distinct new restore cluster; never DROP source or unrelated databases; run the reviewed same server configuration against restored original database names',
    authority:
      'all acquisition/service commands are proposed only; require new direct approval and an exclusive budget; trust/no-auth limited to the new localhost-only test cluster',
  };
}
export async function freshServicePlan(raw, root) {
  const config = parseConfig(raw);
  assert.equal(config.recoverySet, null, 'fresh service preparation never imports an old archive');
  assert.equal(
    config.authorization.evidence,
    null,
    'prepare-only configuration must not claim authorization',
  );
  assert.notEqual(config.resumePending, true, 'this fresh window does not authorize a Signal');
  assert.equal(
    dirname(localPath(root)),
    realpathSync(config.target.parent),
    'new root must be a direct child of canonical target parent',
  );
  assert.ok(!existsSync(root), 'fresh proposed destination must not exist');
  const { assertAllExecutablePins } = await import('./t4-pg-temporal-binaries.mjs');
  const executablePins = assertAllExecutablePins(config, temporalAcquisition.sha256),
    plan = temporaryServicePlan(config, root, dirname(config.executables.temporalServer));
  return {
    ...plan,
    kind: 't4-fresh-service-preparation/1',
    operationMode: 'prepare-only',
    acquisition: {
      mode: 'existing-pinned-binaries-only',
      downloadAllowed: false,
      installationAllowed: false,
      commandsNotExecuted: [],
    },
    executablePins,
    requiresNewDirectServiceAuthorization: true,
    activationAllowed: false,
    proposedStartsAfterSeparateApproval: {
      postgres: 2,
      temporalServer: 2,
      sdkWorker: 2,
      workflow: 3,
      model: 0,
      signal: 0,
    },
    authority:
      'prepare-only; require separate exact direct approval for the existing runner, reviewed config/helper bytes, parent/prefix, localhost ports, budgets and export; no acquisition or installation',
    operationalRpo: 'UNKNOWN',
    operationalRto: 'UNKNOWN',
    workingRoot: {
      parent: config.target.parent,
      prefix: 'aw-t4-pg-temporal-',
      proposedExample: root,
      selection:
        'runner mkdtemp creates a new private direct child; it never reuses the example path',
    },
    evidenceExport: {
      parent: join(packageRoot, 'tmp'),
      prefix: 't4-pg-temporal-',
      preserveOnFailure: true,
    },
    limits: [
      'fresh source/target only; historical archive UNKNOWN is unchanged',
      'requested budgets are not authorization or operational RPO/RTO targets',
      'no downloads, installation, activation, models, external writers, or pending Signal',
    ],
  };
}
function archivedWorkflowState(bytes) {
  const { events } = JSON.parse(bytes);
  assert.ok(Array.isArray(events) && events.length > 0, 'archived history missing');
  const normalized = JSON.parse(
    historyToJSON({ events: events.map(({ eventType }) => ({ eventType })) }),
  ).events;
  assert.equal(normalized[0].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED');
  for (const { eventType } of normalized) {
    assert.ok(
      typeof eventType === 'string' && eventType !== 'EVENT_TYPE_UNSPECIFIED',
      'archived history state unknown',
    );
  }
  return terminalWorkflowEvent(normalized) === null ? 'open' : 'closed';
}

function archivedReadbackWindow(checked, proof, windowMs, historyState, now = Date.now) {
  exact(proof, ['kind', 'snapshot', 'defaultDump', 'workflows']);
  assert.equal(proof.kind, 't4-archived-readback/1');
  assert.deepEqual(artifact(proof.snapshot), checked.snapshotRef);
  const defaultStore = checked.snapshot.datastores.find(({ role }) => role === 'default');
  assert.deepEqual(artifact(proof.defaultDump), defaultStore.dump);
  assert.ok(Array.isArray(proof.workflows));
  const identity = ({ namespace, workflowId, runId }) =>
    JSON.stringify([namespace, workflowId, runId]);
  const expected = new Map(checked.snapshot.workflows.map((item) => [identity(item), item]));
  assert.equal(proof.workflows.length, expected.size, 'incomplete archived readback scope');
  let earliestDeleteAtMs = null;
  for (const entry of proof.workflows) {
    exact(entry, ['namespace', 'workflowId', 'runId', 'history', 'state', 'deleteAtMs']);
    const key = identity(entry);
    const workflow = expected.get(key);
    assert.ok(workflow, 'unknown or duplicate archived workflow');
    expected.delete(key);
    assert.deepEqual(artifact(entry.history), workflow.history);
    assert.equal(entry.state, historyState(workflow.history), 'archived workflow state mismatch');
    if (entry.state === 'open') {
      assert.equal(workflow.result, null, 'completed result marked open');
      assert.equal(entry.deleteAtMs, null);
    } else {
      assert.equal(entry.state, 'closed', 'archived workflow state unknown');
      assert.ok(
        Number.isSafeInteger(entry.deleteAtMs) && entry.deleteAtMs > 0,
        'deletion deadline unknown',
      );
      earliestDeleteAtMs = Math.min(earliestDeleteAtMs ?? entry.deleteAtMs, entry.deleteAtMs);
    }
  }
  const checkedAtMs = now(),
    windowEndsAtMs = checkedAtMs + windowMs;
  return {
    status:
      earliestDeleteAtMs !== null && earliestDeleteAtMs <= windowEndsAtMs
        ? 'blocked-deadline'
        : 'within-window',
    checkedAtMs,
    windowEndsAtMs,
    earliestDeleteAtMs,
  };
}

function observeArchivedReadback(config, checked, readHistory) {
  const ref = config.target.archivedReadback;
  if (!ref) return { status: 'blocked-unknown', reason: 'archived-readback-proof-required' };
  try {
    const bytes = readFileSync(ref.path);
    assert.equal(bytes.length, ref.content.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.content.sha256);
    return archivedReadbackWindow(checked, JSON.parse(bytes), config.budget.outerMs, (history) =>
      archivedWorkflowState(readHistory(history)),
    );
  } catch {
    return { status: 'blocked-unknown', reason: 'archived-readback-proof-invalid' };
  }
}

export async function preflight(raw) {
  const config = parseConfig(raw),
    observations = {},
    checks = [];
  if (config.recoverySet !== null) {
    const [{ verifyTemporalRecoverySet }, { artifactStore }] = await Promise.all([
      import(join(packageRoot, 'dist/adapters/artifacts/backup.js')),
      import(join(packageRoot, 'dist/adapters/artifacts/files.js')),
    ]);
    const checked = verifyTemporalRecoverySet(config.recoverySet);
    const blobs = artifactStore(join(config.recoverySet.backup, 'blobs'), { existingOnly: true });
    observations.filesVerified = true;
    observations.archivedReadback = observeArchivedReadback(config, checked, blobs.read);
    checks.push({ name: 'recovery-set', result: checked });
    checks.push({ name: 'archived-readback-window', result: observations.archivedReadback });
  }
  if (config.executables.postgresDirectory !== null)
    observations.postgres = ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore'].every(
      (name) => tool(join(config.executables.postgresDirectory, name)),
    );
  observations.temporalServer = tool(config.executables.temporalServer);
  observations.temporalSqlTool = tool(config.executables.temporalSqlTool);
  // File existence is deliberately not treated as a server/configuration/version or authority qualification.
  const plan = preparationPlan(config, observations);
  return { ...plan, checks, observations, requiredServiceCommandsNotExecuted: true };
}
export async function stage(raw, destination) {
  const config = parseConfig(raw);
  assert.ok(config.recoverySet !== null, 'pinned recovery-set required');
  localPath(destination);
  const { stageTemporalRecoverySet } = await import(
    join(packageRoot, 'dist/adapters/artifacts/backup.js')
  );
  return stageTemporalRecoverySet({ ...config.recoverySet, destination });
}
export function selfTest() {
  const config = {
    schemaVersion: 1,
    recoverySet: null,
    executables: { postgresDirectory: null, temporalServer: null, temporalSqlTool: null },
    executablePins: {},
    temporalBinaryInventory: null,
    target: {
      parent: '/private/tmp',
      postgresPort: 55438,
      grpcPort: 17239,
      renderedConfiguration: null,
    },
    budget: {
      mainMs: 180000,
      outerMs: 420000,
      cleanupMs: 20000,
      maxObservedDiskBytes: 1073741824,
      postgresSharedBuffersMb: 64,
      postgresMaxConnections: 32,
      temporalMaxObservedRssBytes: 1073741824,
    },
    authorization: {
      evidence: null,
      sourceQuiescenceVerified: false,
      writerReconciliationVerified: false,
    },
  };
  assert.deepEqual(parseConfig(config), config);
  assert.equal(parseConfig(config).resumePending === true, false);
  assert.equal(parseConfig({ ...config, resumePending: false }).resumePending, false);
  assert.equal(parseConfig({ ...config, resumePending: true }).resumePending, true);
  for (const resumePending of [null, 'true', 1, {}, []])
    assert.throws(() => parseConfig({ ...config, resumePending }));
  assert.throws(() => parseConfig({ ...config, resumePending: true, recoverySet: {} }));
  const blocked = preparationPlan(config);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.activationAllowed, false);
  assert.equal(blocked.serverStarts, 0);
  assert.ok(blocked.blockers.length >= 7);
  const ref = (digit) => ({ sha256: digit.repeat(64), bytes: 10 });
  const archived = {
    ...config,
    recoverySet: {
      schemaVersion: 1,
      backup: '/fixture/backup',
      manifest: ref('1'),
      snapshot: ref('2'),
    },
  };
  const completed = {
    namespace: 'fixture',
    workflowId: 'closed',
    runId: 'run-1',
    history: ref('3'),
  };
  const open = { namespace: 'fixture', workflowId: 'open', runId: 'run-2', history: ref('4') };
  const checked = {
    snapshotRef: archived.recoverySet.snapshot,
    snapshot: {
      datastores: [{ role: 'default', dump: ref('5') }],
      workflows: [
        { ...completed, result: ref('6') },
        { ...open, result: null },
      ],
    },
  };
  const proof = {
    kind: 't4-archived-readback/1',
    snapshot: checked.snapshotRef,
    defaultDump: ref('5'),
    workflows: [
      { ...completed, state: 'closed', deleteAtMs: 2001 },
      { ...open, state: 'open', deleteAtMs: null },
    ],
  };
  const attached = {
    ...archived,
    target: {
      ...archived.target,
      archivedReadback: { path: '/fixture/proof.json', content: ref('7') },
    },
  };
  assert.deepEqual(parseConfig(attached), attached);
  assert.throws(() => parseConfig({ ...attached, recoverySet: null }));
  const readbackWindow = (value, at) =>
    archivedReadbackWindow(
      checked,
      value,
      1000,
      (history) => (history.sha256 === completed.history.sha256 ? 'closed' : 'open'),
      () => at,
    );
  assert.equal(readbackWindow(proof, 1000).status, 'within-window');
  assert.equal(readbackWindow(proof, 1001).status, 'blocked-deadline');
  assert.equal(readbackWindow(proof, 2002).status, 'blocked-deadline');
  assert.equal(
    observeArchivedReadback(archived, checked).reason,
    'archived-readback-proof-required',
  );
  assert.equal(
    observeArchivedReadback(attached, checked).reason,
    'archived-readback-proof-invalid',
  );
  for (const bad of [
    { ...proof, snapshot: ref('0') },
    { ...proof, defaultDump: ref('0') },
    { ...proof, workflows: [proof.workflows[0]] },
    { ...proof, workflows: [proof.workflows[0], proof.workflows[0]] },
    { ...proof, workflows: [{ ...proof.workflows[0], runId: 'wrong' }, proof.workflows[1]] },
    { ...proof, workflows: [{ ...proof.workflows[0], history: ref('0') }, proof.workflows[1]] },
    {
      ...proof,
      workflows: [{ ...proof.workflows[0], state: 'open', deleteAtMs: null }, proof.workflows[1]],
    },
    { ...proof, workflows: [{ ...proof.workflows[0], deleteAtMs: null }, proof.workflows[1]] },
  ])
    assert.throws(() => readbackWindow(bad, 1000));
  const readbackBlockers = (status) =>
    preparationPlan(archived, {
      filesVerified: true,
      archivedReadback: { status },
    }).blockers.filter((value) => value.startsWith('archived-readback'));
  assert.deepEqual(readbackBlockers('blocked-unknown'), ['archived-readback-window-unconfirmed']);
  assert.deepEqual(readbackBlockers('blocked-deadline'), ['archived-readback-deadline-too-close']);
  assert.deepEqual(readbackBlockers('within-window'), []);
  assert.ok(!blocked.blockers.some((value) => value.startsWith('archived-readback')));
  const service = temporaryServicePlan(
    { ...config, executables: { ...config.executables, postgresDirectory: '/fixture/postgres' } },
    '/private/tmp/aw-t4-review',
    '/private/tmp/aw-t4-review/tools',
  );
  assert.equal(service.resumePending, false);
  assert.equal(service.serverConfiguration.persistence.defaultStore, 't4-default');
  assert.equal(service.serverConfiguration.services.frontend.rpc.httpPort, 0);
  assert.ok(
    Object.values(service.serverConfiguration.services).every(
      (value) => value.rpc.bindOnIP === '127.0.0.1',
    ),
  );
  assert.equal(service.schemaCreate.length, 6);
  assert.equal(service.restoreIntoFreshOwnedClusterOnly.length, 4);
  assert.throws(() =>
    temporaryServicePlan(
      {
        ...config,
        executables: { ...config.executables, postgresDirectory: '/fixture/postgres' },
        target: { ...config.target, grpcPort: 65535 },
      },
      '/private/tmp/review',
      '/private/tmp/review/tools',
    ),
  );
  for (const invalid of [
    { ...config, schemaVersion: 2 },
    { ...config, target: { ...config.target, grpcPort: 543 } },
    { ...config, target: { ...config.target, grpcPort: 55438 } },
    { ...config, target: { ...config.target, parent: 'relative' } },
    { ...config, budget: { ...config.budget, mainMs: 1800001 } },
    { ...config, authorization: { ...config.authorization, sourceQuiescenceVerified: 'yes' } },
  ])
    assert.throws(() => parseConfig(invalid));
  console.log(
    JSON.stringify({
      status: 'PASS',
      scope: 'pure-recovery-preparation-contract',
      serverStarts: 0,
      modelStarts: 0,
      actualTemporalPostgresqlRestore: 'NOT RUN',
    }),
  );
}
