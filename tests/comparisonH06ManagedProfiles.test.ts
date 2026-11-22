import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { verifyH06ManagedProfiles } from './comparisonH06ManagedProfiles.js';

it('matches managed admission turns and effective profiles only within the sealed source', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aw-h06-profiles-'));
  try {
    const transcript = join(root, 'run.jsonl');
    const profile = { model: 'model', effort: 'high', clientVersion: 'version' };
    const admission = { scope: { session: 'session' }, response: { turnId: 'turn' } };
    const rows = [
      { type: 'session_meta', payload: { id: 'session', cli_version: 'version' } },
      { type: 'event_msg', payload: { turn_id: 'turn', type: 'task_started' } },
      { type: 'turn_context', payload: { turn_id: 'turn', model: 'model', effort: 'high' } },
      { type: 'event_msg', payload: { turn_id: 'turn', type: 'task_aborted' } },
    ];
    const lines = rows.map((row) => JSON.stringify(row) + '\n');
    const through = { locator: transcript + '#L4', hash: digest(lines[3]!) };
    writeFileSync(transcript, lines.join('') + '{another upcoming native append');
    const participant = {
      session: 'session',
      transcript,
      run: 'run',
      stage: 'execution' as const,
      through,
    };
    expect(verifyH06ManagedProfiles([participant], [admission], profile)).toEqual([
      { locator: transcript + '#L3', hash: digest(lines[2]!) },
    ]);
    expect(() => verifyH06ManagedProfiles([participant], [], profile)).toThrow(
      'h06-series-managed-turns',
    );
    expect(() =>
      verifyH06ManagedProfiles(
        [participant],
        [admission, { ...admission, response: null }],
        profile,
      ),
    ).toThrow('h06-series-managed-inventory');
    expect(() =>
      verifyH06ManagedProfiles(
        [{ ...participant, through: { ...through, hash: 'bad' } }],
        [admission],
        profile,
      ),
    ).toThrow('h06-series-managed-prefix');
    expect(() =>
      verifyH06ManagedProfiles([participant], [admission], { ...profile, effort: 'changed' }),
    ).toThrow('h06-series-managed-profile');
    expect(() =>
      verifyH06ManagedProfiles([participant], [admission], {
        ...profile,
        clientVersion: 'changed',
      }),
    ).toThrow('h06-series-managed-client');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
