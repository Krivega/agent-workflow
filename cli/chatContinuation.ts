import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { TechnicalState, StoreRequest, EffectRecord } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import { confirmLoad } from '../core/localRun.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import type { ChatMessageEvent } from '../core/chatMessages.js';
import { sameValue } from '../core/equality.js';
import type { ChatContextJournal } from '../ports/chatContext.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { RunInputs } from '../ports/localRuns.js';
import type { ChatRecovery } from '../ports/chatRecovery.js';
import { prepareChatControl } from '../application/chatControl.js';
import { prepareChatMessage } from '../application/chatMessages.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import type { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';

export { saveChatArtifact, readChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { saveChatArtifact } from '../adapters/storage/sharedArtifacts.js';
export function refreshChatLease(
  store: SqliteEvidenceStore,
  recovery?: { evidence: InputRef; expected_revision: number },
  forceRenew = false,
) {
  const state = unwrap<TechnicalState>(
    store.execute({ context: store.grant.context, command: { type: 'state', archive: 'current' } }),
  );
  const now = Date.now();
  requireWorkflow(
    recovery === undefined || recovery.expected_revision === state.revision,
    'chat-owner-recovery-conflict',
  );
  if (!forceRenew && state.lease_until > now + 60_000) return;
  requireWorkflow(
    state.lease_until > now || recovery !== undefined,
    'chat-lease-recovery-required',
  );
  const expired = state.lease_until <= now;
  const request: StoreRequest & { command: Extract<StoreRequest['command'], { type: 'mutate' }> } =
    {
      context: store.grant.context,
      command: {
        type: 'mutate',
        mutation: {
          operation_id: `chat:lease:${state.generation}:${state.revision}`,
          expected_revision: state.revision,
          owner_generation: state.generation,
          payload_hash: '',
        },
        change: expired
          ? {
              type: 'recover-owner',
              lease_until: now + 30 * 60_000,
              proof: {
                owner: state.owner!,
                generation: state.generation,
                revision: state.revision,
                checkpoint_hash: digest(canonical(state.checkpoint)),
                evidence: recovery!.evidence,
              },
            }
          : { type: 'renew', lease_until: now + 30 * 60_000 },
      },
    };
  request.command.mutation.payload_hash = requestHash(request);
  unwrap(store.execute(request));
}

export async function withActiveChatLease<T>(
  store: SqliteEvidenceStore,
  assertRuntime: () => void,
  action: (verify: () => void) => Promise<T>,
) {
  let failure: unknown;
  const verify = () => {
    if (failure !== undefined) throw failure;
    assertRuntime();
  };
  verify();
  refreshChatLease(store);
  const timer = setInterval(() => {
    try {
      verify();
      refreshChatLease(store);
    } catch (error) {
      failure = error;
    }
  }, 5000);
  try {
    const result = await action(verify);
    if (failure !== undefined) throw failure;
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function continueChat(
  request: Record<string, unknown>,
  chat: ChatContextJournal,
  host: CurrentChatHost,
  inputs: RunInputs,
  recovery: ChatRecovery,
  store: SqliteEvidenceStore,
  assertRuntime: () => void,
) {
  const initial = unwrap<TechnicalState>(
    store.execute({ context: store.grant.context, command: { type: 'state', archive: 'current' } }),
  );
  const context = await chat.read();
  requireWorkflow(context.control !== null, 'chat-control-missing');
  const authorization = request.authorization as InputRef | undefined;
  const source = (authorization ?? request.human_source) as InputRef;
  textField(source.locator);
  textField(source.hash);
  const message = request.message as ChatMessageEvent | undefined;
  if (message !== undefined)
    requireWorkflow(
      message?.type === 'REQUIREMENTS' &&
        authorization === undefined &&
        sameValue(message.source, source) &&
        request.previous_source_turn === undefined,
      'chat-continuation-requirements-source-mismatch',
    );
  const pending =
    message === undefined
      ? context
      : (await prepareChatMessage(message, context, host, inputs, chat.fingerprint)).next;
  const observed = await host.observe();
  const id = `resume:${digest(canonical({ source, observation: observed.source, ...(message === undefined ? {} : { message }) }))}`;
  const previous = context.control.history.find((entry) => entry.id === id);
  const event: ChatControlEvent = previous
    ? (JSON.parse(previous.payload) as ChatControlEvent)
    : {
        type: 'RESUME',
        id,
        expected_revision: context.control.revision,
        generation: context.run.generation,
        thread_id: context.run.spec.session_id,
        source,
        marker: textField(request.marker),
        ...(authorization === undefined ? {} : { authorization }),
        ...(request.previous_source_turn === undefined
          ? {}
          : { previous_source_turn: textField(request.previous_source_turn) }),
      };
  requireWorkflow(event.type === 'RESUME', 'chat-continuation-event-mismatch');
  const prepared = await prepareChatControl(
    event,
    pending,
    host,
    inputs,
    recovery,
    new NativeUserCommands(textField(request.root)),
  );
  const sameLiveOwner =
    prepared.next === context &&
    message === undefined &&
    authorization === undefined &&
    context.run.status === 'ready' &&
    context.control.status === 'active' &&
    context.control.history.at(-1)?.id === event.id &&
    sameValue(context.control.observed, observed);
  let liveLoad;
  if (sameLiveOwner) {
    requireWorkflow(
      sameValue(
        { ...context.control.origin, turn_id: observed.turn_id, source: observed.source },
        observed,
      ),
      'chat-continuation-identity-mismatch',
    );
    await host.message(source, event.previous_source_turn);
    await recovery.settled();
    for (const turn of context.control.unreconciled_turns ?? []) await host.continuation(turn);
    await inputs.verify(context.run);
    liveLoad = await host.load(context.run, event.marker, event.previous_source_turn !== undefined);
    confirmLoad(context.run, liveLoad);
  }
  assertRuntime();
  const effects = unwrap<EffectRecord[]>(
    store.execute({ context: store.grant.context, command: { type: 'effects' } }),
  );
  const reservations = context.workflow.execution?.supervision?.reservations ?? [];
  requireWorkflow(
    effects.every((effect) => {
      if (effect.outcome === 'confirmed' || effect.outcome === 'not-started') return true;
      const execution = context.workflow.execution;
      if (
        effect.intent === null ||
        typeof effect.intent !== 'object' ||
        Array.isArray(effect.intent)
      )
        return false;
      const intent = object(effect.intent);
      return (
        intent.kind === 'progress-audit' &&
        intent.task_id === execution?.task_id &&
        intent.generation === execution?.generation &&
        reservations.some(
          (a) =>
            a.settled === null &&
            effect.id === `progress-audit:${a.id}` &&
            intent.key === a.key &&
            sameValue(intent.card, a.card.ref),
        )
      );
    }),
    'chat-effect-outcome-unknown',
  );
  if (effects.some((effect) => effect.outcome === 'pending' || effect.outcome === 'unknown'))
    await new FileWorkflowInputs(textField(request.root), textField(request.evidence_root)).verify(
      reservations.filter((a) => a.settled === null).map((a) => a.card.ref),
    );
  const state = unwrap<TechnicalState>(
    store.execute({ context: store.grant.context, command: { type: 'state', archive: 'current' } }),
  );
  requireWorkflow(state.revision === initial.revision, 'chat-owner-recovery-conflict');
  const sameCompactedOwner =
    prepared.next !== context &&
    message === undefined &&
    authorization === undefined &&
    context.run.status === 'ready' &&
    context.control.status === 'active' &&
    context.control.observed.turn_id === observed.turn_id &&
    context.control.history.at(-1) !== undefined &&
    (JSON.parse(context.control.history.at(-1)!.payload) as ChatControlEvent).type === 'RESUME';
  requireWorkflow(
    state.lease_until > Date.now() ||
      context.control.observed.turn_id !== prepared.next.control!.observed.turn_id ||
      sameLiveOwner ||
      sameCompactedOwner,
    'chat-expired-owner-boundary-required',
  );
  if (prepared.next === context) {
    const recoveryProof =
      sameLiveOwner && state.lease_until <= Date.now()
        ? saveChatArtifact(textField(request.evidence_root), 'live-owner-continuation', {
            schema_version: 1,
            owner: state.owner,
            generation: state.generation,
            revision: state.revision,
            checkpoint_hash: digest(canonical(state.checkpoint)),
            event,
            observed,
            loaded: liveLoad,
            settled: true,
          })
        : undefined;
    refreshChatLease(
      store,
      recoveryProof === undefined
        ? undefined
        : { evidence: recoveryProof, expected_revision: state.revision },
      true,
    );
    return prepared.next;
  }
  const proof = saveChatArtifact(textField(request.evidence_root), 'owner-continuation', {
    schema_version: 1,
    owner: state.owner,
    generation: state.generation,
    revision: state.revision,
    checkpoint_hash: digest(canonical(state.checkpoint)),
    event,
    ...(message === undefined ? {} : { requirements: message }),
    observed: prepared.next.control!.observed,
    continuation: prepared.next.control!.continuation ?? null,
    unreconciled_turns: prepared.next.control!.unreconciled_turns,
  });
  assertRuntime();
  refreshChatLease(store, { evidence: proof, expected_revision: state.revision }, true);
  await chat.save(context, prepared.next, 'chat:control:' + event.id);
  return prepared.next;
}
