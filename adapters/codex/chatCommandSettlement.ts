import ts from 'typescript';
import { object, requireWorkflow } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';

interface NativeRecord {
  record: Record<string, unknown>;
  ref: InputRef;
}

type Invocation = { command: string } | { process: string };

export function serialInvocations(input: string): Invocation[] | null {
  const diagnostics: ts.Diagnostic[] = [];
  ts.transpile(
    input,
    { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    'native.ts',
    diagnostics,
  );
  if (diagnostics.length > 0) return null;
  const file = ts.createSourceFile(
    'native.js',
    input,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const result: Invocation[] = [];
  // shortcut: only direct serial text(await tools.*(...)) calls have an observed output order.
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement)) return null;
    const text = statement.expression;
    if (
      !ts.isCallExpression(text) ||
      !ts.isIdentifier(text.expression) ||
      text.expression.text !== 'text' ||
      text.arguments.length !== 1
    )
      return null;
    const awaited = text.arguments[0]!;
    if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
    const call = awaited.expression;
    const target = call.expression;
    if (
      !ts.isPropertyAccessExpression(target) ||
      !ts.isIdentifier(target.expression) ||
      target.expression.text !== 'tools' ||
      !['exec_command', 'write_stdin'].includes(target.name.text) ||
      call.arguments.length !== 1
    )
      return null;
    const argument = call.arguments[0]!;
    if (!ts.isObjectLiteralExpression(argument)) return null;
    const fields = new Map<string, ts.Expression>();
    for (const property of argument.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        return null;
      const name = property.name.text;
      if (fields.has(name)) return null;
      const value = property.initializer;
      if (
        !ts.isStringLiteralLike(value) &&
        !ts.isNumericLiteral(value) &&
        ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)
      )
        return null;
      fields.set(name, value);
    }
    const value = fields.get(target.name.text === 'exec_command' ? 'cmd' : 'session_id');
    if (target.name.text === 'exec_command') {
      if (value === undefined || !ts.isStringLiteralLike(value)) return null;
      result.push({ command: value.text });
    } else {
      if (
        value === undefined ||
        !ts.isNumericLiteral(value) ||
        !Number.isSafeInteger(Number(value.text)) ||
        Number(value.text) <= 0
      )
        return null;
      result.push({ process: String(Number(value.text)) });
    }
  }
  return result;
}

export function observedLaunches(records: NativeRecord[]): Map<string, string | null> {
  const calls = new Map<string, string>();
  const launches = new Map<string, string | null>();
  const assigned = new Set<string>();
  for (const { record } of records) {
    if (record.type !== 'response_item') continue;
    const payload = object(record.payload);
    if (
      payload.type === 'custom_tool_call' &&
      payload.name === 'exec' &&
      typeof payload.input === 'string'
    )
      calls.set(String(payload.call_id), payload.input);
    if (payload.type !== 'custom_tool_call_output' || !Array.isArray(payload.output)) continue;
    const input = calls.get(String(payload.call_id));
    if (input === undefined) continue;
    const outputs: Record<string, unknown>[] = [];
    for (const value of payload.output) {
      const block: unknown = value;
      if (
        typeof block !== 'object' ||
        block === null ||
        !('text' in block) ||
        typeof block.text !== 'string'
      )
        continue;
      try {
        const output = object(JSON.parse(block.text) as unknown);
        if (typeof output.output !== 'string') continue;
        const pending =
          Number.isSafeInteger(output.session_id) &&
          Number(output.session_id) > 0 &&
          output.exit_code === undefined;
        const terminal = Number.isInteger(output.exit_code) && output.session_id === undefined;
        if (!pending && !terminal) continue;
        outputs.push(output);
        if (pending && !launches.has(String(output.session_id)))
          launches.set(String(output.session_id), null);
      } catch {
        // A code-mode output also contains prose and unrelated command results.
      }
    }
    const invocations = serialInvocations(input);
    if (invocations === null || invocations.length !== outputs.length) continue;
    if (
      invocations.some(
        (invocation, i) =>
          'process' in invocation &&
          outputs[i]!.session_id !== undefined &&
          String(outputs[i]!.session_id) !== invocation.process,
      )
    )
      continue;
    for (const [i, invocation] of invocations.entries()) {
      const output = outputs[i]!;
      if (!('command' in invocation) || output.session_id === undefined) continue;
      const process = String(output.session_id);
      launches.set(process, assigned.has(process) ? null : invocation.command);
      assigned.add(process);
    }
  }
  return launches;
}

export function lateCommandSettlement(
  records: NativeRecord[],
  start: number,
  end: number,
  thread: string,
  turn: string,
  workspace: string,
): { source: InputRef; ids: string[] } {
  let source = records[end]!.ref;
  const ids = new Set<string>();
  const processes = new Set<string>();
  const prior = records.slice(start + 1, end);
  const launches = observedLaunches(prior);
  const completed = new Set(
    prior
      .filter(
        ({ record }) =>
          record.type === 'event_msg' && object(record.payload).type === 'item_completed',
      )
      .map(({ record }) => object(object(record.payload).item).id),
  );
  const settled = new Set(
    prior
      .filter(
        ({ record }) =>
          record.type === 'event_msg' &&
          object(record.payload).type === 'item_completed' &&
          object(object(record.payload).item).type === 'CommandExecution',
      )
      .map(({ record }) => object(object(record.payload).item).process_id),
  );
  for (const entry of records.slice(end + 1)) {
    if (entry.record.type !== 'event_msg') continue;
    const payload = object(entry.record.payload);
    if (
      payload.turn_id !== turn ||
      !['item_started', 'item_completed'].includes(String(payload.type))
    )
      continue;
    const item = object(payload.item);
    if (payload.type === 'item_completed' && item.type === 'SubAgentActivity') continue;
    const command = item.command;
    requireWorkflow(
      payload.type === 'item_completed' &&
        payload.thread_id === thread &&
        item.type === 'CommandExecution' &&
        item.source === 'unified_exec_startup' &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        !completed.has(item.id) &&
        !ids.has(item.id) &&
        typeof item.process_id === 'string' &&
        /^[1-9]\d*$/u.test(item.process_id) &&
        !processes.has(item.process_id) &&
        Array.isArray(command) &&
        command.length === 3 &&
        command.every((part) => typeof part === 'string' && part.length > 0) &&
        (command[1] === '-lc' || command[1] === '-c') &&
        (item.cwd === workspace || item.cwd === 'file://' + workspace) &&
        (item.status === 'completed' || item.status === 'failed') &&
        Number.isInteger(item.exit_code) &&
        Number.isSafeInteger(payload.started_at_ms) &&
        Number.isSafeInteger(payload.completed_at_ms) &&
        Number(payload.started_at_ms) >= Date.parse(String(records[start]!.record.timestamp)) &&
        Number(payload.started_at_ms) < Date.parse(String(records[end]!.record.timestamp)) &&
        Number(payload.completed_at_ms) >= Date.parse(String(records[end]!.record.timestamp)) &&
        payload.completed_at_ms === Date.parse(String(entry.record.timestamp)) &&
        launches.has(item.process_id) &&
        launches.get(item.process_id) === command[2],
      'chat-continuation-late-operation',
    );
    ids.add(item.id);
    processes.add(item.process_id);
    settled.add(item.process_id);
    source = entry.ref;
  }
  requireWorkflow(
    [...launches.keys()].every((process) => settled.has(process)),
    'chat-continuation-operation-pending',
  );
  return { source, ids: [...ids] };
}
