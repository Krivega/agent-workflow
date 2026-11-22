import { readPrivateFile } from '../storage/storeFiles.js';
import { readChatArtifact } from '../storage/sharedArtifacts.js';
import type { InputRef } from '../../core/localRun.js';
import { object } from '../../core/connection.js';
import { readDeliveryReceipt } from './transportJournal.js';

export async function rejectedSend(journal: string, session: string, delivery: string) {
  const receipt = readDeliveryReceipt(journal, session, delivery);
  let content: string;
  try {
    content = readPrivateFile(journal).toString('utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') content = '';
    else throw error;
  }
  const marker = `Workflow delivery id: ${JSON.stringify(delivery)}\n`;
  const attempts: {
    request: Record<string, unknown>;
    responses: Record<string, unknown>[];
  }[] = [];
  const pending = new Map<number, (typeof attempts)[number]>();
  for (const line of content.trim().split('\n').filter(Boolean)) {
    const record = object(JSON.parse(line) as unknown);
    if (record.direction !== 'send' && record.direction !== 'recv') continue;
    const data = object(
      record.data_ref === undefined ? record.data : readChatArtifact(record.data_ref as InputRef),
    );
    if (typeof data.id !== 'number') continue;
    if (record.direction === 'send') {
      pending.delete(data.id);
      if (data.method !== 'turn/start') continue;
      const params = object(data.params);
      if (params.threadId !== session || !Array.isArray(params.input)) continue;
      if (
        !params.input
          .map(object)
          .some(
            (part) =>
              part.type === 'text' && typeof part.text === 'string' && part.text.startsWith(marker),
          )
      )
        continue;
      const attempt = { request: data, responses: [] as Record<string, unknown>[] };
      attempts.push(attempt);
      pending.set(data.id, attempt);
    } else pending.get(data.id)?.responses.push(data);
  }
  if (receipt !== null)
    return attempts.length === 0 &&
      receipt.attempts === 1 &&
      receipt.responses === 1 &&
      receipt.outcome === 'rejected' &&
      receipt.error_code === -32602 &&
      receipt.input_error_code === 'input_too_large'
      ? { journal, receipt }
      : null;
  if (attempts.length !== 1 || attempts[0]!.responses.length !== 1) return null;
  const { request, responses } = attempts[0]!;
  const response = responses[0]!;
  if ('result' in response || response.error === undefined) return null;
  const error = object(response.error);
  if (error.code !== -32602 || error.data === undefined) return null;
  if (object(error.data).input_error_code !== 'input_too_large') return null;
  return { journal, request, response };
}
