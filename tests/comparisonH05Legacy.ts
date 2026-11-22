import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import { AppServerWaits } from '../adapters/codex/appServerWaits.js';
import { confirmNativeRead } from '../adapters/codex/nativeRead.js';
import { AssignmentLocalRuns } from '../adapters/storage/localRunStores.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { object, parseConnection, requireWorkflow } from '../core/connection.js';
import { confirmSession, validateDataAnswer, validateDataQuery } from '../core/dataRoute.js';
import type { DataReading, DataAnswer } from '../core/dataRoute.js';
import {
  applyLocalEvent,
  startLocalRun,
  type LocalEvent,
  type RunSpec,
  type LocalRun,
  type InputRef,
} from '../core/localRun.js';
import type {
  H01AttemptContext,
  H01BackendAdapter,
  H01BackendResult,
} from './comparisonH01Contract.js';
import { h01ReadPin, h01RawFile, h01ReadJson, h01Record } from './comparisonH01Contract.js';
import { checkNativeCase } from './comparisonH01.js';
import { createH02NativeRpc, type H02NativeRpc } from './comparisonH02NativeRpc.js';
import {
  h05Material,
  h05Scenario,
  h05Procedures,
  h05PreparedMetadata,
  verifyH05Primary,
  h05WireJournal,
  h05WireSource,
  type H05Binding,
  type H05CaseReport,
  type H05ProbeId,
  type H05Probe,
  type H05WaitExecutor,
} from './comparisonH05Contract.js';

function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
const plainAnswer = ({ evidence: _evidence, ...answer }: DataAnswer) => answer;

/** Same known native turn for every probe. New delivery views reuse the actual transport wait owner. */
export async function runH05Case(
  ctx: H01AttemptContext,
  engine: 'legacy' | 'temporal',
  executor?: H05WaitExecutor,
): Promise<H01BackendResult> {
  requireWorkflow(
    ctx.criteria.value.id === 'H-05' &&
      ctx.variant === (engine === 'legacy' ? 'baseline' : 'candidate') &&
      ctx.identity.generation >= 2,
    'h05-context',
  );
  const evidence: InputRef[] = [],
    saved = (label: string, value: unknown) => {
      const ref = h01Record(ctx.roots.evidenceRoot, 'h05-' + label, value);
      evidence.push(ref);
      return ref;
    };
  const report: H05CaseReport = {
    kind: 'comparison-h05-case',
    scenario: 'H-05',
    opId: ctx.opId,
    engine,
    session: null,
    turn: null,
    outcome: 'unknown',
    checks: Object.fromEntries(h05Scenario.checks.map((id) => [id, false])),
    blocking: [],
    binding: null,
    initial: { failure: null, load: null, state: null },
    native: { primary: null, prefixBefore: null, prefixAfter: null, journals: [] },
    probes: {},
    restart: { waiting: null, detached: null, resumed: null, state: null },
    retained: { before: null, after: null },
    stop: ctx.verifiedAuthorization,
    evidence,
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  };
  const notifications: InputRef[] = [];
  let portLabel = 'h05-initial';
  const journalPath = () =>
    join(ctx.roots.evidenceRoot, 'native-rpc-' + portLabel, 'primary.jsonl');
  let sequence = 0;
  const observed = (message: Record<string, unknown>) => {
    const source = h05WireJournal(journalPath()).at(-1);
    requireWorkflow(
      source !== undefined && source.envelope.side === 'recv' && same(source.message, message),
      'h05-notification-source',
    );
    notifications.push(
      saved('notification', {
        kind: 'comparison-h05-native-notification',
        opId: ctx.opId,
        sequence: ++sequence,
        source: source.ref,
        message,
      }),
    );
  };
  let port: H02NativeRpc = createH02NativeRpc(ctx, 'h05-initial', {
    stage: 'execution',
    observe: observed,
  });
  let retired: H02NativeRpc | null = null,
    binding: H05Binding | null = null,
    runs: AssignmentLocalRuns | null = null;
  let applicationPin: InputRef | null = null;
  const immutableWorkspace: InputRef[] = [];
  const immutableInputs = structuredClone([
    ctx.material.ref,
    ctx.rules,
    ctx.executor,
    ...ctx.runtime.files,
  ]);
  let originalCreation: InputRef | null = null;
  let ownerSpec: RunSpec | null = null;
  const assertOwner = (run: LocalRun) => {
    requireWorkflow(
      binding !== null &&
        ownerSpec !== null &&
        run.generation === binding.identity.generation &&
        run.status !== 'cancelled' &&
        same(run.spec, ownerSpec),
      'h05-current-owner-changed',
    );
  };
  const commitGuard = () => {
    ctx.signal.throwIfAborted();
    requireWorkflow(process.hrtime.bigint() < BigInt(ctx.workDeadlineNs), 'h05-commit-deadline');
    h01ReadPin(ctx.verifiedAuthorization);
    immutableWorkspace.forEach(h01ReadPin);
    immutableInputs.forEach(h01ReadPin);
    requireWorkflow(
      binding !== null &&
        originalCreation !== null &&
        ctx.nativeObserver.assertRecoveryParticipant !== undefined,
      'h05-commit-owner-guard',
    );
    ctx.nativeObserver.assertRecoveryParticipant(
      binding.session.id,
      originalCreation,
      binding.nativeTranscript,
    );
    for (const ref of [
      report.binding,
      report.initial.failure,
      report.initial.load,
      report.native.primary,
      applicationPin,
    ])
      if (ref !== null) h01ReadPin(ref);
    const failure = object(h01ReadJson(report.initial.failure!)),
      check = object(h01ReadJson(failure.check as InputRef));
    h01ReadPin(check.stdout as InputRef);
    h01ReadPin(check.stderr as InputRef);
    decodeChatArtifact(ctx.roots.evidenceRoot, h01ReadPin(report.initial.load!).toString('utf8'));
    const primary = object(h01ReadJson(report.native.primary!));
    h05WireSource(primary.requestSource as InputRef);
    h05WireSource(primary.responseSource as InputRef);
    if (binding !== null && existsSync(join(binding.stateRoot, 'assignment.json')))
      assertOwner(
        object(
          JSON.parse(h01RawFile(join(binding.stateRoot, 'assignment.json')).toString('utf8')),
        ) as unknown as LocalRun,
      );
  };
  const working = async () => {
    ctx.signal.throwIfAborted();
    await ctx.nativeObserver.verify();
    ctx.signal.throwIfAborted();
    requireWorkflow(process.hrtime.bigint() < BigInt(ctx.workDeadlineNs), 'h05-deadline');
    if (report.binding !== null) h01ReadPin(report.binding);
  };
  const read = async (
    id: string,
    phase: string,
    method: string,
    params: Record<string, unknown>,
    reads?: InputRef[],
  ) => {
    await working();
    const path = journalPath(),
      before = existsSync(path) ? h05WireJournal(path).length : 0;
    const response = await port.rpc.request(method, params);
    const rows = h05WireJournal(path).slice(before);
    const pairs = rows
      .filter((row) => row.envelope.side === 'send' && row.message.method === method)
      .flatMap((sent) =>
        rows
          .filter(
            (received) =>
              received.envelope.side === 'recv' &&
              received.message.id === sent.message.id &&
              same(received.message.result, response),
          )
          .map((received) => ({ sent, received })),
      );
    requireWorkflow(pairs.length === 1, 'h05-read-source');
    const pair = pairs[0]!;
    const ref = saved('read', {
      kind: 'comparison-h05-primary-read',
      opId: ctx.opId,
      id,
      phase,
      method,
      params: pair.sent.message.params,
      response,
      requestSource: pair.sent.ref,
      responseSource: pair.received.ref,
    });
    reads?.push(ref);
    return { ref, response };
  };
  const prefix = () => {
    const participants = ctx.nativeObserver
      .accounting()
      .participants.filter(
        (participant) => participant.session === report.session && participant.run === ctx.opId,
      );
    requireWorkflow(participants.length === 1, 'h05-native-participant');
    const transcript = participants[0]!.transcript,
      bytes = h01RawFile(transcript);
    requireWorkflow(bytes.toString('utf8').endsWith('\n'), 'h05-native-prefix-partial');
    return saved('prefix', {
      kind: 'comparison-h05-native-prefix',
      opId: ctx.opId,
      transcript,
      content: bytes.toString('utf8'),
      hash: digest(bytes),
      bytes: bytes.length,
    });
  };
  const state = async () => {
    requireWorkflow(
      runs !== null && binding !== null && report.binding !== null,
      'h05-state-missing',
    );
    const run = await runs.read();
    requireWorkflow(run !== null, 'h05-state-missing');
    const locator = join(binding.stateRoot, 'assignment.json'),
      bytes = h01RawFile(locator);
    requireWorkflow(same(JSON.parse(bytes.toString()), run), 'h05-checkpoint-changed');
    return {
      run,
      ref: saved('state', {
        kind: 'comparison-h05-state',
        opId: ctx.opId,
        binding: report.binding,
        source: { locator, hash: digest(bytes) },
        text: bytes.toString('utf8'),
      }),
    };
  };
  try {
    await working();
    const descriptor = ctx.runtime.files.find(
      (ref) => ref.locator === join(ctx.runtime.root, 'project/workflow.json'),
    );
    requireWorkflow(descriptor !== undefined, 'h05-descriptor-unpinned');
    const project = parseConnection(h01ReadJson(descriptor));
    const procedures = h05Procedures.map((id) => {
      const p = project.procedures.find((row) => row.id === id);
      requireWorkflow(p !== undefined, 'h05-procedure-missing');
      const pin = ctx.runtime.files.find(
        (ref) => ref.locator === join(ctx.runtime.root, p.locator),
      );
      requireWorkflow(pin !== undefined && pin.hash === p.hash, 'h05-procedure-unpinned');
      return { ...p, content: h01ReadPin(pin).toString('utf8') };
    });
    const metadata = h05PreparedMetadata(
      h01ReadPin(ctx.rules).toString(),
      h01ReadPin(ctx.executor).toString(),
    );
    const prepared = {
      ...h05Material.files,
      ...metadata,
      ...Object.fromEntries(procedures.map((p) => [p.locator, p.content])),
    };
    await verifyComparisonMaterial(ctx.roots.workspaceRoot, prepared, []);
    immutableWorkspace.push(
      ...Object.entries(prepared).map(([path, text]) => ({
        locator: join(ctx.roots.workspaceRoot, path),
        hash: digest(text),
      })),
    );
    const checked = await checkNativeCase(ctx, 'h05-initial-check');
    await working();
    requireWorkflow(checked.failed === true, 'h05-initial-failure-unconfirmed');
    report.initial.failure = saved('failure', {
      kind: 'comparison-h05-initial-failure',
      opId: ctx.opId,
      id: 'F-01',
      check: checked.evidence,
    });
    const inputs = new FileWorkflowInputs(ctx.roots.workspaceRoot, ctx.roots.evidenceRoot),
      assignment = await inputs.ref('.h05/task.md');
    const rules = await Promise.all(
      ['.h05/rules.md', '.h05/executor.md'].map((path) => inputs.ref(path)),
    );
    const query: H05Binding['query'] = {
      kind: 'unknown-source',
      question:
        'Read the immutable H05 rules, assignment and original F-01. Return one primary read result; the owning host handles delivery recovery. Never dispatch or repeat another native turn.',
      scope: ['evidence/'],
      sources: [assignment, report.initial.failure],
      criterion: 'Read every pinned source and preserve F-01 without resolving it.',
      format: 'JSON DataAnswer',
      rules,
      procedures: procedures.map(({ content: _content, ...p }) => p),
      entrypoints: ['.h05/task.md'],
    };
    validateDataQuery(query);
    const sessions = new AppServerSessions(
      port.rpc,
      ctx.roots.workspaceRoot,
      'h05-' + digest(ctx.opId).slice(0, 16),
      ctx.roots.evidenceRoot,
      null,
      null,
    );
    const session = await sessions.create({
      ...ctx.profile,
      reason: 'H05 isolated known-turn reader',
    });
    confirmSession(session, { ...ctx.profile, reason: 'H05 isolated known-turn reader' }, true);
    report.session = session.id;
    const deliveryId = ctx.opId + ':h05-known-turn',
      refs = [...query.rules, ...query.procedures, ...query.sources];
    const brief =
      'Only read tools; no helpers, network, writes or authority changes. Read fully every pinned file and print JSON {"path":"locator","sha256":"hash","content":"complete bytes"} through actual reading commands. For large files use contiguous aw-native-read-parts/1 chunks <=8000 UTF-16 units, each command output <=24000 UTF-8 bytes. Do not truncate or retry oversized output. Sources: ' +
      canonical(refs) +
      '\nThen return exactly one JSON object ' +
      canonical({
        outcome: 'PASS',
        scope: query.scope,
        sources: query.sources,
        coverage: 'complete',
        content: 'Known H05 read completed; original F-01 remains unresolved.',
        continuation: null,
        limitations: [],
      }) +
      '. No second turn or model polling. Host will inject notifications separately.';
    const turn = await sessions.send(session, brief, deliveryId);
    report.turn = turn;
    await port.rpc.completed(session.id, turn, ctx.signal, working);
    await working();
    const primary = await read('initial', 'source', 'thread/read', {
      threadId: session.id,
      includeTurns: true,
    });
    report.native.primary = primary.ref;
    const nativeThread = object(object(primary.response).thread),
      nativeTurn = (nativeThread.turns as unknown[]).map(object).find((value) => value.id === turn);
    requireWorkflow(nativeTurn !== undefined, 'h05-known-turn-missing');
    confirmNativeRead(nativeTurn, refs);
    report.initial.load = await sessions.observeLoad(session, query, turn);
    evidence.push(report.initial.load);
    const initialAnswer = await sessions.poll(session, turn);
    requireWorkflow(initialAnswer.status === 'completed', 'h05-result-unconfirmed');
    validateDataAnswer({ query } as DataReading, initialAnswer.answer);
    requireWorkflow(initialAnswer.answer.outcome === 'PASS', 'h05-native-read-refused');
    const stateRoot = join(ctx.roots.stateRoot, 'h05-waiting');
    mkdirSync(stateRoot, { mode: 0o700 });
    const participant = ctx.nativeObserver
      .accounting()
      .participants.filter(
        (participant) => participant.session === session.id && participant.run === ctx.opId,
      );
    requireWorkflow(participant.length === 1, 'h05-native-participant');
    const creations = port.evidence.filter((ref) => {
      const value = object(h01ReadJson(ref));
      return (
        value.kind === 'h01-native-dispatch' &&
        value.method === 'thread/start' &&
        object(object(value.response).thread).id === session.id
      );
    });
    requireWorkflow(creations.length === 1, 'h05-creation-source');
    originalCreation = creations[0]!;
    binding = {
      kind: 'comparison-h05-binding',
      schemaVersion: 1,
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      engine,
      identity: structuredClone(ctx.identity),
      material: ctx.material.ref,
      failure: report.initial.failure,
      workspace: ctx.roots.workspaceRoot,
      stateRoot,
      evidenceRoot: ctx.roots.evidenceRoot,
      session,
      turn,
      deliveryId,
      query,
      nativeTranscript: participant[0]!.transcript,
    };
    report.binding = saved('binding', binding);
    runs = new AssignmentLocalRuns(stateRoot, commitGuard);
    const spec: RunSpec = {
      project_id: 'h05-' + digest(ctx.opId).slice(0, 16),
      identity: { assignment_id: ctx.opId },
      assignment,
      product: false,
      run_id: ctx.opId,
      session_id: session.id,
      host_id: 'local',
      workspace: ctx.roots.workspaceRoot,
      parent_run_id: null,
      coordinator: false,
      role: null,
      fork_turns: 'none',
      scope: ['evidence/'],
      outcome: h05Material.instructions,
      criteria: [...h05Scenario.checks],
      writer: ctx.identity.owner,
      requested: { model: ctx.profile.model, effort: ctx.profile.effort, permissions: ['read'] },
      effective: { model: ctx.profile.model, effort: ctx.profile.effort, permissions: ['read'] },
      sources: [...query.sources, report.binding],
      procedures: query.procedures,
      rules: query.rules,
      procedure_loading: 'by-action',
      route: { kind: 'nonproduct' },
    };
    ownerSpec = structuredClone(spec);
    let initialRun = startLocalRun(spec, ctx.identity.generation);
    initialRun = applyLocalEvent(initialRun, {
      type: 'WAIT',
      event_id: ctx.opId + ':waiting',
      expected_revision: initialRun.revision,
      generation: initialRun.generation,
    });
    initialRun = applyLocalEvent(initialRun, {
      type: 'LOAD',
      event_id: ctx.opId + ':load',
      expected_revision: initialRun.revision,
      generation: initialRun.generation,
      receipt: {
        run_id: ctx.opId,
        session_id: session.id,
        procedures: query.procedures,
        rules: query.rules,
        observed_read: report.initial.load.locator,
        native: report.initial.load,
      },
    });
    initialRun = applyLocalEvent(initialRun, {
      type: 'RESULT',
      event_id: ctx.opId + ':initial-failure',
      expected_revision: initialRun.revision,
      generation: initialRun.generation,
      session_id: session.id,
      source: report.initial.failure,
      outcome: 'FAIL',
    });
    await runs.save(null, initialRun);
    const initial = await state();
    report.initial.state = initial.ref;
    report.retained.before = initial.ref;
    const terminal = notifications.find((ref) => {
      const value = object(h01ReadJson(ref)),
        message = object(value.message),
        params = message.params === undefined ? {} : object(message.params);
      return (
        message.method === 'turn/completed' &&
        params.threadId === session.id &&
        object(params.turn).id === turn
      );
    });
    requireWorkflow(terminal !== undefined, 'h05-native-terminal-unavailable');
    const terminalSequence = Number(object(h01ReadJson(terminal)).sequence);
    const progress = notifications.find((ref) => {
      const value = object(h01ReadJson(ref)),
        message = object(value.message),
        params = message.params === undefined ? {} : object(message.params);
      return (
        Number(value.sequence) < terminalSequence &&
        params.threadId === session.id &&
        message.method === 'item/started'
      );
    });
    requireWorkflow(progress !== undefined, 'h05-native-progress-unavailable');
    const execute: H05WaitExecutor =
      executor ??
      (async (input, wait) => {
        const cancel = new AbortController();
        if (input.mode === 'cancel') {
          const pending = wait(cancel.signal);
          cancel.abort(new Error('H05 expected cancellation'));
          try {
            await pending;
            throw new Error('h05-cancellation-not-observed');
          } catch (error) {
            requireWorkflow(
              (error as Error).message === 'app-server-wait-cancelled',
              'h05-cancellation-unknown',
            );
          }
          return { outcome: 'cancelled', result: null, evidence: [] };
        }
        return { outcome: 'completed', result: await wait(ctx.signal), evidence: [] };
      });
    const waitProbe = async (id: H05ProbeId, mode: 'wait' | 'cancel' | 'restart') => {
      const before = await state(),
        reads: InputRef[] = [],
        delivered: InputRef[] = [],
        held: InputRef[] = [];
      let invocation = 0,
        lastOwner: AppServerWaits | null = null;
      const wait = (signal: AbortSignal): Promise<InputRef> => {
        const call = ++invocation,
          combined = AbortSignal.any([ctx.signal, signal]);
        const owner = new AppServerWaits(async (method, params) => {
          if (mode === 'cancel' || (mode === 'restart' && engine === 'temporal' && call === 1)) {
            held.push(
              saved('held', {
                kind: 'comparison-h05-primary-read-held',
                id,
                binding: report.binding,
                method,
                params,
                invocation: call,
              }),
            );
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new Error('app-server-wait-cancelled'));
              if (combined.aborted) abort();
              else combined.addEventListener('abort', abort, { once: true });
            });
          }
          return (await read(id, 'reconcile', method, params, reads)).response;
        });
        lastOwner = owner;
        const deliver = (ref: InputRef) => {
          delivered.push(ref);
          owner.observe(object(object(h01ReadJson(ref)).message));
        };
        if (id === 'pre-subscription') deliver(terminal);
        const pending = owner.completed(session.id, turn, combined);
        if (id === 'deduplicated') {
          deliver(terminal);
          deliver(terminal);
        }
        if (id === 'reordered') {
          deliver(terminal);
          deliver(progress);
        }
        return (async () => {
          try {
            await pending;
            await working();
            const rpc = {
              request: async (method: string, params: Record<string, unknown>) =>
                (await read(id, 'result', method, params, reads)).response,
              completed: port.rpc.completed,
            };
            const currentSessions = new AppServerSessions(
              rpc,
              ctx.roots.workspaceRoot,
              'h05-' + digest(ctx.opId).slice(0, 16),
              ctx.roots.evidenceRoot,
              null,
              null,
            );
            const result = await currentSessions.poll(session, turn);
            requireWorkflow(result.status === 'completed', 'h05-result-unconfirmed');
            validateDataAnswer({ query } as DataReading, result.answer);
            requireWorkflow(
              same(plainAnswer(result.answer), plainAnswer(initialAnswer.answer)),
              'h05-primary-result-changed',
            );
            return saved('known-result', {
              kind: 'comparison-h05-wait-result',
              binding: report.binding,
              answer: plainAnswer(result.answer),
              source: report.native.primary,
            });
          } finally {
            owner.close(new Error('h05-wait-scope-closed'));
          }
        })();
      };
      const execution = await execute({ id, binding: report.binding!, mode }, wait);
      await working();
      execution.evidence.forEach((ref) => {
        h01ReadPin(ref);
        evidence.push(ref);
      });
      let observation: InputRef;
      if (mode === 'cancel') {
        requireWorkflow(
          execution.outcome === 'cancelled' && execution.result === null && lastOwner !== null,
          'h05-cancel-not-confirmed',
        );
        const cancel: LocalEvent = {
          type: 'CANCEL',
          event_id: ctx.opId + ':cancel',
          expected_revision: before.run.revision,
          generation: before.run.generation,
          reason: 'H05 expected cancellation',
          unfinished: ['evidence/'],
          stopped_receipt: report.restart.detached!.locator,
        };
        const cancelled = applyLocalEvent(before.run, cancel);
        await runs!.save(before.run, cancelled);
        delivered.push(terminal);
        (lastOwner as AppServerWaits).observe(object(object(h01ReadJson(terminal)).message));
        const late: LocalEvent = {
          type: 'RESULT',
          event_id: ctx.opId + ':late',
          expected_revision: cancelled.revision,
          generation: before.run.generation,
          session_id: session.id,
          source: report.native.primary!,
          outcome: 'PASS',
        };
        let error: string | null = null;
        try {
          applyLocalEvent((await state()).run, late);
        } catch (failure) {
          error = (failure as Error).message;
        }
        requireWorkflow(error === 'run-cancelled', 'h05-late-result-applied');
        observation = saved('event', {
          kind: 'comparison-h05-event',
          id,
          binding: report.binding,
          cancel,
          late,
          error,
        });
      } else {
        requireWorkflow(
          execution.outcome === 'completed' && execution.result !== null,
          'h05-wait-not-completed',
        );
        const current = (await state()).run;
        await working();
        assertOwner(current);
        h01ReadPin(execution.result);
        const primaryResult = object(h01ReadJson(execution.result));
        requireWorkflow(
          primaryResult.kind === 'comparison-h05-wait-result' &&
            same(primaryResult.binding, report.binding) &&
            same(primaryResult.source, report.native.primary) &&
            same(primaryResult.answer, plainAnswer(initialAnswer.answer)),
          'h05-result-binding',
        );
        applicationPin = execution.result;
        const prior = current.history.find(
          (event) => event.event_id === ctx.opId + ':known-result',
        );
        const event: LocalEvent =
          prior === undefined
            ? {
                type: 'RESULT',
                event_id: ctx.opId + ':known-result',
                expected_revision: current.revision,
                generation: binding!.identity.generation,
                session_id: session.id,
                source: execution.result,
                outcome: 'PASS',
              }
            : (JSON.parse(prior.payload) as LocalEvent);
        requireWorkflow(
          event.type === 'RESULT' && same(event.source, execution.result),
          'h05-duplicate-result-changed',
        );
        const next = applyLocalEvent(current, event);
        if (next !== current) await runs!.save(current, next);
        observation = saved('event', {
          kind: 'comparison-h05-event',
          id,
          binding: report.binding,
          event,
        });
      }
      const after = await state();
      const basis = saved('delivery', {
        kind: 'comparison-h05-delivery',
        id,
        binding: report.binding,
        terminal,
        progress,
        delivered,
        held,
        subscription: id === 'pre-subscription' ? 'after-delivery' : 'before-delivery',
      });
      const probe: H05Probe = {
        before: before.ref,
        after: after.ref,
        basis,
        observation,
        reads,
        execution,
        result: execution.result,
      };
      report.probes[id] = probe;
      report.checks[id] = true;
    };
    for (const id of [
      'pre-subscription',
      'delivery-recovered',
      'deduplicated',
      'reordered',
    ] as const)
      await waitProbe(id, 'wait');
    report.native.prefixBefore = prefix();
    report.restart.waiting = (await state()).ref;
    requireWorkflow(port.detachForRecovery !== undefined, 'h05-detach-unavailable');
    report.restart.detached = await port.detachForRecovery();
    evidence.push(report.restart.detached);
    retired = port;
    portLabel = 'h05-recovery';
    port = createH02NativeRpc(ctx, portLabel, {
      stage: 'execution',
      resume: report.restart.detached,
      observe: observed,
    });
    const recoveryReads: InputRef[] = [];
    const recoveryRpc = {
      request: async (method: string, params: Record<string, unknown>) =>
        (
          await read(
            'restart-reconciled',
            'resume',
            method,
            method === 'thread/resume'
              ? {
                  ...params,
                  model: ctx.profile.model,
                  config: { model_reasoning_effort: ctx.profile.effort },
                }
              : params,
            recoveryReads,
          )
        ).response,
      completed: port.rpc.completed,
    };
    const recoverySessions = new AppServerSessions(
      recoveryRpc,
      ctx.roots.workspaceRoot,
      'h05-' + digest(ctx.opId).slice(0, 16),
      ctx.roots.evidenceRoot,
      null,
      null,
    );
    const restoredSession = await recoverySessions.inspect(session.id);
    requireWorkflow(restoredSession !== null, 'h05-recovery-session-lost');
    confirmSession(restoredSession, { ...ctx.profile, reason: 'H05 same owner recovery' }, false);
    const restoredTurn = await recoverySessions.recoverSend(restoredSession, deliveryId);
    requireWorkflow(restoredTurn === turn, 'h05-recovery-turn-lost');
    runs = new AssignmentLocalRuns(stateRoot, commitGuard);
    report.restart.state = (await state()).ref;
    report.restart.resumed = saved('resumed', {
      kind: 'comparison-h05-resumed',
      opId: ctx.opId,
      detached: report.restart.detached,
      session: restoredSession.id,
      turn: restoredTurn,
      deliveryId,
      receipt: restoredSession.receipt,
      reads: recoveryReads,
    });
    await waitProbe('restart-reconciled', 'restart');
    const beforeFence = await state(),
      attempts: { event: LocalEvent; error: string }[] = [];
    for (const wrong of ['generation', 'owner'] as const) {
      const event: LocalEvent = {
        type: 'RESULT',
        event_id: ctx.opId + ':wrong-' + wrong,
        expected_revision: beforeFence.run.revision,
        generation: wrong === 'generation' ? ctx.identity.generation - 1 : ctx.identity.generation,
        session_id: wrong === 'owner' ? 'foreign-' + session.id : session.id,
        source: report.native.primary,
        outcome: 'PASS',
      };
      let error: string | null = null;
      try {
        applyLocalEvent((await state()).run, event);
      } catch (failure) {
        error = (failure as Error).message;
      }
      requireWorkflow(
        error === (wrong === 'generation' ? 'stale-event' : 'wrong-result-identity'),
        'h05-owner-fence-missing',
      );
      attempts.push({ event, error });
    }
    const afterFence = await state();
    report.probes['owner-fenced'] = {
      before: beforeFence.ref,
      after: afterFence.ref,
      basis: saved('delivery', {
        kind: 'comparison-h05-delivery',
        id: 'owner-fenced',
        binding: report.binding,
        terminal,
        progress,
        delivered: [],
        held: [],
        subscription: 'before-delivery',
      }),
      observation: saved('event', {
        kind: 'comparison-h05-event',
        id: 'owner-fenced',
        binding: report.binding,
        attempts,
      }),
      reads: [],
      execution: null,
      result: null,
    };
    report.checks['owner-fenced'] = true;
    await waitProbe('late-cancel-refused', 'cancel');
    report.retained.after = (await state()).ref;
    await working();
    await verifyComparisonMaterial(ctx.roots.workspaceRoot, prepared, []);
    const manifest = Buffer.from(
      canonical({
        sources: [
          report.initial.failure,
          report.binding,
          report.native.primary,
          report.retained.after,
        ],
        initial_failure: 'F-01',
      }) + '\n',
    );
    mkdirSync(join(ctx.roots.workspaceRoot, 'evidence'), { recursive: true, mode: 0o700 });
    publishFile(join(ctx.roots.workspaceRoot, 'evidence/manifest.json'), manifest);
    evidence.push({
      locator: join(ctx.roots.workspaceRoot, 'evidence/manifest.json'),
      hash: digest(manifest),
    });
    report.outcome = 'accepted';
  } catch (error) {
    report.blocking.push(error instanceof Error ? error.message : String(error));
    if (report.session === null) report.outcome = 'not-run';
  } finally {
    report.stop = await port.stop();
    evidence.push(...port.evidence);
    if (retired !== null) evidence.push(...retired.evidence);
    for (const label of ['h05-initial', 'h05-recovery']) {
      const path = join(ctx.roots.evidenceRoot, 'native-rpc-' + label, 'primary.jsonl');
      if (existsSync(path)) {
        const ref = { locator: path, hash: digest(h01RawFile(path)) };
        report.native.journals.push(ref);
        evidence.push(ref);
      }
    }
    const physical = object(h01ReadJson(report.stop));
    if (physical.confirmed !== true || ctx.signal.aborted) {
      report.outcome = 'unknown';
      report.blocking.push('h05-stop-unconfirmed');
    }
    if (report.binding !== null && report.session !== null) {
      try {
        report.native.prefixAfter = prefix();
      } catch (error) {
        report.outcome = 'unknown';
        report.blocking.push((error as Error).message);
      }
    }
  }
  if (report.outcome === 'accepted') {
    try {
      verifyH05Primary(report.binding!, report);
    } catch (error) {
      report.outcome = 'unknown';
      report.blocking.push((error as Error).message);
    }
  }
  const caseReport = saved('case', report),
    projection = saved('projection', {
      kind: 'comparison-h05-native-projection',
      scenario: 'H-05',
      opId: ctx.opId,
      engine,
      caseReport,
    });
  const nativeAcceptance =
    report.outcome === 'accepted'
      ? saved('acceptance', {
          kind: 'comparison-h05-native-acceptance',
          opId: ctx.opId,
          binding: report.binding,
          caseReport,
          qualification: false,
        })
      : null;
  return {
    outcome: report.outcome === 'accepted' ? 'completed' : 'unknown',
    evidence,
    stop: report.stop,
    projection,
    nativeAcceptance,
  };
}

export function createH05LegacyAdapter(): H01BackendAdapter {
  return { execute: (ctx) => runH05Case(ctx, 'legacy') };
}
