import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { readH06DelegatedAuthority } from './comparisonH06DelegatedAuthority.js';
import {
  observeH06DelegatedUsage,
  type H06DelegatedUsageInput,
} from './comparisonH06DelegatedUsage.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import * as NativeJournal from './comparisonH06NativeJournal.js';

vi.mock('./comparisonH06DelegatedAuthority.js', () => ({ readH06DelegatedAuthority: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(inputTokens = 10, pending = false) {
  const top = mkdtempSync(join(realpathSync(tmpdir()), 'h06-delegated-usage-'));
  roots.push(top);
  const evidenceRoot = join(top, 'evidence'),
    sessionsRoot = join(top, 'sessions');
  mkdirSync(evidenceRoot);
  mkdirSync(sessionsRoot);
  const pin = (path: string, value: unknown): H04Pin => {
    const bytes = canonical(value) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const budget = {
    maxElapsedMs: 60000,
    reserveMs: 10000,
    maxManagedStarts: 24,
    maxInputUncached: 100,
    maxOutput: 30,
  };
  const startedAt = Date.now(),
    stopDeadlineMs = startedAt + budget.maxElapsedMs,
    workDeadlineMs = stopDeadlineMs - budget.reserveMs;
  const receipt = pin(join(evidenceRoot, 'delegated-claim.json'), { startedAt });
  const claim = {
    receipt,
    request: { binding: { variant: 'legacy', operationId: 'example' }, evidenceRoot, budget },
    grant: { sessionsRoot },
    startedAt,
    stopDeadlineMs,
    workDeadlineMs,
  };
  vi.mocked(readH06DelegatedAuthority).mockReturnValue(
    claim as unknown as ReturnType<typeof readH06DelegatedAuthority>,
  );
  const ledger = openH06NativeTurnLedger(join(evidenceRoot, 'legacy-turns'), {
    mode: 'create',
    operationId: 'example',
    legacy: true,
    maxManagedStarts: 24,
  });
  const threads: H04Pin[] = [],
    snapshots: Record<string, unknown>[] = [],
    transcripts: string[] = [];
  let count = 0;
  for (const phase of ['warm', 'cold', 'completion']) {
    const root = join(evidenceRoot, 'coder-workspaces', phase),
      journal = join(evidenceRoot, 'coders', phase, 'transport.jsonl');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(evidenceRoot, 'coders', phase), { recursive: true });
    const session = phase + '-session',
      transcript = join(sessionsRoot, phase + '.jsonl'),
      turns: { id: string }[] = [];
    const records: unknown[] = [
      { type: 'session_meta', payload: { id: session, session_id: session, cwd: root } },
    ];
    let cumulative = 0;
    for (const stage of ['profile', 'load', 'implementation']) {
      const turnId = phase + '-' + stage,
        turn = {
          role: 'legacy-writer' as const,
          root,
          journal,
          session,
          params: {
            threadId: session,
            input: [
              { type: 'text', text: `Workflow delivery id: "coder:${phase}:${stage}"\nfixture` },
            ],
          },
        };
      await ledger.admitTurn(turn, count++);
      if (!(pending && count === 9))
        await ledger.recordTurn({ ...turn, turnId, response: { turn: { id: turnId } } });
      turns.push({ id: turnId });
      cumulative++;
      records.push(
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
        {
          type: 'token_usage_record',
          payload: {
            session_id: session,
            thread_id: session,
            turn_id: turnId,
            response_id: turnId + '-response',
            usage: { input_tokens: inputTokens, cached_input_tokens: 2, output_tokens: 2 },
            thread_token_usage: {
              input_tokens: inputTokens * cumulative,
              cached_input_tokens: 2 * cumulative,
              output_tokens: 2 * cumulative,
            },
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
      );
    }
    writeFileSync(transcript, records.map(canonical).join('\n') + '\n');
    const response = { thread: { id: session, cwd: root, path: transcript, turns } };
    snapshots.push(response);
    transcripts.push(transcript);
    threads.push(pin(join(evidenceRoot, `delegated-${phase}-writer-thread.json`), response));
  }
  const value: H06DelegatedUsageInput = {
    claim: receipt,
    threads: threads as H06DelegatedUsageInput['threads'],
  };
  return {
    claim,
    value,
    snapshots,
    transcripts,
    pin,
    ledger,
    rewrite(index = 0) {
      value.threads[index] = pin(value.threads[index]!.path, snapshots[index]);
    },
  };
}

it('reopens all nine retained native managed turns and accounts only for the three Writers', async () => {
  const f = await fixture(),
    result = await observeH06DelegatedUsage(f.value);
  expect(result).toMatchObject({
    kind: 'h06-delegated-managed-usage/1',
    status: 'WITHIN_BUDGET',
    knownSubtotal: { inputUncached: 72, output: 18 },
    caps: f.claim.request.budget,
    ledger: { used: 9, status: 'RECORDED' },
    providerHardCap: false,
    wholeAttemptComplete: false,
    qualification: false,
  });
  expect(result.nativeSources.map((s) => s.transcript)).toEqual(f.transcripts);
  expect(f.ledger.inspect().used).toBe(9);
});
it('detects an overrun caused by the final managed Writer without starting another turn', async () => {
  const f = await fixture(30);
  expect(await observeH06DelegatedUsage(f.value)).toMatchObject({
    status: 'OVER_BUDGET',
    knownSubtotal: { inputUncached: 252, output: 18 },
  });
  expect(f.ledger.inspect().used).toBe(9);
});

it.each(['complete', 'partial'] as const)(
  'keeps pinned usage while a native journal appends a %s record',
  async (kind) => {
    const f = await fixture(),
      read = NativeJournal.readH06NativeJournal;
    let appended = false;
    vi.spyOn(NativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
      const bytes = read(path);
      if (path === f.transcripts[0] && !appended) {
        appended = true;
        const addition =
          kind === 'complete'
            ? canonical({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n'
            : '{"type":"event_msg"';
        writeFileSync(path, Buffer.concat([bytes, Buffer.from(addition)]));
      }
      return bytes;
    });
    expect(await observeH06DelegatedUsage(f.value)).toMatchObject({
      status: 'WITHIN_BUDGET',
      knownSubtotal: { inputUncached: 72, output: 18 },
    });
    expect(appended).toBe(true);
    expect(f.ledger.inspect().used).toBe(9);
  },
);

it('keeps accounting UNKNOWN when an already observed native prefix changes', async () => {
  const f = await fixture(),
    read = NativeJournal.readH06NativeJournal;
  let changed = false;
  vi.spyOn(NativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
    const bytes = read(path);
    if (path === f.transcripts[0] && !changed) {
      changed = true;
      writeFileSync(path, ' ' + bytes.toString());
    }
    return bytes;
  });
  expect(await observeH06DelegatedUsage(f.value)).toMatchObject({
    status: 'UNKNOWN',
    wholeAttemptComplete: false,
  });
  expect(changed).toBe(true);
  expect(f.ledger.inspect().used).toBe(9);
});
it.each(['missing', 'partial', 'pending'] as const)(
  'keeps %s native accounting UNKNOWN',
  async (kind) => {
    const f = await fixture(10, kind === 'pending');
    if (kind === 'missing') unlinkSync(f.transcripts[2]!);
    if (kind === 'partial')
      writeFileSync(f.transcripts[2]!, readFileSync(f.transcripts[2]!).subarray(0, -1));
    expect(await observeH06DelegatedUsage(f.value)).toMatchObject({
      status: 'UNKNOWN',
      wholeAttemptComplete: false,
    });
  },
);
it.each([
  'inventory',
  'path',
  'duplicate',
  'session',
  'cwd',
  'native-path',
  'turns',
  'turn-id',
  'stale-pin',
] as const)('rejects changed %s identity instead of attributing another Writer', async (kind) => {
  const f = await fixture(),
    thread = f.snapshots[0]!.thread as Record<string, unknown>;
  if (kind === 'inventory') f.value.threads.pop();
  if (kind === 'path')
    f.value.threads[0] = f.pin(join(f.claim.request.evidenceRoot, 'other.json'), f.snapshots[0]);
  if (kind === 'duplicate') f.snapshots[1] = f.snapshots[0]!;
  if (kind === 'session') thread.id = 'other';
  if (kind === 'cwd') thread.cwd += '-other';
  if (kind === 'native-path') thread.path = '/outside/native.jsonl';
  if (kind === 'turns') thread.turns = [];
  if (kind === 'turn-id') thread.turns = [{ id: 'other' }, { id: 'other' }, { id: 'other' }];
  if (kind === 'stale-pin') writeFileSync(f.value.threads[0].path, 'changed');
  else if (!['inventory', 'path'].includes(kind)) f.rewrite(kind === 'duplicate' ? 1 : 0);
  await expect(observeH06DelegatedUsage(f.value)).rejects.toThrow();
});
