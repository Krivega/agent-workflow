import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { artifactStore, publishFile } from '../src/adapters/artifacts/files.ts';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.ts';
import { startControlledReader } from '../src/client/reader.ts';
import { bindTaskBackendClient } from '../src/client/taskBackend.ts';
import { createReaderHost } from '../src/worker/readerHost.ts';
import { h04Pin, readH04Pin } from './comparisonH04Contract.ts';
import { openH06NativeTransport } from './comparisonH06NativeTransport.ts';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.ts';
import { verifyH06NativeTemporalServer } from './comparisonH06NativeTemporalServer.ts';
import { canonical, digest } from '../adapters/storage/storeCodec.ts';
import { readTD054Claim, observeTD054Processes, remainingTD054 } from './td054DeadlineContract.mjs';

function record(path, value) {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

async function boundedRead(operation, ms, deadline) {
  const timeout = Math.min(ms, remainingTD054(deadline));
  const abort = new globalThis.AbortController();
  try {
    const result = await Promise.race([
      operation(),
      pause(timeout, undefined, { signal: abort.signal }).then(() => {
        throw new Error('td054-primary-read-timeout');
      }),
    ]);
    remainingTD054(deadline);
    return result;
  } finally {
    abort.abort();
  }
}

/** One ReaderWorkflow LOAD inside the existing H06-owned transport and process supervisor. */
export async function runTD054DeadlineLoad(input, signal) {
  signal.throwIfAborted();
  assert.deepEqual(Object.keys(input).sort(), ['claim', 'node', 'server']);
  const claim = await readTD054Claim(input.claim);
  const { packet, workDeadlineMs, stopDeadlineMs } = claim;
  assert.deepEqual(input.node, packet.binaryPins.node);
  const server = h04Pin(input.server);
  await verifyH06NativeTemporalServer(
    { ...packet.server, requestHash: packet.requestHash },
    server,
    workDeadlineMs,
  );
  const connection = await NativeConnection.connect({ address: packet.server.address });
  let transport;
  let started;
  const root = packet.evidenceRoot;
  const ledger = openH06NativeTurnLedger(join(root, 'turns'), {
    mode: 'create',
    operationId: packet.operationId,
    maxManagedStarts: 1,
  });
  try {
    signal.throwIfAborted();
    artifactStore(join(root, 'artifacts'));
    transport = await openH06NativeTransport({
      operationId: packet.operationId,
      binary: packet.binaryPins.appServer,
      workspaceRoot: packet.workspaceRoot,
      copyRoot: join(root, 'copies'),
      evidenceRoot: join(root, 'transport-initial'),
      profile: packet.profile,
      disabledServers: packet.disabledServers,
      workDeadlineMs,
      stopDeadlineMs,
      readerLoadProbe: {
        node: packet.binaryPins.node,
        waitMs: packet.proposedBounds.foregroundWaitMs,
      },
      admitTurn: ledger.admitTurn,
      async recordTurn(turn) {
        await ledger.recordTurn(turn);
        assert.equal(started, undefined, 'no second native turn');
        assert.equal(turn.role, 'reader');
        started = { ...turn, observedAt: Date.now() };
        record(join(root, 'load-started.json'), started);
      },
    });
    const registration = {
      project: packet.input.preparation.project,
      hostId: packet.operationId,
      owner: packet.input.preparation.owner,
      generation: packet.input.preparation.generation,
      workspaceRoot: packet.workspaceRoot,
      artifactRoot: join(root, 'artifacts'),
      commands: Object.fromEntries(
        packet.input.preparation.project.checks.map((name) => [
          name,
          { executable: packet.binaryPins.node.path, args: ['--check'] },
        ]),
      ),
    };
    const authority = nativeReaderAuthority(artifactStore(registration.artifactRoot), {
      sessionsRoot: claim.nativeGrant.sessionsRoot,
      workspaceRoot: packet.chat.workspace,
      threadId: packet.chat.threadId,
      owner: registration.owner,
    });
    const host = await createReaderHost(
      connection,
      packet.taskQueue,
      packet.workflows.path,
      [{ registration, rpc: transport.rpc, authority }],
      packet.profile,
      join(root, 'reader-host'),
      1,
    );
    const client = bindTaskBackendClient(new Client({ connection }), registration);
    await host.runUntil(async () => {
      signal.throwIfAborted();
      const handle = await startControlledReader(client, packet.input, packet.taskQueue);
      record(join(root, 'workflow-started.json'), {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      });
      let interrupted;
      const cancelled = new Promise((_, reject) => {
        interrupted = () => reject(signal.reason ?? new Error('td054-interrupted'));
        signal.addEventListener('abort', interrupted, { once: true });
        if (signal.aborted) interrupted();
      });
      try {
        await Promise.race([
          cancelled,
          handle.result().then(() => {
            throw new Error('td054-load-completed-before-deadline');
          }),
        ]);
      } catch (failure) {
        if (signal.aborted && Date.now() >= workDeadlineMs && started !== undefined) {
          const primary = await boundedRead(
            () =>
              transport.rpc.request('thread/read', {
                threadId: started.session,
                includeTurns: true,
              }),
            4000,
            stopDeadlineMs,
          );
          const observedAt = Date.now();
          const snapshot = record(join(root, 'load-at-deadline.json'), {
            kind: 'td054-primary-load-at-deadline/1',
            started,
            primary,
            workDeadlineMs,
            stopDeadlineMs,
            observedAt,
          });
          const turns = primary.thread?.turns?.filter((turn) => turn.id === started.turnId);
          assert.equal(primary.thread?.id, started.session);
          assert.equal(turns?.length, 1, 'one primary LOAD turn required');
          assert.equal(turns[0].status, 'inProgress', 'LOAD must still be ACTIVE at deadline');
          record(join(root, 'active-confirmed.json'), { snapshot, observedAt });
          await client.connection.withDeadline(Math.min(stopDeadlineMs, Date.now() + 2000), () =>
            handle.cancel(),
          );
        }
        throw failure;
      } finally {
        signal.removeEventListener('abort', interrupted);
      }
    });
    throw new Error('td054-unexpected-reader-completion');
  } finally {
    try {
      if (transport !== undefined) {
        await transport.stop();
        const path = join(root, 'transport-initial/transport-stop.json');
        const stop = h04Pin({ path, sha256: digest(readFileSync(path)) });
        const receipts = JSON.parse(readH04Pin(stop).toString()).receipts;
        const identities = receipts.flatMap((receipt) => receipt.processes);
        assert.deepEqual(observeTD054Processes(identities, stopDeadlineMs), []);
        record(join(root, 'transport-stop-observed.json'), {
          stop,
          identities,
          observedAt: Date.now(),
        });
      }
    } finally {
      await connection.close();
    }
  }
}
