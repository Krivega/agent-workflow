import { lateCommandSettlement } from '../adapters/codex/chatCommandSettlement.js';
import { contentHash } from '../adapters/project/projectFiles.js';

function fixture() {
  const command = 'yarn validate:brief';
  const call = {
    type: 'custom_tool_call',
    call_id: 'launch',
    name: 'exec',
    input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:1000}));`,
  };
  const output = {
    type: 'custom_tool_call_output',
    call_id: 'launch',
    output: [{ text: JSON.stringify({ session_id: 10566, output: '' }) }],
  };
  const item = {
    type: 'CommandExecution',
    id: 'background',
    source: 'unified_exec_startup',
    process_id: '10566',
    command: ['/bin/zsh', '-lc', command],
    cwd: 'file:///workspace',
    status: 'completed',
    exit_code: 0,
  };
  const completion = {
    type: 'item_completed',
    thread_id: 'session',
    turn_id: 'turn',
    started_at_ms: 2000,
    completed_at_ms: 4000,
    item,
  };
  const records: { type: string; timestamp?: string; payload: Record<string, unknown> }[] = [
    {
      type: 'event_msg',
      timestamp: new Date(1000).toISOString(),
      payload: { type: 'task_started' },
    },
    { type: 'response_item', payload: call },
    { type: 'response_item', payload: output },
    {
      type: 'event_msg',
      timestamp: new Date(3000).toISOString(),
      payload: { type: 'task_complete' },
    },
    { type: 'event_msg', timestamp: new Date(4000).toISOString(), payload: completion },
  ];
  const settle = () =>
    lateCommandSettlement(
      records.map((record, i) => ({
        record,
        ref: { locator: `native#L${i + 1}`, hash: contentHash(JSON.stringify(record) + '\n') },
      })),
      0,
      records.findIndex((r) => r.payload.type === 'task_complete'),
      'session',
      'turn',
      '/workspace',
    );
  return { records, call, output, item, completion, settle };
}

it.each([
  'completed',
  'failed',
  'plain-cwd',
  'non-login-shell',
  'literal-escaping',
  'repeated-poll',
])('preserves a known terminal receipt: %s', (kind) => {
  const h = fixture();
  if (kind === 'failed') Object.assign(h.item, { status: 'failed', exit_code: 7 });
  if (kind === 'plain-cwd') h.item.cwd = '/workspace';
  if (kind === 'non-login-shell') h.item.command[1] = '-c';
  if (kind === 'literal-escaping') {
    h.item.command[2] = 'printf "$() `text` \\ .+? [value]"';
    h.call.input = `text(await tools.exec_command({ cmd: ${JSON.stringify(h.item.command[2])} }));`;
  }
  if (kind === 'repeated-poll')
    h.records.splice(
      3,
      0,
      {
        type: 'response_item',
        payload: {
          ...h.call,
          call_id: 'poll',
          input: 'text(await tools.write_stdin({session_id:10566}));',
        },
      },
      { type: 'response_item', payload: { ...h.output, call_id: 'poll' } },
    );
  const result = h.settle();
  expect(result).toEqual({
    source: {
      locator: `native#L${h.records.length}`,
      hash: contentHash(JSON.stringify(h.records.at(-1)) + '\n'),
    },
    ids: ['background'],
  });
});

it.each([
  'new-start',
  'wrong-thread',
  'file-writer',
  'mcp-writer',
  'wrong-source',
  'missing-id',
  'empty-id',
  'wrong-process',
  'malformed-process',
  'missing-process',
  'wrong-command',
  'missing-command',
  'short-command',
  'empty-command-part',
  'non-string-command-part',
  'wrong-shell-mode',
  'wrong-cwd',
  'pending-status',
  'missing-exit',
  'non-integer-exit',
  'missing-start-time',
  'fractional-start-time',
  'fractional-end-time',
  'early-start',
  'late-start',
  'early-completion',
  'mismatched-completion-time',
  'missing-boundary-time',
  'missing-turn-time',
  'duplicate-id',
  'duplicate-process',
  'previously-completed',
  'wrong-call-type',
  'wrong-call-name',
  'non-string-input',
  'missing-input',
  'non-array-output',
  'wrong-call-id',
  'invalid-json',
  'json-primitive',
  'json-array',
  'invalid-session',
  'negative-session',
  'string-session',
  'missing-session',
  'already-terminal-output',
  'nonliteral-command',
])('rejects an unconfirmed or conflicting late receipt: %s', (kind) => {
  const h = fixture();
  if (kind === 'new-start') h.completion.type = 'item_started';
  if (kind === 'wrong-thread') h.completion.thread_id = 'other';
  if (kind === 'file-writer') h.item.type = 'FileChange';
  if (kind === 'mcp-writer') h.item.type = 'McpToolCall';
  if (kind === 'wrong-source') h.item.source = 'unknown';
  if (kind === 'missing-id') Reflect.deleteProperty(h.item, 'id');
  if (kind === 'empty-id') h.item.id = '';
  if (kind === 'wrong-process') h.item.process_id = '10567';
  if (kind === 'malformed-process') h.item.process_id = 'not-a-session';
  if (kind === 'missing-process') Reflect.deleteProperty(h.item, 'process_id');
  if (kind === 'wrong-command') h.item.command[2] = 'different command';
  if (kind === 'missing-command') Reflect.deleteProperty(h.item, 'command');
  if (kind === 'short-command') h.item.command.pop();
  if (kind === 'empty-command-part') h.item.command[2] = '';
  if (kind === 'non-string-command-part') Object.assign(h.item.command, { 2: 123 });
  if (kind === 'wrong-shell-mode') h.item.command[1] = 'unrecognized';
  if (kind === 'wrong-cwd') h.item.cwd = 'file:///other';
  if (kind === 'pending-status') h.item.status = 'inProgress';
  if (kind === 'missing-exit') Reflect.deleteProperty(h.item, 'exit_code');
  if (kind === 'non-integer-exit') h.item.exit_code = 0.5;
  if (kind === 'missing-start-time') Reflect.deleteProperty(h.completion, 'started_at_ms');
  if (kind === 'fractional-start-time') h.completion.started_at_ms = 2000.5;
  if (kind === 'fractional-end-time') h.completion.completed_at_ms = 4000.5;
  if (kind === 'early-start') h.completion.started_at_ms = 999;
  if (kind === 'late-start') h.completion.started_at_ms = 3000;
  if (kind === 'early-completion') h.completion.completed_at_ms = 2999;
  if (kind === 'mismatched-completion-time') h.completion.completed_at_ms = 4001;
  if (kind === 'missing-boundary-time') Reflect.deleteProperty(h.records[3]!, 'timestamp');
  if (kind === 'missing-turn-time') Reflect.deleteProperty(h.records[0]!, 'timestamp');
  if (kind === 'duplicate-id') h.records.push(structuredClone(h.records[4]!));
  if (kind === 'duplicate-process') {
    const duplicate = structuredClone(h.records[4]!);
    duplicate.payload.item = { ...h.item, id: 'other-id' };
    h.records.push(duplicate);
  }
  if (kind === 'previously-completed')
    h.records.splice(3, 0, {
      type: 'event_msg',
      payload: { type: 'item_completed', item: h.item },
    });
  if (kind === 'wrong-call-type') h.call.type = 'function_call';
  if (kind === 'wrong-call-name') h.call.name = 'other';
  if (kind === 'non-string-input') Object.assign(h.call, { input: 123 });
  if (kind === 'missing-input') Reflect.deleteProperty(h.call, 'input');
  if (kind === 'non-array-output') Object.assign(h.output, { output: 'unknown' });
  if (kind === 'wrong-call-id') h.output.call_id = 'other';
  if (kind === 'invalid-json') h.output.output[0]!.text = '{';
  if (kind === 'json-primitive') h.output.output[0]!.text = 'null';
  if (kind === 'json-array') h.output.output[0]!.text = '[]';
  if (kind === 'invalid-session')
    h.output.output[0]!.text = JSON.stringify({ session_id: 1.5, output: '' });
  if (kind === 'negative-session')
    h.output.output[0]!.text = JSON.stringify({ session_id: -1, output: '' });
  if (kind === 'string-session')
    h.output.output[0]!.text = JSON.stringify({ session_id: '10566', output: '' });
  if (kind === 'missing-session') h.output.output[0]!.text = '{}';
  if (kind === 'already-terminal-output')
    h.output.output[0]!.text = JSON.stringify({ session_id: 10566, exit_code: 0, output: '' });
  if (kind === 'nonliteral-command')
    h.call.input = 'text(await tools.exec_command({cmd:command}));';
  expect(h.settle).toThrow('chat-continuation-late-operation');
});

it('ignores non-receipt output blocks and unrelated later events', () => {
  const h = fixture();
  Object.assign(h.output, {
    output: [null, 'prose', {}, { text: 1 }, { text: 'Script completed' }, ...h.output.output],
  });
  h.records.push(
    { type: 'response_item', payload: { type: 'message' } },
    { type: 'event_msg', payload: { type: 'other' } },
    { type: 'event_msg', payload: { ...h.completion, turn_id: 'other' } },
    {
      type: 'event_msg',
      payload: { type: 'item_completed', turn_id: 'turn', item: { type: 'SubAgentActivity' } },
    },
  );
  expect(h.settle()).toMatchObject({ source: { locator: 'native#L5' }, ids: ['background'] });
});

it('keeps another uncompleted background process pending', () => {
  const h = fixture();
  h.call.input += '\ntext(await tools.exec_command({cmd:"command-b"}));';
  h.output.output.push({ text: JSON.stringify({ session_id: 10567, output: '' }) });
  expect(h.settle).toThrow('chat-continuation-operation-pending');
});

it('rejects a receipt that pairs one command with another command process in the same cell', () => {
  const h = fixture();
  h.call.input += '\ntext(await tools.exec_command({cmd:"command-b"}));';
  h.output.output.push({ text: JSON.stringify({ exit_code: 0, output: '' }) });
  h.item.command[2] = 'command-b';
  expect(h.settle).toThrow('chat-continuation-late-operation');
});

it.each(['first', 'second', 'both', 'poll-before-launch', 'literal-options'])(
  'keeps exact serial command/output pairs: %s',
  (kind) => {
    const h = fixture();
    if (kind === 'poll-before-launch') {
      h.call.input = 'text(await tools.write_stdin({session_id:15066,chars:""}));\n' + h.call.input;
      h.output.output.unshift({ text: JSON.stringify({ exit_code: 0, output: '' }) });
    } else if (kind === 'literal-options') {
      h.call.input =
        'text(await tools.exec_command({"cmd":`yarn validate:brief`,yield_time_ms:1000,tty:false,login:true}));';
    } else {
      h.call.input += '\ntext(await tools.exec_command({cmd:"command-b"}));';
      if (kind === 'second') {
        h.output.output.unshift({ text: JSON.stringify({ exit_code: 0, output: '' }) });
        h.item.command[2] = 'command-b';
      } else if (kind === 'first') {
        h.output.output.push({ text: JSON.stringify({ exit_code: 0, output: '' }) });
      } else {
        h.output.output.push({ text: JSON.stringify({ session_id: 10567, output: '' }) });
        const second = structuredClone(h.records[4]!);
        second.timestamp = new Date(4500).toISOString();
        second.payload = {
          ...h.completion,
          completed_at_ms: 4500,
          item: {
            ...h.item,
            id: 'second',
            process_id: '10567',
            command: ['/bin/zsh', '-lc', 'command-b'],
          },
        };
        h.records.push(second);
      }
    }
    expect(h.settle().ids).toEqual(kind === 'both' ? ['background', 'second'] : ['background']);
  },
);

it.each([
  '',
  'text(await tools.exec_command({cmd:"yarn validate:brief"})',
  'const result = 1;',
  '0;',
  'other.text(await tools.exec_command({cmd:"yarn validate:brief"}));',
  'other(await tools.exec_command({cmd:"yarn validate:brief"}));',
  'text();',
  'text(await tools.exec_command({cmd:"yarn validate:brief"}),1);',
  'text(tools.exec_command({cmd:"yarn validate:brief"}));',
  'text(await 1);',
  'text(await exec_command({cmd:"yarn validate:brief"}));',
  'text(await getTools().exec_command({cmd:"yarn validate:brief"}));',
  'text(await other.exec_command({cmd:"yarn validate:brief"}));',
  'text(await tools.other({cmd:"yarn validate:brief"}));',
  'text(await tools.exec_command());',
  'text(await tools.exec_command({},{}));',
  'text(await tools.exec_command(options));',
  'text(await tools.exec_command({...options,cmd:"yarn validate:brief"}));',
  'text(await tools.exec_command({get cmd(){return "yarn validate:brief"}}));',
  'text(await tools.exec_command({["cmd"]:"yarn validate:brief"}));',
  'text(await tools.exec_command({cmd:"yarn validate:brief",cmd:"different"}));',
  'text(await tools.exec_command({cmd:"yarn validate:brief",workdir:derive()}));',
  'text(await tools.exec_command({cmd:"yarn validate:brief",list:[]}));',
  'text(await tools.exec_command({cmd:"yarn validate:brief",workdir:null}));',
  'text(await tools.exec_command({}));',
  'text(await tools.exec_command({cmd:1}));',
  'text(await tools.exec_command({cmd:`prefix ${value}`}));',
  'text(await tools.write_stdin({}));',
  'text(await tools.write_stdin({session_id:"10566"}));',
  'text(await tools.write_stdin({session_id:1.5}));',
  'text(await tools.write_stdin({session_id:0}));',
])('rejects unsupported or ambiguous code-mode syntax: %s', (input) => {
  const h = fixture();
  h.call.input = input;
  expect(h.settle).toThrow('chat-continuation-late-operation');
});

it.each([
  'duplicate-launch-id',
  'unmatched-poll-id',
  'extra-result',
  'invalid-result',
  'noninteger-exit',
])('rejects inconsistent serial results: %s', (kind) => {
  const h = fixture();
  if (kind === 'duplicate-launch-id') {
    h.call.input += '\ntext(await tools.exec_command({cmd:"command-b"}));';
    h.output.output.push({ text: JSON.stringify({ session_id: 10566, output: '' }) });
  }
  if (kind === 'unmatched-poll-id') {
    h.call.input = 'text(await tools.write_stdin({session_id:15066}));\n' + h.call.input;
    h.output.output.unshift({ text: JSON.stringify({ session_id: 15067, output: '' }) });
  }
  if (kind === 'extra-result')
    h.output.output.push({ text: JSON.stringify({ exit_code: 0, output: '' }) });
  if (kind === 'invalid-result')
    h.output.output[0]!.text = JSON.stringify({ session_id: 10566, output: 1 });
  if (kind === 'noninteger-exit')
    h.output.output[0]!.text = JSON.stringify({ exit_code: 0.5, output: '' });
  expect(h.settle).toThrow('chat-continuation-late-operation');
});

it('requires a terminal receipt when a background process has not yet reported completion', () => {
  const h = fixture();
  h.records.pop();
  expect(h.settle).toThrow('chat-continuation-operation-pending');
});

it('accepts a process already completed before the boundary', () => {
  const h = fixture();
  h.records.splice(3, 0, h.records.pop()!);
  expect(h.settle()).toEqual({
    source: { locator: 'native#L5', hash: contentHash(JSON.stringify(h.records[4]) + '\n') },
    ids: [],
  });
});
