import { isDeepStrictEqual as same } from 'node:util';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import { object, requireContract } from '../src/contracts/project.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

export interface H06ManagedProfile {
  model: string;
  effort: string;
  clientVersion: string;
}

/** Count only the admitted native turns and their sealed effective profiles. */
export function verifyH06ManagedProfiles(
  participants: readonly ComparisonParticipant[],
  admissions: readonly { scope: { session: string }; response: { turnId: string } | null }[],
  profile: H06ManagedProfile,
): InputRef[] {
  const evidence: InputRef[] = [];
  let verified = 0;
  for (const { transcript, session, through } of participants) {
    const rows = readH06NativeJournal(transcript).toString().split('\n');
    const index = rows.findIndex((line, offset) =>
      same(through, {
        locator: `${transcript}#L${offset + 1}`,
        hash: digest(line + '\n'),
      }),
    );
    requireContract(through !== undefined && index >= 0, 'h06-series-managed-prefix');
    const expected = admissions.flatMap(({ scope, response }) =>
      scope.session === session && response !== null ? [response.turnId] : [],
    );
    const started: unknown[] = [],
      completed: unknown[] = [],
      contexts: unknown[] = [];
    let sessions = 0;
    for (const [offset, line] of rows.slice(0, index + 1).entries()) {
      const row = object(JSON.parse(line)),
        payload = object(row.payload);
      if (row.type === 'session_meta') {
        requireContract(
          payload.id === session && payload.cli_version === profile.clientVersion,
          'h06-series-managed-client',
        );
        sessions++;
      }
      if (row.type === 'turn_context') {
        requireContract(
          payload.model === profile.model && payload.effort === profile.effort,
          'h06-series-managed-profile',
        );
        contexts.push(payload.turn_id);
        evidence.push({ locator: `${transcript}#L${offset + 1}`, hash: digest(line + '\n') });
      }
      if (row.type === 'event_msg') {
        if (payload.type === 'task_started') started.push(payload.turn_id);
        if (['task_complete', 'task_aborted', 'turn_aborted'].includes(String(payload.type)))
          completed.push(payload.turn_id);
      }
    }
    requireContract(
      sessions === 1 &&
        same(started, expected) &&
        same(completed, expected) &&
        same(contexts, expected) &&
        expected.length > 0,
      'h06-series-managed-turns',
    );
    verified += expected.length;
  }
  requireContract(verified > 0 && verified === admissions.length, 'h06-series-managed-inventory');
  return evidence;
}
