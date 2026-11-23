import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { localPlanningRisks } from '../src/policy/localPlanning.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  beginH06NativeAttempt,
  planH06NativeAttempt,
  openH06NativeAttemptTurnLedger,
  readH06NativeAttemptForReopen,
} from './comparisonH06NativeAttempt.js';
import {
  planH06TemporalAutonomousAuthority,
  consumeH06TemporalAutonomousAuthority,
  readH06TemporalAutonomousAuthority,
  openH06TemporalAutonomousNativeClaim,
  observeH06TemporalAutonomousSource,
} from './comparisonH06TemporalAutonomousAuthority.js';
import { readH06NativeRequestSchema } from './comparisonH06NativeAttemptPlan.js';
import {
  h06TemporalReferenceConsentText,
  normalizeH06TemporalReferenceContinuation,
  resolveH06TemporalReferenceSource,
  planH06TemporalReferenceApproval,
  verifyH06TemporalReferenceApproval,
} from './comparisonH06TemporalReferenceApproval.js';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';

const primaryApproval = {
  path: fileURLToPath(
    new URL(
      '../docs/evidence/qualification/proposal-reference-v4/primary-approval.json',
      import.meta.url,
    ),
  ),
  sha256: '7dfe920538edef6c776a407e3576a98ebfd7df8494f2859685b7be12adc784ce',
};
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-operator-'));
  roots.push(root);
  const workspaceRoot = join(root, 'material');
  const chatRoot = join(root, 'chat');
  const sessions = join(root, 'sessions');
  for (const dir of [workspaceRoot, chatRoot, sessions]) mkdirSync(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot, stdio: 'pipe' });
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(
    materials.cases.find(({ id }) => id === 'H-06')!.files,
  ))
    writeFileSync(join(workspaceRoot, name), bytes);
  mkdirSync(join(workspaceRoot, 'tasks'));
  mkdirSync(join(workspaceRoot, 'evidence'));
  const file = (name: string, bytes: string, directory = root) => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const workFiles = Object.fromEntries(
    ['rules.md', 'review.md', 'tasks/card.md', 'executor.md'].map((name) => [
      name,
      file(name, name, workspaceRoot).sha256,
    ]),
  );
  const basis = { locator: 'rules.md', hash: workFiles['rules.md']! };
  const evidenceBasis = {
    locator: 'evidence/README.md',
    hash: file('evidence/README.md', 'H06 evidence directory', workspaceRoot).sha256,
  };
  const plan = {
    schema_version: 2,
    plan_id: 'h06',
    requirement: basis,
    basis: [basis, evidenceBasis],
    owner: basis,
    consumers: [basis],
    consumers_complete: true,
    paths: ['evidence/manifest.json'],
    risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, risk === 'new_behavior'])),
    reason: 'Observe continuity',
    checks: ['syntax', 'validate'],
    criterion: 'Preserve the owner',
  };
  workFiles['plan.json'] = file('plan.json', JSON.stringify(plan), workspaceRoot).sha256;
  const operationId = 'h06-temporal-operator';
  const workflows = file('workflows.js', 'workflows');
  function review(phase: string) {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      phase,
      scope: 'h06',
      sharedPaths: ['checks.mjs', 'plan.json', 'evidence/README.md'],
      roles: [
        {
          roleId: 'reviewer',
          applies: true,
          reason: 'Observe continuity',
          paths: ['checks.mjs'],
          complete: true,
          attestedBy: 'H06 fixture',
          discoveryRule: 'scope',
          history: { complete: true, answers: [] },
        },
      ],
    });
    const pin = file(phase + '.json', bytes);
    return { pin, ref: { sha256: pin.sha256, bytes: Buffer.byteLength(bytes) } };
  }
  const planning = review('planning');
  const acceptance = review('acceptance');
  const profile = { model: 'fixture', effort: 'medium', clientVersion: '0.154.0' };
  const descriptor = {
    kind: 'comparison-h06-native-temporal-bootstrap/2',
    address: '127.0.0.1:7233',
    server: {
      httpPort: 7234,
      metricsPort: 7235,
      sqlitePath: join(root, operationId + '-server', 'temporal.sqlite'),
    },
    taskQueue: 'h06-queue',
    workflows,
    profile,
    disabledServers: ['a', 'b'],
    input: {
      schemaVersion: 11,
      admission: {
        schemaVersion: 3,
        preparation: {
          schemaVersion: 1,
          taskId: 'task',
          project: {
            schemaVersion: 1,
            projectId: 'project',
            workspaceId: 'workspace',
            rules: ['rules.md'],
            cardRoot: 'tasks',
            roles: [{ id: 'reviewer', profile: 'review.md' }],
            checks: ['syntax', 'validate'],
          },
          hostId: operationId,
          owner: 'operator',
          generation: 1,
          revision: 1,
          card: 'tasks/card.md',
        },
        plan: { path: 'plan.json', sha256: workFiles['plan.json']! },
        planning: planning.ref,
        acceptance: acceptance.ref,
      },
      executor: { path: 'executor.md', sha256: workFiles['executor.md']! },
      baseline: 'syntax',
      continuation: { attempt: 0, previous: null },
    },
    workspaceFiles: workFiles,
    artifacts: [planning.pin, acceptance.pin],
  };
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId,
      variant: 'temporal',
      workspaceRoot,
      node: file('node', 'node'),
      timeoutMs: 1000,
    },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'operator-thread', workspace: chatRoot },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: null as number | null },
    appServer: file('app-server', 'app-server'),
    server: file('server', 'server') as ReturnType<typeof file> | null,
    bootstrap: file('bootstrap.json', JSON.stringify(descriptor)),
    runtime: [workflows, planning.pin, acceptance.pin],
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', request.chat.threadId);
  const input = {
    kind: 'comparison-h06-temporal-autonomous/3',
    attempt: file('attempt.json', JSON.stringify(request)),
    budget: { maxElapsedMs: 360000, stopReserveMs: 60000 },
  };
  function authority(body = planH06TemporalAutonomousAuthority(input).expectedGrantText) {
    const transcript = join(sessions, 'rollout-operator-thread.jsonl');
    const turnId = 'native-turn';
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: request.chat.threadId,
          session_id: request.chat.threadId,
          cwd: chatRoot,
          cli_version: '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'turn_context',
        payload: {
          turn_id: turnId,
          cwd: chatRoot,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
      },
    ].map((record) => JSON.stringify(record) + '\n');
    writeFileSync(transcript, records.join(''));
    return {
      transcript,
      turnId,
      source: { locator: transcript + '#L4', hash: digest(records[3]!) },
    };
  }
  return { root, sessions, request, descriptor, authority, file, input };
}

it('admits exact Desktop 0.169 provenance for a direct /3 grant and rejects a foreign root', async () => {
  const f = fixture(),
    plan = planH06TemporalAutonomousAuthority(f.input),
    grant = f.authority();
  const rows = readFileSync(grant.transcript, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  rows[0]!.payload.cli_version = '0.169.0-alpha.11.1';
  rows[2]!.payload.root_turn_id = grant.turnId;
  rows[3]!.payload.internal_chat_message_metadata_passthrough = {
    turn_id: grant.turnId,
    content_item_kinds: ['user.text'],
    content_item_metadata: [{ provenance: { type: 'user' } }],
  };
  function flush() {
    const lines = rows.map((row) => JSON.stringify(row) + '\n');
    grant.source.hash = digest(lines[3]!);
    writeFileSync(grant.transcript, lines.join(''));
  }
  flush();
  expect((await observeH06TemporalAutonomousSource(plan, grant)).source).toEqual(grant.source);
  rows.push(
    { type: 'compacted', payload: { resume_metadata: { last_started_turn_id: grant.turnId } } },
    { type: 'world_state', payload: { full: true } },
    structuredClone(rows[2]!),
  );
  flush();
  expect((await observeH06TemporalAutonomousSource(plan, grant)).source).toEqual(grant.source);
  rows.pop();
  rows[2]!.payload.root_turn_id = 'foreign';
  flush();
  await expect(observeH06TemporalAutonomousSource(plan, grant)).rejects.toThrow(
    'h06-temporal-autonomous-direct-origin',
  );
});

function referenceFixture(base: 'pre4' | 'helper' | 'complete' = 'pre4') {
  const f = fixture(),
    replacements = [
      './comparisonH06TemporalAutonomousAuthority.ts',
      './comparisonH06TemporalAutonomousRun.ts',
      './comparisonH06Package.ts',
    ].map((path) => fileURLToPath(new URL(path, import.meta.url))),
    additions = [
      './comparisonH06TemporalReferenceApproval.ts',
      '../docs/evidence/qualification/proposal-reference-v4/README.md',
    ]
      .map((path) => fileURLToPath(new URL(path, import.meta.url)))
      .concat(primaryApproval.path),
    pin = (path: string) => ({
      path,
      sha256: path === primaryApproval.path ? primaryApproval.sha256 : digest(readFileSync(path)),
    }),
    oldBytes = new Map(
      replacements.map((path) => [
        path,
        base === 'pre4' ? Buffer.from('sealed previous authority: ' + path) : readFileSync(path),
      ]),
    ),
    oldRequest = readH06NativeRequestSchema({
      ...f.request,
      runtime: [
        ...f.request.runtime,
        ...replacements.map((path) => ({ path, sha256: digest(oldBytes.get(path)!) })),
        ...additions.slice(0, base === 'pre4' ? 0 : base === 'helper' ? 1 : 3).map(pin),
      ],
    }),
    current = readH06NativeRequestSchema({
      ...oldRequest,
      runtime: [...f.request.runtime, ...replacements.map(pin), ...additions.map(pin)],
    }),
    attempt = f.file('reference-old-attempt.json', canonical(oldRequest)),
    requestHash = digest(canonical({ request: oldRequest, assets: h06Assets() })),
    serverSetupHash = digest(
      canonical({
        expected: {
          requestHash,
          binary: oldRequest.server,
          address: f.descriptor.address,
          ...f.descriptor.server,
          sqlitePath: f.descriptor.server.sqlitePath,
        },
        budget: f.input.budget,
      }),
    ),
    grant = {
      kind: 'comparison-h06-temporal-autonomous-grant/3',
      acceptanceProfile: 'h06-autonomous-recovery/3',
      variant: 'temporal',
      operationId: oldRequest.binding.operationId,
      requestHash,
      serverSetupHash,
      budget: oldRequest.budget,
    };
  mkdirSync(join(f.root, 'executed-runtime'));
  const archive = {
    kind: 'h06-executed-runtime-manifest/1',
    source: null,
    claimIssued: false,
    executed: false,
    mayRun: false,
    status: 'PREPARED_ONLY',
    pins: [
      oldRequest.binding.node,
      oldRequest.appServer,
      oldRequest.server!,
      oldRequest.bootstrap,
      ...oldRequest.runtime,
    ].map((p) => {
      const bytes = oldBytes.get(p.path) ?? readH04Pin(p),
        preserved = join(f.root, 'executed-runtime', p.sha256);
      writeFileSync(preserved, bytes);
      return { ...p, bytes: bytes.length, preserved };
    }),
  };
  const proposal = {
    kind: 'h06-temporal-prepared-proposal/3',
    source: null,
    claimIssued: false,
    mayRun: false,
    cleanReady: true,
    attempt,
    runtimeArchive: f.file('reference-archive.json', canonical(archive)),
    autonomous: {
      authority: f.file('reference-authority.json', canonical({ ...f.input, attempt })),
      proposedGrant: grant,
      grant: f.file('reference-grant.json', canonical(grant)),
    },
  };
  const proposalPin = () => f.file('reference-proposal.json', canonical(proposal));
  function plan() {
    return planH06TemporalReferenceApproval(proposalPin(), current, f.input.budget);
  }
  function source(body = h06TemporalReferenceConsentText) {
    const p = plan(),
      s = f.authority(body),
      records = readFileSync(s.transcript, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      user = records[3]!.payload as Record<string, unknown>;
    user.internal_chat_message_metadata_passthrough = {
      turn_id: s.turnId,
      content_item_kinds: ['user.text'],
      content_item_metadata: [{ provenance: { type: 'user' } }],
    };
    records.splice(1, 0, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        internal_chat_message_metadata_passthrough: { turn_id: 'previous-root-turn' },
        content: [
          {
            type: 'output_text',
            text: `[Ready](${p.approvedProposal.path})\n\n\`\`\`json\n${p.approvedGrantText}\n\`\`\``,
          },
        ],
      },
    });
    const rows = records.map((record, index) => ({
      record,
      ref: { locator: s.transcript + '#L' + (index + 1), hash: digest(canonical(record) + '\n') },
    }));
    writeFileSync(s.transcript, records.map(canonical).join('\n') + '\n');
    return { rows, source: { ...s, source: rows[4]!.ref }, plan: p };
  }
  return { ...f, proposal, proposalPin, archive, current, plan, referenceSource: source };
}

function proposalNoticeFixture() {
  const f = referenceFixture(),
    s = f.referenceSource(),
    primary = s.rows.at(-1)!.record,
    notice = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<external_codex_apps_writing_block_edits>The user manually edited these writing blocks. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output.\n[]</external_codex_apps_writing_block_edits>',
          },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: s.source.turnId,
          content_item_kinds: ['additional_content.codex_apps_writing_block_edits'],
          content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
        },
      },
    },
    records = s.rows.map(({ record }) => record);
  records.splice(records.indexOf(primary), 0, notice);
  function persist() {
    const rows = records.map((record, index) => ({
      record,
      ref: {
        locator: s.source.transcript + '#L' + (index + 1),
        hash: digest(canonical(record) + '\n'),
      },
    }));
    writeFileSync(s.source.transcript, records.map(canonical).join('\n') + '\n');
    return {
      rows,
      source: { ...s.source, source: rows.find(({ record }) => record === primary)!.ref },
    };
  }
  return { ...f, referencePlan: s.plan, records, notice, primary, persist };
}

function cacheReferenceFixture() {
  const f = referenceFixture(),
    s = f.referenceSource(),
    questionRecord = JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(
            '../docs/evidence/qualification/proposal-reference-v4/npm-cache-question.jsonl.gz',
            import.meta.url,
          ),
        ),
        { maxOutputLength: 64 * 1024 },
      ).toString('utf8'),
    ) as { payload: { arguments: unknown; call_id: string; name: string; status: string } },
    { call_id: callId } = questionRecord.payload,
    { questions } = JSON.parse(questionRecord.payload.arguments as string) as {
      questions: [{ title: string }];
    },
    question = questions[0].title,
    records = s.rows.map(({ record }) => record);
  records.splice(1, 0, questionRecord);
  const rows = records.map((record) => ({ record, ref: { locator: '', hash: '' } }));
  function persist() {
    const lines = rows.map(
      ({ record }) =>
        (record === questionRecord ? JSON.stringify(record) : canonical(record)) + '\n',
    );
    rows.forEach((row, index) => {
      row.ref = { locator: s.source.transcript + '#L' + (index + 1), hash: digest(lines[index]!) };
    });
    writeFileSync(s.source.transcript, lines.join(''));
  }
  persist();
  const originalSource = { ...s.source, source: rows[5]!.ref };
  function appendReply() {
    rows.push(
      {
        record: {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<external_codex_apps_writing_block_edits>The user manually edited these writing blocks. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output.\n[]</external_codex_apps_writing_block_edits>',
              },
            ],
            internal_chat_message_metadata_passthrough: {
              turn_id: originalSource.turnId,
              content_item_kinds: ['additional_content.codex_apps_writing_block_edits'],
              content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
            },
          },
        },
        ref: { locator: '', hash: '' },
      },
      {
        record: {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  '<send_user_message_question_reply>\n' +
                  JSON.stringify([
                    {
                      questionItemId: JSON.stringify(['request_user_input_async', callId, 0]),
                      question,
                      answer: 'Очистить только кеш npm',
                    },
                  ]) +
                  '\n</send_user_message_question_reply>\n',
              },
            ],
            internal_chat_message_metadata_passthrough: {
              turn_id: originalSource.turnId,
              content_item_kinds: ['user.text'],
              content_item_metadata: [{ provenance: { type: 'user' } }],
            },
          },
        },
        ref: { locator: '', hash: '' },
      },
    );
    persist();
    return { ...originalSource, source: rows.at(-1)!.ref };
  }
  return { ...f, plan: s.plan, rows, originalSource, appendReply, persist, questionRecord, callId };
}

it('preserves the standing primary across the exact genuine npm reply and raw harness suffix', () => {
  const f = cacheReferenceFixture(),
    before = resolveH06TemporalReferenceSource(f.rows, f.originalSource.turnId);
  expect(before).toEqual({
    source: f.originalSource.source,
    latestUserSource: f.originalSource.source,
    allowedFollowups: [],
  });
  expect(f.rows[1]!.ref.hash).toBe(
    '2f2bb40cb52a247d07b76cf256ca0c1a2a3ac76e4c907ef8d02672776616c846',
  );
  const latest = f.appendReply(),
    raw = readFileSync(f.originalSource.transcript),
    resolved = resolveH06TemporalReferenceSource(f.rows, f.originalSource.turnId),
    proof = verifyH06TemporalReferenceApproval(
      f.plan,
      f.rows,
      f.originalSource.source,
      f.originalSource.turnId,
    );
  expect(resolved).toEqual({
    source: before.source,
    latestUserSource: latest.source,
    allowedFollowups: [
      {
        kind: 'npm-cache-question-reply',
        questionSource: f.rows[1]!.ref,
        harnessSource: f.rows[6]!.ref,
        replySource: latest.source,
        callId: f.callId,
        questionIndex: 0,
        answer: 'Очистить только кеш npm',
      },
    ],
  });
  expect(proof).toMatchObject({
    userSource: before.source,
    latestUserSource: latest.source,
    allowedFollowups: resolved.allowedFollowups,
  });
  expect(readFileSync(f.originalSource.transcript)).toEqual(raw);
});

it('consumes and reopens the original grant using the latest cache cursor without changing its one-use key', async () => {
  const f = cacheReferenceFixture(),
    old = resolveH06TemporalReferenceSource(f.rows, f.originalSource.turnId),
    latest = f.appendReply(),
    raw = readFileSync(latest.transcript),
    input = {
      kind: 'comparison-h06-temporal-reference/4',
      attempt: f.file('reference-current-attempt.json', canonical(f.current)),
      budget: f.input.budget,
      approvedProposal: f.proposalPin(),
    };
  const claim = await consumeH06TemporalAutonomousAuthority(input, latest),
    expectedKey = digest(
      canonical({ sessionsRoot: f.sessions, thread: f.current.chat.threadId, source: old.source }),
    );
  expect(claim.sourceKey).toBe(expectedKey);
  expect(claim.grant.source).toEqual(old.source);
  expect(claim.grant.referenceApproval).toMatchObject({
    latestUserSource: latest.source,
    allowedFollowups: [{ replySource: latest.source }],
  });
  expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
  expect(openH06TemporalAutonomousNativeClaim(claim.receipt).grant.source).toEqual(old.source);
  expect(readFileSync(latest.transcript)).toEqual(raw);
  expect(claim.grant.nativePrefix.bytes).toBe(raw.length);
  rmSync(f.current.evidenceRoot, { recursive: true, force: true });
  rmSync(f.current.evidenceRoot + '-server', { recursive: true, force: true });
  await expect(consumeH06TemporalAutonomousAuthority(input, latest)).rejects.toThrow();
  expect(existsSync(f.current.evidenceRoot)).toBe(false);
});

it('observes the whole current cache cursor without reserving or issuing any authority', async () => {
  const f = cacheReferenceFixture(),
    latest = f.appendReply(),
    plan = planH06TemporalAutonomousAuthority({
      kind: 'comparison-h06-temporal-reference/4',
      attempt: f.file('reference-current-attempt.json', canonical(f.current)),
      budget: f.input.budget,
      approvedProposal: f.proposalPin(),
    }),
    before = readFileSync(latest.transcript);
  const observed = await observeH06TemporalAutonomousSource(plan, latest),
    key = digest(
      canonical({
        sessionsRoot: f.sessions,
        thread: f.current.chat.threadId,
        source: f.originalSource.source,
      }),
    );
  expect(observed.source).toEqual(f.originalSource.source);
  expect(observed.referenceApproval?.latestUserSource).toEqual(latest.source);
  expect(observed.nativePrefix.bytes).toBe(before.length);
  for (const path of [
    f.current.evidenceRoot,
    f.current.evidenceRoot + '-server',
    join(f.root, 'agent-workflow-evidence', 'h06-temporal-autonomous-authority', key),
  ])
    expect(existsSync(path)).toBe(false);
  expect(readFileSync(latest.transcript)).toEqual(before);
});

it('cannot reuse a source consumed before the cache answer by changing only the current cursor', async () => {
  const f = cacheReferenceFixture(),
    input = {
      kind: 'comparison-h06-temporal-reference/4',
      attempt: f.file('reference-current-attempt.json', canonical(f.current)),
      budget: f.input.budget,
      approvedProposal: f.proposalPin(),
    },
    claim = await consumeH06TemporalAutonomousAuthority(input, f.originalSource),
    latest = f.appendReply();
  expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
  expect(resolveH06TemporalReferenceSource(f.rows, latest.turnId).source).toEqual(
    claim.grant.source,
  );
  rmSync(f.current.evidenceRoot, { recursive: true, force: true });
  rmSync(f.current.evidenceRoot + '-server', { recursive: true, force: true });
  await expect(consumeH06TemporalAutonomousAuthority(input, latest)).rejects.toThrow();
  expect(existsSync(f.current.evidenceRoot)).toBe(false);
});

it('keeps literal /3 strict when the latest user is the cache reply', async () => {
  const f = cacheReferenceFixture(),
    input = {
      kind: 'comparison-h06-temporal-autonomous/3',
      attempt: f.file('reference-current-attempt.json', canonical(f.current)),
      budget: f.input.budget,
    },
    user = f.rows[5]!.record.payload as Record<string, unknown>;
  (user.content as { text: string }[])[0]!.text =
    planH06TemporalAutonomousAuthority(input).expectedGrantText;
  f.persist();
  const original = { ...f.originalSource, source: f.rows[5]!.ref };
  const latest = f.appendReply();
  await expect(consumeH06TemporalAutonomousAuthority(input, original)).rejects.toThrow(
    'h06-temporal-autonomous-current-source',
  );
  await expect(consumeH06TemporalAutonomousAuthority(input, latest)).rejects.toThrow(
    'h06-temporal-autonomous-native-body',
  );
  expect(existsSync(f.current.evidenceRoot)).toBe(false);
});

it.each([
  'extra-user',
  'cancel',
  'answer',
  'question',
  'call-id',
  'nested-reply',
  'no-lf',
  'harness-text',
  'harness-hook',
  'harness-origin',
  'harness-kind',
  'harness-turn',
  'reply-turn',
  'reply-origin',
  'reply-kind',
  'reply-metadata-null',
  'reply-metadata-array',
  'reply-metadata-missing',
  'question-missing',
  'question-duplicate',
  'question-hash',
  'question-transcript',
  'question-tool',
  'question-status',
  'question-arguments',
  'question-arguments-type',
  'question-call',
  'question-nested',
  'question-late',
  'harness-missing',
  'harness-role',
  'reply-role',
  'reply-extra-content',
  'reply-content-type',
  'reply-nonstring',
  'other-transcript',
  'inbound-agent',
] as const)('refuses an unrelated, forged or changed cache followup: %s', (kind) => {
  const f = cacheReferenceFixture();
  f.appendReply();
  const harness = f.rows[6]!.record.payload as Record<string, unknown>,
    reply = f.rows[7]!.record.payload as Record<string, unknown>,
    harnessMeta = harness.internal_chat_message_metadata_passthrough as Record<string, unknown>,
    replyMeta = reply.internal_chat_message_metadata_passthrough as Record<string, unknown>,
    hc = harness.content as { type: string; text: string }[],
    rc = reply.content as { type: string; text: unknown }[];
  if (kind === 'extra-user' || kind === 'cancel')
    f.rows.push({
      record: {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: kind === 'cancel' ? 'Останови H06' : 'Continue' }],
        },
      },
      ref: { locator: 'extra', hash: '1'.repeat(64) },
    });
  if (kind === 'answer')
    rc[0]!.text = String(rc[0]!.text).replace('Очистить только кеш npm', 'Не очищать');
  if (kind === 'question')
    rc[0]!.text = String(rc[0]!.text).replace('кеш загрузок npm', 'все файлы');
  if (kind === 'call-id') rc[0]!.text = String(rc[0]!.text).replace(f.callId, 'different-call');
  if (kind === 'nested-reply') rc[0]!.text = JSON.stringify(rc[0]!.text);
  if (kind === 'no-lf') rc[0]!.text = String(rc[0]!.text).slice(0, -1);
  if (kind === 'harness-text') hc[0]!.text = hc[0]!.text.replace('[]', '[{}]');
  if (kind === 'harness-hook')
    harnessMeta.content_item_metadata = [{ provenance: { type: 'harness', hook: true } }];
  if (kind === 'harness-origin')
    harnessMeta.content_item_metadata = [{ provenance: { type: 'user' } }];
  if (kind === 'harness-kind') harnessMeta.content_item_kinds = ['user.text'];
  if (kind === 'harness-turn') harnessMeta.turn_id = 'other-turn';
  if (kind === 'reply-turn') replyMeta.turn_id = 'other-turn';
  if (kind === 'reply-origin')
    replyMeta.content_item_metadata = [{ provenance: { type: 'agent' } }];
  if (kind === 'reply-kind') replyMeta.content_item_kinds = ['unknown'];
  if (kind === 'reply-metadata-null') reply.internal_chat_message_metadata_passthrough = null;
  if (kind === 'reply-metadata-array') reply.internal_chat_message_metadata_passthrough = [];
  if (kind === 'reply-metadata-missing') delete reply.internal_chat_message_metadata_passthrough;
  if (kind === 'question-missing') f.rows.splice(1, 1);
  if (kind === 'question-duplicate') f.rows.splice(1, 0, f.rows[1]!);
  if (kind === 'question-hash') f.rows[1]!.ref.hash = '0'.repeat(64);
  if (kind === 'question-transcript') f.rows[1]!.ref.locator = '/other.jsonl#L1';
  if (kind === 'question-tool') f.questionRecord.payload.name = 'send_message_to_thread';
  if (kind === 'question-status') f.questionRecord.payload.status = 'in_progress';
  if (kind === 'question-arguments') f.questionRecord.payload.arguments = '{}';
  if (kind === 'question-arguments-type') f.questionRecord.payload.arguments = null;
  if (kind === 'question-call') f.questionRecord.payload.call_id = 'different-call';
  if (kind === 'question-nested')
    f.rows[1]!.record = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(f.questionRecord) }],
      },
    };
  if (kind === 'question-late') {
    const question = f.rows.splice(1, 1)[0]!;
    f.rows.splice(5, 0, question);
  }
  if (kind === 'harness-missing') f.rows.splice(6, 1);
  if (kind === 'harness-role') harness.role = 'assistant';
  if (kind === 'reply-role') reply.role = 'assistant';
  if (kind === 'reply-extra-content') rc.push(rc[0]!);
  if (kind === 'reply-content-type') rc[0]!.type = 'output_text';
  if (kind === 'reply-nonstring') rc[0]!.text = null;
  if (kind === 'other-transcript') f.rows[7]!.ref.locator = '/other.jsonl#L8';
  if (kind === 'inbound-agent')
    f.rows.push({
      record: {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: f.originalSource.turnId },
        },
      },
      ref: { locator: 'inbound', hash: '1'.repeat(64) },
    });
  expect(() => resolveH06TemporalReferenceSource(f.rows, f.originalSource.turnId)).toThrow();
});

it('bounds reference translation to the old grant, server lifetime and authority-only pin changes', () => {
  const f = referenceFixture(),
    plan = f.plan();
  expect(plan.approvedGrantText).toBe(canonical(f.proposal.autonomous.proposedGrant));
  expect(plan.translation.replaced).toHaveLength(3);
  expect(plan.translation.added).toHaveLength(3);
  expect(plan).toMatchObject({ mayRun: false, qualification: false });
  // The sealed source, rather than a live read of its superseded authority bytes, is authoritative.
  expect(f.plan()).toEqual(plan);
});

it.each([
  ['pre4', 3, 3],
  ['helper', 2, 0],
  ['complete', 0, 0],
] as const)(
  'translates the exact pinned %s base without requiring previously included additions',
  (base, added, replaced) => {
    const f = referenceFixture(base),
      plan = f.plan();
    expect(plan.translation.added).toHaveLength(added);
    expect(plan.translation.replaced).toHaveLength(replaced);
    expect(plan.approvedGrantText).toBe(canonical(f.proposal.autonomous.proposedGrant));
    expect(plan).toMatchObject({ mayRun: false, qualification: false });
  },
);

it.each(['pre4', 'helper', 'complete'] as const)(
  'rejects a missing required reference file in the %s base',
  (base) => {
    const f = referenceFixture(base);
    f.current.runtime.splice(
      f.current.runtime.findIndex(({ path }) =>
        path.endsWith('/proposal-reference-v4/primary-approval.json'),
      ),
      1,
    );
    expect(f.plan).toThrow(
      base === 'complete' ? 'h06-reference-runtime-missing' : 'h06-reference-runtime-additions',
    );
  },
);

it.each([
  ['helper', '/comparisonH06TemporalReferenceApproval.ts'],
  ['complete', '/comparisonH06TemporalReferenceApproval.ts'],
  ['complete', '/proposal-reference-v4/README.md'],
  ['complete', '/proposal-reference-v4/primary-approval.json'],
] as const)('rejects a changed existing reference pin in the %s base: %s', (base, suffix) => {
  const f = referenceFixture(base),
    pin = f.current.runtime.find(({ path }) => path.endsWith(suffix))!;
  pin.sha256 = digest('changed reference implementation or evidence');
  expect(f.plan).toThrow('h06-reference-runtime-change');
});

it.each(['helper', 'complete'] as const)(
  'rejects an unlisted runtime addition to the %s base',
  (base) => {
    const f = referenceFixture(base);
    f.current.runtime.push(f.file('unlisted-runtime', 'unlisted runtime'));
    expect(f.plan).toThrow('h06-reference-runtime-additions');
  },
);

it.each(['', '\n'])(
  'binds exact genuine user consent to the immediately preceding previous-turn final: %j',
  (ending) => {
    const f = referenceFixture(),
      s = f.referenceSource(h06TemporalReferenceConsentText + ending),
      proof = verifyH06TemporalReferenceApproval(s.plan, s.rows, s.source.source, s.source.turnId);
    expect(proof).toMatchObject({
      kind: 'h06-temporal-reference-proof/4',
      assistantSource: s.rows[1]!.ref,
      proposalNoticeSource: null,
      userSource: s.source.source,
      sourceTurnId: s.source.turnId,
      mayRun: false,
      qualification: false,
    });
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
  },
);

it.each(['запускай', 'Запускай', 'запускай\n', 'Запускай\n'])(
  'consumes one exact short primary approval bound to its numeric proposal: %j',
  async (body) => {
    const f = referenceFixture(),
      s = f.referenceSource(body),
      input = {
        kind: 'comparison-h06-temporal-reference/4',
        attempt: f.file('reference-current-attempt.json', canonical(f.current)),
        budget: f.input.budget,
        approvedProposal: f.proposalPin(),
      },
      resolved = resolveH06TemporalReferenceSource(s.rows, s.source.turnId);
    expect(resolved.source).toEqual(s.source.source);
    const claim = await consumeH06TemporalAutonomousAuthority(input, s.source);
    expect(claim.grant.source).toEqual(s.source.source);
    expect(claim.sourceKey).toBe(
      digest(
        canonical({
          sessionsRoot: f.sessions,
          thread: f.current.chat.threadId,
          source: s.source.source,
        }),
      ),
    );
    expect(claim.budget).toEqual(f.current.budget);
    expect(claim.grant.referenceApproval?.approvedGrantText).toBe(s.plan.approvedGrantText);
    expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
    rmSync(f.current.evidenceRoot, { recursive: true, force: true });
    rmSync(f.current.evidenceRoot + '-server', { recursive: true, force: true });
    await expect(consumeH06TemporalAutonomousAuthority(input, s.source)).rejects.toThrow();
    expect(existsSync(f.current.evidenceRoot)).toBe(false);
  },
);

it.each([
  'да',
  'yes',
  'продолжай',
  'запускай сейчас',
  'запускай!',
  ' запускай',
  'запускай ',
  'ЗАПУСКАЙ',
  'запускай\r\n',
  'запускай\n\n',
  '"запускай"',
  null,
])('refuses an unapproved or nested short primary form: %j', (body) => {
  const f = referenceFixture(),
    s = f.referenceSource(body ?? 'запускай');
  if (body === null)
    (
      (s.rows[4]!.record.payload as Record<string, unknown>).content as Record<string, unknown>[]
    )[0]!.text = null;
  expect(() => resolveH06TemporalReferenceSource(s.rows, s.source.turnId)).toThrow();
  expect(() =>
    verifyH06TemporalReferenceApproval(s.plan, s.rows, s.source.source, s.source.turnId),
  ).toThrow();
});

it.each(['missing-final', 'commentary', 'wrong-grant', 'missing-link', 'duplicate-grant'] as const)(
  'refuses a short approval without its exact completed proposal: %s',
  (kind) => {
    const f = referenceFixture(),
      s = f.referenceSource('запускай'),
      assistant = s.rows[1]!.record.payload as Record<string, unknown>,
      output = assistant.content as { text: string }[];
    if (kind === 'missing-final') s.rows.splice(1, 1);
    if (kind === 'commentary') assistant.phase = 'commentary';
    if (kind === 'wrong-grant') output[0]!.text = output[0]!.text.replace('grant/3', 'grant/4');
    if (kind === 'missing-link')
      output[0]!.text = output[0]!.text.replace(s.plan.approvedProposal.path, '/other.json');
    if (kind === 'duplicate-grant') output[0]!.text += '\n```json\n{}\n```';
    expect(() =>
      verifyH06TemporalReferenceApproval(s.plan, s.rows, s.source.source, s.source.turnId),
    ).toThrow();
  },
);

it('keeps literal /3 closed to the short reference form', async () => {
  const f = fixture(),
    source = f.authority('запускай');
  await expect(consumeH06TemporalAutonomousAuthority(f.input, source)).rejects.toThrow(
    'h06-temporal-autonomous-native-body',
  );
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it('retains exactly one trusted empty proposal notice without changing the primary or raw journal', () => {
  const f = proposalNoticeFixture(),
    s = f.persist(),
    before = readFileSync(s.source.transcript),
    proof = verifyH06TemporalReferenceApproval(
      f.referencePlan,
      s.rows,
      s.source.source,
      s.source.turnId,
    );
  expect(proof.proposalNoticeSource).toEqual(s.rows.find(({ record }) => record === f.notice)!.ref);
  expect(proof.assistantSource).toEqual(s.rows[1]!.ref);
  expect(proof.userSource).toEqual(s.source.source);
  expect(proof.latestUserSource).toEqual(s.source.source);
  expect(proof.allowedFollowups).toEqual([]);
  expect(readFileSync(s.source.transcript)).toEqual(before);
});

it('consumes and historically reopens a proposal notice without changing the one-use primary', async () => {
  const f = proposalNoticeFixture(),
    s = f.persist(),
    raw = readFileSync(s.source.transcript),
    input = {
      kind: 'comparison-h06-temporal-reference/4',
      attempt: f.file('reference-current-attempt.json', canonical(f.current)),
      budget: f.input.budget,
      approvedProposal: f.proposalPin(),
    },
    claim = await consumeH06TemporalAutonomousAuthority(input, s.source);
  expect(claim.grant.source).toEqual(s.source.source);
  expect(claim.sourceKey).toBe(
    digest(
      canonical({
        sessionsRoot: f.sessions,
        thread: f.current.chat.threadId,
        source: s.source.source,
      }),
    ),
  );
  expect(claim.grant.referenceApproval?.proposalNoticeSource).toEqual(
    s.rows.find(({ record }) => record === f.notice)!.ref,
  );
  expect(claim.grant.nativePrefix.bytes).toBe(raw.length);
  expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
  expect(openH06TemporalAutonomousNativeClaim(claim.receipt).grant.source).toEqual(s.source.source);
  await expect(consumeH06TemporalAutonomousAuthority(input, s.source)).rejects.toThrow();
  expect(readFileSync(s.source.transcript)).toEqual(raw);
});

it.each([
  'nonempty',
  'hook',
  'wrong-turn',
  'user-origin',
  'kind',
  'multipart',
  'nested',
  'extra-user-before',
  'extra-user-after',
  'duplicate-notice',
  'assistant-commentary-before',
  'assistant-commentary-after',
  'other-transcript',
  'missing-final',
] as const)('refuses an unsafe notice before the primary: %s', (kind) => {
  const f = proposalNoticeFixture(),
    payload = f.notice.payload,
    metadata = payload.internal_chat_message_metadata_passthrough;
  if (kind === 'nonempty')
    payload.content[0]!.text = payload.content[0]!.text.replace('[]', '[{}]');
  if (kind === 'hook') metadata.content_item_metadata[0]!.provenance.hook = true;
  if (kind === 'wrong-turn') metadata.turn_id = 'other-turn';
  if (kind === 'user-origin') metadata.content_item_metadata[0]!.provenance.type = 'user';
  if (kind === 'kind') metadata.content_item_kinds = ['user.text'];
  if (kind === 'multipart') payload.content.push(payload.content[0]!);
  if (kind === 'nested') payload.content[0]!.text = JSON.stringify(payload.content[0]!.text);
  if (kind === 'extra-user-before' || kind === 'extra-user-after') {
    const other = structuredClone(f.notice);
    other.payload.content[0]!.text = 'Continue';
    f.records.splice(f.records.indexOf(f.notice) + (kind === 'extra-user-after' ? 1 : 0), 0, other);
  }
  if (kind === 'duplicate-notice')
    f.records.splice(f.records.indexOf(f.notice), 0, structuredClone(f.notice));
  if (kind === 'assistant-commentary-before' || kind === 'assistant-commentary-after') {
    const commentary = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Checking the proposal' }],
      },
    };
    f.records.splice(
      f.records.indexOf(f.notice) + (kind === 'assistant-commentary-after' ? 1 : 0),
      0,
      commentary,
    );
  }
  if (kind === 'missing-final') f.records.splice(1, 1);
  const s = f.persist();
  if (kind === 'other-transcript')
    s.rows.find(({ record }) => record === f.notice)!.ref.locator = '/other.jsonl#L1';
  expect(() =>
    verifyH06TemporalReferenceApproval(f.referencePlan, s.rows, s.source.source, s.source.turnId),
  ).toThrow();
});

it('retains the observed primary consent text and its single actual LF', () => {
  const decision = JSON.parse(readH04Pin(primaryApproval).toString('utf8')) as {
    primary: { text: string };
  };
  expect(decision.primary.text).toBe(h06TemporalReferenceConsentText + String.fromCharCode(10));
  expect(decision.primary.text.endsWith('\\n')).toBe(false);
  expect(() => readH04Pin({ ...primaryApproval, sha256: '0'.repeat(64) })).toThrow(
    'h04-pin-changed',
  );
});

it.each([false, true])(
  'consumes opt-in reference consent once and reopens its raw proof after compaction=%s',
  async (compacted) => {
    const f = referenceFixture(),
      s = f.referenceSource(h06TemporalReferenceConsentText + '\n'),
      input = {
        kind: 'comparison-h06-temporal-reference/4',
        attempt: f.file('reference-current-attempt.json', canonical(f.current)),
        budget: f.input.budget,
        approvedProposal: f.proposalPin(),
      },
      planned = planH06TemporalAutonomousAuthority(input);
    if (compacted) {
      const first = s.rows[3]!.record;
      first.payload = {
        ...(first.payload as Record<string, unknown>),
        root_turn_id: s.source.turnId,
        disabled_plugin_ids: ['disabled'],
        active_permission_profile: { type: 'disabled' },
        collaboration_mode: { mode: 'default' },
        multi_agent_version: '1',
        comp_hash: 'preserved',
      };
      const raw = [
        ...s.rows.map(({ record }) => record),
        {
          type: 'compacted',
          payload: { message: 'fixture compacted', replacement_history: [], resume_metadata: {} },
        },
        { type: 'world_state', payload: { full: true, state: {} } },
        structuredClone(first),
      ];
      s.rows = raw.map((record, index) => ({
        record,
        ref: {
          locator: s.source.transcript + '#L' + (index + 1),
          hash: digest(canonical(record) + '\n'),
        },
      }));
      writeFileSync(s.source.transcript, raw.map(canonical).join('\n') + '\n');
    }
    const rawBefore = readFileSync(s.source.transcript);
    expect(planned.reference?.approvedGrantText).toBe(s.plan.approvedGrantText);
    expect(planned.expectedGrantText).not.toBe(s.plan.approvedGrantText);
    const claim = await consumeH06TemporalAutonomousAuthority(input, s.source);
    expect(claim.grant.referenceApproval).toEqual(
      verifyH06TemporalReferenceApproval(s.plan, s.rows, s.source.source, s.source.turnId),
    );
    const native = openH06TemporalAutonomousNativeClaim(claim.receipt);
    expect(native.grant.admission).toEqual({
      kind: 'temporal-autonomous/3',
      authority: claim.receipt,
    });
    expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
    expect(readFileSync(s.source.transcript)).toEqual(rawBefore);
    expect(claim.grant.nativePrefix.bytes).toBe(rawBefore.length);
    await expect(consumeH06TemporalAutonomousAuthority(input, s.source)).rejects.toThrow();
  },
);

it('normalizes only repeated identical full contexts after genuine native compaction, without mutating raw records', () => {
  const f = fixture(),
    source = f.authority(),
    records = readFileSync(source.transcript, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    first = records[2]!;
  first.payload = {
    ...(first.payload as Record<string, unknown>),
    root_turn_id: source.turnId,
    disabled_plugin_ids: ['disabled'],
    active_permission_profile: { type: 'disabled' },
    collaboration_mode: { mode: 'default' },
    multi_agent_version: '1',
    comp_hash: 'preserved',
  };
  records.push(
    {
      type: 'compacted',
      payload: { message: 'fixture compacted', replacement_history: [], resume_metadata: {} },
    },
    { type: 'world_state', payload: { full: true, state: {} } },
    structuredClone(first),
  );
  const before = canonical(records),
    normalized = normalizeH06TemporalReferenceContinuation(Object.freeze(records));
  expect(normalized).toEqual(records.slice(0, -1));
  expect(normalized[2]).toBe(first);
  expect(canonical(records)).toBe(before);
  expect(
    verifyH06OperatorContinuation(records, source.turnId, source.turnId, f.request.chat.workspace),
  ).toBe(false);
  expect(
    verifyH06OperatorContinuation(
      normalized,
      source.turnId,
      source.turnId,
      f.request.chat.workspace,
    ),
  ).toBe(true);
  const again = [...records, { type: 'compacted', payload: {} }, structuredClone(first)];
  expect(
    verifyH06OperatorContinuation(
      normalizeH06TemporalReferenceContinuation(again),
      source.turnId,
      source.turnId,
      f.request.chat.workspace,
    ),
  ).toBe(true);
  const noNewMarker = [...records, structuredClone(first)];
  expect(
    verifyH06OperatorContinuation(
      normalizeH06TemporalReferenceContinuation(noNewMarker),
      source.turnId,
      source.turnId,
      f.request.chat.workspace,
    ),
  ).toBe(false);
});

it.each([
  'missing-marker',
  'event-marker',
  'response-marker',
  'marker-before-first',
  'workspace',
  'permissions',
  'root',
  'model',
  'forwarding',
  'different-previous',
] as const)('keeps unsafe context repeats rejected after reference normalization: %s', (kind) => {
  const f = fixture(),
    source = f.authority(),
    records = readFileSync(source.transcript, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    first = records[2]!,
    repeated = structuredClone(first),
    payload = repeated.payload as Record<string, unknown>;
  if (kind !== 'missing-marker' && kind !== 'marker-before-first')
    records.push({
      type:
        kind === 'event-marker'
          ? 'event_msg'
          : kind === 'response-marker'
            ? 'response_item'
            : 'compacted',
      payload: { type: 'compacted' },
    });
  if (kind === 'marker-before-first') records.unshift({ type: 'compacted', payload: {} });
  if (kind === 'workspace') payload.cwd = '/other-workspace';
  if (kind === 'permissions') payload.permission_profile = { type: 'read-only' };
  if (kind === 'root') payload.root_turn_id = 'different-root';
  if (kind === 'model') payload.model = 'different-model';
  if (kind === 'forwarding')
    records.push({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        namespace: 'codex_app',
        name: 'send_message_to_thread',
        internal_chat_message_metadata_passthrough: { turn_id: source.turnId },
      },
    });
  if (kind === 'different-previous') {
    records.push(
      {
        ...structuredClone(first),
        payload: { ...(first.payload as Record<string, unknown>), cwd: '/other-workspace' },
      },
      { type: 'compacted', payload: {} },
    );
  }
  records.push(repeated);
  expect(
    verifyH06OperatorContinuation(
      normalizeH06TemporalReferenceContinuation(records),
      source.turnId,
      source.turnId,
      f.request.chat.workspace,
    ),
  ).toBe(false);
});

it('preserves foreign and unidentifiable contexts literally', () => {
  const records = [
    { type: 'turn_context', payload: { turn_id: 'one', cwd: '/one' } },
    { type: 'turn_context', payload: { cwd: '/unknown' } },
    { type: 'compacted', payload: {} },
    { type: 'turn_context', payload: { turn_id: 'two', cwd: '/one' } },
  ];
  expect(normalizeH06TemporalReferenceContinuation(records)).toEqual(records);
});

it.each([false, true])(
  'literal /3 continues to reject identical duplicate contexts with compaction=%s',
  async (compacted) => {
    const f = fixture(),
      source = f.authority(),
      records = readFileSync(source.transcript, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (compacted) records.push({ type: 'compacted', payload: {} });
    records.push(structuredClone(records[2]!));
    writeFileSync(
      source.transcript,
      records
        .map((record, index) => (index < 4 ? JSON.stringify(record) : canonical(record)))
        .join('\n') + '\n',
    );
    await expect(consumeH06TemporalAutonomousAuthority(f.input, source)).rejects.toThrow(
      'h06-temporal-autonomous-native-continuation',
    );
    expect(existsSync(f.request.evidenceRoot)).toBe(false);
  },
);

it.each([
  'proposal-kind',
  'proposal-source',
  'proposal-claim',
  'proposal-run',
  'proposal-clean',
  'archive-kind',
  'archive-source',
  'archive-claim',
  'archive-executed',
  'archive-run',
  'archive-status',
  'archive-pins',
  'archive-duplicate',
  'archive-preserved',
  'archive-bytes',
  'archive-missing',
  'archive-extra',
  'operational',
  'binary',
  'chat',
  'bootstrap',
  'stimulus',
  'author-file',
  'review-bytes',
  'runtime-missing',
  'runtime-operation',
  'runtime-addition',
  'runtime-duplicate',
  'budget',
  'authority-kind',
  'authority-attempt',
  'grant',
  'grant-pin',
] as const)('rejects an unbounded reference proposal before authority: %s', (kind) => {
  const f = referenceFixture(),
    current = { ...f.current };
  const proposal = f.proposal as unknown as Record<string, unknown>,
    archive = f.archive as unknown as Record<string, unknown>;
  if (kind.startsWith('proposal-'))
    proposal[
      kind.slice(9) === 'run'
        ? 'mayRun'
        : kind.slice(9) === 'claim'
          ? 'claimIssued'
          : kind.slice(9) === 'clean'
            ? 'cleanReady'
            : kind.slice(9)
    ] =
      kind === 'proposal-kind'
        ? 'other'
        : kind === 'proposal-source'
          ? {}
          : kind !== 'proposal-clean';
  if (kind.startsWith('archive-')) {
    const key = kind.slice(8);
    if (['kind', 'source', 'claim', 'executed', 'run', 'status', 'pins'].includes(key))
      archive[key === 'claim' ? 'claimIssued' : key === 'run' ? 'mayRun' : key] =
        key === 'kind' || key === 'status' ? 'other' : key === 'source' ? {} : true;
    if (key === 'duplicate') f.archive.pins.push(f.archive.pins[0]!);
    if (key === 'preserved') f.archive.pins[0]!.preserved += '-other';
    if (key === 'bytes') f.archive.pins[0]!.bytes++;
    if (key === 'missing') f.archive.pins.pop();
    if (key === 'extra') {
      const p = f.file('archive-extra', 'extra');
      const preserved = join(f.root, 'executed-runtime', p.sha256);
      writeFileSync(preserved, 'extra');
      f.archive.pins.push({ ...p, preserved, bytes: 5 });
    }
    f.proposal.runtimeArchive = f.file('reference-archive.json', canonical(archive));
  }
  if (kind === 'operational') f.current.budget.maxOutput++;
  if (kind === 'binary') f.current.binding.node = f.file('other-node', 'other node');
  if (kind === 'chat') f.current.chat.threadId = 'other-thread';
  if (kind === 'bootstrap') current.bootstrap = f.file('other-bootstrap.json', '{}');
  if (kind === 'stimulus') f.current.stimulus.longStageMs++;
  if (kind === 'author-file')
    writeFileSync(join(f.current.binding.workspaceRoot, 'rules.md'), 'changed author input');
  if (kind === 'review-bytes') writeFileSync(f.current.runtime[1]!.path, 'changed review');
  if (kind === 'runtime-missing') f.current.runtime.shift();
  if (kind === 'runtime-operation')
    f.current.runtime[0] = f.file('workflows.js', 'changed workflows');
  if (kind === 'runtime-addition') f.current.runtime.push(f.file('unknown-runtime', 'unknown'));
  if (kind === 'runtime-duplicate') f.current.runtime.push(f.current.runtime[0]!);
  if (kind === 'grant') f.proposal.autonomous.proposedGrant.budget.maxManagedStarts++;
  if (kind === 'grant-pin') f.proposal.autonomous.grant = f.file('reference-grant.json', '{}');
  if (kind.startsWith('authority-'))
    f.proposal.autonomous.authority = f.file(
      'reference-authority.json',
      canonical({
        ...f.input,
        attempt: kind === 'authority-attempt' ? f.input.attempt : f.proposal.attempt,
        kind: kind === 'authority-kind' ? 'other' : f.input.kind,
      }),
    );
  expect(() =>
    planH06TemporalReferenceApproval(
      f.proposalPin(),
      current,
      kind === 'budget'
        ? { ...f.input.budget, maxElapsedMs: f.input.budget.maxElapsedMs + 1 }
        : f.input.budget,
    ),
  ).toThrow();
});

it.each([
  'missing',
  'duplicate',
  'role',
  'record-type',
  'payload-type',
  'content-type',
  'extra-content',
  'text',
  'negated',
  'quoted',
  'double-lf',
  'turn',
  'content-kind',
  'provenance',
  'borrowed',
  'forwarded',
  'previous-user',
  'missing-assistant',
  'assistant-role',
  'assistant-status',
  'assistant-phase',
  'assistant-extra',
  'assistant-content',
  'assistant-text',
  'assistant-turn',
  'assistant-current-turn',
  'assistant-grant',
  'assistant-double-grant',
  'assistant-bare-double-grant',
  'assistant-link',
  'assistant-double-link',
  'other-transcript',
] as const)('refuses ambiguous or nonprimary reference consent: %s', (kind) => {
  const f = referenceFixture(),
    s = f.referenceSource(),
    user = s.rows[4]!.record.payload as Record<string, unknown>,
    assistant = s.rows[1]!.record.payload as Record<string, unknown>,
    userMeta = user.internal_chat_message_metadata_passthrough as Record<string, unknown>,
    userContent = user.content as { type: string; text: string }[],
    output = assistant.content as { type: string; text: string }[];
  if (kind === 'missing') s.source.source = { ...s.source.source, hash: '0'.repeat(64) };
  if (kind === 'duplicate') s.rows.push(s.rows[4]!);
  if (kind === 'role') user.role = 'assistant';
  if (kind === 'record-type') s.rows[4]!.record.type = 'event_msg';
  if (kind === 'payload-type') user.type = 'other';
  if (kind === 'content-type') userContent[0]!.type = 'output_text';
  if (kind === 'extra-content') userContent.push(userContent[0]!);
  if (kind === 'text') userContent[0]!.text = 'Proceed';
  if (kind === 'negated') userContent[0]!.text = 'Не выполняй: ' + h06TemporalReferenceConsentText;
  if (kind === 'quoted') userContent[0]!.text = JSON.stringify(h06TemporalReferenceConsentText);
  if (kind === 'double-lf') userContent[0]!.text += '\n\n';
  if (kind === 'turn') userMeta.turn_id = 'other-turn';
  if (kind === 'content-kind') userMeta.content_item_kinds = ['unknown'];
  if (kind === 'provenance') userMeta.content_item_metadata = [{ provenance: { type: 'agent' } }];
  if (kind === 'borrowed') userMeta.content_item_metadata = [];
  if (kind === 'forwarded')
    s.rows.push({
      record: {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: s.source.turnId },
        },
      },
      ref: { locator: 'delivery', hash: '1'.repeat(64) },
    });
  if (kind === 'previous-user') assistant.role = 'user';
  if (kind === 'missing-assistant') s.rows.splice(1, 1);
  if (kind === 'assistant-role') assistant.role = 'developer';
  if (kind === 'assistant-status') assistant.status = 'in_progress';
  if (kind === 'assistant-phase') assistant.phase = 'commentary';
  if (kind === 'assistant-extra') output.push(output[0]!);
  if (kind === 'assistant-content') output[0]!.type = 'input_text';
  if (kind === 'assistant-text') (output[0] as unknown as Record<string, unknown>).text = null;
  if (kind === 'assistant-turn')
    assistant.internal_chat_message_metadata_passthrough = { turn_id: null };
  if (kind === 'assistant-current-turn')
    assistant.internal_chat_message_metadata_passthrough = { turn_id: s.source.turnId };
  if (kind === 'assistant-grant') output[0]!.text = output[0]!.text.replace('grant/3', 'grant/4');
  if (kind === 'assistant-double-grant') output[0]!.text += '\n```json\n{}\n```';
  if (kind === 'assistant-bare-double-grant') output[0]!.text += '\n' + s.plan.approvedGrantText;
  if (kind === 'assistant-link')
    output[0]!.text = output[0]!.text.replace(s.plan.approvedProposal.path, '/other/proposal.json');
  if (kind === 'assistant-double-link')
    output[0]!.text += `[Other](${s.plan.approvedProposal.path})`;
  if (kind === 'other-transcript') s.rows[1]!.ref.locator = '/different.jsonl#L2';
  expect(() =>
    verifyH06TemporalReferenceApproval(s.plan, s.rows, s.source.source, s.source.turnId),
  ).toThrow();
});

it('plans one combined grant and consumes it before server setup with one inherited native budget', async () => {
  const f = fixture(),
    plan = planH06TemporalAutonomousAuthority(f.input);
  expect(plan).toMatchObject({
    source: null,
    mayRun: false,
    qualification: false,
    budget: f.request.budget,
  });
  expect(JSON.parse(plan.expectedGrantText)).toEqual({
    kind: 'comparison-h06-temporal-autonomous-grant/3',
    acceptanceProfile: 'h06-autonomous-recovery/3',
    variant: 'temporal',
    operationId: f.request.binding.operationId,
    requestHash: plan.requestHash,
    serverSetupHash: plan.serverSetupHash,
    budget: f.request.budget,
  });
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  const source = f.authority(plan.expectedGrantText + '\n'),
    claim = await consumeH06TemporalAutonomousAuthority(f.input, source);
  expect(claim.startedAt).toBeLessThanOrEqual(Date.now());
  expect(claim.stopDeadlineMs - claim.startedAt).toBe(f.request.budget.maxElapsedMs);
  expect(claim.stopDeadlineMs - claim.workDeadlineMs).toBe(f.request.budget.reserveMs);
  expect(existsSync(plan.server.root)).toBe(true);
  const native = openH06TemporalAutonomousNativeClaim(claim.receipt);
  expect(native).toMatchObject({
    startedAt: claim.startedAt,
    workDeadlineMs: claim.workDeadlineMs,
    stopDeadlineMs: claim.stopDeadlineMs,
    grant: { admission: { kind: 'temporal-autonomous/3', authority: claim.receipt } },
  });
  expect(readH06NativeAttemptForReopen(native.receipt)).toMatchObject({
    requestHash: claim.requestHash,
    workDeadlineMs: claim.workDeadlineMs,
    stopDeadlineMs: claim.stopDeadlineMs,
  });
  expect(openH06NativeAttemptTurnLedger(native.receipt).inspect()).toMatchObject({
    status: 'RECORDED',
    used: 0,
  });
  writeFileSync(join(f.request.binding.workspaceRoot, 'evidence', 'manifest.json'), '{}');
  expect(openH06NativeAttemptTurnLedger(native.receipt).inspect()).toMatchObject({
    status: 'RECORDED',
    used: 0,
  });
  expect(() => readH06NativeAttemptForReopen(native.receipt)).toThrow('h06-f01-manifest-present');
  appendFileSync(
    source.transcript,
    JSON.stringify({ type: 'event_msg', payload: { type: 'fixture_append' } }) + '\nunfinished',
  );
  vi.stubEnv('CODEX_THREAD_ID', 'worker-thread');
  expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
  await expect(consumeH06TemporalAutonomousAuthority(f.input, source)).rejects.toThrow();
});

it('allows exactly one concurrent reservation and never resets the shared deadline', async () => {
  const f = fixture(),
    source = f.authority();
  const results = await Promise.allSettled([
    consumeH06TemporalAutonomousAuthority(f.input, source),
    consumeH06TemporalAutonomousAuthority(f.input, source),
  ]);
  expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  const success = results.find(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof consumeH06TemporalAutonomousAuthority>>
    > => result.status === 'fulfilled',
  )!.value;
  const now = vi.spyOn(Date, 'now').mockReturnValue(success.startedAt + 10000);
  expect(readH06TemporalAutonomousAuthority(success.receipt).stopDeadlineMs).toBe(
    success.stopDeadlineMs,
  );
  now.mockRestore();
});

it.each([
  'body',
  'assistant',
  'extra-content',
  'client',
  'environment',
  'source-hash',
  'superseded',
  'completed',
  'delegated',
  'outside',
] as const)('refuses an invalid primary root source before reserving roots: %s', async (kind) => {
  const f = fixture(),
    source = f.authority(),
    rows = readFileSync(source.transcript, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  if (kind === 'body') (rows[3]!.payload.content as { text: string }[])[0]!.text = 'Proceed';
  if (kind === 'assistant') rows[3]!.payload.role = 'assistant';
  if (kind === 'extra-content')
    (rows[3]!.payload.content as unknown[]).push({ type: 'input_text', text: 'extra' });
  if (kind === 'client') rows[0]!.payload.cli_version = '0.154.0';
  if (kind === 'environment') vi.stubEnv('CODEX_THREAD_ID', 'different-root');
  if (kind === 'superseded')
    rows.push({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'New decision' }],
      },
    });
  if (kind === 'completed')
    rows.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: source.turnId } });
  if (kind === 'delegated')
    rows.push({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        namespace: 'codex_app',
        name: 'send_message_to_thread',
        internal_chat_message_metadata_passthrough: { turn_id: source.turnId },
      },
    });
  writeFileSync(source.transcript, rows.map(canonical).join('\n') + '\n');
  source.source.hash = digest(canonical(rows[3]) + '\n');
  if (kind === 'source-hash') source.source.hash = '0'.repeat(64);
  if (kind === 'outside') {
    const path = join(f.root, 'outside.jsonl');
    writeFileSync(path, readFileSync(source.transcript));
    source.transcript = path;
    source.source.locator = path + '#L4';
  }
  await expect(consumeH06TemporalAutonomousAuthority(f.input, source)).rejects.toThrow();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(existsSync(f.request.evidenceRoot + '-server')).toBe(false);
});

it('retains the original human source through an explicit native capacity retry only', async () => {
  const f = fixture(),
    source = f.authority();
  const rows = readFileSync(source.transcript, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  rows.push(
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: source.turnId,
        root_turn_id: source.turnId,
        last_agent_message: null,
        error: { codex_error_info: 'server_overloaded' },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'retry-turn',
        turn_attribution: {
          turn_id: 'retry-turn',
          turn_trigger: 'capacity_retry_manual',
          root_turn_id: 'retry-turn',
          parent_turn_id: null,
          initiating_agent_path: null,
        },
      },
    },
    { type: 'turn_context', payload: { ...rows[2]!.payload, turn_id: 'retry-turn' } },
  );
  writeFileSync(source.transcript, rows.map(canonical).join('\n') + '\n');
  source.source.hash = digest(canonical(rows[3]) + '\n');
  const claim = await consumeH06TemporalAutonomousAuthority(f.input, source);
  expect(claim.grant).toMatchObject({
    sourceTurnId: source.turnId,
    anchor: { turn_id: 'retry-turn' },
  });
  expect(readH06TemporalAutonomousAuthority(claim.receipt)).toEqual(claim);
});

it.each([
  'prefix',
  'native-claim',
  'server-root',
  'reservation',
  'clock',
  'scope',
  'kind',
] as const)('refuses changed issued authority evidence: %s', async (kind) => {
  const f = fixture(),
    source = f.authority(),
    claim = await consumeH06TemporalAutonomousAuthority(f.input, source);
  let receipt = claim.receipt;
  if (kind === 'prefix')
    writeFileSync(source.transcript, readFileSync(source.transcript).subarray(0, 20));
  if (kind === 'native-claim') writeFileSync(claim.nativeClaim.path, '{}');
  if (kind === 'server-root') {
    renameSync(claim.server.root, claim.server.root + '.old');
    mkdirSync(claim.server.root);
  }
  if (kind === 'reservation') writeFileSync(claim.reservation.path, '{}');
  if (kind === 'clock' || kind === 'scope' || kind === 'kind') {
    const changed = JSON.parse(readH04Pin(receipt).toString()) as Record<string, unknown>;
    if (kind === 'clock') changed.startedAt = Date.now() + 10000;
    if (kind === 'scope') changed.requestHash = '0'.repeat(64);
    if (kind === 'kind') changed.kind = 'unknown';
    const bytes = canonical(changed) + '\n';
    writeFileSync(receipt.path, bytes);
    receipt = { path: receipt.path, sha256: digest(bytes) };
  }
  expect(() => readH06TemporalAutonomousAuthority(receipt)).toThrow();
});

it('keeps the manual /2 grant and the single autonomous /3 grant mutually explicit', async () => {
  const f = fixture();
  const manual = f.authority(planH06NativeAttempt(f.request).expectedGrantText);
  await expect(consumeH06TemporalAutonomousAuthority(f.input, manual)).rejects.toThrow(
    'h06-temporal-autonomous-native-body',
  );
  const autonomous = f.authority();
  await expect(beginH06NativeAttempt(f.request, autonomous)).rejects.toThrow(
    'h06-native-attempt-authority-body',
  );
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});
