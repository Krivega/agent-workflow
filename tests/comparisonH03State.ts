import { join } from 'node:path';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { evidenceSchema } from '../core/evidence.js';
import type {
  Change,
  EvidenceBody,
  EvidenceGrant,
  EffectRecord,
  Json,
  StoredEvidence,
  StoreRequest,
  TechnicalState,
} from '../core/evidence.js';
import type { LocalRun, LoadReceipt, InputRef } from '../core/localRun.js';
import type { ChatObservation } from '../core/currentChat.js';
import type { ChatContext } from '../ports/chatContext.js';
import { createChatControl } from '../core/chatControl.js';
import { createChatMessages } from '../core/chatMessages.js';
import { createExecution } from '../core/execution.js';
import { recordFinding } from '../core/findings.js';
import { applyLocalEvent } from '../core/localRun.js';
import { h03ContextPath, publishH03Context } from './comparisonH03Contract.js';
import { h01ReadJson, h01Record, type H01AttemptContext } from './comparisonH01Contract.js';

/** A real isolated task checkpoint and unfinished effect, under this H03 attempt only. */
export function createH03State(ctx: H01AttemptContext, run: LocalRun, initialCheck: InputRef) {
  const task = 'h03-' + digest(ctx.opId).slice(0, 16),
    grant: EvidenceGrant = {
      context: {
        schema_version: evidenceSchema,
        project_id: run.spec.project_id,
        task_id: task,
        subtask_id: null,
        run_id: run.spec.run_id,
        actor_id: run.spec.session_id,
      },
      permissions: ['read', 'manage', 'produce'],
    };
  ctx.signal.throwIfAborted();
  initializeStore(join(ctx.roots.stateRoot, 'h03-checkpoint'), grant.context);
  const store = new SqliteEvidenceStore(
    join(ctx.roots.stateRoot, 'h03-checkpoint'),
    grant,
    Date.now,
  );
  const saved = (label: string, value: unknown) =>
    h01Record(ctx.roots.evidenceRoot, 'h03-' + label, value);
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'full' } }),
    );
  const mutate = (change: Change, operation: string) => {
    ctx.signal.throwIfAborted();
    const before = state(),
      request = {
        context: grant.context,
        command: {
          type: 'mutate',
          mutation: {
            operation_id: ctx.opId + ':' + operation,
            expected_revision: before.revision,
            owner_generation: before.generation,
            payload_hash: '',
          },
          change,
        },
      } satisfies StoreRequest;
    request.command.mutation.payload_hash = requestHash(request);
    const reply = store.execute(request);
    unwrap(reply);
    return { request, reply };
  };
  const lease =
    Date.now() +
    Math.max(1, Math.floor(Number(BigInt(ctx.deadlineNs) - process.hrtime.bigint()) / 1e6));
  mutate({ type: 'claim', lease_until: lease }, 'claim');
  const body: EvidenceBody = {
    kind: 'h03-initial-check',
    result: 'FAIL',
    scope: 'evidence/',
    criterion: ctx.criteria.value.task,
    summary: 'Original H03 material checker failure, retained without a resolution.',
    command: 'node checks.mjs',
    exit_code: null,
    limitations: [],
    provenance: {
      head: '',
      base: '',
      dirty_diff: '',
      untracked: '',
      rules: run.spec.rules as unknown as Json,
      tools: null,
      environment: null,
    },
    manifest: {
      complete: true,
      attested_by: run.spec.session_id,
      discovery_rule: 'H03 pinned initial checker primary',
      inputs: [initialCheck],
    },
    links: [],
    raw: { input: canonical(ctx.material.ref), output: canonical(h01ReadJson(initialCheck)) },
  };
  const written = mutate({ type: 'write', id: 'F-01', body }, 'initial-failure');
  const failureRead = () =>
    unwrap<StoredEvidence>(
      store.execute({ context: grant.context, command: { type: 'read', id: 'F-01', revision: 1 } }),
    );
  const failure = saved('initial-failure', {
    kind: 'comparison-h03-initial-failure',
    check: initialCheck,
    ...written,
    stored: failureRead(),
  });
  const inputs = {
    complete: true,
    attested_by: run.spec.session_id,
    discovery_rule: 'H03 immutable task inputs',
    inputs: run.spec.sources,
  };
  const execution = createExecution(
    task,
    1,
    { scope: 'evidence/', base: ctx.requestHash, diff: run.spec.assignment, inputs },
    [{ id: 'F-01', kind: 'check', applicable: true, reason: 'Original failure remains open.' }],
    false,
    'mechanical',
  );
  execution.findings = recordFinding(
    [],
    {
      id: 'F-01',
      scope: 'evidence/',
      condition: 'Original H03 material failure remains unresolved.',
      reason: 'The first real checker failed before a manifest existed.',
      blocking: true,
      sources: [initialCheck],
    },
    'architect',
    failure,
  );
  const context: ChatContext = {
    run,
    messages: createChatMessages(task, run.spec.session_id, 1, run.spec.assignment),
    control: null,
    coordination_bound: false,
    workflow: { schema_version: 1, revision: 0, execution, readings: {} },
  };
  const pendingId = ctx.opId + ':unfinished';
  const pendingWrite = mutate(
    {
      type: 'checkpoint',
      state: {
        local_run: run,
        chat_messages: context.messages,
        workflow: context.workflow,
      } as unknown as Json,
      effects: [
        {
          id: pendingId,
          intent: {
            kind: 'h03-unfinished-operation',
            opId: ctx.opId,
            task,
            source: initialCheck as unknown as Json,
          },
        },
      ],
    },
    'checkpoint',
  );
  const pending = saved('pending-intent', {
    kind: 'comparison-h03-pending-intent',
    id: pendingId,
    ...pendingWrite,
  });
  const contextPin = publishH03Context(ctx, failure, pending);
  const contextRef = { locator: h03ContextPath, hash: contextPin.hash };
  context.run = {
    ...run,
    spec: {
      ...run.spec,
      sources: [...run.spec.sources, contextRef],
      rules: [...run.spec.rules, contextRef],
    },
  };
  mutate(
    {
      type: 'checkpoint',
      state: {
        local_run: context.run,
        chat_messages: context.messages,
        workflow: context.workflow,
      } as unknown as Json,
      effects: [],
    },
    'context-binding',
  );
  const journal = new TaskChatContext(
    { execute: async (request) => store.execute(request) },
    grant.context,
    1,
  );
  const effects = () =>
    unwrap<EffectRecord[]>(store.execute({ context: grant.context, command: { type: 'effects' } }));
  return {
    store,
    journal,
    context: contextPin,
    initialRun: context.run,
    failure,
    pending,
    state,
    effects,
    snapshot: () =>
      saved('state', {
        kind: 'comparison-h03-state',
        state: state(),
        effects: effects(),
        failure: failureRead(),
      }),
    async load(receipt: LoadReceipt, observed: ChatObservation) {
      const previous = await journal.read();
      let next = applyLocalEvent(previous.run, {
        type: 'LOAD',
        event_id: 'h03-load:' + receipt.observed_read,
        expected_revision: previous.run.revision,
        generation: 1,
        receipt,
      });
      next = applyLocalEvent(next, {
        type: 'READY',
        event_id: 'h03-ready:' + receipt.observed_read,
        expected_revision: next.revision,
        generation: 1,
      });
      await journal.save(
        previous,
        { ...previous, run: next, control: createChatControl(observed, 1) },
        'h03-load:' + digest(receipt.observed_read),
      );
      return next;
    },
  };
}
