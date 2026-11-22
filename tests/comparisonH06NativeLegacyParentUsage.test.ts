import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { ChatObservation } from '../core/currentChat.js';
import {
  captureH06NativeLegacyParentStart,
  checkH06NativeLegacyParentUsage,
} from './comparisonH06NativeLegacyParentUsage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-parent-usage-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  mkdirSync(sessionsRoot);
  const transcript = join(sessionsRoot, 'actor.jsonl');
  const actor = 'actor';
  const workspace = join(root, 'workspace');
  const context = { task_id: 'operation', actor_id: actor };
  const storeRoot = join(root, 'legacy-store');
  const json = (name: string, value: unknown) => {
    const path = join(root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const claim = json('attempt-claim.json', {
    kind: 'h06-native-attempt-claim',
    request: { binding: { workspaceRoot: workspace } },
    grant: { sessionsRoot },
  });
  const initial = {
    kind: 'h06-native-legacy-operator-start',
    claim,
    context,
    storeRoot,
    generation: 1,
  };
  const started = json('legacy-operator-start.json', initial);
  const event = (type: string, turn_id: string) => ({
    type: 'event_msg',
    payload: { type, turn_id },
  });
  const ctx = (turn_id: string) => ({ type: 'turn_context', payload: { turn_id } });
  const counts = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
    input_tokens,
    cached_input_tokens,
    output_tokens,
  });
  const usage = (turn_id: string, n: number) => ({
    type: 'token_usage_record',
    payload: {
      turn_id,
      thread_id: actor,
      session_id: actor,
      response_id: turn_id,
      usage: counts(10, 3, 2),
      thread_token_usage: counts(10 * n, 3 * n, 2 * n),
    },
  });
  const prefix: unknown[] = [
    { type: 'session_meta', payload: { id: actor, session_id: actor, cwd: workspace } },
    event('task_started', 'earlier'),
    ctx('earlier'),
    usage('earlier', 1),
    event('task_complete', 'earlier'),
  ];
  const future = [
    event('task_started', 'next'),
    ctx('next'),
    usage('next', 3),
    event('task_complete', 'next'),
  ];
  const final = [
    event('task_started', 'cold'),
    ctx('cold'),
    usage('cold', 2),
    event('task_complete', 'cold'),
  ];
  const write = (rows: unknown[], complete = true) =>
    writeFileSync(
      transcript,
      rows.map((row) => JSON.stringify(row)).join('\n') + (complete ? '\n' : ''),
    );
  const source = (index: number, row: unknown) => ({
    locator: transcript + '#L' + (index + 1),
    hash: digest(JSON.stringify(row) + '\n'),
  });
  write(prefix);
  const parent = captureH06NativeLegacyParentStart(claim, transcript, {
    thread_id: actor,
    workspace,
    source: source(2, prefix[2]),
  } as ChatObservation);
  const cold = {
    kind: 'h06-native-legacy-resume',
    phase: 'cold',
    identity: { workspace, store: storeRoot, evidence: root, context, generation: 1 },
    control: {
      observed: {
        thread_id: actor,
        workspace,
        turn_id: 'cold',
        source: source(prefix.length + 1, final[1]),
      },
    },
  };
  const coldResume = json('legacy-cold-resume.json', cold);
  write([...prefix, ...final, ...future]);
  return {
    root,
    claim,
    input: { started, parent, coldResume },
    json,
    initial,
    cold,
    transcript,
    prefix,
    final,
    future,
    write,
    event,
  };
}

it('counts only the append-only parent window through the verified cold terminal turn', () => {
  const f = fixture();
  expect(checkH06NativeLegacyParentUsage(f.input)).toMatchObject({
    status: 'RECORDED',
    knownSubtotal: { responses: 1, inputUncached: 7, inputCached: 3, output: 2 },
    through: { locator: f.transcript + '#L9' },
    qualification: false,
  });
  f.write([...f.prefix, ...f.final]);
  expect(checkH06NativeLegacyParentUsage(f.input)).toMatchObject({ status: 'RECORDED' });
});

it.each(['terminal', 'usage'] as const)('keeps missing %s unknown', (missing) => {
  const f = fixture();
  const final = f.final.filter((_, index) => index !== (missing === 'terminal' ? 3 : 2));
  f.write([...f.prefix, ...final]);
  expect(checkH06NativeLegacyParentUsage(f.input)).toMatchObject({ status: 'UNKNOWN' });
});

it.each([
  'start-path',
  'parent-path',
  'cold-path',
  'start-kind',
  'parent-kind',
  'cold-kind',
  'phase',
  'claim',
  'actor',
  'workspace',
  'transcript',
  'identity',
  'final-actor',
  'final-workspace',
  'prefix',
  'partial',
  'source',
  'duplicate',
  'wrong-turn',
] as const)('rejects a changed or crossed primary record (%s)', (which) => {
  const f = fixture();
  const parent = JSON.parse(readFileSync(f.input.parent.path, 'utf8')) as Record<string, unknown>;
  if (which === 'start-kind') f.initial.kind = 'other';
  if (which === 'parent-kind') parent.kind = 'other';
  if (which === 'cold-kind') f.cold.kind = 'other';
  if (which === 'phase') f.cold.phase = 'warm';
  if (which === 'claim') parent.claim = { ...f.claim, sha256: digest('other') };
  if (which === 'actor') parent.actor = 'other';
  if (which === 'workspace') parent.workspace = '/other';
  if (which === 'transcript') parent.transcript = '/elsewhere.jsonl';
  if (which === 'identity') f.cold.identity.generation++;
  if (which === 'final-actor') f.cold.control.observed.thread_id = 'other';
  if (which === 'final-workspace') f.cold.control.observed.workspace = '/other';
  if (which === 'prefix')
    f.write([{ type: 'session_meta', payload: {} }, ...f.prefix.slice(1), ...f.final]);
  if (which === 'partial') f.write([...f.prefix, ...f.final], false);
  if (which === 'source') f.cold.control.observed.source.hash = digest('wrong');
  if (which === 'duplicate') f.write([...f.prefix, ...f.final, f.event('task_complete', 'cold')]);
  if (which === 'wrong-turn') f.cold.control.observed.turn_id = 'other';
  f.input.started = f.json(
    which === 'start-path' ? 'other-start.json' : 'legacy-operator-start.json',
    f.initial,
  );
  f.input.parent = f.json(
    which === 'parent-path' ? 'other-parent.json' : 'legacy-parent-usage-start.json',
    parent,
  );
  f.input.coldResume = f.json(
    which === 'cold-path' ? 'other-cold.json' : 'legacy-cold-resume.json',
    f.cold,
  );
  expect(() => checkH06NativeLegacyParentUsage(f.input)).toThrow();
});
