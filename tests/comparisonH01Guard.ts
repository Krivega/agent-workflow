import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { requireWorkflow, object } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';
import { readComparisonUsage, sealComparisonUsage } from '../adapters/codex/comparisonUsage.js';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { privateDirectory, publishFile } from '../src/adapters/artifacts/files.js';
import { readerBudget } from '../src/adapters/codex/readerBudget.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { captureTaskBudget, verifyTaskBudget } from '../src/worker/taskBudget.js';
import type { TaskExecutionBudget } from '../src/contracts/taskExecution.js';
import type {
  H01GuardDescriptor,
  H01ModelStart,
  H01NativeAccounting,
  H01NativeObserver,
  NativeComparisonScenario,
  NativeCompactionConfirmation,
} from './comparisonH01Contract.js';
import {
  comparisonKind,
  parseH01GuardDescriptor,
  verifyH01GuardAuthorization,
} from './comparisonH01Contract.js';

function bytes(path: string): Buffer {
  safeDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireWorkflow(before.isFile() && before.nlink === 1n, 'h01-guard-file-unknown');
    const content = readFileSync(fd),
      after = fstatSync(fd, { bigint: true });
    const identity = (stat: typeof before) => [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ];
    requireWorkflow(
      same(identity(before), identity(after)) &&
        same(identity(after), identity(lstatSync(path, { bigint: true }))),
      'h01-guard-file-changed',
    );
    return content;
  } finally {
    closeSync(fd);
  }
}
function pinned(ref: InputRef): Buffer {
  const content = bytes(ref.locator);
  requireWorkflow(digest(content) === ref.hash, 'h01-guard-pin-changed');
  return content;
}
function ref(path: string): InputRef {
  return { locator: path, hash: digest(bytes(path)) };
}
function descriptor(
  controlRef: InputRef,
  scenario: NativeComparisonScenario = 'H-01',
): H01GuardDescriptor {
  pinned(controlRef);
  return parseH01GuardDescriptor(controlRef, scenario);
}
function save(root: string, name: string, value: unknown): InputRef {
  const path = join(root, name),
    content = Buffer.from(canonical(value) + '\n');
  try {
    publishFile(path, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireWorkflow(bytes(path).equals(content), 'h01-guard-record-conflict');
  }
  return { locator: path, hash: digest(content) };
}

/** A completed app-server response alone is not a native accounting barrier. */
export function verifyNativeCompactionBarrier(
  participant: ComparisonParticipant,
  before: InputRef,
) {
  const body = bytes(participant.transcript).toString('utf8');
  requireWorkflow(body.endsWith('\n'), 'native-compaction-before-partial');
  const lines = body.slice(0, -1).split('\n'),
    match = before.locator.match(/^(.*)#L([1-9]\d*)$/u);
  requireWorkflow(match?.[1] === participant.transcript, 'native-compaction-before-source');
  const end = Number(match![2]),
    text = lines[end - 1];
  requireWorkflow(
    text !== undefined && digest(text + '\n') === before.hash,
    'native-compaction-before-changed',
  );
  const records = lines.slice(0, end).map((line) => object(JSON.parse(line)));
  const start = records
    .map((record) => record.type === 'event_msg' && object(record.payload).type === 'task_started')
    .lastIndexOf(true);
  requireWorkflow(start >= 0, 'native-compaction-before-turn-missing');
  const turn = object(records[start]!.payload).turn_id;
  requireWorkflow(
    typeof turn === 'string' && turn.length > 0,
    'native-compaction-before-turn-missing',
  );
  const terminal = records
    .map(
      (record) =>
        record.type === 'event_msg' &&
        ['task_complete', 'task_aborted', 'turn_aborted'].includes(
          String(object(record.payload).type),
        ) &&
        object(record.payload).turn_id === turn,
    )
    .lastIndexOf(true);
  requireWorkflow(terminal > start, 'native-compaction-before-turn-active');
  requireWorkflow(
    records
      .slice(start + 1, terminal)
      .some(
        (record) => record.type === 'token_usage_record' && object(record.payload).turn_id === turn,
      ),
    'native-compaction-before-usage-missing',
  );
  const receipts = readComparisonUsage({
    session: participant.session,
    transcript: participant.transcript,
    run: participant.run,
    stage: participant.stage,
    through: before,
  });
  requireWorkflow(
    receipts.length > 0 &&
      receipts.every((receipt) =>
        [receipt.responses, receipt.input_uncached, receipt.input_cached, receipt.output].every(
          (metric) => metric !== null,
        ),
      ),
    'native-compaction-before-usage-unknown',
  );
  return { turn, through: before };
}

export function verifyNativeCompactionSpan(
  participant: ComparisonParticipant,
  value: Pick<NativeCompactionConfirmation, 'before' | 'boundary' | 'through'>,
) {
  verifyNativeCompactionBarrier(participant, value.before);
  const transcript = bytes(participant.transcript).toString('utf8');
  requireWorkflow(transcript.endsWith('\n'), 'native-compaction-partial');
  const lines = transcript.slice(0, -1).split('\n');
  const line = (ref: InputRef) => {
    const match = ref.locator.match(/^(.*)#L([1-9]\d*)$/u);
    requireWorkflow(match?.[1] === participant.transcript, 'native-compaction-source');
    const index = Number(match![2]) - 1,
      text = lines[index];
    requireWorkflow(
      text !== undefined && digest(text + '\n') === ref.hash,
      'native-compaction-source-changed',
    );
    return { index, record: object(JSON.parse(text)) };
  };
  const before = line(value.before),
    boundary = line(value.boundary),
    through = value.through ?? value.boundary;
  requireWorkflow(
    boundary.index > before.index &&
      boundary.record.type === 'compacted' &&
      line(through).index >= boundary.index,
    'native-compaction-boundary',
  );
  requireWorkflow(
    !lines.slice(before.index + 1, line(through).index + 1).some((text) => {
      const record = object(JSON.parse(text));
      return record.type === 'event_msg' && object(record.payload).type === 'task_started';
    }),
    'native-compaction-range-has-turn',
  );
  const base = {
    session: participant.session,
    transcript: participant.transcript,
    run: participant.run,
    stage: participant.stage,
  };
  const prior = new Set(
    readComparisonUsage({ ...base, through: value.before }, true).map((receipt) => receipt.id),
  );
  const observed = readComparisonUsage({ ...base, through }, true);
  const fresh = observed.filter(
    (receipt) => line(receipt.source).index > before.index && !prior.has(receipt.id),
  );
  requireWorkflow(
    fresh.length > 0 &&
      fresh.every(
        (receipt) =>
          line(receipt.source).record.type === 'token_usage_record' &&
          receipt.responses !== null &&
          receipt.responses > 0 &&
          [receipt.input_uncached, receipt.input_cached, receipt.output].every(
            (metric) => metric !== null,
          ),
      ),
    'native-compaction-usage-unknown',
  );
  return fresh;
}

export function createH01NativeGuard(
  controlRef: InputRef,
  scenario: NativeComparisonScenario = 'H-01',
): H01NativeObserver {
  const control = descriptor(controlRef, scenario);
  pinned(control.binary);
  const root = privateDirectory(join(control.roots.evidenceRoot, 'native-guard'));
  const ledger = join(control.roots.hostRoot, 'turn-credits');
  const consume = readerBudget(ledger, control.budget.maxManagedStarts);
  const store = artifactStore(control.roots.artifactRoot);
  save(control.roots.evidenceRoot, 'native-guard-binding.json', {
    controlRef,
    root: String(lstatSync(root).ino),
    rootDevice: String(lstatSync(root).dev),
    ledger: String(lstatSync(ledger).ino),
    ledgerDevice: String(lstatSync(ledger).dev),
  });
  const records = (prefix: string) =>
    readdirSync(root)
      .sort()
      .filter((name) => name.startsWith(prefix));
  const json = (name: string) => object(JSON.parse(bytes(join(root, name)).toString()));
  function unknown(reason: string) {
    save(root, `unknown-${digest(reason)}.json`, {
      reason,
      qualification: false,
    });
  }
  function checked<T>(effect: () => T): T {
    try {
      return effect();
    } catch (error) {
      unknown(error instanceof Error ? error.message : 'h01-guard-outcome-unknown');
      throw error;
    }
  }
  function budget() {
    const previousName = records('budget-').at(-1);
    const previous = previousName === undefined ? null : json(previousName).manifest;
    const value = captureTaskBudget(
      ledger,
      store,
      previous as Parameters<typeof captureTaskBudget>[2],
    );
    const record = object(JSON.parse(store.read(value.manifest).toString()));
    save(root, `budget-${String(value.used).padStart(16, '0')}.json`, value);
    return {
      value,
      credits: record.credits as { key: string; hash: string }[],
    };
  }
  const pendingLedger = (error: unknown) =>
    error instanceof Error && error.message === 'task-budget-operation-pending';
  function availableBudget() {
    try {
      return budget();
    } catch (error) {
      if (pendingLedger(error)) return null;
      throw error;
    }
  }
  async function consistentBudget(work: boolean) {
    for (;;) {
      clock(work);
      try {
        return budget();
      } catch (error) {
        if (!pendingLedger(error)) throw error;
      }
      const end = BigInt(work ? control.workDeadlineNs : control.deadlineNs);
      const remainingMs = Math.max(0, Number(end - process.hrtime.bigint()) / 1_000_000);
      await new Promise<void>((done) => setTimeout(done, Math.min(25, remainingMs)));
    }
  }
  function capabilities(name: string) {
    const value = json(name);
    const observation = object(
      JSON.parse(pinned(value.evidence as unknown as InputRef).toString()),
    );
    requireWorkflow(
      observation.kind === 'h01-native-capabilities' && observation.session === value.session,
      'h01-guard-capabilities-unconfirmed',
    );
    assertCoderCapabilities(observation.response, value.disabled as string[]);
  }
  function clock(work: boolean) {
    const start = BigInt(control.startedNs),
      end = BigInt(control.deadlineNs);
    const workEnd = BigInt(control.workDeadlineNs),
      now = process.hrtime.bigint();
    requireWorkflow(
      end - start === BigInt(control.budget.maxElapsedMs) * 1_000_000n &&
        end - workEnd === BigInt(control.budget.reserveMs) * 1_000_000n &&
        workEnd >= start &&
        now >= start,
      'h01-guard-clock-unknown',
    );
    requireWorkflow(now < (work ? workEnd : end), 'h01-guard-deadline');
  }
  function compaction(value: NativeCompactionConfirmation) {
    requireWorkflow(scenario === 'H-03', 'native-compaction-scenario');
    const start = json(`start-${value.key}.json`);
    const participant = json(`participant-${digest(value.session)}.json`)
      .participant as unknown as ComparisonParticipant;
    const dispatch = object(JSON.parse(pinned(value.evidence).toString()));
    requireWorkflow(
      start.method === 'thread/compact/start' &&
        start.session === value.session &&
        same(start.before, value.before) &&
        participant.session === value.session &&
        dispatch.kind === 'comparison-native-compaction-dispatch' &&
        dispatch.scenario === scenario &&
        dispatch.opId === control.opId &&
        dispatch.method === start.method &&
        same(dispatch.start, start) &&
        same(dispatch.params, { threadId: value.session }) &&
        same(dispatch.before, value.before),
      'native-compaction-binding',
    );
    return verifyNativeCompactionSpan(participant, value);
  }
  function state(captured: ReturnType<typeof budget> | null = availableBudget()): {
    accounting: H01NativeAccounting;
    closedUnknown: boolean;
    recoveryUnknown: boolean;
  } {
    pinned(controlRef);
    const participants: ComparisonParticipant[] = [];
    const receipts = [] as H01NativeAccounting['receipts'];
    let missingUsage = false;
    let closedMissing = false;
    for (const name of records('participant-')) {
      const participant = json(name).participant as unknown as ComparisonParticipant;
      const complete = records(`complete-${digest(participant.session)}.`).length > 0;
      const sealed = complete
        ? json(`complete-${digest(participant.session)}.json`).participant
        : participant;
      participants.push(sealed as ComparisonParticipant);
      const observed = readComparisonUsage(sealed as ComparisonParticipant, !complete);
      if (
        complete &&
        observed.some((receipt) =>
          [receipt.responses, receipt.input_uncached, receipt.input_cached, receipt.output].some(
            (v) => v === null,
          ),
        )
      )
        closedMissing = true;
      if (
        observed.length === 0 &&
        records('start-').some((name) => json(name).session === participant.session)
      )
        missingUsage = true;
      receipts.push(...observed);
    }
    const pending = records('start-').some(
      (name) => records(`confirmed-${name.slice('start-'.length)}`).length === 0,
    );
    const missing =
      missingUsage ||
      records('start-').some(
        (name) => !existsSync(join(root, `participant-${digest(String(json(name).session))}.json`)),
      ) ||
      receipts.some((receipt) =>
        [receipt.responses, receipt.input_uncached, receipt.input_cached, receipt.output].some(
          (v) => v === null,
        ),
      );
    const sum = (field: 'input_uncached' | 'input_cached' | 'output') =>
      missing || captured === null
        ? null
        : receipts.reduce((total, receipt) => total + receipt[field]!, 0);
    const incomplete = records('created-').some(
      (name) => !existsSync(join(root, name.replace('created-', 'complete-'))),
    );
    const unregistered = captured !== null && captured.value.used > records('start-').length;
    const accounting: H01NativeAccounting = {
      participants,
      receipts,
      reservedManagedStarts: captured?.value.used ?? null,
      observedResponses:
        missing || captured === null
          ? null
          : receipts.reduce((total, receipt) => total + receipt.responses!, 0),
      inputUncached: sum('input_uncached'),
      inputCached: sum('input_cached'),
      output: sum('output'),
      unknown:
        captured === null ||
        records('unknown-').length > 0 ||
        pending ||
        missing ||
        incomplete ||
        unregistered,
      evidence: [
        controlRef,
        ...readdirSync(root)
          .sort()
          .map((name) => ref(join(root, name))),
      ],
    };
    return {
      accounting,
      recoveryUnknown:
        captured === null || records('unknown-').length > 0 || pending || missing || unregistered,
      closedUnknown:
        closedMissing ||
        (captured !== null &&
          records('created-').length > 0 &&
          !incomplete &&
          (pending || missing || unregistered)),
    };
  }
  async function verify(work: boolean) {
    await verifyH01GuardAuthorization(control);
    const captured = await consistentBudget(work);
    await verifyH01GuardAuthorization(control);
    return checked(() => {
      clock(work);
      control.pins.forEach(pinned);
      for (const name of records('confirmed-')) {
        const confirmation = json(name);
        if (confirmation.kind === 'comparison-native-compaction-confirmation')
          requireWorkflow(
            same(
              compaction(confirmation as unknown as NativeCompactionConfirmation),
              confirmation.usage,
            ),
            'native-compaction-usage-changed',
          );
      }
      pinned(control.binary);
      records('capabilities-').forEach(capabilities);
      const request = object(JSON.parse(pinned(control.request).toString()));
      const bootstrap = object(
        JSON.parse(pinned(request.bootstrap as unknown as InputRef).toString()),
      );
      if (bootstrap.engine === 'legacy' && scenario === 'H-01') {
        const runtime = resolve(control.roots.stateRoot, 'legacy-runtime');
        verifyH01LegacyOverlay(runtime, controlRef, ref(join(runtime, 'h01-overlay.json')));
      }
      const { accounting, closedUnknown } = state(captured);
      requireWorkflow(records('unknown-').length === 0, 'h01-guard-unknown');
      requireWorkflow(!closedUnknown, 'h01-guard-final-evidence-unknown');
      const knownLowerBound = (field: 'input_uncached' | 'output') =>
        accounting.receipts
          .map((receipt) => receipt[field])
          .filter((value): value is number => value !== null)
          .reduce((total, value) => total + value, 0);
      const input = knownLowerBound('input_uncached'),
        output = knownLowerBound('output');
      // The parent can be waiting for this nested role before its own usage exists.
      requireWorkflow(
        (work
          ? input < control.budget.maxInputUncached
          : input <= control.budget.maxInputUncached) &&
          (work ? output < control.budget.maxOutput : output <= control.budget.maxOutput),
        'h01-guard-usage-unknown-or-exhausted',
      );
      return captured;
    });
  }
  return {
    controlRef,
    async beforeModelStart(start) {
      try {
        const captured = await verify(true);
        checked(() => {
          requireWorkflow(
            ['legacy', 'temporal-host', 'common-council'].includes(start.origin) &&
              /^[a-f0-9]{64}$/u.test(start.key) &&
              /^[a-f0-9]{64}$/u.test(start.hash),
            'h01-guard-start-invalid',
          );
          requireWorkflow(
            start.method === undefined ||
              (scenario === 'H-03' &&
                start.method === 'thread/compact/start' &&
                start.stage === 'execution'),
            'native-compaction-start-forbidden',
          );
          if (start.method !== undefined) {
            requireWorkflow(
              !records('start-').some((name) => json(name).method === 'thread/compact/start'),
              'native-compaction-no-repeat',
            );
            requireWorkflow(start.before !== undefined, 'native-compaction-before-required');
            const participant = json(`participant-${digest(start.session)}.json`)
              .participant as unknown as ComparisonParticipant;
            verifyNativeCompactionBarrier(participant, start.before);
          }
          requireWorkflow(
            records('start-').every(
              (name) => records(`confirmed-${name.slice('start-'.length)}`).length > 0,
            ),
            'h01-guard-dispatch-pending',
          );
          const creation = json(`created-${digest(start.session)}.json`);
          requireWorkflow(creation.stage === start.stage, 'h01-guard-stage-conflict');
          const primary = object(
            object(JSON.parse(pinned(creation.creation as unknown as InputRef).toString()))
              .response,
          );
          requireWorkflow(
            primary.model === control.profile.model &&
              primary.reasoningEffort === control.profile.effort,
            'h01-guard-native-profile-unconfirmed',
          );
          const knownCapabilities = records(`capabilities-${digest(start.session)}-`);
          requireWorkflow(knownCapabilities.length > 0, 'h01-guard-capabilities-missing');
          knownCapabilities.forEach(capabilities);
          requireWorkflow(
            !records('start-').includes(`start-${start.key}.json`),
            'h01-guard-no-blind-retry',
          );
          const credits = captured.credits;
          if (start.origin === 'temporal-host')
            requireWorkflow(
              credits.some((c) => c.key === start.key && c.hash === start.hash),
              'h01-guard-temporal-credit-missing',
            );
          requireWorkflow(
            credits.every(
              (credit) =>
                records('start-').includes(`start-${credit.key}.json`) ||
                (start.origin === 'temporal-host' && credit.key === start.key),
            ),
            'h01-guard-unaccounted-credit',
          );
          save(root, `start-${start.key}.json`, start);
          if (start.origin !== 'temporal-host') consume(start.key, start.hash);
        });
        const after = await verify(true);
        checked(() =>
          requireWorkflow(
            after.credits.some((credit) => credit.key === start.key && credit.hash === start.hash),
            'h01-guard-reservation-unconfirmed',
          ),
        );
      } catch (error) {
        unknown('h01-guard-start-refused');
        throw error;
      }
    },
    confirmModelStart(confirmation) {
      checked(() => {
        clock(false);
        const start = json(`start-${confirmation.key}.json`);
        const observation = object(JSON.parse(pinned(confirmation.evidence).toString()));
        const response = object(observation.response);
        requireWorkflow(
          observation.kind === 'h01-native-dispatch' &&
            start.method === undefined &&
            observation.method === 'turn/start' &&
            object(observation.params).threadId === confirmation.session &&
            same(observation.start, start) &&
            start.session === confirmation.session &&
            object(response.turn).id === confirmation.turn,
          'h01-guard-start-unconfirmed',
        );
        save(root, `confirmed-${confirmation.key}.json`, confirmation);
      });
    },
    confirmCompaction(confirmation) {
      checked(() => {
        clock(false);
        const usage = compaction(confirmation);
        save(root, `confirmed-${confirmation.key}.json`, {
          ...confirmation,
          kind: 'comparison-native-compaction-confirmation',
          usage,
        });
      });
    },
    registerCreation(creation) {
      checked(() => {
        const observation = object(JSON.parse(pinned(creation.creation).toString()));
        const thread = object(object(observation.response).thread);
        requireWorkflow(
          observation.kind === 'h01-native-dispatch' &&
            observation.method === 'thread/start' &&
            thread.id === creation.session &&
            Array.isArray(thread.turns) &&
            thread.turns.length === 0 &&
            creation.run === control.opId,
          'h01-guard-creation-unconfirmed',
        );
        save(root, `created-${digest(creation.session)}.json`, creation);
      });
    },
    registerCapabilities(value) {
      checked(() => {
        json(`created-${digest(value.session)}.json`);
        const observation = object(JSON.parse(pinned(value.evidence).toString()));
        requireWorkflow(
          observation.kind === 'h01-native-capabilities' && observation.session === value.session,
          'h01-guard-capabilities-unconfirmed',
        );
        assertCoderCapabilities(observation.response, value.disabled);
        save(root, `capabilities-${digest(value.session)}-${digest(canonical(value))}.json`, value);
      });
    },
    registerParticipant(participant) {
      checked(() => {
        const approved = json(`created-${digest(participant.session)}.json`);
        const observation = object(JSON.parse(pinned(participant.creation).toString()));
        const thread = object(object(observation.response).thread);
        let path = thread.path;
        if (participant.pathObservation !== undefined) {
          const observed = object(JSON.parse(pinned(participant.pathObservation).toString()));
          const primary = object(object(observed.response).thread);
          requireWorkflow(
            observed.method === 'thread/read' && primary.id === participant.session,
            'h01-guard-path-unconfirmed',
          );
          path = primary.path;
        }
        requireWorkflow(
          observation.kind === 'h01-native-dispatch' &&
            ['thread/start', 'thread/resume'].includes(String(observation.method)) &&
            same(approved.creation, participant.creation) &&
            approved.stage === participant.stage &&
            thread.id === participant.session &&
            path === participant.transcript &&
            participant.run === control.opId &&
            typeof path === 'string',
          'h01-guard-participant-unconfirmed',
        );
        const name = `participant-${digest(participant.session)}.json`;
        if (existsSync(join(root, name))) {
          const {
            creation: _creation,
            pathObservation: _path,
            ...before
          } = json(name).participant as Record<string, unknown>;
          const { creation: _newCreation, pathObservation: _newPath, ...after } = participant;
          requireWorkflow(same(before, after), 'h01-guard-participant-conflict');
          save(root, `creation-${participant.creation.hash}.json`, participant.creation);
        } else save(root, name, { participant });
      });
    },
    assertRecoveryParticipant(session, creation, transcript) {
      requireWorkflow(scenario === 'H-05', 'h05-recovery-scenario');
      clock(true);
      pinned(control.binary);
      pinned(control.request);
      control.pins.forEach(pinned);
      const approved = json(`created-${digest(session)}.json`);
      const known = object(json(`participant-${digest(session)}.json`).participant);
      const previous = records('budget-').at(-1);
      requireWorkflow(previous !== undefined, 'h05-recovery-budget-unobserved');
      const value = json(previous!) as unknown as TaskExecutionBudget;
      const current = state({ value, credits: verifyTaskBudget(ledger, store, value).credits });
      pinned(creation);
      requireWorkflow(
        !current.recoveryUnknown &&
          !current.closedUnknown &&
          Number(current.accounting.observedResponses) > 0 &&
          approved.session === session &&
          approved.run === control.opId &&
          approved.stage === 'execution' &&
          same(approved.creation, creation) &&
          known.session === session &&
          known.run === control.opId &&
          known.stage === 'execution' &&
          same(known.creation, creation) &&
          known.transcript === transcript &&
          !existsSync(join(root, `complete-${digest(session)}.json`)),
        'h05-recovery-participant-sealed',
      );
    },
    observeParticipant(participant) {
      checked(() => {
        const expected = json(`participant-${digest(participant.session)}.json`)
          .participant as Record<string, unknown>;
        const { creation: _creation, pathObservation: _path, ...known } = expected;
        requireWorkflow(same(known, participant), 'h01-guard-unexpected-participant');
      });
    },
    completeParticipant(session, completion) {
      checked(() => {
        clock(false);
        pinned(completion.stop);
        completion.evidence.forEach(pinned);
        const stop = object(JSON.parse(pinned(completion.stop).toString()));
        requireWorkflow(
          stop.kind === comparisonKind(scenario, 'stop') &&
            stop.executionVersion === 2 &&
            stop.opId === control.opId &&
            stop.confirmed === true &&
            Array.isArray(stop.sessions) &&
            stop.sessions.includes(session) &&
            Array.isArray(stop.remainingProcesses) &&
            stop.remainingProcesses.length === 0 &&
            Array.isArray(stop.evidence) &&
            stop.evidence.length > 0,
          'h01-guard-stop-unconfirmed',
        );
        (stop.evidence as InputRef[]).forEach(pinned);
        const participant = json(`participant-${digest(session)}.json`)
          .participant as unknown as ComparisonParticipant;
        save(root, `complete-${digest(session)}.json`, {
          participant: sealComparisonUsage(participant),
          completion,
        });
        if (completion.outcome === 'unknown') unknown('h01-guard-participant-outcome-unknown');
        if (state().closedUnknown) unknown('h01-guard-final-evidence-unknown');
      });
    },
    async verify() {
      try {
        await verify(false);
      } catch (error) {
        unknown('h01-guard-verification-failed');
        throw error;
      }
    },
    accounting() {
      try {
        clock(false);
      } catch {
        unknown('h01-guard-clock-or-deadline-unknown');
      }
      return checked(() => state().accounting);
    },
  };
}

export async function h01GuardRequest(
  observer: H01NativeObserver,
  stage: 'execution' | 'council',
  method: string,
  params: Record<string, unknown>,
  effect: () => Promise<unknown>,
  native?: {
    disabled: string[];
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  },
): Promise<unknown> {
  const control = descriptor(observer.controlRef);
  const root = privateDirectory(join(control.roots.evidenceRoot, 'native-guard'));
  const start: H01ModelStart = {
    origin: 'legacy',
    stage,
    session: String(params.threadId),
    key: digest(canonical([params.threadId ?? null, params])),
    hash: digest(canonical(params)),
  };
  try {
    if (method === 'turn/start') {
      requireWorkflow(native !== undefined, 'h01-guard-native-probe-required');
      requireWorkflow(
        (params.model === undefined || params.model === control.profile.model) &&
          (params.effort === undefined || params.effort === control.profile.effort),
        'h01-guard-native-profile-unconfirmed',
      );
      const response = await native.request('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
      });
      const evidence = save(root, `mcp-${digest(canonical([start.session, response]))}.json`, {
        kind: 'h01-native-capabilities',
        session: start.session,
        response,
      });
      observer.registerCapabilities({
        session: start.session,
        evidence,
        disabled: native.disabled,
      });
      await observer.beforeModelStart(start);
    }
    if (method === 'thread/start' || method === 'thread/resume') await observer.verify();
    const response = await effect();
    if (['thread/start', 'thread/resume', 'thread/read', 'turn/start'].includes(method)) {
      const evidence = save(root, `rpc-${digest(canonical([method, params, response]))}.json`, {
        kind: 'h01-native-dispatch',
        method,
        params,
        response,
        ...(method === 'turn/start' ? { start } : {}),
      });
      if (method === 'turn/start')
        observer.confirmModelStart({
          key: start.key,
          session: start.session,
          turn: String(object(object(response).turn).id),
          evidence,
        });
      else {
        const primary = object(response);
        if (method === 'thread/start' || method === 'thread/resume')
          requireWorkflow(
            primary.model === control.profile.model &&
              primary.reasoningEffort === control.profile.effort,
            'h01-guard-native-profile-unconfirmed',
          );
        const thread = object(primary.thread);
        const session = String(thread.id);
        if (method === 'thread/start')
          observer.registerCreation({
            session,
            run: control.opId,
            stage,
            creation: evidence,
          });
        const path = join(root, `created-${digest(session)}.json`);
        if (typeof thread.path === 'string' && existsSync(path)) {
          const creation = object(JSON.parse(bytes(path).toString()));
          observer.registerParticipant({
            session,
            transcript: thread.path,
            run: control.opId,
            stage,
            creation: creation.creation as unknown as InputRef,
            ...(method === 'thread/read' ? { pathObservation: evidence } : {}),
          });
        }
      }
    }
    return response;
  } catch (error) {
    save(root, `unknown-rpc-${digest(canonical([method, params]))}.json`, {
      reason: 'h01-guard-rpc-outcome-unknown',
      method,
      qualification: false,
    });
    throw error;
  }
}

const overlaySources = [
  [
    'adapters/codex/appServerTransport.ts',
    'e6dc3beda11281e83a567733b6496b19ec22ee32c37741f6e071c043f0e13ad8',
  ],
  [
    'cli/nativeCoderSessions.ts',
    '33834a6c988caee0c8bef6cda3dd1674c7981c2066803cdf5986dc9127864926',
  ],
  ['cli/taskChatCouncil.ts', '2db1089699a16a1860facc229b89fab1d76f30669b9253760a7925784cf99f3a'],
  ['cli/chatRoles.ts', '3538f3b61041b5d9bca41908b052bf93c41eed5221327a639a3104f8bdecbfb0'],
  [
    'adapters/codex/appServerWaits.ts',
    'd8f1fd29fce91fdd1d587d693da060b3469b26a752144113a788347177bb2032',
  ],
] as const;

export function h01NativePolicy(args: string[]) {
  requireWorkflow(args.at(-1) === 'app-server', 'h01-native-args-unsupported');
  const disabled: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    const option = args[index],
      value = args[++index]!;
    if (option === '--disable' && ['apps', 'plugins', 'multi_agent'].includes(value)) continue;
    const mcp = /^mcp_servers\.([A-Za-z0-9_-]+)\.enabled=false$/u.exec(value);
    requireWorkflow(
      (option === '-c' || option === '--config') &&
        ([
          'features.apps=false',
          'features.plugins=false',
          'features.multi_agent=false',
          'web_search="disabled"',
        ].includes(value) ||
          mcp !== null ||
          disabled.some((name) => value === `mcp_servers.${name}.url=""`)),
      'h01-native-args-unsupported',
    );
    if (mcp !== null) disabled.push(mcp[1]!);
  }
  return {
    args: [
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.multi_agent=false',
      ...args,
    ],
    disabled: [...new Set(disabled)].sort(),
  };
}
export function h01ApprovedNativeBinary(binary: string, controlRef: InputRef): string {
  const control = descriptor(controlRef);
  requireWorkflow(binary === control.binary.locator, 'h01-native-binary-unapproved');
  pinned(control.binary);
  return binary;
}

export function h01LegacyOverlayPlan() {
  return {
    kind: 'comparison-h01-legacy-overlay-plan',
    executionVersion: 2,
    nativePolicy: {
      apps: false,
      plugins: false,
      multiAgent: false,
      callerArgs: 'strict-supported-restrictions-only',
    },
    tokenLimits: 'observed-cutoff-with-null-pending-totals',
    sources: overlaySources.map(([path, hash]) => ({ path, hash })),
    generator: ref(fileURLToPath(import.meta.url)),
    contract: ref(join(import.meta.dirname, 'comparisonH01Contract.ts')),
  };
}
function overlayMaterial(runtimeRoot: string, controlRef: InputRef, prepared: boolean) {
  const control = descriptor(controlRef);
  requireWorkflow(
    realpathSync(runtimeRoot) === runtimeRoot &&
      runtimeRoot === resolve(control.roots.stateRoot, 'legacy-runtime'),
    'h01-overlay-root-invalid',
  );
  requireWorkflow(
    same(JSON.parse(bytes(join(runtimeRoot, '.comparison-h01-owner.json')).toString()), {
      kind: 'comparison-h01-runtime-owner',
      opId: control.opId,
      requestHash: control.requestHash,
      controlRef,
    }),
    'h01-overlay-owner-changed',
  );
  const root = runtimeRoot;
  const request = object(JSON.parse(pinned(control.request).toString()));
  const bootstrap = object(JSON.parse(pinned(request.bootstrap as unknown as InputRef).toString()));
  const plan = bootstrap.overlay as unknown as InputRef;
  requireWorkflow(
    bootstrap.engine === 'legacy' &&
      same(JSON.parse(pinned(plan).toString()), h01LegacyOverlayPlan()),
    'h01-overlay-plan-changed',
  );
  const originals = overlaySources.map(([name, hash]) => {
    const path = join(root, name);
    const beforePath =
      name === 'adapters/codex/appServerTransport.ts'
        ? join(root, 'adapters/codex/appServerTransport.base.ts')
        : path + '.h01-preimage.snapshot';
    const content = bytes(prepared ? beforePath : path);
    requireWorkflow(digest(content) === hash, 'h01-overlay-source-unsupported');
    return { path, content, before: { locator: beforePath, hash } };
  });
  const helper = ref(fileURLToPath(import.meta.url));
  const contract = ref(join(import.meta.dirname, 'comparisonH01Contract.ts'));
  const wrapper = `import { StdioAppServer as Base } from './appServerTransport.base.js';
export type { AppServerRpc } from './appServerTransport.base.js';
import { createH01NativeGuard, h01GuardRequest, h01NativePolicy, h01ApprovedNativeBinary } from ${JSON.stringify(helper.locator)};
const control = ${JSON.stringify(controlRef)};
export class StdioAppServer extends Base {
  private readonly h01;
  private readonly policy;
  constructor(binary: string, args: string[], cwd: string, journal: string,
    creationOperation?: string, private readonly stage?: 'execution' | 'council') {
    if (stage !== 'execution' && stage !== 'council') throw new Error('h01-overlay-stage-required');
    const policy = h01NativePolicy(args);
    h01ApprovedNativeBinary(binary, control);
    const h01 = createH01NativeGuard(control);
    super(binary, policy.args, cwd, journal, creationOperation);
    this.h01 = h01;
    this.policy = policy;
  }
  override request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return h01GuardRequest(this.h01, this.stage!, method, params, () => super.request(method, params), {
      disabled: this.policy.disabled, request: (method, params) => super.request(method, params),
    });
  }
}
`;
  const changes = [
    wrapper,
    originals[1]!.content
      .toString()
      .replace(
        '    `coder:${id}:create`,\n  );',
        "    `coder:${id}:create`,\n    'execution',\n  );",
      ),
    originals[2]!.content
      .toString()
      .replace(
        "    resolve(directory, 'transport.jsonl'),\n  );",
        "    resolve(directory, 'transport.jsonl'),\n    undefined,\n    'council',\n  );",
      ),
    originals[3]!.content
      .toString()
      .replace(
        '    resolve(evidence, `role-observation-${randomUUID()}.jsonl`),\n  );',
        "    resolve(evidence, `role-observation-${randomUUID()}.jsonl`),\n    undefined,\n    'council',\n  );",
      ),
    originals[4]!.content.toString(),
  ];
  const files = [
    ...originals.map(({ path }, index) => ({
      locator: path,
      hash: digest(changes[index]!),
    })),
    ...originals.map(({ before }) => before),
    helper,
    contract,
  ];
  const manifest = {
    kind: 'comparison-h01-legacy-overlay',
    controlRef,
    plan,
    before: originals.map(({ before }) => before),
    files,
    qualification: false,
  };
  return { root, originals, changes, files, manifest };
}
export function prepareH01LegacyOverlay(runtimeRoot: string, controlRef: InputRef) {
  const { root, originals, changes, files, manifest } = overlayMaterial(
    runtimeRoot,
    controlRef,
    false,
  );
  for (const original of originals) publishFile(original.before.locator, original.content);
  for (const [index, original] of originals.entries()) {
    const fd = openSync(original.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      safeDirectory(dirname(original.path));
      const before = fstatSync(fd, { bigint: true });
      requireWorkflow(
        before.isFile() &&
          before.nlink === 1n &&
          same(before, lstatSync(original.path, { bigint: true })),
        'h01-overlay-source-linked',
      );
      requireWorkflow(readFileSync(fd).equals(original.content), 'h01-overlay-source-changed');
      safeDirectory(dirname(original.path));
      const after = fstatSync(fd, { bigint: true });
      requireWorkflow(
        after.ino === before.ino &&
          after.dev === before.dev &&
          after.size === before.size &&
          after.mtimeNs === before.mtimeNs &&
          after.ctimeNs === before.ctimeNs &&
          same(after, lstatSync(original.path, { bigint: true })),
        'h01-overlay-source-changed',
      );
      const content = Buffer.from(changes[index]!);
      writeSync(fd, content, 0, content.length, 0);
      ftruncateSync(fd, content.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const overlay = save(root, 'h01-overlay.json', manifest);
  verifyH01LegacyOverlay(runtimeRoot, controlRef, overlay);
  return { overlay, files };
}
export function verifyH01LegacyOverlay(
  runtimeRoot: string,
  controlRef: InputRef,
  overlay: InputRef,
): void {
  const expected = overlayMaterial(runtimeRoot, controlRef, true);
  requireWorkflow(
    same(JSON.parse(pinned(overlay).toString()), expected.manifest),
    'h01-overlay-manifest-changed',
  );
  expected.files.forEach(pinned);
}
