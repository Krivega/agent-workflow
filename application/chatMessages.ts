import { applyChatMessage, createChatMessages } from '../core/chatMessages.js';
import type { ChatMessageEvent } from '../core/chatMessages.js';
import { requireWorkflow } from '../core/connection.js';
import { applyLocalEvent } from '../core/localRun.js';
import { applyExecution, createExecution } from '../core/execution.js';
import type { ChatContext, ChatContextJournal } from '../ports/chatContext.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { RunInputs } from '../ports/localRuns.js';

export async function initializeChatMessages(journal: ChatContextJournal) {
  const state = await journal.read();
  if (state.messages !== null) return state.messages;
  const run = state.run;
  requireWorkflow('task_id' in run.spec.identity, 'product-needs-card');
  const messages = createChatMessages(
    run.spec.identity.task_id,
    run.spec.session_id,
    run.generation,
    run.spec.assignment,
  );
  await journal.save(state, { ...state, messages }, 'chat:messages:begin');
  return messages;
}
export async function advanceChatMessages(
  event: ChatMessageEvent,
  journal: ChatContextJournal,
  host: Pick<CurrentChatHost, 'reference' | 'message'>,
  inputs: RunInputs,
) {
  const { state, next } = await prepareChatMessage(
    event,
    await journal.read(),
    host,
    inputs,
    journal.fingerprint,
  );
  if (next !== state) await journal.save(state, next, 'chat:message:' + event.id);
  return next;
}
export async function prepareChatMessage(
  event: ChatMessageEvent,
  state: ChatContext,
  host: Pick<CurrentChatHost, 'reference' | 'message'>,
  inputs: RunInputs,
  fingerprint?: (value: unknown) => string,
) {
  requireWorkflow(state.messages !== null, 'chat-messages-missing');
  const messages = applyChatMessage(state.messages, event, fingerprint);
  if (messages === state.messages) {
    await host.reference(event.source);
    return { state, next: state };
  }
  const message = await host.message(event.source);
  requireWorkflow(message.thread_id === event.thread_id, 'chat-message-identity-mismatch');
  let run = state.run,
    workflow = state.workflow;
  requireWorkflow(
    run.status !== 'cancelled' && run.projection?.result.status !== 'pending',
    'chat-message-scope-closed',
  );
  if (event.type === 'REQUIREMENTS') {
    requireWorkflow(!state.coordination_bound, 'chat-requirements-coordination-bound');
    requireWorkflow(
      'task_id' in run.spec.identity &&
        event.revision.card.locator === run.spec.identity.card.locator &&
        workflow.execution?.status !== 'done',
      'chat-requirements-scope-mismatch',
    );
    run = applyLocalEvent(run, {
      type: 'WAIT',
      event_id: event.id + ':wait',
      expected_revision: run.revision,
      generation: run.generation,
    });
    const { card, ...revision } = event.revision;
    run = {
      ...run,
      loaded: null,
      spec: {
        ...run.spec,
        ...revision,
        identity: { ...run.spec.identity, card },
        route: { kind: 'substantial', accepted_plan: null },
      },
    };
    await inputs.verify(run);
    if (workflow.execution !== null) {
      const current = workflow.execution;
      createExecution(
        current.task_id,
        current.generation,
        event.target,
        event.gates,
        current.code,
        'substantial',
      );
      const execution = applyExecution(
        current,
        {
          type: 'REPLAN',
          id: event.id + ':replan',
          expected_revision: current.revision,
          generation: current.generation,
          target: event.target,
          requirements: { revision: messages.requirements_revision, source: event.source },
        },
        fingerprint,
      );
      workflow = {
        ...workflow,
        revision: workflow.revision + 1,
        execution: { ...execution, gates: event.gates },
      };
    }
  }
  const next = { ...state, messages, run, workflow };
  return { state, next };
}
