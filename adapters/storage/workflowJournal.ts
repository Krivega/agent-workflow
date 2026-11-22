import {
  requireHumanCompletionFloor,
  requireCurrentHumanCompletion,
  sealHumanCompletion,
  requireSealedHumanCompletion,
} from '../../core/chatMessages.js';
import type { ChatMessages } from '../../core/chatMessages.js';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { EvidenceContext, Json, TechnicalState, EffectRecord } from '../../core/evidence.js';
import { object, requireWorkflow } from '../../core/connection.js';
import type { WorkflowCheckpoint, WorkflowJournal } from '../../ports/workflowJournal.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import { requestHash } from './storeCodec.js';
import { retainEvidenceAsync, retentionFingerprint } from './retainedJson.js';
import { applyLocalEvent, assertRunAction, localRunVersionSupported } from '../../core/localRun.js';
import { coderOwnsSource } from '../../core/coder.js';
import type { LocalRun, InputRef } from '../../core/localRun.js';
import type { Execution } from '../../core/execution.js';
import { validateCheckpoint } from './workflowValidation.js';
import { compactArchive, eventPayload } from './archiveJson.js';

import {
  historyEncoding,
  legacyHistoryPrefix,
  historyPrefix,
  decodeHistoryPayload,
} from './historyPayload.js';

function mapHistory(
  checkpoint: WorkflowCheckpoint,
  transform: (payload: string) => string,
): WorkflowCheckpoint {
  if (checkpoint.execution === null) return checkpoint;
  return {
    ...checkpoint,
    execution: {
      ...checkpoint.execution,
      history: checkpoint.execution.history.map((event) => ({
        ...event,
        payload: transform(event.payload),
      })),
    },
  };
}

export function encodeWorkflowHistory(
  checkpoint: WorkflowCheckpoint,
  cache = new Map<string, string>(),
): WorkflowCheckpoint {
  const previous = new Map<string, string>();
  for (const [encoded, decoded] of cache)
    if (encoded.startsWith(historyPrefix)) previous.set(decoded, encoded);
  const encoded = mapHistory(checkpoint, (payload) =>
    payload.length < 65_536 && !payload.startsWith(historyEncoding)
      ? payload
      : (previous.get(payload) ??
        historyPrefix + gzipSync(JSON.stringify(payload)).toString('base64')),
  );
  const stored = { ...encoded, history_payload_encoding: 1 };
  return stored;
}

export function decodeWorkflowHistory(
  checkpoint: WorkflowCheckpoint,
  cache = new Map<string, string>(),
): WorkflowCheckpoint {
  const { history_payload_encoding: encoding, ...plain } = checkpoint as WorkflowCheckpoint & {
    history_payload_encoding?: unknown;
  };
  if (encoding === undefined) {
    cache.clear();
    return checkpoint;
  }
  requireWorkflow(encoding === 1, 'unsupported-history-format');
  const retained = new Map<string, string>();
  const result = mapHistory(plain, (payload) => {
    if (!payload.startsWith(historyEncoding)) return payload;
    const legacy = payload.startsWith(legacyHistoryPrefix);
    requireWorkflow(legacy || payload.startsWith(historyPrefix), 'unsupported-history-payload');
    const previous = retained.get(payload) ?? cache.get(payload);
    if (previous !== undefined) {
      retained.set(payload, previous);
      return previous;
    }
    const text = decodeHistoryPayload(payload);
    retained.set(payload, text);
    return text;
  });
  cache.clear();
  for (const [encoded, decoded] of retained) cache.set(encoded, decoded);
  return result;
}

export class TaskWorkflowJournal implements WorkflowJournal {
  readonly fingerprint?: (value: unknown) => string;
  private readonly historyCache = new Map<string, string>();
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
    private readonly generation: number,
    private readonly retention = true,
    private readonly backup?: (state: TechnicalState, operation: string) => Promise<InputRef>,
  ) {
    if (retention) this.fingerprint = retentionFingerprint;
  }
  private async state(full = false): Promise<TechnicalState> {
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'state', archive: full ? 'full' : 'current' },
    });
    requireWorkflow(reply.ok, 'workflow-store-unavailable');
    return reply.value as TechnicalState;
  }
  private decode(state: TechnicalState): WorkflowCheckpoint {
    const value = state.checkpoint === null ? undefined : object(state.checkpoint).workflow;
    if (value === undefined)
      return { schema_version: 1, revision: 0, execution: null, readings: {} };
    validateCheckpoint(value);
    return decodeWorkflowHistory(value, this.historyCache);
  }
  async read(options?: { archive: boolean }) {
    return this.decode(await this.state(options?.archive));
  }
  async checkHumanCompletion(run: Execution) {
    const state = await this.state();
    requireWorkflow(
      isDeepStrictEqual(this.decode(state).execution, run),
      'chat-human-completion-stale',
    );
    requireSealedHumanCompletion(run);
  }
  async readEvent(hash: string) {
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'archive', hash },
    });
    requireWorkflow(reply.ok && 'value' in reply.value, 'workflow-archive-unavailable');
    return eventPayload(object(reply.value.value));
  }
  private authorize(state: TechnicalState, execution: Execution) {
    const local = object(object(state.checkpoint).local_run) as unknown as LocalRun;
    requireWorkflow(
      localRunVersionSupported(local) && local.status === 'ready',
      'local-executor-not-ready',
    );
    requireWorkflow(
      local.generation === execution.generation &&
        local.spec.project_id === this.context.project_id &&
        'task_id' in local.spec.identity &&
        local.spec.identity.task_id === execution.task_id &&
        local.spec.run_id === this.context.run_id,
      'wrong-local-executor',
    );
    requireWorkflow(local.projection?.result.status !== 'pending', 'reconciliation-pending');
    assertRunAction(local, 'implement');
  }
  async ensureReady(run: Execution) {
    this.authorize(await this.state(), run);
    if (run.supervision?.schema_version === 2) await this.settleAuditEffects();
  }
  private async prepareSave(
    expected: WorkflowCheckpoint,
    next: WorkflowCheckpoint,
    operation: string,
  ) {
    requireWorkflow(
      [1, 2].includes(next.schema_version) && next.revision === expected.revision + 1,
      'invalid-workflow-revision',
    );
    requireWorkflow(
      next.execution === null || next.execution.task_id === this.context.task_id,
      'wrong-workflow-task',
    );
    let state = await this.state();
    const current = this.decode(state);
    if (next.execution !== null && !isDeepStrictEqual(expected.execution, next.execution))
      this.authorize(state, next.execution);
    if (next.schema_version === 2 && current.schema_version !== 2) {
      requireWorkflow(isDeepStrictEqual(expected, current), 'workflow-revision-conflict');
      const existing = object(state.checkpoint).local_run_format_backup as InputRef | undefined;
      requireWorkflow(
        existing !== undefined || this.backup !== undefined,
        'workflow-format-backup-required',
      );
      next = { ...next, format_backup: existing ?? (await this.backup!(state, operation)) };
      state = await this.state();
      requireWorkflow(isDeepStrictEqual(this.decode(state), current), 'workflow-revision-conflict');
    }
    if (
      next.execution?.supervision?.schema_version === 2 &&
      current.execution?.supervision?.schema_version !== 2
    ) {
      requireWorkflow(isDeepStrictEqual(expected, current), 'workflow-revision-conflict');
      requireWorkflow(this.backup !== undefined, 'supervision-backup-required');
      next = { ...next, supervision_backup: await this.backup(state, operation) };
      state = await this.state();
      requireWorkflow(isDeepStrictEqual(this.decode(state), current), 'workflow-revision-conflict');
    }
    const checkpoint = state.checkpoint === null ? {} : object(state.checkpoint);
    if (
      next.execution !== null &&
      (next.execution.gates.some((gate) => gate.kind === 'human' && gate.applicable) ||
        current.execution?.gates.some((gate) => gate.kind === 'human' && gate.applicable)) &&
      (checkpoint.chat_messages !== undefined || checkpoint.chat_control !== undefined)
    ) {
      if (current.execution?.status === 'done') {
        requireWorkflow(
          isDeepStrictEqual(next.execution, current.execution),
          'chat-human-completion-immutable',
        );
      } else if (next.execution.result !== null || next.execution.status === 'done') {
        const messages = (checkpoint.chat_messages ?? null) as ChatMessages | null;
        requireHumanCompletionFloor(current.execution, next.execution);
        requireCurrentHumanCompletion(current.execution, messages);
        if (
          next.execution.status === 'done' &&
          next.execution.gates.some((gate) => gate.kind === 'human' && gate.applicable)
        )
          next = {
            ...next,
            execution: {
              ...next.execution,
              human_completion: sealHumanCompletion(next.execution, messages!),
            },
          };
      }
    }
    validateCheckpoint(next);
    if (isDeepStrictEqual(current, next)) return null;
    const packed = this.retention
      ? { value: await retainEvidenceAsync(next, (hash) => this.readEvent(hash)), blobs: [] }
      : compactArchive(next);
    if (isDeepStrictEqual(current, packed.value)) return null;
    requireWorkflow(
      isDeepStrictEqual(expected, current) ||
        isDeepStrictEqual(compactArchive(expected).value, compactArchive(current).value),
      'workflow-revision-conflict',
    );
    let local: LocalRun | undefined;
    if (next.coders !== undefined) {
      requireWorkflow(next.execution !== null, 'coder-execution-required');
      this.authorize(state, next.execution);
      const currentLocal = object(object(state.checkpoint).local_run) as unknown as LocalRun;
      const locks = Object.values(next.coders)
        .filter(coderOwnsSource)
        .map((run) => ({
          id: run.brief.id,
          workspace: run.brief.source_root,
          paths: run.brief.paths,
        }));
      if (currentLocal.schema_version !== 2 || !isDeepStrictEqual(currentLocal.coder_locks, locks))
        local = applyLocalEvent(currentLocal, {
          type: 'CODER_LOCKS',
          locks,
          event_id: `coder-locks:${operation}`,
          expected_revision: currentLocal.revision,
          generation: currentLocal.generation,
        });
    }
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: operation,
          expected_revision: state.revision,
          owner_generation: this.generation,
          payload_hash: '',
        },
        change: {
          type: 'checkpoint' as const,
          state: {
            ...(state.checkpoint === null ? {} : object(state.checkpoint)),
            ...(local === undefined
              ? {}
              : { local_run: local, local_run_format_backup: next.format_backup }),
            workflow: packed.value,
          } as unknown as Json,
          effects: (next.execution?.supervision?.reservations ?? [])
            .filter(
              (a) =>
                !(current.execution?.supervision?.reservations ?? []).some(
                  (old) => old.id === a.id,
                ),
            )
            .map((a) => ({
              id: `progress-audit:${a.id}`,
              intent: {
                kind: 'progress-audit',
                key: a.key,
                card: a.card.ref,
                task_id: next.execution!.task_id,
                generation: next.execution!.generation,
              } as unknown as Json,
            })),
          blobs: packed.blobs,
          ...(this.retention ? { retention_version: 1 as const } : { archive_version: 1 as const }),
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    return request;
  }
  private async settleAuditEffects() {
    const state = await this.state();
    const execution = this.decode(state).execution;
    if (execution?.supervision?.schema_version !== 2) return;
    const reply = await this.store.execute({ context: this.context, command: { type: 'effects' } });
    requireWorkflow(reply.ok, 'workflow-store-unavailable');
    const effects = reply.value as EffectRecord[];
    for (const effect of effects) {
      if (
        !effect.id.startsWith('progress-audit:') ||
        !['pending', 'unknown'].includes(effect.outcome)
      )
        continue;
      const id = effect.id.slice('progress-audit:'.length);
      const audit = execution.supervision.audits.find(
        (a) => a.id === id && a.operation !== undefined,
      );
      const settled = execution.supervision.reservations?.find((a) => a.id === id)?.settled;
      if (!audit && !settled) continue;
      const current = await this.state();
      const request = {
        context: this.context,
        command: {
          type: 'mutate' as const,
          mutation: {
            operation_id: `audit-effect:${id}`,
            expected_revision: current.revision,
            owner_generation: this.generation,
            payload_hash: '',
          },
          change: {
            type: 'effect' as const,
            id: effect.id,
            outcome:
              settled?.outcome === 'not-started'
                ? ('not-started' as const)
                : ('confirmed' as const),
            receipt: (settled ?? {
              session: audit!.role.session,
              operation: audit!.operation,
            }) as unknown as Json,
          },
        },
      };
      request.command.mutation.payload_hash = requestHash(request);
      const saved = await this.store.execute(request);
      requireWorkflow(saved.ok, 'audit-effect-settlement-rejected');
    }
  }
  async save(expected: WorkflowCheckpoint, next: WorkflowCheckpoint, operation: string) {
    const request = await this.prepareSave(expected, next, operation);
    if (request !== null) {
      const reply = await this.store.execute(request);
      requireWorkflow(reply.ok, 'workflow-store-write-rejected');
    }
    if (next.execution?.supervision?.schema_version === 2) await this.settleAuditEffects();
  }
}
