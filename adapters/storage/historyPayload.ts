import { gunzipSync } from 'node:zlib';
import { requireWorkflow, textField } from '../../core/connection.js';

export const historyEncoding = 'agent-workflow:gzip-history:';
export const legacyHistoryPrefix = `${historyEncoding}1:`;
export const historyPrefix = `${historyEncoding}2:`;

export function decodeHistoryPayload(payload: string): string {
  if (!payload.startsWith(historyEncoding)) return payload;
  const legacy = payload.startsWith(legacyHistoryPrefix);
  requireWorkflow(legacy || payload.startsWith(historyPrefix), 'unsupported-history-payload');
  try {
    const prefix = legacy ? legacyHistoryPrefix : historyPrefix;
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      gunzipSync(Buffer.from(payload.slice(prefix.length), 'base64'), {
        maxOutputLength: 1_073_741_824,
      }),
    );
    return textField(legacy ? decoded : JSON.parse(decoded));
  } catch {
    throw new Error('workflow-history-corrupt');
  }
}
