import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import type { NativeReaderSource } from '../src/adapters/codex/readerAuthority.js';
import { h06NativeChatRelay } from './comparisonH06NativeChatRelay.js';

const native: NativeReaderSource = {
  schemaVersion: 1,
  kind: 'codex-user-command',
  transcript: '/fixture/transcript.jsonl',
  threadId: 'thread',
  turnId: 'turn',
  user: { line: 2, sha256: 'a'.repeat(64) },
};

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: unknown[] = [];
  output.on('data', (bytes: Buffer) => sent.push(JSON.parse(bytes.toString())));
  const relay = h06NativeChatRelay(input, output);
  const abort = new AbortController();
  const reply = (id: number, value: unknown) => input.write(JSON.stringify({ id, value }) + '\n');
  return { ...relay, input, sent, abort, reply };
}

it('carries distinct attempt, phase and notice messages in order', async () => {
  const f = fixture();
  const { signal } = f.abort;
  const attempt = f.attempt('grant', signal);
  f.reply(1, { authority: 'primary' });
  await expect(attempt).resolves.toEqual({ authority: 'primary' });
  const phase = f.chat.source('pause', signal);
  f.reply(2, native);
  await expect(phase).resolves.toEqual(native);
  const notice = f.chat.record('notice', native, signal);
  f.reply(3, true);
  await notice;
  expect(f.sent).toEqual([
    { kind: 'h06-attempt-authority', id: 1, body: { expectedGrantText: 'grant' } },
    { kind: 'h06-phase-authority', id: 2, body: { text: 'pause' } },
    { kind: 'h06-record-notice', id: 3, body: { notice: 'notice', source: native } },
  ]);
  f.close();
});

it('refuses parallel replies, wrong IDs and a missing notice confirmation', async () => {
  const f = fixture();
  const { signal } = f.abort;
  const phase = f.chat.source('pause', signal);
  await expect(f.attempt('grant', signal)).rejects.toThrow('h06-chat-relay-concurrent');
  f.reply(2, native);
  await expect(phase).rejects.toThrow('h06-chat-relay-out-of-order');
  const notice = f.chat.record('notice', native, signal);
  f.reply(2, false);
  await expect(notice).rejects.toThrow('h06-chat-relay-notice-unconfirmed');
  f.close();
});

it('terminates a pending exchange on EOF or abort', async () => {
  const ended = fixture();
  const pending = ended.attempt('grant', ended.abort.signal);
  ended.input.end();
  await expect(pending).rejects.toThrow('h06-chat-relay-closed');
  ended.close();
  const interrupted = fixture();
  const other = interrupted.attempt('grant', interrupted.abort.signal);
  interrupted.abort.abort(new Error('stop'));
  await expect(other).rejects.toThrow('stop');
  await expect(interrupted.attempt('grant', interrupted.abort.signal)).rejects.toThrow('stop');
  interrupted.close();
});
