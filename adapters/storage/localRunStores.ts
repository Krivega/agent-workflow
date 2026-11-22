import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EvidenceContext, Json, TechnicalState } from '../../core/evidence.js';
import type { LocalRun, InputRef } from '../../core/localRun.js';
import { localRunVersionSupported } from '../../core/localRun.js';
import { object, requireWorkflow } from '../../core/connection.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { LocalRuns } from '../../ports/localRuns.js';
import { requestHash } from './storeCodec.js';
import { retainStoreState } from './retainedJson.js';

function decodeRun(value: unknown): LocalRun | null {
  if (value === null) return null;
  const run = object(value);
  requireWorkflow(localRunVersionSupported(run as unknown as LocalRun), 'unsupported-run-version');
  return run as unknown as LocalRun;
}
function compare(expected: LocalRun | null, current: LocalRun | null) {
  requireWorkflow(isDeepStrictEqual(expected, current), 'run-revision-conflict');
}

export class TaskLocalRuns implements LocalRuns {
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
    private readonly generation: number,
    private readonly retention = true,
    private readonly backup?: (state: TechnicalState, operation: string) => Promise<InputRef>,
  ) {}
  private async state(): Promise<TechnicalState> {
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'state', archive: 'current' },
    });
    requireWorkflow(reply.ok, 'store-unavailable');
    return reply.value as TechnicalState;
  }
  private fromState(state: TechnicalState) {
    return state.checkpoint === null ? null : decodeRun(object(state.checkpoint).local_run ?? null);
  }
  async read() {
    return this.fromState(await this.state());
  }
  async save(expected: LocalRun | null, next: LocalRun) {
    requireWorkflow(
      'task_id' in next.spec.identity &&
        next.spec.identity.task_id === this.context.task_id &&
        next.spec.project_id === this.context.project_id,
      'wrong-store-context',
    );
    let state = await this.state();
    compare(expected, this.fromState(state));
    let formatBackup: InputRef | undefined;
    if (next.schema_version === 2 && expected?.schema_version !== 2) {
      requireWorkflow(this.backup !== undefined, 'run-format-backup-required');
      formatBackup = await this.backup(state, `run-format:${next.spec.run_id}:${next.revision}`);
      state = await this.state();
      compare(expected, this.fromState(state));
    }
    const checkpoint = {
      ...(state.checkpoint === null ? {} : object(state.checkpoint)),
      ...(formatBackup === undefined ? {} : { local_run_format_backup: formatBackup }),
      local_run: next,
    };
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `${next.spec.run_id}:${next.revision}`,
          expected_revision: state.revision,
          owner_generation: this.generation,
          payload_hash: '',
        },
        change: {
          type: 'checkpoint' as const,
          state: this.retention
            ? await retainStoreState(checkpoint, this.store, this.context)
            : (checkpoint as unknown as Json),
          effects: [],
          ...(this.retention ? { retention_version: 1 as const } : {}),
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    const reply = await this.store.execute(request);
    requireWorkflow(reply.ok, 'store-write-rejected');
  }
}

// Cardless assignments never call the task-scoped Evidence Store.
export class AssignmentLocalRuns implements LocalRuns {
  constructor(
    private readonly root: string,
    private readonly beforeCommit: () => void = () => {},
  ) {}
  async read() {
    try {
      return decodeRun(
        JSON.parse(readFileSync(resolve(this.root, 'assignment.json'), 'utf8')) as unknown,
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(expected: LocalRun | null, next: LocalRun) {
    requireWorkflow('assignment_id' in next.spec.identity && !next.spec.product, 'assignment-only');
    mkdirSync(this.root, { recursive: true });
    const lock = resolve(this.root, 'writer.lock');
    writeFileSync(lock, '', { flag: 'wx' });
    try {
      compare(expected, await this.read());
      this.beforeCommit();
      const temporary = resolve(this.root, 'assignment.next');
      writeFileSync(temporary, JSON.stringify(next));
      try {
        this.beforeCommit();
      } catch (error) {
        unlinkSync(temporary);
        throw error;
      }
      renameSync(temporary, resolve(this.root, 'assignment.json'));
    } finally {
      unlinkSync(lock);
    }
  }
}
