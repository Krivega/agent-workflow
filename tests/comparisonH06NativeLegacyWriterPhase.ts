import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  cancelCoder,
  launchCoder,
  startCoder,
  type CoderDependencies,
} from '../application/coderWorkflow.js';
import { validateCoderBrief, type CoderBrief, type CoderRun } from '../core/coder.js';
import type { OperationResult } from '../core/evidence.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { stopH06NativeLegacyWriter } from './comparisonH06NativeLegacyControl.js';
import { runH06NativeLegacyControlOperator } from './comparisonH06NativeLegacyControlOperator.js';
import { captureH06NativeLegacyDispatchThread } from './comparisonH06NativeLegacyDispatch.js';

type Control = Parameters<typeof runH06NativeLegacyControlOperator>[1]['control'];
type Store = Parameters<typeof runH06NativeLegacyControlOperator>[0];

interface WriterPhase {
  claim: H04Pin;
  started: H04Pin;
  brief: H04Pin;
  previousResume: H04Pin | null;
  phase: 'warm' | 'cold';
}

interface WriterPhaseRuntime {
  store: Store;
  coder: CoderDependencies & {
    sessions: Pick<AppServerCoderSessions, 'observeLiveWriter'>;
  };
  rpc: Pick<AppServerRpc, 'request'>;
  runWithinWork<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  stop(cleanup: () => Promise<void>): Promise<void>;
  closeOwned(): Promise<void>;
  awaitPause(writer: CoderRun, signal: AbortSignal): Promise<Control>;
}

function read(value: H04Pin) {
  return object(JSON.parse(readH04Pin(h04Pin(value)).toString()));
}

/** Start a single retained Writer, pause via a native source, and capture its confirmed STOP. */
export async function runH06NativeLegacyWriterPhase(
  input: WriterPhase,
  runtime: WriterPhaseRuntime,
) {
  const { claim, started, phase, previousResume } = input;
  const { request } = readH06NativeAttemptForReopen(claim);
  const { binding, evidenceRoot } = request;
  const { store, coder } = runtime;
  const { context } = store.grant;
  const start = read(started);
  const briefPin = h04Pin(input.brief);
  requireContract(
    binding.variant === 'legacy' &&
      (phase === 'warm' || phase === 'cold') &&
      process.env.CODEX_THREAD_ID === context.actor_id &&
      store.root === join(evidenceRoot, 'legacy-store') &&
      started.path === join(evidenceRoot, 'legacy-operator-start.json') &&
      start.kind === 'h06-native-legacy-operator-start' &&
      same(start.claim, claim) &&
      same(start.context, context) &&
      request.runtime.some((pin) => same(pin, briefPin)),
    'h06-legacy-writer-phase-binding',
  );
  const brief = read(briefPin) as unknown as CoderBrief;
  validateCoderBrief(brief);
  requireContract(
    same(
      [
        brief.project_id,
        brief.task_id,
        brief.parent_run_id,
        brief.parent_session_id,
        brief.source_root,
        brief.generation,
      ],
      [
        context.project_id,
        context.task_id,
        context.run_id,
        context.actor_id,
        binding.workspaceRoot,
        start.generation,
      ],
    ) && brief.copy_root === join(evidenceRoot, 'coder-workspaces', brief.id),
    'h06-legacy-writer-phase-brief',
  );
  let warmStop: {
    coder: string;
    stopped: { locator: string; hash: string };
    retained: unknown;
  } | null = null;
  if (phase === 'warm') {
    requireContract(previousResume === null, 'h06-legacy-writer-phase-order');
  } else {
    requireContract(
      previousResume?.path === join(evidenceRoot, 'legacy-warm-resume.json'),
      'h06-legacy-writer-phase-order',
    );
    const previous = read(previousResume);
    const event = object(previous.event);
    const recorded = unwrap<OperationResult>(
      store.execute({
        context,
        command: { type: 'operation', operation_id: 'chat:control:' + String(event.id) },
      }),
    );
    requireContract(
      previous.kind === 'h06-native-legacy-resume' &&
        previous.phase === 'warm' &&
        same(object(previous.identity).context, context) &&
        recorded.status === 'confirmed' &&
        same(recorded.ack, previous.ack),
      'h06-legacy-writer-phase-order',
    );
    const intentPin = h04Pin(previous.intent);
    const intent = read(intentPin);
    const linkPin = h04Pin(intent.stoppedBy);
    const link = read(linkPin);
    const coderId = identifier(link.coderId);
    const stopped = object(link.stopped);
    const proof = h04Pin({ path: stopped.locator, sha256: stopped.hash });
    requireContract(
      link.kind === 'h06-native-legacy-writer-stop' &&
        link.phase === 'warm' &&
        intentPin.path === join(evidenceRoot, 'legacy-warm-resume-intent.json') &&
        linkPin.path === join(evidenceRoot, 'legacy-warm-writer-stop.json') &&
        same(link.stopped, event.stopped) &&
        coderId !== brief.id,
      'h06-legacy-writer-phase-order',
    );
    readH04Pin(proof);
    const stoppedIntent = h04Pin(link.intent);
    requireContract(
      stoppedIntent.path === join(evidenceRoot, 'legacy-warm-writer-stop-intent.json'),
      'h06-legacy-writer-phase-order',
    );
    warmStop = {
      coder: coderId,
      stopped: { locator: proof.path, hash: proof.sha256 },
      retained: read(stoppedIntent).coder,
    };
  }
  const phaseIntent = Buffer.from(
    canonical({ claim, started, phase, brief: briefPin, previousResume }) + '\n',
  );
  const intentPath = join(evidenceRoot, `legacy-${phase}-writer-phase-intent.json`);
  const run = async () =>
    runtime.runWithinWork(async (signal) => {
      signal.throwIfAborted();
      publishFile(intentPath, phaseIntent);
      if (warmStop !== null) {
        const { coder: warmCoder, stopped, retained } = warmStop;
        const current = (await coder.journal.read()).coders?.[warmCoder];
        requireContract(
          current?.status === 'running' && same(current, retained),
          'h06-legacy-writer-phase-order',
        );
        await cancelCoder(warmCoder, {
          ...coder,
          sessions: { ...coder.sessions, stop: async () => stopped },
        });
      }
      await startCoder(brief, coder);
      const writer = await launchCoder(brief.id, coder);
      requireContract(writer.status === 'running', 'h06-legacy-writer-not-dispatched');
      const control = await runtime.awaitPause(writer, signal);
      signal.throwIfAborted();
      requireContract(
        control.phase === phase && control.event.type === 'PAUSE',
        'h06-legacy-writer-phase-pause',
      );
      const pause = await runH06NativeLegacyControlOperator(store, { claim, started, control });
      const stop = await stopH06NativeLegacyWriter(store, coder.sessions, {
        workspaceRoot: binding.workspaceRoot,
        evidenceRoot,
        phase,
        paused: pause.receipt,
        coderId: brief.id,
      });
      const thread = await captureH06NativeLegacyDispatchThread(runtime.rpc, stop.link);
      return { pause, stop, thread, intent: { path: intentPath, sha256: digest(phaseIntent) } };
    });
  let result: { ok: true; value: Awaited<ReturnType<typeof run>> } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: await run() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await runtime.stop(() => runtime.closeOwned());
  } catch (cleanup) {
    if (!result.ok)
      throw new AggregateError([result.error, cleanup], 'h06-legacy-writer-phase-and-stop-failed');
    throw cleanup;
  }
  if (!result.ok) throw result.error;
  return result.value;
}
