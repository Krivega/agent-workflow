import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { checkH06NativeLegacyDispatch } from './comparisonH06NativeLegacyDispatch.js';
import { checkH06NativeUsage } from './comparisonH06NativeUsage.js';

const emptyTotals = { responses: null, inputUncached: null, inputCached: null, output: null };
function record(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(pin).toString()));
}

function readAvailable(path: string) {
  try {
    return h01RawFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

/** Bind transcript coverage to the exact terminal turns observed by dispatch readback. */
export function observeH06NativeLegacyTranscript(
  bytes: Buffer,
  thread: Record<string, unknown>,
  attempt: { thread: string; turns: readonly { turn: string }[]; completed?: boolean },
) {
  const body = bytes.toString('utf8');
  requireContract(Buffer.from(body).equals(bytes), 'h06-legacy-usage-transcript-encoding');
  if (!body.endsWith('\n')) return null;
  const lines = body.slice(0, -1).split('\n');
  const expected = attempt.turns.map(({ turn }) => turn);
  const boundaries: string[] = [];
  let terminal = 0;
  let observed = false;
  for (const line of lines) {
    const entry = object(JSON.parse(line));
    const payload = object(entry.payload);
    if (entry.type === 'session_meta') {
      requireContract(
        !observed &&
          payload.id === attempt.thread &&
          payload.session_id === attempt.thread &&
          payload.cwd === thread.cwd,
        'h06-legacy-usage-transcript-binding',
      );
      observed = true;
    }
    if (entry.type === 'token_usage_record')
      requireContract(
        typeof payload.turn_id === 'string' && payload.turn_id === boundaries.at(-1),
        'h06-legacy-usage-turn-binding',
      );
    if (entry.type !== 'event_msg') continue;
    if (payload.type === 'token_count' && payload.info !== null && boundaries.length === 0)
      return null;
    if (payload.type === 'task_started') {
      requireContract(
        typeof payload.turn_id === 'string' &&
          expected.includes(payload.turn_id) &&
          !boundaries.includes(payload.turn_id),
        'h06-legacy-usage-turn-binding',
      );
      if (terminal !== boundaries.length) return null;
      boundaries.push(payload.turn_id);
    }
    if (
      payload.type === 'task_complete' ||
      payload.type === 'task_aborted' ||
      payload.type === 'turn_aborted'
    ) {
      if (typeof payload.turn_id !== 'string' || payload.turn_id !== boundaries.at(-1)) return null;
      if (
        attempt.completed === true &&
        payload.turn_id === expected.at(-1) &&
        payload.type !== 'task_complete'
      )
        return null;
      requireContract(terminal < boundaries.length, 'h06-legacy-usage-turn-binding');
      terminal++;
    }
  }
  if (!observed || !same(boundaries, expected) || terminal !== expected.length) return null;
  return { line: lines.length, hash: digest(lines.at(-1)! + '\n') };
}

/** Account for the retained Writers. Dispatch evidence does not inventory the parent or readers. */
export function checkH06NativeLegacyAttemptUsage(value: unknown) {
  const request = object(value);
  const phases: ('warm' | 'cold' | 'completion')[] = ['warm', 'cold'];
  if (Object.hasOwn(request, 'completion')) phases.push('completion');
  exactFields(request, ['started', 'database', ...phases]);
  const started = h04Pin(request.started);
  const claim = h04Pin(record(started).claim);
  requireContract(
    claim.path === join(dirname(started.path), 'attempt-claim.json'),
    'h06-legacy-usage-claim',
  );
  const claimed = record(claim);
  const caps = object(object(claimed.request).budget);
  const sessionsRoot = object(claimed.grant).sessionsRoot;
  requireContract(
    typeof sessionsRoot === 'string' && safeDirectory(sessionsRoot) === sessionsRoot,
    'h06-legacy-usage-sessions',
  );
  const budget = {
    maxInputUncached: caps.maxInputUncached as number,
    maxOutput: caps.maxOutput as number,
  };
  const expected: ComparisonParticipant[] = [];
  const participants: ComparisonParticipant[] = [];
  const missing: { phase: (typeof phases)[number]; reason: string }[] = [];
  const observed: { path: string; sha256: string }[] = [];
  let dispatch: ReturnType<typeof checkH06NativeLegacyDispatch> | null;
  try {
    dispatch = checkH06NativeLegacyDispatch(request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    dispatch = null;
  }
  if (dispatch !== null) {
    requireContract(
      dispatch.attempts.length === phases.length,
      'h06-legacy-usage-dispatch-inventory',
    );
    for (const [index, phase] of phases.entries()) {
      const attempt = dispatch.attempts[index]!;
      const thread = object(record(h04Pin(object(request[phase]).thread)).thread);
      const path = thread.path;
      if (path == null) {
        missing.push({ phase, reason: 'transcript-unavailable' });
        continue;
      }
      requireContract(
        thread.id === attempt.thread &&
          typeof path === 'string' &&
          isAbsolute(path) &&
          resolve(path) === path &&
          path.startsWith(join(sessionsRoot, '/')),
        'h06-legacy-usage-transcript-binding',
      );
      const participant = {
        session: attempt.thread,
        transcript: path,
        run: dispatch.operationId,
        stage: 'execution' as const,
      };
      expected.push(participant);
      const bytes = readAvailable(path);
      if (bytes === null) {
        missing.push({ phase, reason: 'transcript-absent' });
        continue;
      }
      const terminal = observeH06NativeLegacyTranscript(bytes, thread, {
        ...attempt,
        completed: phase === 'completion',
      });
      if (terminal === null) {
        missing.push({ phase, reason: 'transcript-incomplete' });
        continue;
      }
      observed.push({ path, sha256: digest(bytes) });
      participants.push({
        ...participant,
        through: { locator: path + '#L' + terminal.line, hash: terminal.hash },
      });
    }
  }
  const usage = checkH06NativeUsage({ expected, participants, budget });
  for (const source of observed)
    requireContract(
      digest(h01RawFile(source.path)) === source.sha256,
      'h06-legacy-usage-transcript-changed',
    );
  readH04Pin(claim);
  const incomplete = dispatch === null || missing.length > 0;
  return {
    status: usage.status === 'OVER_BUDGET' ? 'OVER_BUDGET' : 'UNKNOWN',
    writerUsage: {
      ...usage,
      status: incomplete && usage.status !== 'OVER_BUDGET' ? 'UNKNOWN' : usage.status,
      totals: incomplete ? emptyTotals : usage.totals,
    },
    writerSources: observed,
    missing,
    dispatchStatus: dispatch === null ? 'UNKNOWN' : dispatch.status,
    wholeAttemptComplete: false,
    providerHardCap: false,
  } as const;
}
