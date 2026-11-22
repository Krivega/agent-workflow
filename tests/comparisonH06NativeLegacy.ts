import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { performance } from 'node:perf_hooks';
import { noStorageProbe, safeDirectory } from '../adapters/storage/storeFiles.js';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { requestHash } from '../adapters/storage/storeCodec.js';
import { unwrap, type SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { withActiveChatLease } from '../cli/chatContinuation.js';
import type {
  EvidenceContext,
  EventRecord,
  OperationResult,
  TechnicalState,
} from '../core/evidence.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { startH06NativeVariant } from './comparisonH06Native.js';
import {
  checkH06NativeFailure,
  type H06NativeFailureBinding,
} from './comparisonH06NativeFailure.js';

function legacyRenewHash(
  context: EvidenceContext,
  before: Pick<TechnicalState, 'generation' | 'revision'>,
  leaseUntil: number,
) {
  const id = `chat:lease:${before.generation}:${before.revision}`;
  return {
    id,
    hash: requestHash({
      context,
      command: {
        type: 'mutate',
        change: { type: 'renew', lease_until: leaseUntil },
        mutation: {
          operation_id: id,
          expected_revision: before.revision,
          owner_generation: before.generation,
          payload_hash: '',
        },
      },
    }),
  };
}

/** Observe a real lease renewal and one native stage crossing the original deadline. */
export async function runH06NativeLegacy<T>(
  binding: H06NativeFailureBinding,
  evidenceRoot: string,
  store: SqliteEvidenceStore,
  oldDeadline: number,
  workDeadlineMs: number,
  stage: (verify: () => void, initialFailure: H04Pin) => Promise<T>,
) {
  const evidence = safeDirectory(evidenceRoot);
  const { context } = store.grant;
  requireContract(
    binding.variant === 'legacy' &&
      context.task_id === binding.operationId &&
      safeDirectory(store.root).startsWith(evidence + sep) &&
      Number.isSafeInteger(oldDeadline) &&
      Number.isSafeInteger(workDeadlineMs) &&
      Date.now() + binding.timeoutMs < oldDeadline &&
      oldDeadline < workDeadlineMs,
    'h06-legacy-start-binding',
  );
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const save = (name: string, value: unknown): H04Pin => {
    const path = join(evidence, name);
    const bytes = Buffer.from(JSON.stringify(value));
    publishFile(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  return startH06NativeVariant(binding, evidence, async (initialFailure) => {
    const before = state();
    const now = Date.now();
    requireContract(
      before.owner === context.actor_id &&
        before.lease_until === oldDeadline &&
        now < oldDeadline &&
        oldDeadline <= now + 60_000,
      'h06-legacy-old-deadline',
    );
    const verifyOwner = () => {
      const current = state();
      requireContract(
        current.owner === before.owner &&
          current.generation === before.generation &&
          !current.released &&
          !current.frozen &&
          Date.now() < current.lease_until &&
          Date.now() < workDeadlineMs,
        'h06-legacy-owner',
      );
    };
    verifyOwner();
    const verifyIdentity = bindChatEvidence(store.root, evidence, before);
    return withActiveChatLease(store, verifyIdentity, async (verifyRuntime) => {
      const verify = () => {
        verifyRuntime();
        verifyOwner();
      };
      verify();
      const renewed = state();
      const { id, hash } = legacyRenewHash(context, before, renewed.lease_until);
      const operation = unwrap<OperationResult>(
        store.execute({ context, command: { type: 'operation', operation_id: id } }),
      );
      const change = { type: 'renew' as const, lease_until: renewed.lease_until };
      const database = new StoreDatabase(store.root, context, noStorageProbe);
      let event: EventRecord;
      try {
        const row = database.db
          .prepare('SELECT body FROM events WHERE revision=?')
          .get(renewed.revision);
        const operationRow = database.db.prepare('SELECT hash FROM operations WHERE id=?').get(id);
        requireContract(
          row !== undefined && operationRow?.hash === hash,
          'h06-legacy-renew-unconfirmed',
        );
        event = database.decode<EventRecord>(String(row.body));
      } finally {
        database.close();
      }
      const observedAt = Date.now();
      requireContract(
        operation.status === 'confirmed' &&
          operation.ack.operation_id === id &&
          operation.ack.catalog_revision === renewed.revision &&
          operation.ack.generation === before.generation &&
          renewed.revision === before.revision + 1 &&
          same(before.checkpoint, renewed.checkpoint) &&
          same(event, { operation_id: id, revision: renewed.revision, context, change }) &&
          observedAt < oldDeadline &&
          oldDeadline < renewed.lease_until,
        'h06-legacy-renew-unconfirmed',
      );
      const renewal = save('legacy-renew.json', {
        kind: 'h06-native-legacy-renew',
        binding,
        initialFailure,
        before,
        renewed,
        event,
        hash,
        ack: operation.ack,
        observedAt,
      });
      const startedAt = Date.now();
      requireContract(startedAt < oldDeadline, 'h06-legacy-stage-not-crossed');
      const startedMonotonic = performance.now();
      const result = await stage(verify, initialFailure);
      const endedAt = Date.now(),
        elapsedMs = performance.now() - startedMonotonic;
      verify();
      const after = state();
      requireContract(
        endedAt > oldDeadline && endedAt < renewed.lease_until,
        'h06-legacy-stage-not-crossed',
      );
      const crossing = save('legacy-crossing.json', {
        kind: 'h06-native-legacy-crossing',
        renewal,
        startedAt,
        endedAt,
        elapsedMs,
        after,
      });
      return { result, renewal, crossing };
    });
  });
}

/** Read only the retained lease evidence. The remaining H06 criteria require their own proofs. */
export function checkH06NativeLegacyCrossing(
  binding: H06NativeFailureBinding,
  renewal: H04Pin,
  crossing: H04Pin,
  minimumStageMs: number,
) {
  const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
  const renew = read(renewal),
    stage = read(crossing);
  const evidence = dirname(renewal.path);
  const initial = h04Pin(renew.initialFailure);
  requireContract(
    binding.variant === 'legacy' &&
      same(renew.binding, binding) &&
      renew.kind === 'h06-native-legacy-renew' &&
      stage.kind === 'h06-native-legacy-crossing' &&
      renewal.path === join(evidence, 'legacy-renew.json') &&
      crossing.path === join(evidence, 'legacy-crossing.json') &&
      same(stage.renewal, renewal) &&
      initial.path === join(evidence, 'f01', 'receipt.json'),
    'h06-legacy-crossing-binding',
  );
  checkH06NativeFailure(binding, initial);
  const before = object(renew.before),
    renewed = object(renew.renewed),
    after = object(stage.after);
  const event = object(renew.event),
    context = object(event.context),
    ack = object(renew.ack);
  requireContract(
    typeof before.owner === 'string' &&
      context.task_id === binding.operationId &&
      context.actor_id === before.owner &&
      Number.isSafeInteger(before.generation) &&
      Number(before.generation) > 0 &&
      Number.isSafeInteger(before.revision) &&
      Number(before.revision) >= 0 &&
      [before, renewed, after].every(
        (state) =>
          state.owner === before.owner &&
          state.generation === before.generation &&
          state.released === false &&
          state.frozen === false &&
          Number.isSafeInteger(state.lease_until),
      ) &&
      renewed.revision === Number(before.revision) + 1 &&
      same(before.checkpoint, renewed.checkpoint),
    'h06-legacy-crossing-owner',
  );
  const { id, hash } = legacyRenewHash(
    context as unknown as EvidenceContext,
    { generation: Number(before.generation), revision: Number(before.revision) },
    Number(renewed.lease_until),
  );
  requireContract(
    renew.hash === hash &&
      event.operation_id === id &&
      event.revision === renewed.revision &&
      same(event.change, { type: 'renew', lease_until: renewed.lease_until }) &&
      ack.operation_id === id &&
      ack.catalog_revision === renewed.revision &&
      ack.generation === before.generation,
    'h06-legacy-crossing-renew',
  );
  requireContract(
    [renew.observedAt, stage.startedAt, stage.endedAt].every(Number.isSafeInteger) &&
      Number(renew.observedAt) <= Number(stage.startedAt) &&
      Number(stage.startedAt) < Number(before.lease_until) &&
      Number(before.lease_until) < Number(stage.endedAt) &&
      Number(stage.endedAt) < Number(renewed.lease_until) &&
      Number(stage.endedAt) < Number(after.lease_until) &&
      Number.isFinite(minimumStageMs) &&
      minimumStageMs > 0 &&
      Number.isFinite(stage.elapsedMs) &&
      Number(stage.elapsedMs) >= minimumStageMs,
    'h06-legacy-crossing-time',
  );
  return { status: 'LEASE_CROSSING_VERIFIED' as const, qualification: false, renewal, crossing };
}
