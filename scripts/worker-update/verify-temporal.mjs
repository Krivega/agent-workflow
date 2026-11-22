import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [activePackage, settings, evidence, artifacts, rawPid] = process.argv.slice(2);
const { Client, Connection } = createRequire(join(activePackage, 'package.json'))(
  '@temporalio/client',
);
const expected = JSON.parse(readFileSync(evidence));
const registration = JSON.parse(settings);
const { address, namespace, taskQueue } = registration;
const connection = await Connection.connect({ address, connectTimeout: 5000 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  await connection.withDeadline(Date.now() + 10000, async () => {
    const client = new Client({ connection, namespace });
    const { status } = await connection.healthService.check({
      service: 'temporal.api.workflowservice.v1.WorkflowService',
    });
    assert.equal(status, 1, 'Temporal frontend is not SERVING');
    const system = await connection.workflowService.getSystemInfo({});
    const description = await connection.workflowService.describeNamespace({ namespace });
    assert.equal(description.namespaceInfo.name, namespace);
    const running = [];
    for await (const execution of client.workflow.list({ query: "ExecutionStatus = 'Running'" })) {
      running.push({
        workflowId: execution.workflowId,
        runId: execution.runId,
        taskQueue: execution.taskQueue,
      });
    }
    console.log(
      JSON.stringify({
        health: 'SERVING',
        serverVersion: system.serverVersion,
        namespace,
        running,
      }),
    );
    assert.equal(running.length, 0, 'The namespace has active workflows');

    if (rawPid) {
      for (const [name, type, label] of [
        [taskQueue, 1, 'Workflow'],
        [taskQueue, 2, 'Activity'],
        [taskQueue + '.control', 2, 'Activity'],
      ]) {
        const result = await connection.workflowService.describeTaskQueue({
          namespace,
          taskQueue: { name, kind: 1 },
          taskQueueType: type,
        });
        const pollers = result.pollers?.map((worker) => worker.identity) ?? [];
        console.log(JSON.stringify({ queue: name, type: label, pollers }));
        assert(
          pollers.some((identity) => identity.startsWith(rawPid + '@')),
          'New Worker PID has not polled ' + name + ' as ' + label,
        );
      }
    }

    const handle = client.workflow.getHandle(expected.workflowId, expected.runId);
    const run = await handle.describe();
    assert.equal(run.runId, expected.runId);
    assert.equal(run.status.name, 'COMPLETED');
    const result = await handle.result({ followRuns: false });
    assert.deepEqual(result, expected.result);
    assert.equal(result.status, 'done');
    assert.equal(sha(JSON.stringify(result)), expected.responseSHA256);
    const artifact = readFileSync(join(artifacts, result.result.sha256));
    assert.equal(artifact.length, result.result.bytes);
    assert.equal(sha(artifact), expected.artifactSHA256);
    console.log(
      JSON.stringify({
        workflowId: expected.workflowId,
        runId: run.runId,
        temporalStatus: run.status.name,
        result: result.status,
        artifactSHA256: sha(artifact),
        responseSHA256: sha(JSON.stringify(result)),
        bytes: artifact.length,
      }),
    );
  });
} finally {
  await connection.close();
}
