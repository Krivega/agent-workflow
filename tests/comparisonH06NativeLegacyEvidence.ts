import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { chatPath, isSupportedChatClientVersion } from '../adapters/codex/currentChatHost.js';
import {
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
} from '../src/adapters/codex/nativeDesktopUser.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { validateChatControl, type ChatControl } from '../core/chatControl.js';
import { stableJson } from '../core/equality.js';
import { evidenceSchema } from '../core/evidence.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';

function read(pin: unknown) {
  return object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
}

function inputPin(value: unknown) {
  const ref = object(value);
  exactFields(ref, ['locator', 'hash']);
  return h04Pin({ path: ref.locator, sha256: ref.hash });
}

function integer(value: unknown, minimum: number) {
  requireContract(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    'h06-legacy-evidence-integer',
  );
  return value;
}

function hash(value: unknown) {
  requireContract(
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
    'h06-legacy-evidence-hash',
  );
  return value;
}

function host(value: unknown) {
  const row = object(value);
  exactFields(row, ['pid', 'startedAt']);
  requireContract(
    typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) && row.startedAt > 0,
    'h06-legacy-evidence-host',
  );
  return { pid: integer(row.pid, 2), startedAt: row.startedAt };
}

function processIds(value: unknown) {
  requireContract(Array.isArray(value), 'h06-legacy-evidence-processes');
  const identities = value.map((item) => {
    const row = object(item);
    exactFields(row, ['pid', 'parent', 'started']);
    return { pid: integer(row.pid, 2), parent: integer(row.parent, 0), started: text(row.started) };
  });
  requireContract(
    new Set(identities.map(({ pid }) => pid)).size === identities.length,
    'h06-legacy-evidence-processes',
  );
  return identities;
}

function lineRef(value: unknown) {
  const source = object(value);
  exactFields(source, ['locator', 'hash']);
  const locator = text(source.locator);
  const match = /^(.*)#L([1-9]\d*)$/u.exec(locator);
  requireContract(match !== null, 'h06-legacy-evidence-source-line');
  const path = h04Pin({ path: match[1], sha256: source.hash }).path;
  return { path, line: integer(Number(match[2]), 1), hash: hash(source.hash) };
}

function transcriptRecords(path: string) {
  const bytes = h01RawFile(path).toString();
  requireContract(bytes.endsWith('\n'), 'h06-legacy-evidence-transcript-partial');
  return bytes
    .slice(0, -1)
    .split('\n')
    .map((line) => ({
      raw: object(JSON.parse(line)),
      hash: digest(line + '\n'),
    }));
}

/** Validate the archived historical turn because the live host observes only the latest turn. */
function humanSource(
  sourceValue: unknown,
  observed: ChatControl['observed'],
  sessionsRoot: string,
) {
  const source = lineRef(sourceValue);
  const context = lineRef(observed.source);
  requireContract(
    source.path === context.path && source.path.startsWith(sessionsRoot + sep),
    'h06-legacy-evidence-source-root',
  );
  const records = transcriptRecords(source.path);
  const sessionRows = records.filter(({ raw }) => raw.type === 'session_meta');
  const session = object(sessionRows[0]?.raw.payload);
  const desktop166 = isNativeDesktopUser166(session);
  const turnRow = records[context.line - 1];
  const turn = object(turnRow?.raw.payload);
  requireContract(
    sessionRows.length === 1 &&
      session.id === observed.thread_id &&
      session.session_id === observed.thread_id &&
      (isSupportedChatClientVersion(session.cli_version) ||
        (desktop166 && chatPath(session.cwd) === observed.workspace)) &&
      turnRow?.hash === context.hash &&
      turnRow.raw.type === 'turn_context' &&
      turn.turn_id === observed.turn_id &&
      chatPath(turn.cwd) === observed.workspace,
    'h06-legacy-evidence-transcript-identity',
  );
  requireContract(
    !desktop166 ||
      !hasNativeDesktopInboundDelivery(
        records.map(({ raw }) => raw),
        observed.turn_id,
      ),
    'h06-legacy-evidence-human-delegated',
  );
  const row = records[source.line - 1];
  const payload = object(row?.raw.payload);
  const started = records
    .slice(0, source.line - 1)
    .reverse()
    .find(({ raw }) => raw.type === 'event_msg' && object(raw.payload).type === 'task_started');
  requireContract(
    row?.hash === source.hash &&
      row.raw.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.some((item) => {
        const part = object(item);
        return part.type === 'input_text' && typeof part.text === 'string' && part.text.length > 0;
      }) &&
      object(started?.raw.payload).turn_id === observed.turn_id,
    'h06-legacy-evidence-human-source',
  );
  return `${source.path}#L${source.line}`;
}

function loadSources(value: unknown, observed: ChatControl['observed'], marker: string) {
  requireContract(typeof value === 'string', 'h06-legacy-evidence-load-source');
  const refs = JSON.parse(value) as unknown;
  const context = lineRef(observed.source);
  requireContract(Array.isArray(refs) && refs.length > 0, 'h06-legacy-evidence-load-source');
  const rows = transcriptRecords(context.path);
  for (const ref of refs) {
    const line = lineRef(ref);
    const record = rows[line.line - 1];
    const payload = object(record?.raw.payload);
    const item = object(payload.item);
    requireContract(
      line.path === context.path &&
        record?.hash === line.hash &&
        record.raw.type === 'event_msg' &&
        payload.type === 'item_completed' &&
        payload.thread_id === observed.thread_id &&
        payload.turn_id === observed.turn_id &&
        item.type === 'CommandExecution' &&
        item.status === 'completed' &&
        item.exit_code === 0 &&
        chatPath(item.cwd) === observed.workspace &&
        typeof item.aggregated_output === 'string',
      'h06-legacy-evidence-load-source',
    );
    const entries = item.aggregated_output
      .split('\n')
      .filter((line) => line.startsWith('{"chat_read":') || line.startsWith('{"chat_compact":'))
      .map((line) => object(JSON.parse(line)));
    requireContract(
      entries.some(
        ({ chat_read, chat_compact }) => chat_read === marker || chat_compact === marker,
      ),
      'h06-legacy-evidence-load-source',
    );
  }
}

/** Checks retained Legacy controls and their stop receipts without operating on the Store or hosts. */
export async function checkH06NativeLegacyEvidence(value: unknown) {
  const refs = object(value);
  exactFields(refs, ['started', 'warm', 'cold']);
  const startedPin = h04Pin(refs.started);
  const evidence = safeDirectory(dirname(startedPin.path));
  function named(value: unknown, name: string) {
    const pin = h04Pin(value);
    requireContract(pin.path === join(evidence, name), 'h06-legacy-evidence-path');
    return { pin, body: read(pin) };
  }
  const { body: start } = named(startedPin, 'legacy-operator-start.json');
  const { body: claim } = named(start.claim, 'attempt-claim.json');
  const request = object(claim.request);
  const binding = object(request.binding);
  const grant = object(claim.grant);
  const budget = object(request.budget);
  const stimulus = object(request.stimulus);
  const context = object(start.context);
  const workspace = safeDirectory(text(binding.workspaceRoot));
  const sessionsRoot = safeDirectory(text(grant.sessionsRoot));
  const store = join(evidence, 'legacy-store');
  const generation = integer(start.generation, 1);
  const firstRevision = integer(start.revision, 0);
  const startedAt = integer(claim.startedAt, 1);
  const stopDeadline = integer(claim.stopDeadlineMs, 1);
  const workDeadline = integer(claim.workDeadlineMs, 1);
  requireContract(
    start.kind === 'h06-native-legacy-operator-start' &&
      claim.kind === 'h06-native-attempt-claim' &&
      request.kind === 'comparison-h06-native/2' &&
      claim.requestHash === digest(canonical({ request, assets: claim.assets })) &&
      request.evidenceRoot === evidence &&
      binding.variant === 'legacy' &&
      context.schema_version === evidenceSchema &&
      context.subtask_id === null &&
      context.task_id === binding.operationId &&
      start.storeRoot === store &&
      same(start.bootstrap, request.bootstrap) &&
      stopDeadline === startedAt + integer(budget.maxElapsedMs, 1) &&
      workDeadline === stopDeadline - integer(budget.reserveMs, 1) &&
      start.oldDeadline === startedAt + integer(stimulus.initialLeaseMs, 1) &&
      Number(start.oldDeadline) < workDeadline,
    'h06-legacy-evidence-start',
  );
  const descriptor = read(start.bootstrap);
  requireContract(
    descriptor.kind === 'comparison-h06-native-legacy-bootstrap/2' &&
      descriptor.projectId === identifier(context.project_id) &&
      descriptor.runId === identifier(context.run_id) &&
      descriptor.actorId === identifier(context.actor_id) &&
      descriptor.generation === generation,
    'h06-legacy-evidence-bootstrap',
  );

  const identity = { workspace, store, evidence, context, generation };
  const sources = new Set<string>();
  let previousRevision = firstRevision;
  let requirementsRevision: number | undefined;
  let previousHistory: ChatControl['history'] | undefined;
  async function command(phase: 'warm' | 'cold', action: 'pause' | 'resume', ref: unknown) {
    const prefix = `legacy-${phase}-${action}`;
    const { pin, body: receipt } = named(ref, prefix + '.json');
    const { body: intent } = named(receipt.intent, prefix + '-intent.json');
    const owner = host(receipt.host);
    const event = object(receipt.event);
    const operation = 'chat:control:' + identifier(event.id);
    const control = receipt.control as ChatControl;
    validateChatControl(control);
    const observed = control.observed;
    const ack = object(receipt.ack);
    const storeRevision = integer(intent.storeRevision, 0);
    const requirements = integer(intent.requirementsRevision, 0);
    const revision = integer(event.expected_revision, 0) + 1;
    const history = control.history;
    requireContract(
      receipt.kind === `h06-native-legacy-${action}` &&
        intent.kind === 'h06-native-legacy-control-intent' &&
        receipt.phase === phase &&
        intent.phase === phase &&
        same(receipt.identity, identity) &&
        same(intent.identity, identity) &&
        same(intent.host, owner) &&
        owner.startedAt < workDeadline &&
        same(intent.event, event) &&
        receipt.operation === operation &&
        intent.operation === operation &&
        event.generation === generation &&
        event.thread_id === context.actor_id &&
        event.type === action.toUpperCase() &&
        control.generation === generation &&
        observed.workspace === workspace &&
        observed.host_id === 'local' &&
        observed.thread_id === context.actor_id &&
        control.status === (action === 'pause' ? 'paused' : 'active') &&
        control.revision === revision &&
        receipt.controlRevision === revision &&
        same(history.at(-1), { id: event.id, payload: stableJson(event) }) &&
        new Set(history.map(({ id }) => id)).size === history.length &&
        (previousHistory === undefined || same(previousHistory, history.slice(0, -1))) &&
        storeRevision >= previousRevision &&
        ack.operation_id === operation &&
        ack.catalog_revision === storeRevision + 1 &&
        ack.generation === generation &&
        ack.locator === store + '#operation=' + encodeURIComponent(operation) &&
        (requirementsRevision === undefined || requirementsRevision === requirements),
      'h06-legacy-evidence-control',
    );
    hash(ack.content_hash);

    let source: string;
    if (action === 'pause') {
      requireContract(
        receipt.load === null &&
          control.reason === text(event.reason) &&
          intent.stoppedBy === undefined,
        'h06-legacy-evidence-pause',
      );
      source = humanSource(event.source, observed, sessionsRoot);
    } else {
      const load = object(receipt.load);
      requireContract(
        load.run_id === context.run_id &&
          load.session_id === context.actor_id &&
          control.reason === null &&
          event.previous_source_turn === undefined,
        'h06-legacy-evidence-resume',
      );
      loadSources(load.observed_read, observed, text(event.marker));
      if (event.authorization === undefined) {
        source = humanSource(event.source, observed, sessionsRoot);
      } else {
        const authorization = inputPin(event.authorization);
        requireContract(
          same(event.authorization, event.source) && authorization.path.startsWith(evidence + sep),
          'h06-legacy-evidence-authorization',
        );
        const issuer = object(read(authorization).issuer);
        const human = lineRef(issuer.source);
        requireContract(
          issuer.transcript === human.path && human.path.startsWith(sessionsRoot + sep),
          'h06-legacy-evidence-authorization',
        );
        await new NativeUserCommands(workspace).verify(
          { locator: authorization.path, hash: authorization.sha256 },
          {
            project_id: identifier(context.project_id),
            task_id: identifier(context.task_id),
            run_id: identifier(context.run_id),
            thread_id: identifier(context.actor_id),
            generation,
            control_revision: revision - 1,
            requirements_revision: requirements,
          },
        );
        source = `${human.path}#L${human.line}`;
      }
    }
    requireContract(!sources.has(source), 'h06-legacy-evidence-reused-source');
    sources.add(source);
    previousRevision = storeRevision + 1;
    previousHistory = history;
    requirementsRevision = requirements;
    return { pin, owner, observed, intent, event, operation, revision };
  }

  const stoppedTurns = new Set<string>();
  async function checkPhase(phase: 'warm' | 'cold', value: unknown) {
    const part = object(value);
    exactFields(part, ['pause', 'stop', 'resume']);
    const pause = await command(phase, 'pause', part.pause);
    const { pin: stopPin, body: stop } = named(part.stop, `legacy-${phase}-writer-stop.json`);
    const { body: intent } = named(stop.intent, `legacy-${phase}-writer-stop-intent.json`);
    const liveness = object(stop.liveness);
    const coder = object(intent.coder);
    const brief = object(coder.brief);
    const session = object(coder.session);
    const copy = object(coder.copy);
    const copyRoot = object(copy.binding).root;
    const thread = identifier(session.id);
    const turn = identifier(coder.turn);
    const coderId = identifier(brief.id);
    const observedAt = integer(liveness.observedAt, 1);
    requireContract(
      stop.kind === 'h06-native-legacy-writer-stop' &&
        intent.kind === 'h06-native-legacy-writer-stop-intent' &&
        stop.phase === phase &&
        intent.phase === phase &&
        same(stop.identity, identity) &&
        same(intent.identity, identity) &&
        same(stop.paused, pause.pin) &&
        same(intent.paused, pause.pin) &&
        stop.parentTurn === pause.observed.turn_id &&
        intent.parentTurn === pause.observed.turn_id &&
        stop.coderId === coderId &&
        brief.project_id === context.project_id &&
        brief.task_id === context.task_id &&
        brief.parent_run_id === context.run_id &&
        brief.parent_session_id === context.actor_id &&
        brief.generation === generation &&
        brief.source_root === workspace &&
        object(object(coder.baseline).source).root === workspace &&
        brief.copy_root === copyRoot &&
        session.workspace === copyRoot &&
        session.project_id === context.project_id &&
        thread !== context.actor_id &&
        coder.status === 'running' &&
        coder.delivery === `coder:${coderId}:implementation` &&
        same(liveness, intent.liveness) &&
        liveness.status === 'live' &&
        observedAt >= Math.max(startedAt, pause.owner.startedAt) &&
        observedAt < workDeadline,
      'h06-legacy-evidence-stop-link',
    );

    const observation = object(liveness.observation);
    const native = object(observation.native);
    const loaded = object(native.loaded);
    const delivery = object(observation.delivery);
    const runtime = object(observation.runtime);
    const [runtimeProcess] = processIds([runtime.process]);
    const observedProcesses = processIds(observation.processes);
    const policy = read(inputPin(runtime.policy));
    requireContract(
      same(policy.runtime, runtimeProcess) &&
        observation.thread === thread &&
        observation.turn === turn &&
        same(native.active, { id: turn, status: 'inProgress' }) &&
        same(loaded.data, [thread]) &&
        loaded.nextCursor == null &&
        delivery.schema_version === 1 &&
        delivery.session === thread &&
        delivery.delivery === coder.delivery &&
        delivery.outcome === 'accepted' &&
        delivery.attempts === 1 &&
        delivery.responses === 1 &&
        observedProcesses.every(({ pid }) => pid !== runtimeProcess!.pid),
      'h06-legacy-evidence-liveness',
    );
    hash(delivery.request_hash);
    hash(delivery.response_hash);

    const rawPin = inputPin(stop.stopped);
    requireContract(rawPin.path.startsWith(evidence + sep), 'h06-legacy-evidence-stop-root');
    const raw = read(rawPin);
    const owned = object(raw.owned);
    const markers = [inputPin(copy.evidence), inputPin(session.receipt)];
    markers.forEach(readH04Pin);
    processIds(raw.processes);
    requireContract(
      raw.kind === 'writers-stopped' &&
        raw.thread === thread &&
        raw.active_turn === false &&
        raw.remaining_terminals === 0 &&
        raw.remaining_processes === 0 &&
        hash(raw.before_hash) === raw.after_hash &&
        owned.thread === thread &&
        owned.turn === turn &&
        owned.complete === true &&
        owned.tree === copyRoot &&
        same(
          owned.markers,
          markers.map(({ path }) => path),
        ) &&
        same(owned.runtime, runtime),
      'h06-legacy-evidence-writer-stop',
    );
    integer(raw.observation_ms, 1);

    const resume = await command(phase, 'resume', part.resume);
    const stoppedKey = JSON.stringify([thread, turn]);
    requireContract(
      same(resume.intent.stoppedBy, stopPin) &&
        same(resume.event.stopped, stop.stopped) &&
        resume.revision === pause.revision + 1 &&
        !stoppedTurns.has(stoppedKey) &&
        (phase === 'warm'
          ? same(pause.owner, resume.owner)
          : pause.owner.pid !== resume.owner.pid && resume.owner.startedAt >= observedAt),
      'h06-legacy-evidence-handoff',
    );
    stoppedTurns.add(stoppedKey);
    return {
      pause: pause.operation,
      resume: resume.operation,
      before: pause.owner,
      after: resume.owner,
      observedAt,
    };
  }

  const warm = await checkPhase('warm', refs.warm);
  const cold = await checkPhase('cold', refs.cold);
  requireContract(
    same(warm.after, cold.before) && warm.observedAt < cold.observedAt,
    'h06-legacy-evidence-host-chain',
  );
  return {
    status: 'LEGACY_CONTROL_CHAIN_VERIFIED',
    qualification: false,
    operationId: identifier(binding.operationId),
    warm,
    cold,
  } as const;
}
