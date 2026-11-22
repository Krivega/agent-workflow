import { requireWorkflow } from './connection.js';
import type { InputRef } from './localRun.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ArchiveRef {
  hash: string;
}
export interface ArchiveBlob {
  hash: string;
  content: string;
}
export const evidenceSchema = 'aw-evidence/1-draft';

export interface EvidenceContext {
  schema_version: string;
  project_id: string;
  task_id: string;
  subtask_id: string | null;
  run_id: string | null;
  actor_id: string;
}

export interface EvidenceGrant {
  context: EvidenceContext;
  permissions: ('read' | 'produce' | 'resolve' | 'manage')[];
}

export interface InputManifest {
  complete: boolean;
  attested_by: string;
  discovery_rule: string;
  inputs: { locator: string; hash: string }[];
}

export interface EvidenceBody {
  kind: string;
  result: 'PASS' | 'FAIL' | 'NOT RUN' | 'unknown';
  scope: string;
  criterion: string;
  summary: string;
  command: string;
  exit_code: number | null;
  limitations: string[];
  provenance: {
    head: string;
    base: string;
    dirty_diff: string;
    untracked: string;
    rules: Json;
    tools: Json;
    environment: Json;
  };
  manifest: InputManifest;
  links: string[];
  raw: { input: string; output: string };
}

export interface Mutation {
  operation_id: string;
  expected_revision: number;
  owner_generation: number;
  payload_hash: string;
}

export type Change =
  | { type: 'claim'; lease_until: number }
  | { type: 'renew'; lease_until: number }
  | {
      type: 'recover-owner';
      lease_until: number;
      proof: {
        owner: string;
        generation: number;
        revision: number;
        checkpoint_hash: string;
        evidence: { locator: string; hash: string };
      };
    }
  | { type: 'release'; stopped_writers_receipt: string; checkpoint: Json }
  | {
      type: 'checkpoint';
      state: Json;
      effects: { id: string; intent: Json }[];
      blobs?: ArchiveBlob[];
      archive_version?: 1;
      retention_version?: 1;
    }
  | { type: 'effect'; id: string; outcome: 'confirmed' | 'not-started' | 'unknown'; receipt: Json }
  | { type: 'write'; id: string; body: EvidenceBody }
  | { type: 'supersede'; id: string; expected_head: number; reason: string; body: EvidenceBody }
  | {
      type: 'resolve';
      id: string;
      expected_head: number;
      condition: string;
      supporting_id: string;
      supporting_revision: number;
      disposition: string;
    }
  | { type: 'reuse'; id: string; revision: number; target_scope: string; manifest: InputManifest }
  | { type: 'freeze' }
  | { type: 'thaw' };

export interface CatalogCursor {
  revision: number;
  offset: number;
  query: string;
}

export type StoreCommand =
  | { type: 'mutate'; mutation: Mutation; change: Change }
  | { type: 'read'; id: string; revision: number | null }
  | {
      type: 'catalog' | 'find';
      query: string;
      cursor: CatalogCursor | null;
      limit: number;
      byte_limit: number;
    }
  | { type: 'operation'; operation_id: string }
  | { type: 'state'; archive?: 'current' | 'full' }
  | { type: 'archive'; hash: string }
  | { type: 'effects' }
  | { type: 'finalization'; expected_revision: number };

export interface StoreRequest {
  context: EvidenceContext;
  command: StoreCommand;
}

export interface WriteAck {
  operation_id: string;
  catalog_revision: number;
  generation: number;
  evidence_id: string | null;
  revision: number | null;
  content_hash: string;
  locator: string;
}

export interface Metadata {
  id: string;
  revision: number;
  head_revision: number;
  kind: string;
  result: EvidenceBody['result'];
  scope: string;
  criterion: string;
  links: string[];
  content_hash: string;
  raw_hash: string;
  actor_id: string;
  subtask_id: string | null;
  run_id: string | null;
  reason: string | null;
}

export interface StoredEvidence {
  metadata: Metadata;
  body: EvidenceBody;
  predecessor: number | null;
  successor: number | null;
  raw_locator: string;
}

export interface CatalogPage {
  catalog_revision: number;
  items: Metadata[];
  coverage: 'complete' | 'partial';
  searched_scope: { project_id: string; task_id: string; query: string };
  next_cursor: CatalogCursor | null;
}

export interface TechnicalState {
  revision: number;
  generation: number;
  owner: string | null;
  lease_until: number;
  released: boolean;
  frozen: boolean;
  checkpoint: Json;
  retention_gc?: true;
}

export interface EffectRecord {
  id: string;
  intent: Json;
  outcome: 'pending' | 'confirmed' | 'not-started' | 'unknown';
  receipt: Json;
}
export interface EventRecord {
  operation_id: string;
  revision: number;
  context: EvidenceContext;
  change: Json;
}
export interface FinalizationManifest {
  schema_version: string;
  context: { project_id: string; task_id: string };
  state: TechnicalState;
  entries: Metadata[];
  events: EventRecord[];
  operations: WriteAck[];
  effects: EffectRecord[];
  blobs: string[];
}

export type OperationResult =
  { status: 'confirmed'; ack: WriteAck } | { status: 'not-started' | 'unknown' };
export type MaintenanceAction =
  | { type: 'initialize' }
  | { type: 'backup'; destination: string }
  | { type: 'restore'; source: string };
export interface BackupReceipt {
  schema: number;
  revision: number;
  manifest_hash: string;
  database_hash: string;
  blobs: string[];
  project_id: string;
  task_id: string;
}
export type StoreValue =
  | { hash: string; value: Json }
  | EffectRecord[]
  | WriteAck
  | StoredEvidence
  | CatalogPage
  | TechnicalState
  | FinalizationManifest
  | OperationResult
  | BackupReceipt
  | { status: 'initialized' };
export type StoreErrorCode =
  | 'invalid-context'
  | 'permission-denied'
  | 'unsupported-version'
  | 'not-found'
  | 'revision-conflict'
  | 'stale-owner'
  | 'budget-exhausted'
  | 'unavailable'
  | 'recovery-required'
  | 'corrupt'
  | 'unknown-outcome';
export interface StoreFailure {
  code: StoreErrorCode;
  operation_id: string | null;
  observed_revision: number | null;
  retryable: boolean;
  recovery_locator: string;
}
export type StoreReply = { ok: true; value: StoreValue } | { ok: false; error: StoreFailure };

export class StoreFault extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    public readonly observed_revision: number | null = null,
  ) {
    super(code);
  }
}

export function requireStore(condition: unknown, code: StoreErrorCode): asserts condition {
  if (!condition) throw new StoreFault(code);
}

export function compareInputs(
  source: InputManifest,
  target: InputManifest,
): 'applicable' | 'changed' | 'unknown' {
  if (!source.complete || !target.complete || !source.attested_by || !target.attested_by)
    return 'unknown';
  const ordered = (manifest: InputManifest) =>
    manifest.inputs.map(({ locator, hash }) => `${locator}\u0000${hash}`).sort();
  if (
    source.discovery_rule !== target.discovery_rule ||
    JSON.stringify(ordered(source)) !== JSON.stringify(ordered(target))
  )
    return 'changed';
  return 'applicable';
}

export function logicalInputs(before: InputManifest, after: InputManifest, graph: InputRef[]) {
  const old = new Set(before.inputs.map((ref) => ref.locator));
  const dependencies = new Map(graph.map((ref) => [ref.locator, ref.hash]));
  const retained = after.inputs.filter((ref) => old.has(ref.locator));
  if (
    new Set(after.inputs.map((ref) => ref.locator)).size === after.inputs.length &&
    compareInputs(before, { ...after, inputs: retained }) === 'applicable' &&
    after.inputs.every((ref) => old.has(ref.locator) || dependencies.get(ref.locator) === ref.hash)
  )
    return { ...after, inputs: retained };
  return after;
}

export function targetEvidenceInputs(target: {
  inputs: InputManifest;
  evidence_inputs?: InputManifest;
}): InputManifest {
  const evidence = target.evidence_inputs;
  if (evidence === undefined) return target.inputs;
  const refs = new Map(evidence.inputs.map((ref) => [ref.locator, ref.hash]));
  requireWorkflow(
    target.inputs.complete &&
      evidence.complete &&
      refs.size === evidence.inputs.length &&
      target.inputs.inputs.every((ref) => refs.get(ref.locator) === ref.hash),
    'target-evidence-missing-source-inputs',
  );
  return evidence;
}
