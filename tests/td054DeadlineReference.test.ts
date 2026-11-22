import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type * as H04Contract from './comparisonH04Contract.js';
import type * as NativeAttemptPlan from './comparisonH06NativeAttemptPlan.js';
import { h06TemporalReferenceConsentText } from './comparisonH06TemporalReferenceApproval.js';
import {
  admitTD054Reference,
  inspectTD054Reference,
  parseTD054ReferenceClaim,
  planTD054ReferenceApproval,
  verifyTD054ReferenceConsent,
} from './td054DeadlineReference.mjs';

const mock = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  journal: Buffer.alloc(0),
  sessions: '',
  observe: vi.fn(),
  hostAnchors: [] as unknown[],
}));
vi.mock('./comparisonH04Contract.js', async (load) => {
  const actual = await load<typeof H04Contract>();
  return {
    ...actual,
    readH04Pin(value: unknown) {
      const pin = actual.h04Pin(value),
        bytes = mock.files.get(pin.path);
      if (bytes === undefined) return actual.readH04Pin(pin);
      expect(digest(bytes)).toBe(pin.sha256);
      return bytes;
    },
  };
});
vi.mock('./comparisonH06NativeAttemptPlan.js', async (load) => ({
  ...(await load<typeof NativeAttemptPlan>()),
  h06NativeSessionsRoot: () => mock.sessions,
}));
vi.mock('./comparisonH06NativeJournal.js', () => ({ readH06NativeJournal: () => mock.journal }));
vi.mock('../adapters/codex/currentChatHost.js', () => ({
  FileCurrentChatHost: class {
    constructor(_root: string, _transcript: string, anchor: unknown) {
      mock.hostAnchors.push(anchor);
    }
    observe = mock.observe;
  },
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  mock.files.clear();
  mock.hostAnchors.splice(0);
  mock.journal = Buffer.alloc(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Pin = { path: string; sha256: string };
type Row = { record: Record<string, unknown>; ref: { locator: string; hash: string } };
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'td054-reference-unit-'));
  roots.push(root);
  mock.sessions = root;
  const transcript = join(root, 'native.jsonl'),
    threadId = 'thread-native',
    turnId = '01a1bcc4-724d-70d0-92ff-b4acf9a0cc6f';
  vi.stubEnv('CODEX_THREAD_ID', threadId);
  const put = (path: string, value: string): Pin => {
    const bytes = Buffer.from(value);
    mock.files.set(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const json = (path: string, value: unknown) => put(path, canonical(value) + '\n');
  const contract = fileURLToPath(new URL('./td054DeadlineContract.mjs', import.meta.url));
  const probe = fileURLToPath(new URL('./td054DeadlineProbe.mjs', import.meta.url));
  const authority = fileURLToPath(new URL('./td054DeadlineReference.mjs', import.meta.url));
  const baseContract = [
    'export async function grants(packet, source) {\n  return literal();\n}\n',
    'function td054ClaimBody(value) {\n  const receipt = value,\n    claim = json(receipt);\n  return claim;\n}\n',
    'export async function readTD054Claim(value) {\n  const claim = td054ClaimBody(value);\n  return claim;\n}\n',
    'export async function readTD054SavedClaim(value) {\n  const claim = td054ClaimBody(value);\n  return claim;\n}\n',
  ].join('');
  const baseProbe =
    'function claim() {\n  const claim = {\n    ...observed,\n  };\n  return claim;\n}\n' +
    'export async function td054DeadlineProbeMain(args) {\n  return literal();\n}\n';
  function insertion(name: string, indent = '') {
    return `${indent}// td054-reference:${name}:begin\n${indent}void reference;\n${indent}// td054-reference:${name}:end\n`;
  }
  const oldContract = put(contract, baseContract),
    oldProbe = put(probe, baseProbe);
  const baselines = [
    { source: oldContract, preserved: put(join(root, 'old-contract'), baseContract) },
    { source: oldProbe, preserved: put(join(root, 'old-probe'), baseProbe) },
  ];
  let newContract = insertion('imports') + baseContract;
  for (const [label, anchor] of [
    ['reference-grants', 'export async function grants(packet, source) {\n'],
    ['reference-body', '    claim = json(receipt);\n'],
    [
      'reference-current',
      'export async function readTD054Claim(value) {\n  const claim = td054ClaimBody(value);\n',
    ],
    [
      'reference-saved',
      'export async function readTD054SavedClaim(value) {\n  const claim = td054ClaimBody(value);\n',
    ],
  ])
    newContract = newContract.replace(anchor!, anchor! + insertion(label!, '  '));
  newContract += insertion('reference-api');
  const newProbe =
    insertion('imports') +
    baseProbe
      .replace(
        '    ...observed,\n  };\n',
        '    ...observed,\n  };\n' + insertion('reference-claim', '  '),
      )
      .replace(
        'export async function td054DeadlineProbeMain(args) {\n',
        'export async function td054DeadlineProbeMain(args) {\n' + insertion('reference-cli', '  '),
      ) +
    insertion('reference-main');
  const critical = put(join(root, 'controlled-reader-and-stop'), 'immutable LOAD/STOP');
  const common = {
    kind: 'td054-native-load-deadline-request/1',
    operationId: 'td054-reference-test',
    evidenceRoot: join(root, 'future-evidence'),
    serverRoot: join(root, 'future-server'),
    input: { unchanged: true },
    chat: { threadId, workspace: root },
    proposedBounds: {
      maxElapsedMs: 90000,
      workWindowMs: 60000,
      stopReserveMs: 27000,
      quietWindowMs: 3000,
      activeLoadByMs: 45000,
      foregroundWaitMs: 120000,
      maxManagedStarts: 1,
      maxInputUncached: 120000,
      maxOutput: 4000,
    },
    scope: { stage: 'deadline-load', noWriter: true, noRetry: true },
    server: { address: '127.0.0.1:17233', httpPort: 17234, metricsPort: 17235 },
    binaryPins: { unchanged: true },
    workspaceFiles: [{ unchanged: true }],
  };
  const approvedBody = { ...common, runtime: [oldContract, oldProbe, critical] };
  const approved = { ...approvedBody, requestHash: digest(canonical(approvedBody)) };
  const approvedPin = json(join(root, 'approved.json'), approved);
  const body = {
    ...common,
    runtime: [
      put(contract, newContract),
      put(probe, newProbe),
      critical,
      put(authority, 'reference code only'),
    ],
  };
  const packet = { ...body, requestHash: digest(canonical(body)) };
  const grantText = canonical({
    kind: 'td054-native-load-deadline-authorization/1',
    native: {
      kind: 'td054-native-load-deadline-grant/1',
      operationId: approved.operationId,
      requestHash: approved.requestHash,
      evidenceRoot: approved.evidenceRoot,
      scope: approved.scope,
      budget: approved.proposedBounds,
    },
    server: {
      kind: 'td054-native-load-deadline-server-grant/1',
      operationId: approved.operationId,
      requestHash: approved.requestHash,
      server: approved.server,
      budget: { maxElapsedMs: 87000, stopReserveMs: 27000 },
    },
  });
  const grant = put(join(root, 'expected-grant.txt'), grantText + '\n');
  const turn = {
    cwd: root,
    model: 'fixture',
    effort: 'medium',
    approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' },
    permission_profile: { type: 'disabled' },
  };
  const meta = (id: string) => ({ turn_id: id });
  const records: Record<string, unknown>[] = [
    {
      type: 'session_meta',
      payload: {
        id: threadId,
        session_id: threadId,
        cwd: root,
        source: 'vscode',
        originator: 'codex_work_desktop',
        thread_source: 'user',
        cli_version: '0.166.0-alpha.6',
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-proposal' } },
    { type: 'turn_context', payload: { ...turn, turn_id: 'turn-proposal' } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-read',
        name: 'exec',
        internal_chat_message_metadata_passthrough: meta('turn-proposal'),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-read',
        internal_chat_message_metadata_passthrough: meta('turn-proposal'),
        output: [
          {
            type: 'input_text',
            text: JSON.stringify({
              status: 'fulfilled',
              value: { exit_code: 0, output: grantText + '\n' },
            }),
          },
          {
            type: 'input_text',
            text: JSON.stringify({
              status: 'fulfilled',
              value: {
                exit_code: 0,
                output: JSON.stringify({
                  run: { expectedGrantTextFile: grant.path, expectedGrantTextSha256: grant.sha256 },
                }),
              },
            }),
          },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        internal_chat_message_metadata_passthrough: meta('turn-proposal'),
        content: [
          { type: 'output_text', text: 'Reviewed [exact numeric envelope](' + grant.path + ')' },
        ],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-proposal' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'turn_context', payload: { ...turn, turn_id: turnId } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: h06TemporalReferenceConsentText + '\n' }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          content_item_kinds: ['user.text'],
          content_item_metadata: [{ provenance: { type: 'user' } }],
        },
      },
    },
  ];
  const rows: Row[] = records.map((record, index) => ({
    record,
    ref: { locator: transcript + '#L' + (index + 1), hash: digest(JSON.stringify(record) + '\n') },
  }));
  mock.journal = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const binding = {
    kind: 'td054-native-load-deadline-reference-binding/2',
    approvedPacket: approvedPin,
    approvedGrant: grant,
    publication: { ...rows[4]!.ref },
    assistant: { ...rows[5]!.ref },
    primary: { transcript, turnId, source: { ...rows[9]!.ref } },
    authorityBaselines: baselines,
  };
  return {
    root,
    packet,
    approved,
    binding,
    rows,
    records,
    critical,
    contract,
    probe,
    authority,
    put,
    json,
    plan: () => planTD054ReferenceApproval(binding, packet),
  };
}

function approveIdentity(f: ReturnType<typeof fixture>, publish = true) {
  const { requestHash: _oldHash, ...body } = f.packet;
  f.packet.requestHash = digest(canonical(body));
  f.binding.approvedPacket = f.json(f.binding.approvedPacket.path, f.packet);
  const grant = {
    kind: 'td054-native-load-deadline-authorization/1',
    native: {
      kind: 'td054-native-load-deadline-grant/1',
      operationId: f.packet.operationId,
      requestHash: f.packet.requestHash,
      evidenceRoot: f.packet.evidenceRoot,
      scope: f.packet.scope,
      budget: f.packet.proposedBounds,
    },
    server: {
      kind: 'td054-native-load-deadline-server-grant/1',
      operationId: f.packet.operationId,
      requestHash: f.packet.requestHash,
      server: f.packet.server,
      budget: {
        maxElapsedMs: f.packet.proposedBounds.workWindowMs + f.packet.proposedBounds.stopReserveMs,
        stopReserveMs: f.packet.proposedBounds.stopReserveMs,
      },
    },
  };
  const grantText = canonical(grant) + '\n';
  f.binding.approvedGrant = f.put(f.binding.approvedGrant.path, grantText);
  f.binding.authorityBaselines = [];
  if (publish) {
    const output = f.records[4]!.payload as { output: { text: string }[] };
    output.output[0]!.text = JSON.stringify({
      status: 'fulfilled',
      value: { exit_code: 0, output: grantText },
    });
    output.output[1]!.text = JSON.stringify({
      status: 'fulfilled',
      value: {
        exit_code: 0,
        output: JSON.stringify({
          run: {
            expectedGrantTextFile: f.binding.approvedGrant.path,
            expectedGrantTextSha256: f.binding.approvedGrant.sha256,
          },
        }),
      },
    });
    f.rows.splice(
      0,
      f.rows.length,
      ...f.records.map((record, index) => ({
        record,
        ref: {
          locator: f.binding.primary.transcript + '#L' + (index + 1),
          hash: digest(JSON.stringify(record) + '\n'),
        },
      })),
    );
    f.binding.publication = { ...f.rows[4]!.ref };
    mock.journal = Buffer.from(f.records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }
}

it('accepts an exactly matching runtime already containing reference authority after fresh publication', async () => {
  const f = fixture();
  f.packet.operationId = 'td054-fresh-identity';
  f.packet.evidenceRoot = join(f.root, 'fresh-identity-evidence');
  f.packet.serverRoot = join(f.root, 'fresh-identity-server');
  approveIdentity(f);
  expect(f.plan()).toMatchObject({
    approvedRequestHash: f.packet.requestHash,
    executionRequestHash: f.packet.requestHash,
    translation: { replaced: [], added: [] },
  });
  const current = await admitTD054Reference(f.binding, f.packet);
  expect(current.nativeGrant.source).toEqual(f.binding.primary.source);
  expect(await inspectTD054Reference(f.binding, f.packet, current.referenceApproval)).toEqual(
    current,
  );
});

it.each([
  'module-only',
  'missing-caller',
  'missing-module',
  'duplicate',
  'current-missing',
  'caller-change',
  'reference-change',
  'foreign-baseline',
  'op',
  'root',
  'bounds',
  'unpinned-file',
])('refuses a nonidentical or incomplete fresh approved runtime: %s', (kind) => {
  const f = fixture();
  if (kind === 'module-only')
    f.packet.runtime = f.packet.runtime.filter((pin) => pin.path === f.authority);
  if (kind === 'missing-caller')
    f.packet.runtime = f.packet.runtime.filter((pin) => pin.path !== f.contract);
  if (kind === 'missing-module')
    f.packet.runtime = f.packet.runtime.filter((pin) => pin.path !== f.authority);
  if (kind === 'duplicate') f.packet.runtime.push(f.packet.runtime[0]!);
  approveIdentity(f);
  if (kind === 'current-missing') f.packet.runtime.pop();
  if (kind === 'caller-change') f.packet.runtime[0] = f.put(f.contract, 'functional caller change');
  if (kind === 'reference-change')
    f.packet.runtime[3] = f.put(f.authority, 'functional reference change');
  if (kind === 'foreign-baseline') {
    const pin = f.put(join(f.root, 'foreign'), 'unrelated baseline');
    f.binding.authorityBaselines.push({ source: pin, preserved: pin });
  }
  if (kind === 'op') f.packet.operationId += '-different';
  if (kind === 'root') f.packet.evidenceRoot += '-different';
  if (kind === 'bounds') f.packet.proposedBounds.maxManagedStarts = 2;
  if (kind === 'unpinned-file')
    f.put(f.authority, 'changed bytes without changing the approved pin');
  const { requestHash: _hash, ...body } = f.packet;
  f.packet.requestHash = digest(canonical(body));
  expect(f.plan).toThrow();
});

it.each(['old-publication', 'publication-after-user', 'forwarded-user', 'new-user'])(
  'keeps genuine approval and latest-user checks for identity mode: %s',
  async (kind) => {
    const f = fixture();
    approveIdentity(f, kind !== 'old-publication');
    if (kind === 'publication-after-user') {
      const publication = f.rows.splice(4, 1)[0]!;
      f.rows.push(publication);
    }
    if (kind === 'forwarded-user') {
      const user = f.records[9]!.payload as {
        internal_chat_message_metadata_passthrough: { content_item_metadata: unknown[] };
      };
      user.internal_chat_message_metadata_passthrough.content_item_metadata = [
        { provenance: { type: 'harness' } },
      ];
    }
    if (kind === 'new-user') {
      appendRecords([genuineFollowup()]);
      await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow();
    } else expect(() => verifyTD054ReferenceConsent(f.plan(), f.packet, f.rows)).toThrow();
  },
);

function environmentRecords(): Record<string, unknown>[] {
  return [
    {
      timestamp: '2026-11-08T21:00:16.206Z',
      ordinal: 49363,
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_01a1bcf6-3bce-7830-a6c7-5c7ff6d7954c',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<environment_context>
  <current_date>2026-11-09</current_date>
  <timezone>Europe/Moscow</timezone>
  <filesystem><workspace_roots><root>/Users/krivega/.codex/visualizations/2026/11/04/01a1a79b-848a-7c82-aa80-b11ae62783e9</root><root>/Users/krivega/workspace/mathematical-detective</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
  <subagents>
    <agent name="/root/t4_current_ready" />
    <agent name="/root/t6_input11_current" />
    <agent name="/root/td054_current_ready" />
    <agent name="/root/actor_readiness" />
    <agent name="/root/actual_t4_scope" />
    <agent name="/root/advance_t6_integration" />
    <agent name="/root/authority_options" />
    <agent name="/root/authority_route" />
  </subagents>
</environment_context>`,
          },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: '01a1bcc4-724d-70d0-92ff-b4acf9a0cc6f',
          create_time: 1794171616.206867,
          content_item_kinds: ['environments.environment_context'],
          content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
        },
      },
    },
    {
      timestamp: '2026-11-08T21:00:16.207Z',
      ordinal: 49364,
      type: 'world_state',
      payload: { full: false, state: { environments: { current_date: '2026-11-09' } } },
    },
  ];
}

function appendRecords(records: Record<string, unknown>[]) {
  mock.journal = Buffer.concat([
    mock.journal,
    Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n'),
  ]);
}

function genuineFollowup() {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'stop' }],
      internal_chat_message_metadata_passthrough: {
        turn_id: '01a1bcc4-724d-70d0-92ff-b4acf9a0cc6f',
        content_item_kinds: ['user.text'],
        content_item_metadata: [{ provenance: { type: 'user' } }],
      },
    },
  };
}

function relatedT4Rows(f: ReturnType<typeof fixture>) {
  const callId = 'call_c17c4889bd5e4e00a73b41822e9893d1';
  const title =
    'Synthetic related T4 b5e4c83b2f64d6d2192f260c70742d4cff2ffa5f67eb44c99e29760d085de0f4 [точный текст допуска](/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2/t4-fresh-service-ready/authorization-draft.txt)';
  const questions = [{ title, options: ['Разрешаю описанный T4', 'Оставить T4 подготовленным'] }];
  const body =
    '<send_user_message_question_reply>\n' +
    JSON.stringify([
      {
        questionItemId: JSON.stringify(['request_user_input_async', callId, 0]),
        question: title,
        answer: 'Разрешаю описанный T4',
      },
    ]) +
    '\n</send_user_message_question_reply>\n';
  const row = (line: number, hash: string, record: Row['record']): Row => ({
    ref: { locator: f.binding.primary.transcript + '#L' + line, hash },
    record,
  });
  // These preverified synthetic rows test semantics; the real raw-hash path is checked read-only.
  const call = row(100001, 'db159b1e09e299ce4e6b944c8dd4eab66acd9ea7a7dabf2d1f08a7c3c837d9e9', {
    type: 'response_item',
    payload: {
      type: 'function_call',
      status: 'completed',
      name: 'request_user_input_async',
      call_id: callId,
      arguments: JSON.stringify({ questions }),
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-proposal' },
    },
  });
  const publication = row(
    100002,
    '7781f743d7311a99986ccf0a1c7e081c0b002c020e75873ce576e7243b3a4a8c',
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: f.packet.chat.threadId,
        turn_id: 'turn-proposal',
        item: {
          type: 'AgentMessage',
          id: callId,
          phase: 'final_answer',
          delivery: 'async',
          questions,
          content: [
            {
              type: 'Text',
              text: title + '\n- Разрешаю описанный T4\n- Оставить T4 подготовленным',
            },
          ],
        },
      },
    },
  );
  const reply = row(100003, 'bd8a82a56ec0acf7d1fdffdcf06201e1e480c551d2136da84fda39d14af2bbfb', {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: body }],
      internal_chat_message_metadata_passthrough: {
        turn_id: f.binding.primary.turnId,
        content_item_kinds: ['user.text'],
        content_item_metadata: [{ provenance: { type: 'user' } }],
      },
    },
  });
  const delivery = row(100004, '549e8152e25428c0b5c78dfce6ecec2f59eb6a4c4cb7fb01ff59aeedc0642b80', {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: f.packet.chat.threadId,
      turn_id: f.binding.primary.turnId,
      item: { type: 'UserMessage', content: [{ type: 'text', text: body, text_elements: [] }] },
    },
  });
  const rows = [...f.rows.slice(0, 5), call, publication, ...f.rows.slice(5), reply, delivery];
  return { rows, call, publication, reply, delivery };
}

it('retains an authenticated related T4 reply separately from the original TD consent', () => {
  const f = fixture(),
    related = relatedT4Rows(f);
  const before = verifyTD054ReferenceConsent(f.plan(), f.packet, f.rows);
  expect(Object.hasOwn(before, 'relatedFollowups')).toBe(false);
  const after = verifyTD054ReferenceConsent(f.plan(), f.packet, related.rows);
  expect(after).toMatchObject({
    sourceText: before.sourceText,
    relatedFollowups: [
      {
        kind: 'VERIFIED_RELATED_T4_FOLLOWUP',
        grantsTD: false,
        startsT4: false,
        originalTDSource: f.binding.primary.source,
        replySource: related.reply.ref,
        deliverySource: related.delivery.ref,
      },
    ],
  });
});

it.each([
  'call-hash',
  'publication-thread',
  'publication-order',
  'request',
  'draft',
  'provenance',
  'turn',
  'answer',
  'delivery',
  'delivery-order',
  'duplicate',
  'new-user',
])('refuses an unauthenticated or superseding related T4 case: %s', (kind) => {
  const f = fixture(),
    related = relatedT4Rows(f);
  const call = related.call.record.payload as { arguments: string };
  const publication = related.publication.record.payload as { thread_id: string };
  const reply = related.reply.record.payload as {
    content: { type: string; text: string }[];
    internal_chat_message_metadata_passthrough: {
      turn_id: string;
      content_item_metadata: unknown[];
    };
  };
  if (kind === 'call-hash') related.call.ref.hash = '0'.repeat(64);
  if (kind === 'publication-thread') publication.thread_id = 'foreign';
  if (kind === 'publication-order') {
    related.rows.splice(related.rows.indexOf(related.publication), 1);
    related.rows.push(related.publication);
  }
  if (kind === 'request') call.arguments = call.arguments.replace('b5e4c83b2f64', 'c5e4c83b2f64');
  if (kind === 'draft')
    call.arguments = call.arguments.replace('authorization-draft.txt', 'other.txt');
  if (kind === 'provenance')
    reply.internal_chat_message_metadata_passthrough.content_item_metadata = [
      { provenance: { type: 'harness', hook: false } },
    ];
  if (kind === 'turn') reply.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
  if (kind === 'answer')
    reply.content[0]!.text = reply.content[0]!.text.replace('Разрешаю описанный T4', 'запускай TD');
  if (kind === 'delivery') related.delivery.ref.hash = '0'.repeat(64);
  if (kind === 'delivery-order') {
    related.rows.splice(related.rows.indexOf(related.delivery), 1);
    related.rows.splice(related.rows.indexOf(related.reply), 0, related.delivery);
  }
  if (kind === 'duplicate') related.rows.push({ ...related.reply });
  if (kind === 'new-user')
    related.rows.push({
      record: genuineFollowup(),
      ref: { locator: f.binding.primary.transcript + '#L100005', hash: '0'.repeat(64) },
    });
  expect(() => verifyTD054ReferenceConsent(f.plan(), f.packet, related.rows)).toThrow();
});

it('leaves older environmental records outside the post-consent allowlist', async () => {
  const f = fixture(),
    prior = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>historical</environment_context>' },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: 'earlier-turn',
          content_item_kinds: ['environments.environment_context'],
          content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
        },
      },
    };
  f.records.splice(1, 0, prior);
  mock.journal = Buffer.from(f.records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  f.binding.publication.locator = f.binding.primary.transcript + '#L6';
  f.binding.assistant.locator = f.binding.primary.transcript + '#L7';
  f.binding.primary.source.locator = f.binding.primary.transcript + '#L11';
  const result = await admitTD054Reference(f.binding, f.packet);
  expect(result.nativeGrant.source).toEqual(f.binding.primary.source);
});

it('recognizes only the authenticated midnight pair without changing consent or saved proof', async () => {
  const f = fixture(),
    before = await admitTD054Reference(f.binding, f.packet),
    environment = environmentRecords();
  expect(environment.map((record) => digest(JSON.stringify(record) + '\n'))).toEqual([
    '3df4b14b33414ae73481a69b0a0c79fa53a8d64f83e30df220136fbc304dcffb',
    '20678157baa9b6a9bd95b322c1b5f34db35d4568fb514cee7590001ed39e173d',
  ]);
  appendRecords(environment);
  const current = await admitTD054Reference(f.binding, f.packet);
  expect(current).toEqual(before);
  expect(await inspectTD054Reference(f.binding, f.packet, current.referenceApproval)).toEqual(
    current,
  );
});

it.each(['provenance', 'world-state', 'missing-state', 'wrong-turn', 'genuine-user', 'duplicate'])(
  'does not hide an unauthorized environmental followup: %s',
  async (kind) => {
    const f = fixture(),
      environment = environmentRecords();
    if (kind === 'provenance') {
      const payload = environment[0]!.payload as {
        internal_chat_message_metadata_passthrough: { content_item_metadata: unknown[] };
      };
      payload.internal_chat_message_metadata_passthrough.content_item_metadata = [
        { provenance: { type: 'user' } },
      ];
    }
    if (kind === 'world-state') environment[1]!.payload = { full: true, state: {} };
    if (kind === 'missing-state') environment.pop();
    if (kind === 'wrong-turn')
      appendRecords([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'foreign' } }]);
    appendRecords(environment);
    if (kind === 'genuine-user') appendRecords([genuineFollowup()]);
    if (kind === 'duplicate') appendRecords(environment);
    await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow();
  },
);

it('accepts the verified environment arriving during observation and rechecks fresh genuine users', async () => {
  const f = fixture();
  mock.observe.mockImplementationOnce(() => appendRecords(environmentRecords()));
  const observed = await admitTD054Reference(f.binding, f.packet);
  expect(observed.nativeGrant.source).toEqual(f.binding.primary.source);
  mock.observe.mockImplementationOnce(() => appendRecords([genuineFollowup()]));
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow(
    'h06-reference-followup-count',
  );
});

it('preserves current host guard failures and refuses a rewritten fresh prefix', async () => {
  const f = fixture();
  mock.observe.mockRejectedValueOnce(new Error('chat-workspace-mismatch'));
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow('chat-workspace-mismatch');
  mock.observe.mockImplementationOnce(() => {
    mock.journal = Buffer.from(mock.journal);
    mock.journal[1] = 32;
  });
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow(
    'td054-reference-current-prefix',
  );
});

it('requires the source native position and refuses a new current turn after observation', async () => {
  const f = fixture();
  mock.observe.mockImplementationOnce(() =>
    appendRecords([{ type: 'turn_context', payload: { turn_id: 'foreign' } }]),
  );
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow(
    'td054-reference-current-turn',
  );
  const other = fixture(),
    source = other.records.pop()!;
  other.records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'foreign' } },
    source,
  );
  mock.journal = Buffer.from(
    other.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  other.binding.primary.source = {
    locator: other.binding.primary.transcript + '#L' + other.records.length,
    hash: digest(JSON.stringify(source) + '\n'),
  };
  await expect(admitTD054Reference(other.binding, other.packet)).rejects.toThrow(
    'chat-human-message-unconfirmed',
  );
});

it('binds the real natural USER text to previously published numbers and preserves raw prefix bytes', async () => {
  const f = fixture(),
    result = await admitTD054Reference(f.binding, f.packet);
  expect(result.referenceApproval).toMatchObject({
    kind: 'td054-actual-reference-consent/2',
    approvedRequestHash: f.approved.requestHash,
    executionRequestHash: f.packet.requestHash,
    sourceText: h06TemporalReferenceConsentText + '\n',
  });
  expect(result.nativeGrant.source).toEqual(f.binding.primary.source);
  expect(result.serverGrant).toEqual(result.nativeGrant);
  expect(mock.observe).toHaveBeenCalledOnce();
  const old = result.referenceApproval;
  mock.journal = Buffer.concat([
    mock.journal,
    Buffer.from(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stop' }] },
      }) + '\n',
    ),
  ]);
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow();
  expect((await inspectTD054Reference(f.binding, f.packet, old)).referenceApproval).toEqual(old);
});

it.each(['budget', 'root', 'LOAD', 'binary'] as const)(
  'refuses an operational %s change even with a valid new execution hash',
  (kind) => {
    const f = fixture();
    if (kind === 'budget') f.packet.proposedBounds.maxManagedStarts = 2;
    if (kind === 'root') f.packet.evidenceRoot += '-new';
    if (kind === 'LOAD') f.packet.input.unchanged = false;
    if (kind === 'binary') f.packet.binaryPins.unchanged = false;
    const { requestHash: _old, ...body } = f.packet;
    f.packet.requestHash = digest(canonical(body));
    expect(f.plan).toThrow('td054-reference-operational-change');
  },
);

it.each(['stage', 'unlisted', 'body', 'position', 'baseline'] as const)(
  'refuses unauthorized source translation: %s',
  (kind) => {
    const f = fixture();
    if (kind === 'stage') f.packet.runtime[2] = f.put(f.critical.path, 'altered STOP');
    if (kind === 'unlisted') f.packet.runtime.push(f.put(join(f.root, 'unexpected'), 'extra'));
    if (kind === 'body' || kind === 'position') {
      const bytes = mock.files.get(f.contract)!.toString();
      const text =
        kind === 'body'
          ? bytes.replace('return literal();', 'return bypass();')
          : bytes.replace(
              'export async function grants(packet, source) {\n',
              'export async function grants(packet, source) {\n  changed();\n',
            );
      f.packet.runtime[0] = f.put(f.contract, text);
    }
    if (kind === 'baseline')
      f.binding.authorityBaselines[0]!.preserved = f.put(
        join(f.root, 'wrong-baseline'),
        'replacement',
      );
    const { requestHash: _old, ...body } = f.packet;
    f.packet.requestHash = digest(canonical(body));
    expect(f.plan).toThrow();
  },
);

it.each([
  'source-hash',
  'foreign-transcript',
  'link',
  'publication-text',
  'publication-hash',
  'assistant-phase',
  'forwarded',
  'wrong-role',
  'foreign-chat',
  'superseded',
] as const)('refuses a changed primary binding: %s', (kind) => {
  const f = fixture();
  if (kind === 'source-hash') f.binding.primary.source.hash = '0'.repeat(64);
  if (kind === 'foreign-transcript') f.binding.primary.transcript += '-foreign';
  const assistant = f.records[5]!.payload as { phase: string; content: { text: string }[] };
  const output = f.records[4]!.payload as { output: { text: string }[] };
  const user = f.records[9]!.payload as {
    role: string;
    internal_chat_message_metadata_passthrough: { content_item_metadata: unknown[] };
  };
  if (kind === 'link') assistant.content[0]!.text = '[different](/another-grant)';
  if (kind === 'publication-text')
    output.output[0]!.text = JSON.stringify({
      status: 'fulfilled',
      value: { exit_code: 0, output: '{}' },
    });
  if (kind === 'publication-hash')
    output.output[1]!.text = JSON.stringify({
      status: 'fulfilled',
      value: {
        exit_code: 0,
        output: JSON.stringify({
          run: {
            expectedGrantTextFile: f.binding.approvedGrant.path,
            expectedGrantTextSha256: '0'.repeat(64),
          },
        }),
      },
    });
  if (kind === 'assistant-phase') assistant.phase = 'commentary';
  if (kind === 'forwarded')
    user.internal_chat_message_metadata_passthrough.content_item_metadata = [
      { provenance: { type: 'harness' } },
    ];
  if (kind === 'wrong-role') user.role = 'assistant';
  if (kind === 'foreign-chat') f.packet.chat.threadId = 'foreign';
  if (kind === 'superseded')
    f.rows.push({
      record: {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stop' }] },
      },
      ref: { locator: f.binding.primary.transcript + '#L11', hash: '0'.repeat(64) },
    });
  expect(() => verifyTD054ReferenceConsent(f.plan(), f.packet, f.rows)).toThrow();
});

it('requires the actual root thread and refuses rewritten historical prefixes', async () => {
  const f = fixture(),
    proof = await inspectTD054Reference(f.binding, f.packet);
  vi.stubEnv('CODEX_THREAD_ID', 'different-thread');
  await expect(admitTD054Reference(f.binding, f.packet)).rejects.toThrow(
    'td054-reference-current-thread',
  );
  mock.journal[1] = 32;
  await expect(inspectTD054Reference(f.binding, f.packet, proof.referenceApproval)).rejects.toThrow(
    'td054-reference-prefix',
  );
});

it('binds a reference claim to the original one-shot root and unchanged clock arithmetic', () => {
  const f = fixture(),
    startedAt = Date.now() - 1;
  const body = {
    kind: 'td054-native-load-deadline-reference-claim/2',
    packet: f.packet,
    startedAt,
    workDeadlineMs: startedAt + 60000,
    stopDeadlineMs: startedAt + 87000,
    finalDeadlineMs: startedAt + 90000,
    nativeGrant: {},
    serverGrant: {},
    referenceApproval: { kind: 'td054-actual-reference-consent/2' },
  };
  const path = join(f.packet.evidenceRoot, 'attempt-claim.json');
  expect(parseTD054ReferenceClaim(f.json(path, body))).toMatchObject({ kind: body.kind });
  expect(() =>
    parseTD054ReferenceClaim(f.json(path, { ...body, finalDeadlineMs: startedAt + 180000 })),
  ).toThrow();
  expect(() => parseTD054ReferenceClaim(f.json(join(f.root, 'other-claim.json'), body))).toThrow();
});

it('keeps the original consent anchor after an existing valid capacity retry and verifies current host separately', async () => {
  const f = fixture(),
    sourceTurn = f.binding.primary.turnId,
    retry = 'turn-capacity-retry';
  const context = f.records[8]!.payload as Record<string, unknown>;
  const later = [
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: sourceTurn,
        root_turn_id: sourceTurn,
        last_agent_message: null,
        error: { codex_error_info: 'server_overloaded' },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: retry,
        turn_attribution: {
          turn_id: retry,
          turn_trigger: 'capacity_retry_manual',
          root_turn_id: retry,
          parent_turn_id: null,
          initiating_agent_path: null,
        },
      },
    },
    { type: 'turn_context', payload: { ...context, turn_id: retry } },
  ];
  mock.journal = Buffer.concat([
    mock.journal,
    Buffer.from(later.map((row) => JSON.stringify(row)).join('\n') + '\n'),
  ]);
  const current = await admitTD054Reference(f.binding, f.packet);
  expect(mock.hostAnchors.at(-1)).toMatchObject({ turn_id: retry });
  expect(mock.observe).toHaveBeenCalledOnce();
  const saved = await inspectTD054Reference(f.binding, f.packet, current.referenceApproval);
  expect(saved).toEqual(current);
  expect(current.nativeGrant.anchor).toMatchObject({ turn_id: sourceTurn });
});
