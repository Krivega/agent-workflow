import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { NativeReaderSource } from '../src/adapters/codex/readerAuthority.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import type { H06TemporalCommandChat } from './comparisonH06NativeTemporalDriver.js';

/** Carry the live chat's evidence between tool calls. Operators still verify every primary line. */
export function h06NativeChatRelay(input: Readable, output: Writable) {
  const stream = createInterface({ input, crlfDelay: Infinity });
  const lines = stream[Symbol.asyncIterator]();
  let id = 0;
  let waiting = false;
  async function exchange(kind: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    requireContract(!waiting, 'h06-chat-relay-concurrent');
    waiting = true;
    const turn = ++id;
    const cancel = () => stream.close();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      output.write(JSON.stringify({ kind, id: turn, body }) + '\n');
      const reply = await lines.next();
      signal.throwIfAborted();
      requireContract(reply.done !== true, 'h06-chat-relay-closed');
      const message = object(JSON.parse(reply.value));
      exactFields(message, ['id', 'value']);
      requireContract(message.id === turn, 'h06-chat-relay-out-of-order');
      return message.value;
    } finally {
      signal.removeEventListener('abort', cancel);
      waiting = false;
    }
  }
  const chat: H06TemporalCommandChat = {
    async source(text, signal) {
      return object(
        await exchange('h06-phase-authority', { text }, signal),
      ) as unknown as NativeReaderSource;
    },
    async record(notice, source, signal) {
      const result = await exchange('h06-record-notice', { notice, source }, signal);
      requireContract(result === true, 'h06-chat-relay-notice-unconfirmed');
    },
  };
  return {
    chat,
    exchange,
    attempt: (expectedGrantText: string, signal: AbortSignal) =>
      exchange('h06-attempt-authority', { expectedGrantText }, signal),
    close: () => stream.close(),
  };
}
