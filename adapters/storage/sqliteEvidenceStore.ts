import {
  evidenceSchema,
  requireStore,
  type Change,
  type EffectRecord,
  type EvidenceGrant,
  type EventRecord,
  type Json,
  type Metadata,
  type StoreReply,
  type StoreRequest,
  type StoreValue,
  type TechnicalState,
  type WriteAck,
} from '../../core/evidence.js';
import { EvidenceRecords } from './evidenceRecords.js';
import { canonical, canonicalHash, digest, failure, requestHash } from './storeCodec.js';
import { revisionMatches, StoreDatabase } from './storeDatabase.js';
import { noStorageProbe, parseStored, type StorageProbe } from './storeFiles.js';
import { archiveHashes, readArchive, eventPayload } from './archiveJson.js';
import { retainEvidence } from './retainedJson.js';
import { pruneRetainedBlobs } from './retainedBlobs.js';

export function authorize(request: StoreRequest, grant: EvidenceGrant): void {
  requireStore(request && request.context && request.command, 'invalid-context');
  requireStore(request.context.schema_version === evidenceSchema, 'unsupported-version');
  requireStore(canonical(request.context) === canonical(grant.context), 'invalid-context');
  requireStore(
    !!request.context.actor_id &&
      !!request.context.project_id &&
      !!request.context.task_id &&
      (request.context.run_id === null || typeof request.context.run_id === 'string') &&
      (request.context.subtask_id === null || typeof request.context.subtask_id === 'string'),
    'invalid-context',
  );
  const command = request.command;
  requireStore(
    [
      'state',
      'archive',
      'effects',
      'read',
      'catalog',
      'find',
      'finalization',
      'operation',
      'mutate',
    ].includes(command.type),
    'invalid-context',
  );
  let permission: EvidenceGrant['permissions'][number] = 'read';
  if (command.type === 'mutate') {
    requireStore(
      command.mutation &&
        command.change &&
        [
          'claim',
          'renew',
          'recover-owner',
          'release',
          'checkpoint',
          'effect',
          'write',
          'supersede',
          'resolve',
          'reuse',
          'freeze',
          'thaw',
        ].includes(command.change.type),
      'invalid-context',
    );
    const type = command.change.type;
    permission =
      type === 'write' || type === 'supersede'
        ? 'produce'
        : type === 'resolve' || type === 'reuse'
          ? 'resolve'
          : 'manage';
  }
  requireStore(grant.permissions.includes(permission), 'permission-denied');
}

export class SqliteEvidenceStore {
  constructor(
    readonly root: string,
    readonly grant: EvidenceGrant,
    private readonly now: () => number,
    private readonly probe: StorageProbe = noStorageProbe,
    private readonly mode: 'live' | 'inspect' = 'live',
  ) {}

  execute(request: StoreRequest): StoreReply {
    let database: StoreDatabase | undefined;
    let committed = false;
    try {
      authorize(request, this.grant);
      requireStore(
        this.mode !== 'inspect' || request.command.type !== 'mutate',
        'permission-denied',
      );
      database = new StoreDatabase(this.root, request.context, this.probe, this.mode);
      const db = database;
      const records = new EvidenceRecords(db);
      const value = db.transaction(request.command.type === 'mutate', () => {
        const command = request.command;
        switch (command.type) {
          case 'state':
            requireStore(
              command.archive === undefined || ['current', 'full'].includes(command.archive),
              'invalid-context',
            );
            return db.state(command.archive);
          case 'archive':
            return {
              hash: command.hash,
              value: readArchive(command.hash, (hash) => db.files.readBlob(hash)) as Json,
            };
          case 'effects':
            return db.db
              .prepare('SELECT body FROM effects')
              .all()
              .map((row) => parseStored<EffectRecord>(row['body'] as string));
          case 'read':
            return records.read(command.id, command.revision);
          case 'catalog':
          case 'find':
            return records.catalog(command, request.context);
          case 'finalization':
            return records.finalization(command.expected_revision, request.context);
          case 'operation': {
            const row = db.db
              .prepare('SELECT ack FROM operations WHERE id=?')
              .get(command.operation_id);
            return row
              ? { status: 'confirmed' as const, ack: parseStored<WriteAck>(row['ack'] as string) }
              : { status: 'not-started' as const };
          }
          case 'mutate':
            return this.mutate(db, records, request as StoreRequest & { command: typeof command });
        }
      });
      committed = request.command.type === 'mutate';
      if (committed) {
        this.probe('after-commit');
        if (db.state('current').retention_gc === true)
          db.transaction(true, () => {
            pruneRetainedBlobs(db);
          });
      }
      return { ok: true, value };
    } catch (error) {
      return failure(error, request, this.root, committed);
    } finally {
      database?.close();
    }
  }

  private mutate(
    db: StoreDatabase,
    records: EvidenceRecords,
    request: StoreRequest & { command: Extract<StoreRequest['command'], { type: 'mutate' }> },
  ): WriteAck {
    const { mutation, change } = request.command;
    requireStore(
      !!mutation.operation_id &&
        Number.isSafeInteger(mutation.expected_revision) &&
        mutation.expected_revision >= 0 &&
        Number.isSafeInteger(mutation.owner_generation) &&
        mutation.owner_generation >= 0 &&
        mutation.payload_hash === requestHash(request),
      'invalid-context',
    );
    const previous = db.db
      .prepare('SELECT hash,ack FROM operations WHERE id=?')
      .get(mutation.operation_id);
    if (previous) {
      requireStore(previous['hash'] === mutation.payload_hash, 'revision-conflict');
      return parseStored<WriteAck>(previous['ack'] as string);
    }
    const state = db.state('current');
    if (
      !db.retained &&
      state.checkpoint === null &&
      change.type === 'checkpoint' &&
      change.retention_version === 1
    )
      state.retention_gc = true;
    revisionMatches(state.revision, mutation.expected_revision);
    requireStore(state.generation === mutation.owner_generation, 'stale-owner');
    requireStore(!state.frozen || change.type === 'thaw', 'revision-conflict');
    const now = this.now();
    requireStore(Number.isSafeInteger(now), 'invalid-context');
    if (change.type === 'claim') {
      requireStore(state.released, 'stale-owner');
      state.generation += 1;
      state.owner = request.context.actor_id;
      state.released = false;
    } else {
      requireStore(
        !state.released &&
          state.owner === request.context.actor_id &&
          (state.lease_until > now ||
            change.type === 'recover-owner' ||
            change.type === 'release' ||
            change.type === 'thaw'),
        'stale-owner',
      );
    }
    let metadata: Metadata | null = null;
    let eventChange: Json;
    if (change.type === 'write' || change.type === 'supersede') {
      metadata = records.write(change, request.context);
      eventChange = {
        type: change.type,
        id: metadata.id,
        revision: metadata.revision,
        content_hash: metadata.content_hash,
        raw_hash: metadata.raw_hash,
        reason: metadata.reason,
      };
    } else {
      eventChange = this.applyState(db, records, state, change, now);
    }
    if (db.retained && change.type === 'release')
      eventChange = {
        type: 'release',
        checkpoint_hash: canonicalHash(state.checkpoint),
        stopped_writers_receipt: change.stopped_writers_receipt,
      };
    state.revision += 1;
    db.save(
      state,
      change.type === 'checkpoint' && change.archive_version === 1,
      change.type === 'checkpoint' && change.retention_version === 1,
    );
    const ack: WriteAck = {
      operation_id: mutation.operation_id,
      catalog_revision: state.revision,
      generation: state.generation,
      evidence_id: metadata?.id ?? null,
      revision: metadata?.revision ?? null,
      content_hash: metadata?.content_hash ?? canonicalHash(eventChange),
      locator: `${this.root}#operation=${encodeURIComponent(mutation.operation_id)}`,
    };
    const event: EventRecord = {
      operation_id: mutation.operation_id,
      revision: state.revision,
      context: request.context,
      change: eventChange,
    };
    db.db.prepare('INSERT INTO events VALUES (?,?)').run(state.revision, db.encode(event));
    db.db
      .prepare('INSERT INTO operations VALUES (?,?,?)')
      .run(mutation.operation_id, mutation.payload_hash, canonical(ack));
    this.probe('before-commit');
    return ack;
  }

  private applyState(
    db: StoreDatabase,
    records: EvidenceRecords,
    state: TechnicalState,
    change: Exclude<Change, { type: 'write' | 'supersede' }>,
    now: number,
  ): Json {
    switch (change.type) {
      case 'recover-owner': {
        const proof = change.proof;
        requireStore(
          state.lease_until <= now &&
            proof?.owner === state.owner &&
            proof.generation === state.generation &&
            proof.revision === state.revision &&
            (proof.checkpoint_hash === canonicalHash(state.checkpoint) ||
              proof.checkpoint_hash === canonicalHash(db.state().checkpoint)) &&
            typeof proof.evidence?.locator === 'string' &&
            proof.evidence.locator.length > 0 &&
            /^[a-f0-9]{64}$/u.test(proof.evidence.hash) &&
            Number.isSafeInteger(change.lease_until) &&
            change.lease_until > now,
          'invalid-context',
        );
        const effects = db.db.prepare('SELECT body FROM effects').all();
        requireStore(
          effects.every((row) => {
            const effect = parseStored<EffectRecord>(row['body'] as string);
            return effect.outcome === 'confirmed' || effect.outcome === 'not-started';
          }),
          'invalid-context',
        );
        state.lease_until = change.lease_until;
        break;
      }
      case 'claim':
      case 'renew':
        requireStore(
          Number.isSafeInteger(change.lease_until) && change.lease_until > now,
          'invalid-context',
        );
        state.lease_until = change.lease_until;
        break;
      case 'release':
        requireStore(
          !!change.stopped_writers_receipt && change.checkpoint !== null,
          'invalid-context',
        );
        state.checkpoint = db.retained
          ? retainEvidence(change.checkpoint, (hash) =>
              eventPayload(readArchive(hash, (child) => db.files.readBlob(child))),
            )
          : change.checkpoint;
        state.released = true;
        break;
      case 'checkpoint': {
        const retention = change.retention_version === 1 || db.retained;
        requireStore(
          change.retention_version === undefined || change.retention_version === 1,
          'unsupported-version',
        );
        if (change.retention_version === 1)
          requireStore(
            change.archive_version === undefined &&
              (change.blobs?.length ?? 0) === 0 &&
              canonicalHash(retainEvidence(change.state)) === canonicalHash(change.state),
            'invalid-context',
          );
        requireStore(
          change.archive_version === undefined || change.archive_version === 1,
          'unsupported-version',
        );
        requireStore(Array.isArray(change.blobs ?? []), 'invalid-context');
        for (const blob of change.blobs ?? []) {
          requireStore(
            blob && typeof blob.content === 'string' && digest(blob.content) === blob.hash,
            'invalid-context',
          );
          requireStore(db.files.publish(blob.content) === blob.hash, 'invalid-context');
        }
        if (change.archive_version === 1) {
          const known = new Set(archiveHashes(state.checkpoint));
          for (const hash of archiveHashes(change.state))
            if (!known.has(hash)) readArchive(hash, (hash) => db.files.readBlob(hash), known);
        }
        state.checkpoint = retention
          ? retainEvidence(change.state, (hash) =>
              eventPayload(readArchive(hash, (child) => db.files.readBlob(child))),
            )
          : change.state;
        for (const effect of change.effects) {
          requireStore(
            !!effect.id && !db.db.prepare('SELECT id FROM effects WHERE id=?').get(effect.id),
            'revision-conflict',
          );
          const record: EffectRecord = { ...effect, outcome: 'pending', receipt: null };
          db.db.prepare('INSERT INTO effects VALUES (?,?)').run(effect.id, canonical(record));
        }
        return {
          type: change.type,
          ...(retention
            ? { state_hash: canonicalHash(state.checkpoint) }
            : { state: change.state }),
          effects: retention ? change.effects.map(({ id }) => ({ id })) : change.effects,
          ...(change.archive_version === undefined
            ? {}
            : { archive_version: change.archive_version }),
          ...(retention ? { retention_version: 1 } : {}),
        };
      }
      case 'effect': {
        const row = db.db.prepare('SELECT body FROM effects WHERE id=?').get(change.id);
        requireStore(row, 'not-found');
        const record = parseStored<EffectRecord>(row['body'] as string);
        requireStore(
          (record.outcome === 'pending' || record.outcome === 'unknown') &&
            ['confirmed', 'not-started', 'unknown'].includes(change.outcome),
          'revision-conflict',
        );
        requireStore(change.outcome === 'unknown' || change.receipt !== null, 'invalid-context');
        db.db
          .prepare('UPDATE effects SET body=? WHERE id=?')
          .run(
            canonical({ ...record, outcome: change.outcome, receipt: change.receipt }),
            change.id,
          );
        break;
      }
      case 'resolve':
      case 'reuse':
        return { ...change, applicability: records.disposition(change) } as Json;
      case 'freeze':
        state.frozen = true;
        break;
      case 'thaw':
        state.frozen = false;
        break;
    }
    return change;
  }
}

export function unwrap<T extends StoreValue>(reply: StoreReply): T {
  requireStore(
    reply.ok,
    !reply.ok && reply.error.code === 'recovery-required' ? 'recovery-required' : 'unavailable',
  );
  return reply.value as T;
}
