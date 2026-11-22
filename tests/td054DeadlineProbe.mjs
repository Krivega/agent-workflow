// td054-reference:imports:begin
import {
  prepareTD054Reference,
  checkTD054Reference,
  td054ReferenceSource,
} from './td054DeadlineContract.mjs';
export {
  prepareTD054Reference,
  checkTD054Reference,
  td054ReferenceSource,
} from './td054DeadlineContract.mjs';
// td054-reference:imports:end
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical } from '../adapters/storage/storeCodec.ts';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.ts';
import { h04Pin, readH04Pin } from './comparisonH04Contract.ts';
import { claimH06NativeAttemptDirectory } from './comparisonH06NativeAttempt.ts';
import { withH06NativeTemporalServer } from './comparisonH06NativeTemporalServerSetup.ts';
import { resolveH06NativeGrant } from './comparisonH06NativeAuthority.ts';
import {
  bindH06NativeUsageParticipants,
  checkH06NativeUsage,
  sealH06NativeUsage,
} from './comparisonH06NativeUsage.ts';
import {
  exact,
  pin,
  json,
  record,
  grantPlan,
  grants,
  td054ProposedBounds,
  prepareTD054DeadlineProbe,
  checkTD054DeadlineProbe,
  planTD054DeadlineProbe,
  readTD054SavedClaim,
  remainingTD054,
  observeTD054Processes,
} from './td054DeadlineContract.mjs';
export {
  td054ProposedBounds,
  prepareTD054DeadlineProbe,
  checkTD054DeadlineProbe,
  planTD054DeadlineProbe,
  readTD054Claim,
  readTD054SavedClaim,
  remainingTD054,
  observeTD054Processes,
} from './td054DeadlineContract.mjs';

const entry = fileURLToPath(import.meta.url),
  packageRoot = resolve(dirname(entry), '..');
const workerEntry = join(packageRoot, 'tests/comparisonH06NativeTemporalProcesses.ts');

function absentPorts(packet, deadline) {
  const ports = [
    Number(packet.server.address.split(':')[1]),
    packet.server.httpPort,
    packet.server.metricsPort,
  ];
  return ports.map((port) => {
    try {
      execFileSync('/usr/sbin/lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
        timeout: Math.min(2000, remainingTD054(deadline)),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail('probe listener remains or observation is unknown');
    } catch (error) {
      assert.ok(
        error.status === 1 && error.stdout === '' && error.stderr === '',
        'listener observation unknown or occupied',
      );
    }
    remainingTD054(deadline);
    return { port, absent: true };
  });
}

/** Both independent exact grants are checked before the common one-shot root or any launch. */
export async function runTD054DeadlineProbe(packet, sources, signal) {
  packet = globalThis.structuredClone(packet);
  if (sources !== undefined) sources = globalThis.structuredClone(sources);
  if (sources === undefined) sources = await resolveH06NativeGrant(grantPlan(packet));
  const observed = await grants(packet, sources);
  signal.throwIfAborted();
  assert.equal(lstatSync(packet.serverRoot, { throwIfNoEntry: false }), undefined);
  const startedAt = Date.now(),
    budget = packet.proposedBounds;
  const claim = {
    kind: 'td054-native-load-deadline-claim/1',
    packet,
    startedAt,
    workDeadlineMs: startedAt + budget.workWindowMs,
    stopDeadlineMs: startedAt + budget.workWindowMs + budget.stopReserveMs,
    finalDeadlineMs: startedAt + budget.maxElapsedMs,
    ...observed,
  };
  // td054-reference:reference-claim:begin
  if (observed.referenceApproval !== undefined)
    claim.kind = 'td054-native-load-deadline-reference-claim/2';
  // td054-reference:reference-claim:end
  claimH06NativeAttemptDirectory(packet.evidenceRoot);
  const claimPin = record(join(packet.evidenceRoot, 'attempt-claim.json'), claim);
  createPrivateDirectory(packet.serverRoot);
  try {
    return await executeTD054DeadlineClaim(packet, claimPin, claim, signal);
  } catch (error) {
    const result = {
      kind: 'td054-native-load-deadline-result/1',
      status: 'UNKNOWN',
      requestHash: packet.requestHash,
      claim: claimPin,
      error: String(error),
      nativeDeadline: 'UNKNOWN',
      r12FormalColdStop: 'UNKNOWN',
      r13NormalCompletion: 'UNCHANGED',
      qualification: false,
      mayRun: false,
      sourceClaimIssued: false,
    };
    record(join(packet.evidenceRoot, 'live-result.json'), result);
    return result;
  }
}

async function executeTD054DeadlineClaim(packet, claimPin, claim, signal) {
  const budget = packet.proposedBounds;
  let failure;
  try {
    const { h06TemporalWorkerProcesses } =
      await import('./comparisonH06NativeTemporalProcesses.ts');
    const workers = h06TemporalWorkerProcesses(
      {
        node: packet.binaryPins.node,
        tsx: packet.binaryPins.tsx,
        entry: pin(workerEntry),
        workDeadlineMs: claim.workDeadlineMs,
        stopDeadlineMs: claim.stopDeadlineMs,
      },
      {
        source: async () => {
          throw new Error('td054-no-phase-command');
        },
        record: async () => {
          throw new Error('td054-no-phase-command');
        },
      },
    );
    await withH06NativeTemporalServer(
      {
        expected: { ...packet.server, requestHash: packet.requestHash },
        deadlineMs: claim.stopDeadlineMs,
        stopReserveMs: budget.stopReserveMs,
        signal,
      },
      (server, state) =>
        workers.deadlineLoad({ claim: claimPin, server, node: packet.binaryPins.node }, state),
    );
  } catch (error) {
    failure = String(error);
  }
  const serverStop = pin(join(packet.serverRoot, 'server-stop.json'));
  record(join(packet.evidenceRoot, 'server-stop-observed.json'), {
    stop: serverStop,
    observedAt: Date.now(),
    failure: failure ?? null,
  });
  const names = [
    'load-started.json',
    'load-at-deadline.json',
    'active-confirmed.json',
    'workflow-started.json',
    'transport-stop-observed.json',
    'transport-initial/transport-stop.json',
    'transport-initial/reader-0.jsonl.diagnostics.json',
  ];
  const fixed = [
    ...names.map((name) => pin(join(packet.evidenceRoot, name))),
    pin(join(packet.serverRoot, 'worker-deadline-load-outcome.json')),
    serverStop,
    pin(join(packet.evidenceRoot, 'server-stop-observed.json')),
  ];
  const transport = json(fixed.find((ref) => ref.path.endsWith('transport-stop-observed.json')));
  const worker = json(fixed.find((ref) => ref.path.endsWith('worker-deadline-load-outcome.json')));
  const server = json(serverStop);
  const identities = [
    ...transport.identities,
    ...[...worker.receipt.identities, ...server.receipt.identities].map((id) => ({
      pid: id.pid,
      parent: id.ppid,
      started: id.identity,
    })),
  ];
  const quietStartedAt = Date.now();
  assert.deepEqual(observeTD054Processes(identities, claim.finalDeadlineMs), []);
  const portsBefore = absentPorts(packet, claim.finalDeadlineMs);
  assert.ok(
    budget.quietWindowMs < remainingTD054(claim.finalDeadlineMs),
    'td054-quiet-window-budget',
  );
  await pause(budget.quietWindowMs, undefined, { signal });
  remainingTD054(claim.finalDeadlineMs);
  assert.deepEqual(observeTD054Processes(identities, claim.finalDeadlineMs), []);
  const portsAfter = absentPorts(packet, claim.finalDeadlineMs);
  for (const ref of fixed) readH04Pin(ref);
  const quiet = record(join(packet.evidenceRoot, 'quiet-observed.json'), {
    quietStartedAt,
    observedAt: Date.now(),
    identities,
    alive: [],
    portsBefore,
    portsAfter,
    fixed,
  });
  const result = await checkTD054LiveResult({ claim: claimPin, quiet });
  record(join(packet.evidenceRoot, 'live-result.json'), result);
  return result;
}

/** Check saved primary native receipts independently of the executor's returned error/result. */
export async function checkTD054LiveResult(value) {
  exact(value, ['claim', 'quiet']);
  const claim = await readTD054SavedClaim(value.claim),
    { packet } = claim;
  const quiet = json(value.quiet);
  assert.equal(value.quiet.path, join(packet.evidenceRoot, 'quiet-observed.json'));
  for (const ref of quiet.fixed) readH04Pin(h04Pin(ref));
  const read = (path) => json(quiet.fixed.find((ref) => ref.path === path));
  const started = read(join(packet.evidenceRoot, 'load-started.json'));
  const active = read(join(packet.evidenceRoot, 'load-at-deadline.json'));
  const confirmed = read(join(packet.evidenceRoot, 'active-confirmed.json'));
  assert.deepEqual(active.started, started);
  assert.equal(confirmed.snapshot.path, join(packet.evidenceRoot, 'load-at-deadline.json'));
  assert.deepEqual(json(confirmed.snapshot), active);
  assert.equal(started.role, 'reader');
  assert.ok(started.observedAt <= claim.startedAt + packet.proposedBounds.activeLoadByMs);
  assert.ok(active.observedAt >= claim.workDeadlineMs && active.observedAt < claim.stopDeadlineMs);
  assert.equal(active.primary.thread.id, started.session);
  const turns = active.primary.thread.turns.filter((turn) => turn.id === started.turnId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'inProgress');
  const transport = read(join(packet.evidenceRoot, 'transport-stop-observed.json'));
  const stop = json(transport.stop);
  assert.equal(
    transport.stop.path,
    join(packet.evidenceRoot, 'transport-initial/transport-stop.json'),
  );
  assert.equal(stop.operationId, packet.operationId);
  assert.equal(stop.receipts.length, 1);
  assert.equal(stop.receipts[0].role, 'reader');
  assert.equal(stop.receipts[0].confirmed, true);
  assert.ok(stop.receipts[0].processes.length > 0);
  assert.deepEqual(transport.identities, stop.receipts[0].processes);
  assert.ok(
    transport.observedAt >= active.observedAt && transport.observedAt <= claim.stopDeadlineMs,
  );
  const worker = read(join(packet.serverRoot, 'worker-deadline-load-outcome.json'));
  assert.equal(worker.stage, 'deadline-load');
  assert.equal(worker.kind, 'h06-native-temporal-process-outcome/1');
  assert.match(worker.failure, /h06-temporal-(?:process|setup)-deadline/u);
  assert.equal(worker.observedExit, true);
  assert.equal(worker.receipt.stopped, true);
  assert.equal(worker.workDeadlineMs, claim.workDeadlineMs);
  assert.equal(worker.stopDeadlineMs, claim.stopDeadlineMs);
  assert.ok(
    worker.deadlineCancel.sentAt >= claim.workDeadlineMs &&
      worker.deadlineCancel.deliveredAt >= worker.deadlineCancel.sentAt,
  );
  assert.ok(worker.recordedAt >= transport.observedAt && worker.recordedAt <= claim.stopDeadlineMs);
  const server = read(join(packet.serverRoot, 'server-stop.json'));
  assert.equal(server.requestHash, packet.requestHash);
  assert.equal(server.receipt.stopped, true);
  assert.deepEqual(worker.server, server.ready);
  assert.equal(server.ready.path, join(packet.serverRoot, 'server-ready.json'));
  const ready = json(server.ready);
  assert.equal(ready.requestHash, packet.requestHash);
  assert.deepEqual(ready.binary, packet.binaryPins.server);
  assert.ok(server.receipt.identities.some((identity) => identity.pid === ready.process.pid));
  assert.ok(worker.receipt.identities.some((identity) => identity.pid === worker.pid));
  assert.ok(transport.identities.some((identity) => identity.parent === worker.pid));
  const serverObserved = read(join(packet.evidenceRoot, 'server-stop-observed.json'));
  assert.equal(serverObserved.stop.path, join(packet.serverRoot, 'server-stop.json'));
  assert.ok(
    serverObserved.observedAt >= worker.recordedAt &&
      serverObserved.observedAt <= claim.stopDeadlineMs,
  );
  assert.deepEqual(quiet.alive, []);
  assert.deepEqual(quiet.identities, [
    ...transport.identities,
    ...[...worker.receipt.identities, ...server.receipt.identities].map((identity) => ({
      pid: identity.pid,
      parent: identity.ppid,
      started: identity.identity,
    })),
  ]);
  assert.ok(quiet.quietStartedAt >= serverObserved.observedAt);
  assert.ok(
    quiet.observedAt - quiet.quietStartedAt >= packet.proposedBounds.quietWindowMs &&
      quiet.observedAt <= claim.finalDeadlineMs,
  );
  assert.deepEqual(quiet.portsBefore, quiet.portsAfter);
  assert.equal(quiet.portsBefore.length, 3);
  assert.ok(quiet.portsBefore.every((row) => row.absent === true));
  assert.deepEqual(
    quiet.portsBefore.map((row) => row.port),
    [
      Number(packet.server.address.split(':')[1]),
      packet.server.httpPort,
      packet.server.metricsPort,
    ],
  );
  const { openH06NativeTurnLedger } = await import('./comparisonH06NativeTurnLedger.ts');
  const ledger = openH06NativeTurnLedger(join(packet.evidenceRoot, 'turns'), {
    mode: 'reopen',
    operationId: packet.operationId,
    maxManagedStarts: 1,
  }).inspect();
  assert.equal(ledger.status, 'RECORDED');
  assert.equal(ledger.used, 1);
  assert.equal(ledger.admissions.length, 1);
  const inventory = bindH06NativeUsageParticipants({
    operationId: packet.operationId,
    stops: [transport.stop],
    admissions: ledger.admissions,
  });
  assert.equal(inventory.status, 'BOUND');
  const usage = checkH06NativeUsage({
    expected: inventory.participants,
    participants: inventory.participants.map(sealH06NativeUsage),
    budget: packet.proposedBounds,
  });
  assert.equal(usage.exceeded.inputUncached, false);
  assert.equal(usage.exceeded.output, false);
  return {
    kind: 'td054-native-load-deadline-result/1',
    status: 'PASS',
    requestHash: packet.requestHash,
    claim: value.claim,
    quiet: value.quiet,
    nativeDeadline: 'PASS',
    r12FormalColdStop: 'UNKNOWN',
    r13NormalCompletion: 'UNCHANGED',
    qualification: false,
    mayRun: false,
    sourceClaimIssued: false,
    managedUsage: usage,
  };
}

export async function td054DeadlineProbeMain(args) {
  // td054-reference:reference-cli:begin
  if (['--prepare-reference', '--check-reference', '--run-reference'].includes(args[0]))
    return td054ReferenceMain(args);
  // td054-reference:reference-cli:end
  const [command, path, operationId, output] = args;
  if (command === '--prepare') {
    assert.equal(args.length, 4, '--prepare REFERENCE_ATTEMPT OPERATION_ID OUTPUT');
    const packet = prepareTD054DeadlineProbe(
      operationId,
      pin(realpathSync(path)),
      td054ProposedBounds,
      safeDirectory(dirname(resolve(output))),
    );
    writeFileSync(resolve(output), canonical(packet) + '\n', { flag: 'wx', mode: 0o600 });
    return { output: resolve(output), ...checkTD054DeadlineProbe(packet) };
  }
  if (command === '--run') {
    assert.ok(args.length === 2 || args.length === 3, '--run PACKET [PRIMARY_SOURCE_JSON]');
    const signal = new globalThis.AbortController(),
      stop = () => signal.abort(new Error('td054-user-interrupted'));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      return await runTD054DeadlineProbe(
        JSON.parse(readFileSync(path)),
        operationId === undefined ? undefined : JSON.parse(readFileSync(operationId)),
        signal.signal,
      );
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  assert.ok(args.length === 2 && ['--check', '--show-run-plan', '--check-live'].includes(command));
  const value = JSON.parse(readFileSync(path));
  return command === '--check-live'
    ? checkTD054LiveResult({ claim: value.claim, quiet: value.quiet })
    : command === '--check'
      ? checkTD054DeadlineProbe(value)
      : planTD054DeadlineProbe(value);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  td054DeadlineProbeMain(process.argv.slice(2)).then(
    (value) => {
      process.stdout.write(canonical(value) + '\n');
      if (value.status === 'UNKNOWN') process.exitCode = 1;
    },
    (error) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
}
// td054-reference:reference-main:begin
async function td054ReferenceMain(args) {
  const [command, path, output] = args;
  if (command === '--prepare-reference') {
    assert.equal(args.length, 3, '--prepare-reference BINDING_JSON OUTPUT');
    const reference = await prepareTD054Reference(JSON.parse(readFileSync(path)));
    writeFileSync(resolve(output), canonical(reference) + '\n', { flag: 'wx', mode: 0o600 });
    return { output: resolve(output), ...(await checkTD054Reference(reference)) };
  }
  assert.equal(args.length, 2, command + ' REFERENCE_JSON');
  const reference = JSON.parse(readFileSync(path));
  if (command === '--check-reference') return checkTD054Reference(reference);
  await checkTD054Reference(reference);
  const signal = new globalThis.AbortController();
  const stop = () => signal.abort(new Error('td054-user-interrupted'));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await runTD054DeadlineProbe(
      reference.packet,
      td054ReferenceSource(reference),
      signal.signal,
    );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
// td054-reference:reference-main:end
