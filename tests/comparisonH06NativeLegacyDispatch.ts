import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import {
  deliveryReceiptPath,
  nativeCreationProof,
  readDeliveryReceipt,
} from '../adapters/codex/transportJournal.js';
import { decodeArchivedJson } from '../adapters/storage/archiveJson.js';
import { canonical, canonicalHash, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { storageSchema } from '../adapters/storage/storeDatabase.js';
import { decodeWorkflowHistory } from '../adapters/storage/workflowJournal.js';
import type { WorkflowCheckpoint } from '../ports/workflowJournal.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { checkH06NativeHarness } from './comparisonH06NativeHarness.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';

const launch = [
  'COPY_INTENT',
  'COPIED',
  'CREATE_INTENT',
  'BIND',
  'LOAD_INTENT',
  'LOADED',
  'SEND_INTENT',
  'SENT',
] as const;
const release = ['STOP_INTENT', 'STOPPED', 'RELEASE'] as const;
const cancellation = [...release, 'CANCEL_IDLE'] as const;
const completion = ['RESULT', ...release, 'INTEGRATE_INTENT', 'INTEGRATED'] as const;
const afterLaunch = [...completion, 'CANCEL_IDLE'];
const deliveries = ['profile', 'load', 'implementation'] as const;
const sha256 = /^[a-f0-9]{64}$/u;

function read(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(pin).toString()));
}

function stored(value: unknown): string {
  requireContract(typeof value === 'string', 'h06-legacy-dispatch-store-record');
  return value;
}

function fromInput(value: unknown) {
  const ref = object(value);
  exactFields(ref, ['locator', 'hash']);
  return h04Pin({ path: ref.locator, sha256: ref.hash });
}

function named(value: unknown, path: string) {
  const pin = h04Pin(value);
  requireContract(pin.path === path, 'h06-legacy-dispatch-path');
  return read(pin);
}

function snapshot(directory: string) {
  return readdirSync(safeDirectory(directory))
    .sort()
    .map((name) => ({
      name,
      sha256: digest(h01RawFile(join(directory, name))),
    }));
}

function pinFile(path: string): H04Pin {
  return { path, sha256: digest(h01RawFile(path)) };
}

function writerState(coder: Record<string, unknown>, evidence: string) {
  const brief = object(coder.brief);
  const session = object(coder.session);
  const id = identifier(brief.id);
  const thread = identifier(session.id);
  const turn = identifier(coder.turn);
  const copy = text(brief.copy_root);
  const directory = join(evidence, 'coders', id);
  return { coder, brief, session, evidence, directory, id, thread, turn, copy };
}

function stoppedCoder(pin: H04Pin) {
  const body = read(h04Pin(pin));
  const phase = body.phase;
  const evidence = dirname(pin.path);
  requireContract(
    (phase === 'warm' || phase === 'cold') &&
      body.kind === 'h06-native-legacy-writer-stop' &&
      pin.path === join(evidence, `legacy-${phase}-writer-stop.json`),
    'h06-legacy-dispatch-stop',
  );
  const intent = named(body.intent, join(evidence, `legacy-${phase}-writer-stop-intent.json`));
  const state = writerState(object(intent.coder), evidence);
  const { coder, session, id, thread, turn, copy, directory } = state;
  const rawPin = fromInput(body.stopped);
  requireContract(
    intent.kind === 'h06-native-legacy-writer-stop-intent' &&
      intent.phase === phase &&
      same(intent.identity, body.identity) &&
      same(intent.paused, body.paused) &&
      body.coderId === id &&
      coder.status === 'running' &&
      coder.delivery === `coder:${id}:implementation` &&
      session.workspace === copy &&
      dirname(rawPin.path) === directory,
    'h06-legacy-dispatch-stop',
  );
  const raw = read(rawPin);
  const owned = object(raw.owned);
  requireContract(
    raw.kind === 'writers-stopped' &&
      raw.thread === thread &&
      raw.active_turn === false &&
      raw.remaining_terminals === 0 &&
      raw.remaining_processes === 0 &&
      typeof raw.before_hash === 'string' &&
      sha256.test(raw.before_hash) &&
      raw.before_hash === raw.after_hash &&
      owned.thread === thread &&
      owned.turn === turn &&
      owned.tree === copy &&
      owned.complete === true,
    'h06-legacy-dispatch-stop',
  );
  return { ...state, kind: 'stopped' as const, body, intent, phase, pin };
}

function completedCoder(pin: H04Pin) {
  const evidence = dirname(pin.path);
  const state = writerState(named(pin, join(evidence, 'legacy-completion-coder.json')), evidence);
  requireContract(
    state.coder.status === 'integrated' &&
      object(state.coder.result).outcome === 'PASS' &&
      state.coder.delivery === `coder:${state.id}:implementation` &&
      state.session.workspace === state.copy,
    'h06-legacy-dispatch-completion',
  );
  return { ...state, kind: 'completed' as const, pin };
}

type Writer = ReturnType<typeof stoppedCoder> | ReturnType<typeof completedCoder>;

function nativeTurns(value: unknown, state: Writer) {
  const thread = object(object(value).thread);
  requireContract(
    thread.id === state.thread &&
      thread.cwd === state.copy &&
      Array.isArray(thread.turns) &&
      thread.turns.length === deliveries.length,
    'h06-legacy-dispatch-thread',
  );
  const turns = thread.turns.map((value, index) => {
    const turn = object(value);
    const label = deliveries[index]!;
    const id = identifier(turn.id);
    requireContract(
      Array.isArray(turn.items) &&
        (label === 'implementation' && state.kind === 'stopped'
          ? ['completed', 'failed', 'interrupted'].includes(String(turn.status))
          : turn.status === 'completed'),
      'h06-legacy-dispatch-turn',
    );
    const user = turn.items.map(object).filter((item) => item.type === 'userMessage');
    requireContract(user.length === 1, 'h06-legacy-dispatch-turn');
    const content = user[0]!.content;
    requireContract(Array.isArray(content) && content.length === 1, 'h06-legacy-dispatch-turn');
    const part = object(content[0]);
    const delivery = `coder:${state.id}:${label}`;
    requireContract(
      part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.startsWith(`Workflow delivery id: ${JSON.stringify(delivery)}\n`),
      'h06-legacy-dispatch-turn',
    );
    return { id, delivery };
  });
  requireContract(
    new Set(turns.map(({ id }) => id)).size === turns.length && turns.at(-1)!.id === state.turn,
    'h06-legacy-dispatch-turn',
  );
  return turns;
}

/** Capture only the already stopped Writer thread while its owning app-server is still available. */
export async function captureH06NativeLegacyDispatchThread(
  rpc: Pick<AppServerRpc, 'request'>,
  stopped: H04Pin,
) {
  const phase = stoppedCoder(stopped);
  const value = await rpc.request('thread/read', { threadId: phase.thread, includeTurns: true });
  nativeTurns(value, phase);
  readH04Pin(stopped);
  const path = join(phase.evidence, `legacy-${phase.phase}-writer-thread.json`);
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

/** Capture the integrated Writer before its app server is closed. */
export async function captureH06NativeLegacyCompletedThread(
  rpc: Pick<AppServerRpc, 'request'>,
  coder: H04Pin,
) {
  const state = completedCoder(coder);
  const value = await rpc.request('thread/read', { threadId: state.thread, includeTurns: true });
  nativeTurns(value, state);
  readH04Pin(coder);
  const path = join(state.evidence, 'legacy-completion-writer-thread.json');
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

function journalProof(state: Writer, turns: ReturnType<typeof nativeTurns>) {
  const journal = join(state.directory, 'transport.jsonl');
  const creationRoot = journal + '.creations';
  const deliveryRoot = journal + '.deliveries';
  const creationFiles = snapshot(creationRoot);
  const deliveryFiles = snapshot(deliveryRoot);
  const operation = `coder:${state.id}:create`;
  const creation = nativeCreationProof(journal, operation);
  const source = fromInput(state.session.receipt);
  requireContract(
    creation !== null &&
      creation.response !== null &&
      creation.source !== null &&
      same(fromInput(creation.source), source) &&
      !('error' in creation.response) &&
      creationFiles.length === 2 &&
      same(
        creationFiles.map(({ name }) => name).sort(),
        [canonicalHash(operation) + '.json', basename(source.path)].sort(),
      ),
    'h06-legacy-dispatch-create',
  );
  const response = object(creation.response.result);
  const createdThread = object(response.thread);
  requireContract(
    createdThread.id === state.thread &&
      response.cwd === state.copy &&
      same(createdThread.turns, []),
    'h06-legacy-dispatch-create',
  );
  requireContract(
    same(
      deliveryFiles.map(({ name }) => name),
      turns
        .map(({ delivery }) => basename(deliveryReceiptPath(journal, state.thread, delivery)))
        .sort(),
    ),
    'h06-legacy-dispatch-inventory',
  );
  const observation = state.kind === 'stopped' ? liveObservation(state) : null;
  const rpcs = new Set([canonical([creation.receipt.connection, creation.receipt.rpc_id])]);
  const admitted = turns.map(({ id, delivery }) => {
    const receipt = readDeliveryReceipt(journal, state.thread, delivery);
    requireContract(
      receipt !== null &&
        receipt.outcome === 'accepted' &&
        receipt.attempts === 1 &&
        receipt.responses === 1,
      'h06-legacy-dispatch-delivery',
    );
    const rpc = canonical([receipt.connection, receipt.rpc_id]);
    requireContract(!rpcs.has(rpc), 'h06-legacy-dispatch-rpc');
    rpcs.add(rpc);
    if (observation !== null && id === state.turn)
      requireContract(same(receipt, observation.delivery), 'h06-legacy-dispatch-live');
    return {
      delivery,
      turn: id,
      requestHash: receipt.request_hash,
      responseHash: receipt.response_hash,
    };
  });
  requireContract(
    same(snapshot(creationRoot), creationFiles) && same(snapshot(deliveryRoot), deliveryFiles),
    'h06-legacy-dispatch-journal-changed',
  );
  return { coderId: state.id, thread: state.thread, implementation: state.turn, turns: admitted };
}

function liveObservation(state: ReturnType<typeof stoppedCoder>) {
  const active = object(state.body.liveness);
  const observation = object(active.observation);
  requireContract(
    active.status === 'live' &&
      same(active, state.intent.liveness) &&
      observation.thread === state.thread &&
      observation.turn === state.turn,
    'h06-legacy-dispatch-live',
  );
  return observation;
}

function coldResume(cold: ReturnType<typeof stoppedCoder>) {
  const pin = pinFile(join(cold.evidence, 'legacy-cold-resume.json'));
  const receipt = read(pin);
  const intent = named(receipt.intent, join(cold.evidence, 'legacy-cold-resume-intent.json'));
  const event = object(receipt.event);
  const control = object(receipt.control);
  const operation = `chat:control:${identifier(event.id)}`;
  requireContract(
    receipt.kind === 'h06-native-legacy-resume' &&
      receipt.phase === 'cold' &&
      same(receipt.identity, cold.body.identity) &&
      receipt.operation === operation &&
      intent.kind === 'h06-native-legacy-control-intent' &&
      intent.phase === 'cold' &&
      intent.operation === operation &&
      same(intent.identity, receipt.identity) &&
      same(intent.event, event) &&
      same(intent.stoppedBy, cold.pin) &&
      event.type === 'RESUME' &&
      same(event.stopped, cold.body.stopped) &&
      control.status === 'active',
    'h06-legacy-dispatch-cold-resume',
  );
  return { operation, ack: object(receipt.ack), control, pin };
}

function checkCompletionTurns(
  request: Record<string, unknown>,
  operationId: string,
  evidence: string,
  checked: { state: Writer; journal: ReturnType<typeof journalProof> }[],
) {
  const budget = object(request.budget);
  requireContract(typeof budget.maxManagedStarts === 'number', 'h06-legacy-dispatch-turn-budget');
  const ledger = openH06NativeTurnLedger(join(evidence, 'legacy-turns'), {
    mode: 'reopen',
    operationId,
    maxManagedStarts: budget.maxManagedStarts,
    legacy: true,
  }).inspect();
  const expected = checked.flatMap(({ state, journal }) =>
    journal.turns.map(({ delivery, turn }) => ({
      root: state.copy,
      session: state.thread,
      journal: join(state.directory, 'transport.jsonl'),
      operation: delivery,
      turn,
    })),
  );
  const actual = ledger.admissions.map(({ scope, response }) => ({
    root: scope.root,
    session: scope.session,
    journal: scope.journal,
    operation: scope.operation,
    turn: response?.turnId,
  }));
  requireContract(
    ledger.status === 'RECORDED' && same(actual, expected),
    'h06-legacy-dispatch-turn-budget',
  );
}

function storeProof(
  pin: H04Pin,
  start: Record<string, unknown>,
  phases: Writer[],
  resume: ReturnType<typeof coldResume> | null,
) {
  const context = object(start.context);
  const root = text(start.storeRoot);
  requireContract(pin.path === join(root, 'store.sqlite'), 'h06-legacy-dispatch-store-path');
  const idle = () =>
    requireContract(
      ['-journal', '-wal', '-shm'].every(
        (suffix) => lstatSync(pin.path + suffix, { throwIfNoEntry: false }) === undefined,
      ),
      'h06-legacy-dispatch-store-active',
    );
  idle();
  readH04Pin(pin);
  const db = new DatabaseSync(pin.path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const identity = db.prepare('SELECT project,task FROM identity').get();
    const version = db.prepare('PRAGMA user_version').get();
    requireContract(
      version?.user_version === storageSchema &&
        identity?.project === context.project_id &&
        identity?.task === context.task_id,
      'h06-legacy-dispatch-store-identity',
    );
    const decode = (value: unknown) =>
      object(
        decodeArchivedJson(
          stored(value),
          (hash) =>
            readH04Pin(h04Pin({ path: join(root, 'blobs', hash), sha256: hash })).toString(),
          false,
        ),
      );
    const state = decode(db.prepare('SELECT body FROM state').get()?.body);
    requireContract(
      state.generation === start.generation &&
        state.owner === context.actor_id &&
        state.released === false &&
        state.frozen === false,
      'h06-legacy-dispatch-store-owner',
    );
    const checkpoint = object(object(state.checkpoint).workflow);
    const retained = decodeWorkflowHistory(checkpoint as unknown as WorkflowCheckpoint);
    const coders = object(retained.coders);
    requireContract(
      same(Object.keys(coders).sort(), phases.map(({ id }) => id).sort()),
      'h06-legacy-dispatch-store-inventory',
    );
    const operationNames = new Set(
      phases.flatMap(({ id, kind }) => {
        const tail =
          kind === 'completed' ? completion : resume === null ? afterLaunch : cancellation;
        return ['reserve', ...launch, ...tail].map((action) => `coder:${id}:${action}`);
      }),
    );
    const operations = db
      .prepare("SELECT id,hash,ack FROM operations WHERE id GLOB 'coder:*'")
      .all();
    requireContract(
      operations.every(({ id }) => typeof id === 'string' && operationNames.has(id)),
      'h06-legacy-dispatch-store-inventory',
    );
    const effects = db
      .prepare('SELECT body FROM effects')
      .all()
      .map(({ body }) => object(JSON.parse(stored(body))));
    requireContract(
      effects.every(
        ({ outcome, receipt }) =>
          (outcome === 'confirmed' || outcome === 'not-started') && receipt != null,
      ),
      'h06-legacy-dispatch-store-effects',
    );
    let revision = Number(start.revision);
    requireContract(
      Number.isSafeInteger(revision) && revision >= 0,
      'h06-legacy-dispatch-store-revision',
    );
    const rows = new Map(operations.map((row) => [row.id, row]));
    const eventAt = db.prepare('SELECT body FROM events WHERE revision=?');
    function acknowledgement(operation: string, row = rows.get(operation)) {
      requireContract(
        row !== undefined && typeof row.hash === 'string' && sha256.test(row.hash),
        'h06-legacy-dispatch-store-operation',
      );
      const ack = object(JSON.parse(stored(row.ack)));
      const current = ack.catalog_revision;
      requireContract(
        typeof current === 'number' &&
          Number.isSafeInteger(current) &&
          current > revision &&
          current <= Number(state.revision) &&
          ack.operation_id === operation &&
          ack.generation === start.generation &&
          ack.locator === `${root}#operation=${encodeURIComponent(operation)}`,
        'h06-legacy-dispatch-store-operation',
      );
      const event = decode(eventAt.get(current)?.body);
      const change = object(event.change);
      requireContract(
        event.operation_id === operation &&
          event.revision === current &&
          same(event.context, context) &&
          change.type === 'checkpoint' &&
          ack.content_hash === canonicalHash(change),
        'h06-legacy-dispatch-store-operation',
      );
      revision = current;
      return { operation, revision, ack, change };
    }
    const proof = phases.map((phase) => {
      const { coder, id, session, thread, turn, brief } = phase;
      const final = object(coders[id]);
      const history =
        phase.kind === 'completed' && Array.isArray(coder.history)
          ? coder.history.slice(0, launch.length)
          : coder.history;
      requireContract(
        same(final.brief, brief) &&
          same(final.session, session) &&
          same(final.copy, coder.copy) &&
          final.turn === turn &&
          final.delivery === coder.delivery &&
          Array.isArray(history) &&
          history.length === launch.length &&
          Array.isArray(final.history) &&
          same(final.history.slice(0, launch.length), history),
        'h06-legacy-dispatch-store-coder',
      );
      for (const [index, action] of launch.entries()) {
        const entry = object(history[index]);
        const event = object(JSON.parse(stored(entry.payload)));
        requireContract(
          entry.id === `${id}:${action}` &&
            event.id === entry.id &&
            event.type === action &&
            event.generation === start.generation,
          'h06-legacy-dispatch-store-coder',
        );
        if (action === 'BIND')
          requireContract(same(event.session, session), 'h06-legacy-dispatch-store-coder');
        if (action === 'SEND_INTENT')
          requireContract(event.delivery === coder.delivery, 'h06-legacy-dispatch-store-coder');
        if (action === 'SENT')
          requireContract(event.turn === turn, 'h06-legacy-dispatch-store-coder');
      }
      const step = (action: string) => {
        const { operation, revision } = acknowledgement(`coder:${id}:${action}`);
        return { operation, revision };
      };
      const acknowledgements = ['reserve', ...launch].map(step);
      if (resume !== null) {
        const finished = phase.kind === 'completed';
        const tail = finished ? completion : cancellation;
        requireContract(
          (finished ? same(final, coder) : final.status === 'cancelled') &&
            same(
              final.history.map((entry) => object(entry).id),
              [...launch, ...tail].map((action) => `${id}:${action}`),
            ),
          'h06-legacy-dispatch-store-completion',
        );
        if (phase.kind === 'stopped' && phase.phase === 'cold') {
          const row = db
            .prepare('SELECT id,hash,ack FROM operations WHERE id=?')
            .get(resume.operation);
          const confirmed = acknowledgement(resume.operation, row);
          requireContract(
            same(confirmed.ack, resume.ack) &&
              same(object(object(confirmed.change.state).workflow).control, resume.control),
            'h06-legacy-dispatch-cold-resume',
          );
          readH04Pin(resume.pin);
        }
        acknowledgements.push(...tail.map(step));
      }
      return { thread, acknowledgements };
    });
    db.exec('COMMIT');
    return proof;
  } finally {
    db.close();
    idle();
    readH04Pin(pin);
  }
}

/** Reconcile retained Legacy Writer dispatches without operating on the Store or hosts. */
export function checkH06NativeLegacyDispatch(value: unknown) {
  const refs = object(value);
  const hasCompletion = Object.hasOwn(refs, 'completion');
  exactFields(refs, [
    'started',
    'database',
    'warm',
    'cold',
    ...(hasCompletion ? ['completion'] : []),
  ]);
  const started = h04Pin(refs.started);
  const evidence = dirname(started.path);
  const start = named(started, join(evidence, 'legacy-operator-start.json'));
  const claim = named(start.claim, join(evidence, 'attempt-claim.json'));
  const request = object(claim.request);
  const binding = object(request.binding);
  const context = object(start.context);
  const generation = start.generation;
  const identity = {
    workspace: binding.workspaceRoot,
    store: start.storeRoot,
    evidence,
    context,
    generation,
  };
  requireContract(
    start.kind === 'h06-native-legacy-operator-start' &&
      claim.kind === 'h06-native-attempt-claim' &&
      request.kind === 'comparison-h06-native/2' &&
      binding.variant === 'legacy' &&
      request.evidenceRoot === evidence &&
      same(start.bootstrap, request.bootstrap) &&
      claim.requestHash === digest(canonical({ request, assets: claim.assets })) &&
      context.task_id === binding.operationId &&
      start.storeRoot === join(evidence, 'legacy-store') &&
      typeof generation === 'number' &&
      Number.isSafeInteger(generation) &&
      generation > 0,
    'h06-legacy-dispatch-attempt',
  );
  function verifyIdentity(state: Writer) {
    requireContract(
      state.evidence === evidence &&
        state.brief.project_id === context.project_id &&
        state.brief.task_id === context.task_id &&
        state.brief.parent_run_id === context.run_id &&
        state.brief.parent_session_id === context.actor_id &&
        state.brief.generation === generation &&
        state.brief.source_root === binding.workspaceRoot &&
        state.thread !== context.actor_id,
      'h06-legacy-dispatch-identity',
    );
  }
  const held = (['warm', 'cold'] as const).map((phase) => {
    const part = object(refs[phase]);
    exactFields(part, ['stop', 'thread']);
    const state = stoppedCoder(h04Pin(part.stop));
    verifyIdentity(state);
    requireContract(
      state.phase === phase && same(state.body.identity, identity),
      'h06-legacy-dispatch-identity',
    );
    const thread = named(part.thread, join(evidence, `legacy-${phase}-writer-thread.json`));
    return { state, journal: journalProof(state, nativeTurns(thread, state)) };
  });
  const operationId = identifier(binding.operationId);
  let completed: {
    state: ReturnType<typeof completedCoder>;
    journal: ReturnType<typeof journalProof>;
    harness: ReturnType<typeof checkH06NativeHarness>;
  } | null = null;
  let resumed: ReturnType<typeof coldResume> | null = null;
  if (hasCompletion) {
    const part = object(refs.completion);
    exactFields(part, ['coder', 'thread']);
    const coder = h04Pin(part.coder);
    const state = completedCoder(coder);
    verifyIdentity(state);
    resumed = coldResume(held[1]!.state);
    const intentPin = pinFile(join(evidence, 'legacy-completion-intent.json'));
    const intent = read(intentPin);
    exactFields(intent, ['claim', 'started', 'coldResume', 'brief', 'warmThread', 'coldThread']);
    const brief = h04Pin(intent.brief);
    requireContract(
      same(intent.claim, start.claim) &&
        same(intent.started, started) &&
        same(intent.coldResume, resumed.pin) &&
        same(intent.warmThread, object(refs.warm).thread) &&
        same(intent.coldThread, object(refs.cold).thread) &&
        Array.isArray(request.runtime) &&
        request.runtime.some((pin) => same(pin, brief)) &&
        same(read(brief), state.brief) &&
        state.copy === join(evidence, 'coder-workspaces', state.id),
      'h06-legacy-dispatch-completion-intent',
    );
    const thread = named(part.thread, join(evidence, 'legacy-completion-writer-thread.json'));
    const journal = journalProof(state, nativeTurns(thread, state));
    const harness = checkH06NativeHarness({
      variant: 'legacy',
      coder,
      integrated: fromInput(state.coder.receipt),
    });
    requireContract(
      harness.variant === 'legacy' &&
        harness.session === journal.thread &&
        harness.loadTurn === journal.turns[1]!.turn &&
        harness.implementationTurn === journal.implementation,
      'h06-legacy-dispatch-completion-harness',
    );
    readH04Pin(intentPin);
    completed = { state, journal, harness };
  }
  const checked = completed === null ? held : [...held, completed];
  const ids = checked.map(({ state }) => state.id);
  requireContract(
    new Set(ids).size === checked.length &&
      new Set(checked.map(({ state }) => state.thread)).size === checked.length &&
      new Set(checked.map(({ state }) => state.copy)).size === checked.length &&
      same(readdirSync(safeDirectory(join(evidence, 'coders'))).sort(), ids.sort()),
    'h06-legacy-dispatch-inventory',
  );
  if (completed !== null) checkCompletionTurns(request, operationId, evidence, checked);
  return {
    status: 'LEGACY_DISPATCH_CHAIN_VERIFIED',
    operationId,
    attempts: checked.map(({ journal }) => journal),
    store: storeProof(
      h04Pin(refs.database),
      start,
      checked.map(({ state }) => state),
      resumed,
    ),
    ...(completed === null ? {} : { completion: completed.harness }),
    qualification: false,
  } as const;
}
