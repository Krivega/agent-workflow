import {
  compareInputs,
  evidenceSchema,
  requireStore,
  type CatalogPage,
  type Change,
  type EvidenceBody,
  type EvidenceContext,
  type EventRecord,
  type FinalizationManifest,
  type InputManifest,
  type Metadata,
  type StoredEvidence,
  type StoreCommand,
  type WriteAck,
  type EffectRecord,
} from '../../core/evidence.js';
import { canonical } from './storeCodec.js';
import type { StoreDatabase } from './storeDatabase.js';
import { revisionMatches } from './storeDatabase.js';
import { parseStored } from './storeFiles.js';

export function validateManifest(manifest: InputManifest): void {
  requireStore(manifest && typeof manifest === 'object', 'invalid-context');
  requireStore(
    typeof manifest.complete === 'boolean' &&
      typeof manifest.attested_by === 'string' &&
      !!manifest.discovery_rule &&
      Array.isArray(manifest.inputs),
    'invalid-context',
  );
  requireStore(
    manifest.inputs.every(
      (input) => input && typeof input.locator === 'string' && typeof input.hash === 'string',
    ),
    'invalid-context',
  );
  const names = manifest.inputs.map((input) => input.locator);
  requireStore(
    new Set(names).size === names.length &&
      manifest.inputs.every((input) => !!input.locator && /^[a-f0-9]{64}$/.test(input.hash)),
    'invalid-context',
  );
}

export function validateBody(body: EvidenceBody): void {
  requireStore(body && typeof body === 'object' && body.provenance && body.raw, 'invalid-context');
  requireStore(
    ['PASS', 'FAIL', 'NOT RUN', 'unknown'].includes(body.result) &&
      !!body.kind &&
      !!body.scope &&
      !!body.criterion,
    'invalid-context',
  );
  requireStore(
    typeof body.summary === 'string' &&
      typeof body.command === 'string' &&
      (body.exit_code === null || Number.isSafeInteger(body.exit_code)),
    'invalid-context',
  );
  requireStore(
    Array.isArray(body.links) &&
      body.links.every((link) => typeof link === 'string') &&
      Array.isArray(body.limitations) &&
      body.limitations.every((item) => typeof item === 'string'),
    'invalid-context',
  );
  requireStore(
    typeof body.raw.input === 'string' && typeof body.raw.output === 'string',
    'invalid-context',
  );
  requireStore(
    ['head', 'base', 'dirty_diff', 'untracked'].every(
      (key) => typeof body.provenance[key as 'head'] === 'string',
    ),
    'invalid-context',
  );
  // These fields must be explicitly present, including unknown represented by null.
  canonical([body.provenance.rules, body.provenance.tools, body.provenance.environment]);
  validateManifest(body.manifest);
}

export class EvidenceRecords {
  constructor(private readonly store: StoreDatabase) {}

  metadata(id: string, revision: number | null): Metadata {
    const head = this.store.db.prepare('SELECT revision FROM heads WHERE id=?').get(id);
    requireStore(head, 'not-found');
    const headRevision = head['revision'] as number;
    const row = this.store.db
      .prepare('SELECT metadata FROM entries WHERE id=? AND revision=?')
      .get(id, revision ?? headRevision);
    requireStore(row, 'not-found');
    return { ...parseStored<Metadata>(row['metadata'] as string), head_revision: headRevision };
  }

  read(id: string, revision: number | null): StoredEvidence {
    const metadata = this.metadata(id, revision);
    const body = parseStored<EvidenceBody>(this.store.files.readBlob(metadata.content_hash));
    const raw = parseStored<EvidenceBody['raw']>(this.store.files.readBlob(metadata.raw_hash));
    requireStore(canonical(raw) === canonical(body.raw), 'corrupt');
    return {
      metadata,
      body,
      predecessor: metadata.revision === 1 ? null : metadata.revision - 1,
      successor: metadata.revision === metadata.head_revision ? null : metadata.revision + 1,
      raw_locator: this.store.files.blobPath(metadata.raw_hash),
    };
  }

  all(): Metadata[] {
    return this.store.db
      .prepare(
        'SELECT e.metadata, h.revision AS head FROM entries e JOIN heads h ON h.id=e.id ORDER BY e.id,e.revision',
      )
      .all()
      .map((row) => ({
        ...parseStored<Metadata>(row['metadata'] as string),
        head_revision: row['head'] as number,
      }));
  }

  catalog(
    command: Extract<StoreCommand, { type: 'catalog' | 'find' }>,
    context: EvidenceContext,
  ): CatalogPage {
    const revision = this.store.state('current').revision;
    requireStore(
      Number.isSafeInteger(command.limit) &&
        command.limit > 0 &&
        command.limit <= 100 &&
        Number.isSafeInteger(command.byte_limit) &&
        command.byte_limit > 0,
      'invalid-context',
    );
    const cursor = command.cursor;
    if (cursor) {
      revisionMatches(revision, cursor.revision);
      requireStore(
        cursor.query === command.query && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0,
        'invalid-context',
      );
    }
    const entries = this.all().filter((entry) =>
      canonical([
        entry.id,
        entry.kind,
        entry.result,
        entry.scope,
        entry.criterion,
        entry.links,
      ]).includes(command.query),
    );
    const offset = cursor?.offset ?? 0;
    requireStore(offset <= entries.length, 'invalid-context');
    const page: CatalogPage = {
      catalog_revision: revision,
      items: [],
      coverage: 'complete',
      searched_scope: {
        project_id: context.project_id,
        task_id: context.task_id,
        query: command.query,
      },
      next_cursor: null,
    };
    for (let index = offset; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const candidate: CatalogPage = {
        ...page,
        items: [...page.items, entry],
        coverage: index + 1 === entries.length ? 'complete' : 'partial',
        next_cursor:
          index + 1 === entries.length
            ? null
            : { revision, offset: index + 1, query: command.query },
      };
      if (
        page.items.length === command.limit ||
        Buffer.byteLength(canonical(candidate)) > command.byte_limit
      )
        break;
      Object.assign(page, candidate);
    }
    const next = offset + page.items.length;
    page.coverage = next === entries.length ? 'complete' : 'partial';
    page.next_cursor =
      next === entries.length ? null : { revision, offset: next, query: command.query };
    requireStore(
      Buffer.byteLength(canonical(page)) <= command.byte_limit &&
        (page.items.length > 0 || page.coverage === 'complete'),
      'budget-exhausted',
    );
    return page;
  }

  write(
    change: Extract<Change, { type: 'write' | 'supersede' }>,
    context: EvidenceContext,
  ): Metadata {
    requireStore(!!change.id, 'invalid-context');
    validateBody(change.body);
    let revision = 1;
    let reason: string | null = null;
    if (change.type === 'write') {
      requireStore(
        !this.store.db.prepare('SELECT id FROM heads WHERE id=?').get(change.id),
        'revision-conflict',
      );
    } else {
      const previous = this.metadata(change.id, null);
      requireStore(
        previous.actor_id === context.actor_id && previous.subtask_id === context.subtask_id,
        'permission-denied',
      );
      revisionMatches(previous.revision, change.expected_head);
      requireStore(!!change.reason, 'invalid-context');
      revision = previous.revision + 1;
      reason = change.reason;
    }
    const rawHash = this.store.files.publish(canonical(change.body.raw));
    const contentHash = this.store.files.publish(canonical(change.body));
    const metadata: Metadata = {
      id: change.id,
      revision,
      head_revision: revision,
      kind: change.body.kind,
      result: change.body.result,
      scope: change.body.scope,
      criterion: change.body.criterion,
      links: change.body.links,
      content_hash: contentHash,
      raw_hash: rawHash,
      actor_id: context.actor_id,
      run_id: context.run_id,
      subtask_id: context.subtask_id,
      reason,
    };
    this.store.db
      .prepare('INSERT INTO entries VALUES (?,?,?)')
      .run(change.id, revision, canonical(metadata));
    this.store.db
      .prepare(
        'INSERT INTO heads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',
      )
      .run(change.id, revision);
    return metadata;
  }

  disposition(change: Extract<Change, { type: 'resolve' | 'reuse' }>): string {
    if (change.type === 'resolve') {
      const current = this.metadata(change.id, null);
      revisionMatches(current.revision, change.expected_head);
      this.read(change.supporting_id, change.supporting_revision);
      requireStore(!!change.condition && !!change.disposition, 'invalid-context');
      return 'resolved';
    }
    validateManifest(change.manifest);
    requireStore(!!change.target_scope, 'invalid-context');
    return compareInputs(this.read(change.id, change.revision).body.manifest, change.manifest);
  }

  finalization(expected: number, context: EvidenceContext): FinalizationManifest {
    const state = this.store.state();
    revisionMatches(state.revision, expected);
    requireStore(state.frozen, 'revision-conflict');
    const entries = this.all();
    for (const entry of entries) this.read(entry.id, entry.revision);
    const blobs = new Set(entries.flatMap((entry) => [entry.content_hash, entry.raw_hash]));
    this.store.decode(
      this.store.db.prepare('SELECT body FROM state WHERE singleton=1').get()!['body'] as string,
      blobs,
    );
    const rows = <T>(table: string, field: string): T[] =>
      this.store.db
        .prepare(`SELECT ${field} FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => this.store.decode<T>(row[field] as string, blobs));
    return {
      schema_version: evidenceSchema,
      context: { project_id: context.project_id, task_id: context.task_id },
      state,
      entries,
      events: rows<EventRecord>('events', 'body'),
      operations: rows<WriteAck>('operations', 'ack'),
      effects: rows<EffectRecord>('effects', 'body'),
      blobs: [...blobs].sort(),
    };
  }
}
