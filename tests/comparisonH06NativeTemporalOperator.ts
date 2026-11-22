import { dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { Client } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import { createPrivateDirectory } from '../adapters/storage/storeFiles.js';
import { artifactStore, publishFile } from '../src/adapters/artifacts/files.js';
import type { startLocalTask } from '../src/client/localTask.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  beginH06NativeAttempt,
  observeH06NativePrimaryGrant,
  openH06NativeAttemptTurnLedger,
  planH06NativeAttempt,
  readH06NativeAttemptForReopen,
  readH06NativeRequestBinding,
} from './comparisonH06NativeAttempt.js';
import {
  h06NativeTemporalServices,
  readH06NativeTemporalStart,
  startH06NativeTemporal,
  type H06TemporalStage,
} from './comparisonH06NativeTemporal.js';
import {
  readH06NativeTemporalResumeReceipt,
  reopenH06NativeTemporal,
  verifyH06NativeTemporalResume,
  type H06Opening,
  type H06ResumeRequest,
} from './comparisonH06NativeTemporalResume.js';
import { verifyH06NativeTemporalServer } from './comparisonH06NativeTemporalServer.js';
import { withH06NativeTemporalServer } from './comparisonH06NativeTemporalServerSetup.js';
import {
  checkH06NativeTemporalAttemptUsage,
  sealH06NativeUsage,
} from './comparisonH06NativeUsage.js';

import {
  temporalBootstrap,
  planH06NativeTemporalOperator,
  planH06NativeTemporalServerSetup,
} from './comparisonH06NativeTemporalPlan.js';
export { planH06NativeTemporalOperator, planH06NativeTemporalServerSetup };

import {
  isH06TemporalAutonomousMode,
  readH06TemporalControlMode,
  type H06TemporalAutonomousMode,
} from './comparisonH06TemporalAutonomousControls.js';
import { openH06TemporalAutonomousNativeClaim } from './comparisonH06TemporalAutonomousAuthority.js';

type Claim = ReturnType<typeof readH06NativeAttemptForReopen>;
export type H06NativeTemporalOperatorContext = Pick<
  H06TemporalStage,
  'client' | 'issuer' | 'workDeadlineMs' | 'controlMode'
>;

/** Hold one server under the exact setup grant, independently of native model authority. */
export async function runH06NativeTemporalServerSetup<T>(
  value: unknown,
  budget: unknown,
  authority: unknown,
  run: (ready: H04Pin, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const plan = planH06NativeTemporalServerSetup(value, budget);
  const source = (current: typeof plan) =>
    observeH06NativePrimaryGrant(
      { request: current.attempt.request, expectedGrantText: current.expectedGrantText },
      authority,
    );
  await source(plan);
  signal?.throwIfAborted();
  const current = planH06NativeTemporalServerSetup(value, budget);
  requireContract(current.setupHash === plan.setupHash, 'h06-temporal-server-setup-changed');
  const grant = await source(current);
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const deadlineMs = startedAt + current.budget.maxElapsedMs;
  createPrivateDirectory(current.root);
  publishFile(
    join(current.root, 'setup-claim.json'),
    Buffer.from(
      canonical({
        kind: 'comparison-h06-native-temporal-server-setup-claim/2',
        setupHash: current.setupHash,
        expected: current.expected,
        budget: current.budget,
        grant,
        startedAt,
        deadlineMs,
      }) + '\n',
    ),
  );
  return withH06NativeTemporalServer(
    {
      expected: current.expected,
      deadlineMs,
      stopReserveMs: current.budget.stopReserveMs,
      ...(signal === undefined ? {} : { signal }),
    },
    run,
  );
}

/** Start against an already running loopback server, owning only this SDK connection and host. */
export async function runH06NativeTemporalOperator<T>(
  value: unknown,
  authority: unknown,
  serverValue: H04Pin,
  run: (
    handle: Awaited<ReturnType<typeof startLocalTask>>,
    started: H04Pin,
    signal: AbortSignal,
    context: H06NativeTemporalOperatorContext,
  ) => Promise<T>,
) {
  const admitted = isH06TemporalAutonomousMode(authority)
    ? openH06TemporalAutonomousNativeClaim(readH06TemporalControlMode(authority).authority)
    : undefined;
  const plan =
    admitted === undefined
      ? planH06NativeAttempt(value)
      : { request: readH06NativeRequestBinding(value), requestHash: admitted.requestHash };
  requireContract(
    admitted === undefined || same(plan.request, admitted.request),
    'h06-temporal-operator-autonomous-request',
  );
  const proposed = temporalBootstrap(plan.request);
  const server = h04Pin(serverValue);
  await verifyH06NativeTemporalServer(
    { requestHash: plan.requestHash, ...proposed.server },
    server,
    admitted?.workDeadlineMs ?? Date.now() + 5000,
  );
  const claim = admitted ?? (await beginH06NativeAttempt(value, authority));
  requireContract(claim.requestHash === plan.requestHash, 'h06-temporal-operator-request-changed');
  const { request } = claim;
  const bootstrap = temporalBootstrap(request);
  publishFile(serverBindingPath(claim), Buffer.from(JSON.stringify(server)));
  const artifactRoot = join(request.evidenceRoot, 'artifacts');
  const store = artifactStore(artifactRoot);
  for (const bytes of bootstrap.artifacts.values()) store.publish(bytes);
  return withNativeTemporalStage(
    claim,
    bootstrap,
    server,
    'initial',
    request.binding.timeoutMs + request.stimulus.longStageMs,
    (services) =>
      startH06NativeTemporal(
        request.binding,
        request.evidenceRoot,
        bootstrap.input,
        services,
        (handle, started) =>
          withinWork(claim.workDeadlineMs, (signal) => run(handle, started, signal, services)),
      ),
  );
}

type ResumeStage = Parameters<typeof reopenH06NativeTemporal>[4];

export interface H06NativeTemporalRetainedOpening {
  claim: H04Pin;
  server: H04Pin;
  resume: H06ResumeRequest;
  opening: H06Opening;
  command: PayloadReaderCommand;
  stops: readonly H04Pin[];
  participants: readonly ComparisonParticipant[];
  controlMode?: H06TemporalAutonomousMode;
}

/** The original claim binds the route and budget. Each reopen also needs its own exact native RESUME. */
export async function reopenH06NativeTemporalOperator<T>(
  retainedValue: H06NativeTemporalRetainedOpening,
  run: (
    ...args: [
      ...Parameters<ResumeStage>,
      signal: AbortSignal,
      context: H06NativeTemporalOperatorContext,
    ]
  ) => Promise<T>,
) {
  const retained = structuredClone(retainedValue);
  const receipt = h04Pin(retained.claim);
  requireContract(
    receipt.path === join(dirname(retained.resume.started.path), 'attempt-claim.json'),
    'h06-temporal-operator-reopen-binding',
  );
  const prior = readH06NativeTemporalResumeReceipt(
    retained.resume,
    retained.command,
    retained.opening,
  );
  if (prior !== null) {
    readH04Pin(receipt);
    return prior;
  }
  const claim = readH06NativeAttemptForReopen(receipt);
  const { request } = claim;
  requireContract(
    same(retained.controlMode, 'admission' in claim.grant ? claim.grant.admission : undefined),
    'h06-temporal-operator-reopen-mode',
  );
  const bootstrap = temporalBootstrap(request);
  const server = h04Pin(retained.server);
  requireContract(
    same(h04Pin(JSON.parse(h01RawFile(serverBindingPath(claim)).toString())), server),
    'h06-temporal-operator-server-binding',
  );
  const { start, input, evidence } = readH06NativeTemporalStart(retained.resume.started);
  const phase = retained.opening.phase;
  requireContract(
    (phase === 'warm' || phase === 'cold') &&
      evidence === request.evidenceRoot &&
      start.transportRoot === join(evidence, 'transport-initial') &&
      same(input, bootstrap.input) &&
      Date.now() < claim.workDeadlineMs,
    'h06-temporal-operator-reopen-binding',
  );
  const previous = phase === 'warm' ? ['initial'] : ['initial', 'warm'];
  requireContract(
    same(
      retained.stops.map(({ path }) => path).sort(),
      previous.map((stage) => join(evidence, `transport-${stage}`, 'transport-stop.json')).sort(),
    ),
    'h06-temporal-operator-reopen-stops',
  );
  await verifyH06NativeTemporalResume(
    retained.resume,
    temporalIssuer(claim, bootstrap),
    retained.command,
  );
  const usage = checkH06NativeTemporalAttemptUsage({
    claim: retained.claim,
    stops: retained.stops,
    participants: retained.participants,
  });
  requireContract(
    usage.status === 'WITHIN_BUDGET' &&
      usage.knownSubtotal.inputUncached < request.budget.maxInputUncached &&
      usage.knownSubtotal.output < request.budget.maxOutput,
    'h06-temporal-operator-reopen-usage',
  );
  for (const participant of usage.binding.participants)
    requireContract(
      same(
        sealH06NativeUsage(participant),
        retained.participants.find(({ session }) => session === participant.session),
      ),
      'h06-temporal-operator-reopen-usage-boundary',
    );
  return withNativeTemporalStage(claim, bootstrap, server, phase, 0, (services) =>
    reopenH06NativeTemporal(
      retained.resume,
      services,
      retained.command,
      retained.opening,
      (resumed, opened) =>
        withinWork(claim.workDeadlineMs, (signal) => run(resumed, opened, signal, services)),
    ),
  );
}

function serverBindingPath(claim: Claim) {
  return join(claim.request.evidenceRoot, 'temporal-server-owner.json');
}

function temporalIssuer(claim: Claim, bootstrap: ReturnType<typeof temporalBootstrap>) {
  return {
    sessionsRoot: claim.grant.sessionsRoot,
    workspaceRoot: claim.request.chat.workspace,
    threadId: claim.request.chat.threadId,
    owner: bootstrap.input.admission.preparation.owner,
  };
}

async function withinWork<T>(deadline: number, run: (signal: AbortSignal) => Promise<T>) {
  const remaining = deadline - Date.now();
  requireContract(remaining > 0, 'h06-temporal-operator-deadline');
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('h06-temporal-operator-deadline');
      reject(error);
      abort.abort(error);
    }, remaining);
  });
  try {
    return await Promise.race([expired, run(abort.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

async function withNativeTemporalStage<T>(
  claim: Claim,
  bootstrap: ReturnType<typeof temporalBootstrap>,
  server: H04Pin,
  phase: 'initial' | 'warm' | 'cold',
  minimumRemaining: number,
  run: (services: H06TemporalStage) => Promise<T>,
) {
  const { request, receipt, workDeadlineMs, stopDeadlineMs } = claim;
  const { binding, evidenceRoot } = request;
  const { preparation } = bootstrap.input.admission;
  const turns = openH06NativeAttemptTurnLedger(receipt);
  const ledger = turns.inspect();
  requireContract(
    ledger.status === 'RECORDED' && ledger.used < request.budget.maxManagedStarts,
    'h06-temporal-operator-turn-budget',
  );
  const retainedReaderSessions = [
    ...new Set(
      ledger.admissions
        .filter(({ scope }) => scope.role === 'reader')
        .map(({ scope }) => scope.session),
    ),
  ];
  function working() {
    requireContract(
      Date.now() + minimumRemaining < workDeadlineMs,
      'h06-temporal-operator-deadline',
    );
  }
  working();
  const serverExpectation = { requestHash: claim.requestHash, ...bootstrap.server };
  await verifyH06NativeTemporalServer(serverExpectation, server, workDeadlineMs);
  working();
  const connection = await NativeConnection.connect({ address: bootstrap.server.address });
  let result: T;
  try {
    working();
    await verifyH06NativeTemporalServer(serverExpectation, server, workDeadlineMs);
    working();
    for (const pin of [binding.node, request.appServer, ...request.runtime]) readH04Pin(pin);
    const services = h06NativeTemporalServices(
      {
        client: new Client({ connection }),
        connection,
        taskQueue: bootstrap.taskQueue,
        workflowsPath: bootstrap.workflows.path,
        registration: {
          project: preparation.project,
          hostId: preparation.hostId,
          owner: preparation.owner,
          generation: preparation.generation,
          workspaceRoot: binding.workspaceRoot,
          artifactRoot: join(evidenceRoot, 'artifacts'),
          commands: {
            syntax: {
              executable: binding.node.path,
              args: ['--check', 'checks.mjs'],
              timeoutMs: binding.timeoutMs,
            },
            validate: {
              executable: binding.node.path,
              args: ['checks.mjs'],
              timeoutMs: binding.timeoutMs,
            },
          },
        },
        issuer: temporalIssuer(claim, bootstrap),
        maxTurnStarts: request.budget.maxManagedStarts,
        workDeadlineMs,
        ...('admission' in claim.grant
          ? { controlMode: readH06TemporalControlMode(claim.grant.admission) }
          : {}),
      },
      {
        evidenceRoot: join(evidenceRoot, `transport-${phase}`),
        profile: bootstrap.profile,
        binary: request.appServer,
        disabledServers: bootstrap.disabledServers,
        stopDeadlineMs,
        retainedReaderSessions,
        ...('admission' in claim.grant && phase !== 'cold'
          ? { writerStimulus: { node: binding.node, minimumMs: request.stimulus.longStageMs } }
          : {}),
        admitTurn: turns.admitTurn,
        recordTurn: turns.recordTurn,
      },
    );
    result = await run(services);
  } catch (error) {
    try {
      await connection.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'h06-temporal-operator-and-close-failed');
    }
    throw error;
  }
  await connection.close();
  requireContract(Date.now() <= stopDeadlineMs, 'h06-temporal-operator-stop-deadline');
  return result;
}
