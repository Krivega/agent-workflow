import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { encodeChatArtifact, encodeProofArtifact } from '../adapters/storage/sharedArtifacts.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { checkH06NativeLegacyCouncilUsage } from './comparisonH06NativeLegacyCouncilUsage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-council-usage-'));
  roots.push(root);
  const council = join(root, 'council');
  const sessions = join(root, 'sessions');
  for (const path of [council, sessions]) mkdirSync(path);
  const workspace = join(root, 'workspace');
  const write = (path: string, bytes: string | Buffer) => {
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const json = (path: string, value: unknown) => write(join(root, path), JSON.stringify(value));
  const claim = {
    kind: 'h06-native-attempt-claim',
    request: {
      binding: { operationId: 'task', variant: 'legacy', workspaceRoot: workspace },
      evidenceRoot: root,
      budget: { maxInputUncached: 10, maxOutput: 20 },
    },
    grant: { sessionsRoot: sessions },
  };
  const start = {
    kind: 'h06-native-legacy-operator-start',
    claim: json('attempt-claim.json', claim),
    context: { run_id: 'run', task_id: 'task', actor_id: 'actor', project_id: 'project' },
  };
  const intent = {
    role: 'architect',
    parent_run: 'run',
    profile: { model: 'astra', effort: 'medium' },
  };
  const primary = {
    operation: 'thread/start',
    parent: null as unknown,
    session: {
      thread: { id: 'adviser', cwd: workspace, turns: [] as unknown[] },
      cwd: workspace,
      model: 'astra',
      reasoningEffort: 'medium',
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
    },
  };
  const progress = {
    session: {
      id: 'adviser',
      workspace,
      project_id: 'project',
      receipt: { locator: '', hash: '' },
    },
    run: {
      spec: {
        role: 'council-adviser',
        parent_run_id: 'run',
        run_id: 'run-architect',
        session_id: 'adviser',
        workspace,
      },
    },
  };
  const counts = { input_tokens: 13, cached_input_tokens: 2, output_tokens: 3 };
  const meta = { type: 'session_meta', payload: { id: 'adviser', cwd: workspace } };
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'token_usage_record',
      payload: {
        thread_id: 'adviser',
        session_id: 'adviser',
        response_id: 'response',
        turn_id: 'turn',
        usage: counts,
        thread_token_usage: counts,
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ];
  function material() {
    const proof = encodeProofArtifact(council, primary);
    const receipt = write(join(council, `adviser.json.${digest(proof)}`), proof);
    progress.session.receipt = { locator: receipt.path, hash: receipt.sha256 };
    return {
      started: json('legacy-operator-start.json', start),
      roles: [
        {
          intent: write(
            join(council, 'create-architect.json'),
            encodeChatArtifact(council, intent),
          ),
          progress: write(join(council, 'architect.json'), encodeChatArtifact(council, progress)),
          transcript: write(
            join(sessions, 'adviser.jsonl'),
            [meta, ...lines].map((row) => JSON.stringify(row)).join('\n') + '\n',
          ),
        },
      ],
    };
  }
  return { root, start, intent, primary, progress, meta, material, write };
}

it('accounts for the pinned council transcript, preserving proved overspend', () => {
  const input = fixture().material();
  expect(checkH06NativeLegacyCouncilUsage(input)).toMatchObject({
    qualification: false,
    councilUsage: {
      status: 'OVER_BUDGET',
      wholeAttemptComplete: false,
      knownSubtotal: { responses: 1, inputUncached: 11, inputCached: 2, output: 3 },
      receipts: [{ participant: 'adviser', stage: 'council', run: 'run' }],
    },
  });
  expect(checkH06NativeLegacyCouncilUsage({ ...input, roles: [] }).councilUsage.status).toBe(
    'UNKNOWN',
  );
  expect(() => checkH06NativeLegacyCouncilUsage({ ...input, roles: 'unknown' })).toThrow(
    'h06-legacy-council-roles',
  );
});

const mismatches: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'attempt',
    (f) => {
      f.start.context.task_id = 'other';
    },
  ],
  [
    'role',
    (f) => {
      f.intent.parent_run = 'other';
    },
  ],
  [
    'role',
    (f) => {
      f.intent.role = 'not-a-role';
    },
  ],
  [
    'session',
    (f) => {
      f.start.context.actor_id = 'adviser';
    },
  ],
  [
    'session',
    (f) => {
      f.progress.session.project_id = 'other';
    },
  ],
  [
    'session',
    (f) => {
      f.progress.run.spec.session_id = 'other';
    },
  ],
  [
    'session',
    (f) => {
      f.primary.operation = 'thread/resume';
    },
  ],
  [
    'session',
    (f) => {
      f.primary.session.sandbox.networkAccess = true;
    },
  ],
  [
    'transcript',
    (f) => {
      f.meta.payload.cwd = '/foreign';
    },
  ],
];

it.each(mismatches)('rejects mismatched %s evidence', (code, change) => {
  const f = fixture();
  change(f);
  expect(() => checkH06NativeLegacyCouncilUsage(f.material())).toThrow(
    `h06-legacy-council-${code}`,
  );
});

it('rejects a foreign, changed or incomplete transcript', () => {
  const f = fixture();
  const input = f.material();
  const row = input.roles[0]!;
  const foreign = f.write(join(f.root, 'foreign.jsonl'), '{}\n');
  expect(() =>
    checkH06NativeLegacyCouncilUsage({ ...input, roles: [{ ...row, transcript: foreign }] }),
  ).toThrow('h06-legacy-council-transcript');
  const partial = f.write(row.transcript.path, '{}');
  expect(() => checkH06NativeLegacyCouncilUsage(input)).toThrow('h04-pin-changed');
  expect(() =>
    checkH06NativeLegacyCouncilUsage({ ...input, roles: [{ ...row, transcript: partial }] }),
  ).toThrow('h06-legacy-council-transcript');
  const invalidUtf8 = f.write(row.transcript.path, Buffer.from([0xff, 0x0a]));
  expect(() =>
    checkH06NativeLegacyCouncilUsage({ ...input, roles: [{ ...row, transcript: invalidUtf8 }] }),
  ).toThrow('h06-legacy-council-transcript');
});

it('rejects a creation intent or raw receipt outside the attempt council', () => {
  const f = fixture();
  const input = f.material();
  const row = input.roles[0]!;
  const intent = f.write(join(f.root, 'foreign.json'), '{}');
  expect(() => checkH06NativeLegacyCouncilUsage({ ...input, roles: [{ ...row, intent }] })).toThrow(
    'h06-legacy-council-directory',
  );
  f.progress.session.receipt = { locator: intent.path, hash: intent.sha256 };
  const progress = f.write(row.progress.path, JSON.stringify(f.progress));
  expect(() =>
    checkH06NativeLegacyCouncilUsage({ ...input, roles: [{ ...row, progress }] }),
  ).toThrow('h06-legacy-council-receipt');
});
