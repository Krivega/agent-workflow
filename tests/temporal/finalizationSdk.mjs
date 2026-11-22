import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { finalizationActivities } from '../../dist/activities/finalization.js';
import { makeArchiveCommand, startFinalization } from '../../dist/client/finalization.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import { finalizationTarget } from '../../dist/policy/finalization.js';
import { inspectFileBackup, verifyBackup } from '../../dist/adapters/artifacts/backup.js';
import { readerHeartbeat } from '../../dist/worker/readerHeartbeat.js';

export function finalizationBundleOptions(packageRoot, mode) {
  return {
    workflowsPath: join(packageRoot, 'dist/workflows/finalization.js'),
    ...(mode === '--finalization-timeout-cancel'
      ? {
          workflowInterceptorModules: [
            join(packageRoot, 'tests/temporal/finalization-timeout-interceptor.mjs'),
          ],
        }
      : {}),
  };
}
export async function qualifyFinalization({
  environment,
  packageRoot,
  evidence,
  registration,
  preparation,
  result,
  main,
  queue,
  mode,
  before,
  save,
}) {
  bindTaskBackendClient(environment.client, registration);
  const beforeCopy = mode === '--finalization-cancel-before',
    afterCopy = mode === '--finalization-cancel-after',
    timeout = mode === '--finalization-timeout-cancel';
  const directory = join(evidence, 'finalization'),
    receipts = artifactStore(join(directory, 'artifacts'));
  const own = (value) => receipts.publish(Buffer.from(JSON.stringify(value)));
  const backup = {
    schemaVersion: 2,
    roots: { artifacts: registration.artifactRoot },
    destination: join(evidence, 'task-archive'),
  };
  const inspected = inspectFileBackup(backup),
    inventory = own(inspected.inventory);
  assert.deepEqual(inventory, inspected.manifest);
  const payload = own({
    schemaVersion: 1,
    kind: 'task-archive-authorization',
    result: result.result,
    backup,
    inventory,
  });
  const input = {
    schemaVersion: 1,
    operation: 'archive',
    preparation,
    result: result.result,
    command: {
      schemaVersion: 3,
      commandId: 'archive-one',
      hash: '0'.repeat(64),
      target: {},
      expectedRevision: 0,
      author: preparation.owner,
      action: 'archive',
      attempt: 0,
      source: own({ kind: 'simulated-human-archive-source', native: false }),
      payload,
    },
  };
  input.command = makeArchiveCommand({ ...input.command, target: finalizationTarget(input) });
  let release,
    entered = false,
    cancellationObserved = false,
    activityExited = false,
    calls = 0,
    observations = 0,
    copies = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actual = finalizationActivities(
    registration,
    {
      async verify(command) {
        if (beforeCopy || timeout) {
          entered = true;
          const context = Context.current();
          context.cancelled.catch(() => {
            cancellationObserved = true;
          });
          await gate;
        }
        return {
          origin: 'human',
          author: command.author,
          hash: command.hash,
          proof: own({ kind: 'simulated-human-archive-authority', native: false, command }),
        };
      },
    },
    directory,
  );
  const bundleOptions = finalizationBundleOptions(packageRoot, mode),
    workflowBundle = await bundleWorkflowCode(bundleOptions);
  save('finalization-fixture.json', {
    mode,
    native: false,
    bundleOptions,
    controlledTimeout: timeout
      ? { startToCloseTimeoutMs: 1000, scope: 'SDK fixture outbound interceptor' }
      : null,
    interceptor: timeout ? digest(readFileSync(bundleOptions.workflowInterceptorModules[0])) : null,
  });
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: queue + '.finalization',
    workflowBundle,
    maxConcurrentActivityTaskExecutions: 1,
    maxHeartbeatThrottleInterval: '1 second',
    activities: {
      archiveFinalizedTask(value) {
        calls++;
        return readerHeartbeat(async () => {
          try {
            const outcome = await actual.archiveFinalizedTask(value);
            copies++;
            if (afterCopy) {
              entered = true;
              Context.current().cancelled.catch(() => {
                cancellationObserved = true;
              });
              await gate;
            } else if (!beforeCopy && !timeout)
              throw new Error('Injected lost Activity response after archive completion');
            return outcome;
          } finally {
            activityExited = true;
          }
        });
      },
      reconcileFinalizedTask(value) {
        observations++;
        return actual.reconcileFinalizedTask(value);
      },
    },
  });
  const until = Date.now() + 60000;
  async function waitFor(condition, message) {
    while (!(await condition())) {
      assert.ok(Date.now() < until, message);
      await sleep(25);
    }
  }
  await worker.runUntil(async () => {
    try {
      const archived = await startFinalization(environment.client, input, queue + '.finalization');
      assert.equal(
        (await startFinalization(environment.client, input, queue + '.finalization')).workflowId,
        archived.workflowId,
      );
      if (beforeCopy || afterCopy || timeout) {
        await waitFor(() => entered, 'Archive activity must reach its actual held boundary');
        if (timeout)
          await waitFor(
            async () => (await archived.query('finalizationStatus')).phase === 'unknown',
            'The real server timeout must preserve unknown',
          );
        await archived.cancel();
        await waitFor(
          () => cancellationObserved,
          'Heartbeat must deliver cancellation to the held activity',
        );
        const pending = await archived.query('finalizationStatus');
        assert.equal((await archived.describe()).status.name, 'RUNNING');
        assert.equal(pending.cancellationRequested, true);
        assert.equal(pending.phase, timeout ? 'unknown' : 'archiving');
        assert.equal(activityExited, false);
        assert.equal(copies, afterCopy ? 1 : 0);
        assert.equal(existsSync(backup.destination), afterCopy);
        save('pending-finalization-history.json', await archived.fetchHistory());
        save('pending-finalization-source-before.json', before);
        save('pending-finalization-state.json', {
          pending,
          activityExited,
          cancellationObserved,
          copies,
          native: false,
        });
        release();
        await waitFor(() => activityExited, 'The original activity must actually exit');
        if (timeout) {
          await archived.signal('finalizationReconcile');
          await waitFor(
            async () =>
              (await archived.query('finalizationStatus')).error === 'archive-effect-missing',
            'A read-only missing intent must remain unknown',
          );
          const unknown = await archived.query('finalizationStatus');
          assert.equal((await archived.describe()).status.name, 'RUNNING');
          assert.equal(unknown.phase, 'unknown');
          assert.equal(copies, 0);
          assert.equal(calls, 1);
          assert.equal(observations, 1);
          assert.equal(existsSync(backup.destination), false);
          assert.equal(readdirSync(join(directory, 'effects')).length, 0);
          save('unknown-finalization-history.json', await archived.fetchHistory());
          save('finalization-result.json', {
            input,
            status: 'unknown-preserved',
            unknown,
            calls,
            observations,
            copies,
            activityExited,
            native: false,
            cleanup: 'administrative terminate only after observed activity exit',
          });
          await archived.terminate(
            'Bounded SDK fixture cleanup after primary Activity exit; unknown is preserved in exported evidence',
          );
        } else if (beforeCopy) {
          await assert.rejects(
            archived.result(),
            (error) => error.cause?.name === 'CancelledFailure',
          );
          assert.equal(copies, 0);
          assert.equal(existsSync(backup.destination), false);
          save('finalization-result.json', {
            input,
            status: 'cancelled-before-copy',
            calls,
            observations,
            copies,
            activityExited,
            native: false,
          });
        } else {
          const outcome = await archived.result();
          assert.equal(outcome.status, 'archived');
          assert.deepEqual(outcome.manifest, inventory);
          assert.equal(copies, 1);
          assert.equal(calls, 1);
          save('finalization-result.json', {
            input,
            result: outcome,
            receipt: JSON.parse(receipts.read(outcome.receipt).toString()),
            calls,
            observations,
            copies,
            activityExited,
            native: false,
          });
        }
      } else {
        await waitFor(
          async () => (await archived.query('finalizationStatus')).phase === 'unknown',
          'Lost response must wait for read-only reconciliation',
        );
        save('pending-finalization-history.json', await archived.fetchHistory());
        save('pending-finalization-source-before.json', before);
        await archived.signal('finalizationReconcile');
        const outcome = await archived.result();
        assert.equal(outcome.status, 'archived');
        assert.deepEqual(outcome.manifest, inventory);
        assert.equal(calls, 1);
        assert.equal(observations, 1);
        assert.equal(copies, 1);
        assert.equal(
          verifyBackup({ schemaVersion: 1, backup: backup.destination, manifest: inventory }).scope,
          'files-only',
        );
        save('finalization-result.json', {
          input,
          result: outcome,
          receipt: JSON.parse(receipts.read(outcome.receipt).toString()),
          calls,
          observations,
          copies,
          native: false,
        });
      }
      assert.equal((await main.query('localTaskStatus')).phase, 'done');
      assert.equal(inspectFileBackup(backup).manifest.sha256, inventory.sha256);
    } finally {
      release();
    }
  });
}
