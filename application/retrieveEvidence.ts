import {
  requireStore,
  type CatalogPage,
  type EvidenceContext,
  type StoredEvidence,
} from '../core/evidence.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';

export class EvidenceRetrieval {
  private pages = 0;
  private bodies = 0;
  private limits = { pages: 5, bodies: 5, bytes: 2000 };
  readonly extensions: {
    question: string;
    reason: string;
    coverage: string;
    continuation: string;
    pages: number;
    bodies: number;
    bytes: number;
  }[] = [];
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
    readonly question: string,
  ) {
    requireStore(!!question, 'invalid-context');
  }
  extend(extension: EvidenceRetrieval['extensions'][number]): void {
    requireStore(
      extension.question === this.question &&
        !!extension.reason &&
        !!extension.coverage &&
        !!extension.continuation &&
        [extension.pages, extension.bodies, extension.bytes].every(
          (limit) => Number.isSafeInteger(limit) && limit > 0,
        ),
      'invalid-context',
    );
    this.limits = { pages: extension.pages, bodies: extension.bodies, bytes: extension.bytes };
    this.extensions.push({ ...extension });
  }
  async page(query: string, cursor: CatalogPage['next_cursor'] = null): Promise<CatalogPage> {
    requireStore(this.pages < this.limits.pages, 'budget-exhausted');
    this.pages += 1;
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'find', query, cursor, limit: 100, byte_limit: this.limits.bytes },
    });
    requireStore(reply.ok, reply.ok ? 'unavailable' : reply.error.code);
    return reply.value as CatalogPage;
  }
  async selectedBody(id: string, revision: number): Promise<StoredEvidence> {
    requireStore(this.bodies < this.limits.bodies, 'budget-exhausted');
    this.bodies += 1;
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'read', id, revision },
    });
    requireStore(reply.ok, reply.ok ? 'unavailable' : reply.error.code);
    const value = reply.value as StoredEvidence;
    requireStore(
      new TextEncoder().encode(JSON.stringify(value)).length <= this.limits.bytes,
      'budget-exhausted',
    );
    return value;
  }
}
