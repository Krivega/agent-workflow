import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function auditorRuntime(f, profile) {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const read = (ref) => JSON.parse(f.store.read(ref).toString());
  const parent = {
    ...f.response.thread,
    id: 'parent',
    path: join(f.root, 'parent.jsonl'),
    turns: [],
  };
  const child = {
    ...f.response.thread,
    id: 'child',
    path: join(f.root, 'child.jsonl'),
    parentThreadId: 'parent',
    agentRole: 'auditor',
    canAcceptDirectInput: false,
    turns: [],
  };
  const records = {};
  for (const t of [parent, child])
    records[String(t.id)] = [
      { type: 'session_meta', payload: { id: t.id, cli_version: profile.clientVersion } },
    ];
  const writeRecords = () => {
    for (const t of [parent, child])
      writeFileSync(
        String(t.path),
        records[String(t.id)].map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
  };
  writeRecords();
  const native = {
    cwd: f.workspace,
    model: profile.model,
    reasoningEffort: 'xhigh',
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: child,
  };
  const state = {
    loadPending: false,
    answerPending: false,
    direction: 'continue',
    coverage: 'complete',
    starts: 0,
  };
  let input;
  const loadedItem = (refs) => ({
    type: 'commandExecution',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: refs
      .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
      .join('\n'),
  });
  const turns = (t) => t.turns;
  const rpc = {
    request: async (method, params) => {
      if (method === 'model/list')
        return {
          data: [
            {
              model: profile.model,
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium' },
                { reasoningEffort: 'xhigh' },
              ],
            },
          ],
        };
      if (method === 'mcpServerStatus/list')
        return { data: [{ name: 'fixture' }], nextCursor: null };
      if (method === 'thread/start')
        return globalThis.structuredClone({ ...f.response, model: profile.model, thread: parent });
      if (method === 'thread/loaded/list') return { data: ['parent'] };
      if (method === 'thread/read')
        return globalThis.structuredClone({
          thread: params.threadId === 'parent' ? parent : child,
        });
      if (method === 'thread/resume')
        return globalThis.structuredClone(
          params.threadId === 'child'
            ? native
            : { ...f.response, model: profile.model, thread: parent },
        );
      if (method === 'turn/interrupt') {
        turns(params.threadId === 'parent' ? parent : child).find(
          (t) => t.id === params.turnId,
        ).status = 'interrupted';
        return {};
      }
      if (method !== 'turn/start') throw new Error('unexpected-rpc:' + method);
      if (params.threadId !== 'parent') throw new Error('direct-child-input-forbidden');
      state.starts += 2;
      const message = params.input[0].text;
      const launch = turns(parent).length === 0,
        parentId = launch ? 'parent-load' : 'parent-answer',
        childId = launch ? 'child-load' : 'child-answer';
      const args = JSON.parse(
        message.split('arguments: ')[1].split(launch ? '. agent_type' : '. The child')[0],
      );
      const callId = launch ? 'spawn-call' : 'followup-call';
      const item = launch
        ? {
            type: 'subAgentActivity',
            kind: 'started',
            id: callId,
            model: profile.model,
            reasoningEffort: 'xhigh',
            agentThreadId: 'child',
            agentPath: '/root/' + args.task_name,
          }
        : { type: 'subAgentActivity', kind: 'message', id: callId, agentThreadId: 'child' };
      turns(parent).push({
        id: parentId,
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }, item],
      });
      records.parent.push(
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: launch ? 'spawn_agent' : 'followup_task',
            call_id: callId,
            arguments: JSON.stringify(args),
            internal_chat_message_metadata_passthrough: { turn_id: parentId },
          },
        },
        {
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: callId, output: 'accepted' },
        },
      );
      records.child.push({
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: childId,
          turn_attribution: { parent_turn_id: parentId },
        },
      });
      const refs = launch
        ? read(input.preflight).refs
        : [{ path: args.message, sha256: digest(readFileSync(args.message)) }];
      const body = launch ? null : JSON.parse(readFileSync(args.message, 'utf8'));
      const report = {
        schemaVersion: 1,
        card: input.card,
        coverage: state.coverage,
        direction: state.direction,
        reasons: ['Достигнут проверяемый checkpoint'],
        sources: body?.allowedSources,
        checkpoint: body?.facts.checkpoint,
        nextResult: 'Технические проверки и независимая приёмка',
        limitations: [],
      };
      turns(child).push({
        id: childId,
        status: (launch ? state.loadPending : state.answerPending) ? 'inProgress' : 'completed',
        items: [
          loadedItem(refs),
          ...(launch
            ? []
            : [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(report) }]),
        ],
      });
      writeRecords();
      return { turn: { id: parentId } };
    },
    completed: async () => {},
  };
  return {
    parent,
    child,
    records,
    writeRecords,
    native,
    state,
    rpc,
    turns,
    bind(value) {
      input = value;
    },
  };
}
