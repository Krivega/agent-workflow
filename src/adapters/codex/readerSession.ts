import { object, requireContract, text } from '../../contracts/project.js';

export function readerSession(
  response: unknown,
  workspace: string,
  profile: { model: string; effort: string },
  expectedId?: string,
) {
  const raw = object(response),
    thread = object(raw.thread),
    sandbox = object(raw.sandbox);
  requireContract(
    raw.cwd === workspace &&
      raw.model === profile.model &&
      raw.reasoningEffort === profile.effort &&
      raw.approvalPolicy === 'never' &&
      sandbox.type === 'readOnly' &&
      sandbox.networkAccess === false &&
      thread.forkedFromId === null &&
      thread.projectId === null &&
      thread.parentThreadId === null &&
      (expectedId === undefined || thread.id === expectedId),
    'reader-session-mismatch',
  );
  requireContract(Array.isArray(thread.turns), 'reader-history-unknown');
  return { raw, thread, id: text(thread.id) };
}
