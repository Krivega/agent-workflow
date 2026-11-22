import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { contentHash } from '../project/projectFiles.js';
import { FileCurrentChatHost } from './currentChatHost.js';
import type { InputRef } from '../../core/localRun.js';

import {
  comparisonDesktopRequestRows,
  comparisonDesktopVersion,
} from '../../src/adapters/codex/nativeDesktopUser.js';
export async function discoverChat(
  root: string,
  sessions: string,
  thread: string,
  previous?: { source: InputRef; turn_id: string },
  comparisonSource = false,
) {
  requireWorkflow(/^[a-zA-Z0-9-]+$/u.test(thread), 'invalid-chat-thread');
  const matches: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(`-${thread}.jsonl`)) matches.push(path);
    }
  }
  await visit(sessions);
  requireWorkflow(matches.length === 1, 'chat-transcript-not-unique');
  const transcript = matches[0]!;
  const bytes = await readFile(transcript, 'utf8');
  requireWorkflow(bytes.endsWith('\n'), 'chat-transcript-partial');
  const lines = bytes.slice(0, -1).split('\n');
  const records = lines.map((line) => object(JSON.parse(line) as unknown));
  const context = [...records].reverse().find((r) => r.type === 'turn_context');
  requireWorkflow(context !== undefined, 'chat-context-missing');
  const anchor = {
    thread_id: thread,
    turn_id: textField(object(context.payload).turn_id),
    workspace: await realpath(root),
    host_id: 'local' as const,
  };
  const host = new FileCurrentChatHost(root, transcript, anchor, null, false, comparisonSource);
  const observed = await host.observe();
  let turn = '',
    source: { locator: string; hash: string } | null = null;
  const indexed = records.map((record, index) => ({ record, index }));
  for (const { index, record } of comparisonSource &&
  observed.client_version === comparisonDesktopVersion
    ? comparisonDesktopRequestRows(indexed)
    : indexed) {
    const payload = object(record.payload);
    if (record.type === 'event_msg' && payload.type === 'task_started')
      turn = textField(payload.turn_id);
    if (
      turn !== anchor.turn_id ||
      record.type !== 'response_item' ||
      payload.type !== 'message' ||
      payload.role !== 'user' ||
      !Array.isArray(payload.content)
    )
      continue;
    const text = payload.content
      .map((c) => object(c).text)
      .filter((t) => typeof t === 'string')
      .join('\n');
    if (
      text.trim() &&
      !text.startsWith('<external_codex_apps_open_page>') &&
      !text.startsWith('<skill>')
    )
      source = { locator: `${transcript}#L${index + 1}`, hash: contentHash(lines[index]! + '\n') };
  }
  const inherited = source === null ? previous : undefined;
  source ??= inherited?.source ?? null;
  requireWorkflow(source !== null, 'chat-human-message-required');
  await host.message(source, inherited?.turn_id);
  return {
    transcript,
    anchor,
    observed,
    human_source: source,
    host,
    previous_source_turn: inherited?.turn_id,
  };
}
