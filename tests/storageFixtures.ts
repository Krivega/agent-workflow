import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evidenceSchema,
  type Change,
  type EvidenceBody,
  type EvidenceGrant,
  type StoreCommand,
  type StoreRequest,
  type WriteAck,
} from '../core/evidence.js';
import { requestHash } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';

export const grant: EvidenceGrant = {
  context: {
    schema_version: evidenceSchema,
    project_id: 'project',
    task_id: 'task',
    subtask_id: null,
    run_id: 'run',
    actor_id: 'owner',
  },
  permissions: ['read', 'produce', 'resolve', 'manage'],
};
export const body: EvidenceBody = {
  kind: 'check',
  result: 'FAIL',
  scope: 'module',
  criterion: 'TC-1',
  summary: 'Полный вывод сохранён',
  command: 'check',
  exit_code: 1,
  limitations: ['local'],
  provenance: {
    head: 'head-1',
    base: 'base-1',
    dirty_diff: 'diff',
    untracked: 'file',
    rules: { hash: 'rules' },
    tools: { node: '22' },
    environment: { os: 'test' },
  },
  manifest: {
    complete: true,
    attested_by: 'owner',
    discovery_rule: 'transitive inputs v1',
    inputs: [{ locator: 'source.ts', hash: 'a'.repeat(64) }],
  },
  links: ['TC-1'],
  raw: { input: 'input', output: 'failure\n'.repeat(1000) },
};

export function signed(
  change: Change,
  revision: number,
  generation = 1,
  operation = `op-${revision}`,
  authority = grant,
): StoreRequest {
  const request: StoreRequest & { command: Extract<StoreCommand, { type: 'mutate' }> } = {
    context: { ...authority.context },
    command: {
      type: 'mutate',
      mutation: {
        operation_id: operation,
        expected_revision: revision,
        owner_generation: generation,
        payload_hash: '',
      },
      change,
    },
  };
  request.command.mutation.payload_hash = requestHash(request);
  return request;
}

export function fixture() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'aw3-'));
  const root = join(parent, 'store');
  initializeStore(root, grant.context);
  const store = new SqliteEvidenceStore(root, grant, () => 100);
  const execute = (command: StoreCommand) => store.execute({ context: grant.context, command });
  const mutate = (change: Change, revision: number, generation = 1, operation = `op-${revision}`) =>
    store.execute(signed(change, revision, generation, operation));
  const claim = () => unwrap<WriteAck>(mutate({ type: 'claim', lease_until: 1000 }, 0, 0));
  return {
    parent,
    root,
    store,
    execute,
    mutate,
    claim,
    dispose: () => rmSync(parent, { recursive: true, force: true }),
  };
}

/** Launch the storage worker in the fixture's own workspace. */
export function enterStorageWorkspace(directory: string) {
  const previous = process.cwd();
  process.chdir(directory);
  onTestFinished(() => process.chdir(previous));
}
