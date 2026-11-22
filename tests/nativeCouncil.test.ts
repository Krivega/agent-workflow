import { execFileSync } from 'node:child_process';
import { readArtifactFile } from '../adapters/storage/sharedArtifacts.js';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { verifyNativeReview } from '../adapters/codex/appServerCouncil.js';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import {
  councilReviewBrief,
  nativeCouncilReviewBrief,
} from '../adapters/codex/councilReviewBrief.js';
import { inspectChatPeer } from '../adapters/codex/chatPeer.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { observeChatCouncil } from '../application/chatCouncil.js';
import {
  councilReviewRequest,
  createCouncil,
  repeatCouncil,
  revisePlanning,
} from '../core/council.js';
import type { DataAnswer } from '../core/dataRoute.js';
import type { InputRef } from '../core/localRun.js';
import { workflowFixture } from './workflowFixtures.js';
import { saveCouncilRequestFile } from '../adapters/codex/councilRequestFile.js';
import { councilRoleView } from '../adapters/codex/councilRequestFile.js';
import { runChatCommand } from '../cli/chatCommand.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let out: string;
beforeEach(async () => {
  f = await workflowFixture();
  out = await realpath(await mkdtemp(resolve(tmpdir(), 'native-council-')));
});
afterEach(async () => {
  await f.dispose();
  await rm(out, { recursive: true, force: true });
});

async function proof(value: unknown): Promise<InputRef> {
  const content = JSON.stringify(value) + '\n';
  const hash = contentHash(content);
  const locator = resolve(out, `${hash}.json`);
  await writeFile(locator, content);
  return { locator, hash };
}

async function nativeCouncil() {
  const run = structuredClone(f.adviser);
  const council = createCouncil('planning', f.selection, f.target);
  const lines = await Promise.all(
    [...run.spec.procedures, ...run.spec.rules].map(async (ref) =>
      JSON.stringify({
        path: ref.locator,
        sha256: ref.hash,
        content: await readFile(resolve(f.root, ref.locator), 'utf8'),
      }),
    ),
  );
  const load: Record<string, unknown> = {
    id: 'load',
    status: 'completed',
    items: [{ type: 'commandExecution', exitCode: 0, aggregatedOutput: lines.join('\n') }],
  };
  const thread = {
    id: 'session',
    path: resolve(f.root, 'child.jsonl'),
    turns: [] as Record<string, unknown>[],
    cwd: f.root,
    projectId: 'project',
    parentThreadId: null,
    forkedFromId: null,
    source: 'vscode',
    cliVersion: '0.162.0-alpha.17.2',
    name: 'Советник: Архитектор',
  };
  await f.file(
    'child.jsonl',
    [
      {
        type: 'session_meta',
        payload: {
          id: 'session',
          session_id: 'session',
          cwd: f.root,
          cli_version: thread.cliVersion,
          thread_source: null,
          source: 'vscode',
        },
      },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'load',
          cwd: f.root,
          model: run.spec.requested.model,
          effort: 'high',
          approval_policy: 'never',
          sandbox_policy: { type: 'read-only' },
          permission_profile: {
            type: 'managed',
            file_system: { type: 'restricted', entries: [{ access: 'read' }] },
            network: 'restricted',
          },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const started = {
    thread: structuredClone(thread),
    cwd: f.root,
    model: run.spec.requested.model,
    reasoningEffort: run.spec.requested.effort,
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return structuredClone(started);
      if (params.threadId === 'principal')
        return { thread: { id: 'principal', cwd: f.root, projectId: 'project' } };
      return { thread };
    }),
    completed: vi.fn(async () => undefined),
  };
  const sessions = new AppServerSessions(rpc, f.root, 'project', out);
  const created = await sessions.create({ ...run.spec.requested, reason: 'architect' });
  thread.turns.push(load);
  const roles = {
    project_id: 'project',
    peer_observations: {
      session: {
        root: f.root,
        transcript: resolve(f.root, 'child.jsonl'),
        anchor: { thread_id: 'session', turn_id: 'load', host_id: 'local', workspace: f.root },
      },
    },
  };
  const inspect = (id: string) => inspectChatPeer(rpc, roles, id, out, undefined, 'project');
  const session = await inspect('session');
  run.loaded!.native = await sessions.observeLoad(created, f.query, 'load');
  run.loaded!.origin = run.loaded!.native;
  rpc.request.mockClear();
  const request = councilReviewRequest(council, 'architect', run);
  const raw = f.answer(council);
  const data: DataAnswer = {
    outcome: 'PASS',
    coverage: 'complete',
    scope: [f.target.scope],
    sources: raw.sources,
    content: JSON.stringify(raw),
    limitations: ['isolated native protocol fixture'],
    continuation: null,
    evidence: f.proof,
  };
  const userMessage = {
    type: 'userMessage',
    content: [{ type: 'text', text: councilReviewBrief(request) + 'Review the exact target.' }],
  };
  const answer: Record<string, unknown> = {
    id: 'answer',
    status: 'completed',
    items: [userMessage, { type: 'agentMessage', text: JSON.stringify(data) }],
  };
  thread.turns.push(answer);
  const polled = await sessions.poll(session, 'answer');
  if (polled.status !== 'completed') throw new Error('fixture answer missing');
  const evidence = polled.answer.evidence;
  const inputs = new FileWorkflowInputs(f.root, out);
  const verify = () => sessions.verifyReview(session, request, 'answer', evidence);
  const observe = async (selected = council, nextRun = run, turn = 'answer') => {
    const transcript = resolve(f.root, 'child.jsonl');
    const records = (await readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    records.find((record) => record.type === 'turn_context')!.payload.turn_id = turn;
    await writeFile(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    roles.peer_observations.session.anchor.turn_id = turn;
    return observeChatCouncil(
      selected,
      'architect',
      nextRun,
      turn,
      'principal',
      {
        inspect,
        poll: sessions.poll.bind(sessions),
        verifyReview: sessions.verifyReview.bind(sessions),
      },
      inputs,
    );
  };
  return {
    run,
    council,
    session,
    sessions,
    request,
    thread,
    load,
    answer,
    userMessage,
    evidence,
    verify,
    observe,
    rpc,
    created,
  };
}

it('verifies a retained LOAD in the task evidence root and binds the answer to the new review directory', async () => {
  const n = await nativeCouncil();
  const original = await verifyNativeReview(
    n.rpc,
    out,
    n.session,
    n.request,
    'answer',
    n.evidence,
    (_name, value) => proof(value),
  );
  expect(original.answer_evidence).toEqual(n.evidence);
  const directory = await mkdtemp(resolve(out, 'review-'));
  const sessions = new AppServerSessions(n.rpc, f.root, 'project', directory, null, 'project', out);
  const file = await saveCouncilRequestFile(directory, n.request);
  n.userMessage.content[0]!.text = councilReviewBrief(n.request, file);
  const result = await sessions.poll(n.session, 'answer');
  if (result.status !== 'completed') throw new Error('fixture answer missing');
  const binding = await sessions.verifyReview(
    n.session,
    n.request,
    'answer',
    result.answer.evidence,
  );
  expect(binding.request_file).toEqual(file);
  await expect(sessions.verifyReview(n.session, n.request, 'answer', n.evidence)).rejects.toThrow(
    'unsafe-locator',
  );
  const foreign = {
    ...n.request,
    load: { ...n.request.load, locator: resolve(f.root, 'foreign') },
  };
  await expect(
    sessions.verifyReview(n.session, foreign, 'answer', result.answer.evidence),
  ).rejects.toThrow('unsafe-locator');
});

async function compactCouncil() {
  const n = await nativeCouncil();
  const file = await saveCouncilRequestFile(out, n.request);
  n.userMessage.content[0]!.text = councilReviewBrief(n.request, file);
  const message = (n.answer.items as { type: string; text?: string }[])[1]!;
  const data = JSON.parse(message.text!) as { content: string };
  const raw = JSON.parse(data.content) as Record<string, unknown>;
  delete raw.target;
  raw.target_ref = file;
  data.content = JSON.stringify(raw);
  message.text = JSON.stringify(data);
  return { ...n, file, raw, data, message };
}

it('binds a compact native answer to every original target input and preserves the complete request', async () => {
  const n = await compactCouncil();
  expect(await saveCouncilRequestFile(out, n.request)).toEqual(n.file);
  expect(readArtifactFile(n.file.locator)).toEqual(n.request);
  const accepted = (await n.observe()).advisers.architect!.answer!;
  expect(accepted.target).toEqual(n.request.target);
  expect(accepted.binding!.request).toEqual(n.request);
  expect(accepted.binding!.request_file).toEqual(n.file);
});

it.each([false, true])(
  'reads role context without expanding the global target, evidence=%s',
  async (evidence) => {
    const n = await nativeCouncil();
    const full = {
      ...n.request,
      target: {
        ...n.request.target,
        inputs: {
          ...n.request.target.inputs,
          inputs: Array.from({ length: 2188 }, (_, i) => ({
            locator: `archive/${i}.png`,
            hash: 'a'.repeat(64),
          })),
        },
        ...(evidence ? { evidence_inputs: n.request.target.inputs } : {}),
      },
    };
    const ref = await saveCouncilRequestFile(out, full);
    const output: string[] = [],
      errors: string[] = [];
    expect(
      await runChatCommand(
        ['read-artifact', ref.locator + '.role.ref.json'],
        (s) => output.push(s),
        (s) => errors.push(s),
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    const view = councilRoleView(full, ref);
    const portable = { ...full, reader: 'runtime-cli' as const };
    const portableRef = await saveCouncilRequestFile(out, portable);
    const {
      request_reader: [file, ...args],
    } = JSON.parse(
      councilReviewBrief(portable, portableRef).slice('Council review request file: '.length),
    ) as { request_reader: [string, ...string[]] };
    expect(JSON.parse(execFileSync(file, args, { cwd: out, encoding: 'utf8' }))).toEqual(
      councilRoleView(portable, portableRef),
    );
    expect(JSON.parse(output[0]!)).toEqual(view);
    expect(view.inputs).toEqual(full.inputs);
    expect(view.requirements).toEqual(full.requirements);
    expect(view.target.inputs).toEqual({ request_file: ref, field: 'target.inputs', count: 2188 });
    if (evidence)
      expect(view.target.evidence_inputs).toMatchObject({ field: 'target.evidence_inputs' });
    expect(output[0]!.length).toBeLessThan(JSON.stringify(full).length / 4);
    output.length = 0;
    expect(
      await runChatCommand(
        ['read-artifact', ref.locator + '.ref.json'],
        (s) => output.push(s),
        (s) => errors.push(s),
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual(full);
    await writeFile(ref.locator + '.role.ref.json', JSON.stringify({ ...ref, view: 'unknown' }));
    expect(
      await runChatCommand(
        ['read-artifact', ref.locator + '.role.ref.json'],
        (s) => output.push(s),
        (s) => errors.push(s),
      ),
    ).toBe(1);
    expect(errors).toEqual(['unsupported-artifact-view']);
    await expect(saveCouncilRequestFile(out, full)).rejects.toThrow(
      'council-request-file-conflict',
    );
  },
);

it('keeps a 2188-file native instruction small without dropping files from its immutable request', async () => {
  const n = await nativeCouncil();
  const inputs = Array.from({ length: 2188 }, (_, i) => ({
    locator: `prototypes/godot-g1/${'source-directory/'.repeat(9)}${i}.png`,
    hash: 'a'.repeat(64),
  }));
  const manifest = {
    ...n.request.inputs,
    inputs,
    discovery_rule: JSON.stringify({ files: inputs.map((f) => f.locator), directories: [] }),
  };
  const request = {
    ...n.request,
    inputs: manifest,
    target: { ...n.request.target, inputs: manifest },
  };
  expect(councilReviewBrief(request).length).toBeGreaterThan(1_048_576);
  const file = await saveCouncilRequestFile(out, request);
  expect(councilReviewBrief(request, file).length).toBeLessThan(20_000);
  expect(readArtifactFile(file.locator)).toEqual(request);
});

it.each(['changed', 'missing', 'foreign-reference', 'mixed-target', 'changed-marker'])(
  'refuses compact native request/answer tampering: %s',
  async (kind) => {
    const n = await compactCouncil();
    if (kind === 'changed') await writeFile(n.file.locator, '{}\n');
    if (kind === 'missing') await rm(n.file.locator);
    if (kind === 'foreign-reference') n.raw.target_ref = { ...n.file, hash: 'changed' };
    if (kind === 'mixed-target') n.raw.target = n.request.target;
    if (kind === 'changed-marker')
      n.userMessage.content[0]!.text = councilReviewBrief(n.request, {
        ...n.file,
        hash: 'changed',
      });
    n.data.content = JSON.stringify(n.raw);
    n.message.text = JSON.stringify(n.data);
    await expect(n.observe()).rejects.toThrow();
  },
);

it('refuses a target reference without a native request-file binding', async () => {
  const n = await compactCouncil();
  n.userMessage.content[0]!.text = councilReviewBrief(n.request);
  await expect(n.observe()).rejects.toThrow('chat-role-target-reference-mismatch');
});

it('preserves a conflicting request file and rejects other write errors', async () => {
  const n = await compactCouncil();
  await writeFile(n.file.locator, 'foreign bytes');
  await expect(saveCouncilRequestFile(out, n.request)).rejects.toThrow(
    'council-request-file-conflict',
  );
  expect(await readFile(n.file.locator, 'utf8')).toBe('foreign bytes');
  await expect(saveCouncilRequestFile(resolve(out, 'missing'), n.request)).rejects.toThrow(
    'council-request-file-conflict',
  );
});

it('accepts only native LOAD → exact request → response and preserves native proof rather than model binding', async () => {
  const n = await nativeCouncil();
  const result = await n.observe();
  const accepted = result.advisers.architect!.answer!;
  expect(accepted.binding).toMatchObject({
    request: n.request,
    load_turn: 'load',
    answer_turn: 'answer',
    answer_evidence: n.evidence,
  });
  expect(readArtifactFile(accepted.binding!.evidence.locator)).toEqual({
    request: n.request,
    origin: {
      load: readArtifactFile(n.request.origin.locator) as unknown,
      creation: readArtifactFile(n.created.receipt.locator) as unknown,
      turn: n.load,
    },
    load: n.load,
    answer: n.answer,
  });
  expect(accepted.binding!.evidence).not.toEqual(f.proof);
  await expect(n.observe(repeatCouncil(result, f.target, ['architect']))).rejects.toThrow(
    'review-turn-already-used',
  );
  const next = { ...n.answer, id: 'next' };
  n.thread.turns.push(next);
  const repeated = await n.observe(repeatCouncil(result, f.target, ['architect']), n.run, 'next');
  expect(repeated.history).toHaveLength(1);
  expect(repeated.review_turns).toHaveLength(2);
  expect(repeated.advisers.architect!.run.spec.session_id).toBe('session');
  expect(repeated.advisers.architect!.run.loaded!.origin).toEqual(n.request.origin);
  expect(n.rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
});

it('reuses only a native verified LOAD still present after the last compaction', async () => {
  const n = await nativeCouncil();
  const receipt = n.run.loaded!.native!;
  expect(await n.sessions.reuseLoad(n.session, f.query, receipt)).toEqual(receipt);
  expect(n.rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
  n.thread.turns.push({
    id: 'compacted',
    status: 'completed',
    items: [{ type: 'contextCompaction' }],
  });
  expect(await n.sessions.reuseLoad(n.session, f.query, receipt)).toBeNull();
  n.thread.turns.pop();
  (n.answer.items as unknown[]).push({ type: 'contextCompaction' });
  await expect(n.verify()).rejects.toThrow('native-load-compacted');
});

it('rejects incomplete or still-running native history instead of assuming the loaded context survived', async () => {
  const n = await nativeCouncil();
  const receipt = n.run.loaded!.native!;
  n.thread.turns.push({ id: 'unknown', status: 'completed' });
  await expect(n.sessions.reuseLoad(n.session, f.query, receipt)).rejects.toThrow(
    'native-load-history-unconfirmed',
  );
  n.thread.turns.pop();
  n.thread.turns.push({ id: 'running', status: 'inProgress', items: [] });
  await expect(n.sessions.reuseLoad(n.session, f.query, receipt)).rejects.toThrow(
    'native-load-history-unconfirmed',
  );
  n.thread.turns.pop();
  n.thread.turns.splice(1, 0, { id: 'unknown', status: 'completed' });
  await expect(n.verify()).rejects.toThrow('native-load-history-unconfirmed');
  n.thread.turns.splice(1, 1, { id: 'running', status: 'inProgress', items: [] });
  await expect(n.verify()).rejects.toThrow('native-load-history-unconfirmed');
});

it.each(['hash', 'session', 'refs', 'thread', 'duplicate', 'missing', 'read'])(
  'rejects %s corruption when attempting to reuse LOAD',
  async (kind) => {
    const n = await nativeCouncil();
    let receipt = n.run.loaded!.native!;
    if (kind === 'hash') receipt = { ...receipt, hash: 'changed' };
    if (kind === 'session' || kind === 'refs') {
      const saved = readArtifactFile(receipt.locator) as Record<string, unknown>;
      receipt = await proof({
        ...saved,
        [kind === 'session' ? 'session' : 'refs']: kind === 'session' ? 'foreign' : [],
      });
    }
    if (kind === 'thread') n.thread.id = 'foreign';
    if (kind === 'duplicate') n.thread.turns.push(n.load);
    if (kind === 'missing') n.thread.turns.shift();
    if (kind === 'read') n.load.items = [];
    await expect(n.sessions.reuseLoad(n.session, f.query, receipt)).rejects.toThrow();
  },
);

it('keeps the original empty-session witness through acceptance and a new observed LOAD', async () => {
  const n = await nativeCouncil();
  await n.observe();
  const acceptance = createCouncil('acceptance', f.selection, f.target);
  const run = structuredClone(n.run);
  n.thread.turns.push({ ...n.load, id: 'acceptance-load' });
  run.loaded!.native = await n.sessions.observeLoad(n.session, f.query, 'acceptance-load');
  expect(readArtifactFile(run.loaded!.native.locator)).not.toHaveProperty('creation');
  const request = councilReviewRequest(acceptance, 'architect', run);
  n.thread.turns.push({
    ...n.answer,
    id: 'acceptance-answer',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: councilReviewBrief(request) }] },
      (n.answer.items as unknown[])[1],
    ],
  });
  const result = await n.observe(acceptance, run, 'acceptance-answer');
  expect(result.advisers.architect!.run.spec.session_id).toBe(n.session.id);
  expect(result.advisers.architect!.run.loaded!.origin).toEqual(n.request.origin);
  expect(result.advisers.architect!.answer!.binding!.request).toEqual(request);
});

it('requires the original creation/first LOAD witness and rejects missing, changed or foreign evidence', async () => {
  const n = await nativeCouncil();
  const verify = (origin: InputRef | undefined) =>
    n.sessions.verifyReview(n.session, { ...n.request, origin: origin! }, 'answer', n.evidence);
  const original = readArtifactFile(n.request.origin.locator) as {
    session: string;
    turn: string;
    refs: InputRef[];
    creation: InputRef;
  };
  await expect(verify(undefined)).rejects.toThrow('native-council-origin-required');
  delete n.run.loaded!.origin;
  await expect(n.observe()).rejects.toThrow('native-council-origin-required');
  await expect(verify({ ...n.request.origin, hash: 'changed' })).rejects.toThrow(
    'native-council-origin-changed',
  );
  for (const patch of [{ session: 'foreign' }, { refs: null }, { refs: [] }])
    await expect(verify(await proof({ ...original, ...patch }))).rejects.toThrow(
      'native-council-origin-mismatch',
    );
  await expect(verify(await proof({ ...original, turn: 'answer' }))).rejects.toThrow(
    'native-council-history-not-empty',
  );
  await expect(
    verify(await proof({ ...original, creation: { ...original.creation, hash: 'changed' } })),
  ).rejects.toThrow('native-council-creation-changed');
  await expect(verify(await proof({ ...original, creation: undefined }))).rejects.toThrow();
  await expect(
    verify(await proof({ ...original, refs: [{ locator: 'not-read', hash: 'unknown' }] })),
  ).rejects.toThrow('procedure-read-unconfirmed');
});

it.each([
  ['operation', 'thread/resume'],
  ['parent', { id: 'principal' }],
  ['session.thread.id', 'foreign'],
  ['session.thread.projectId', 'foreign'],
  ['session.thread.parentThreadId', 'principal'],
  ['session.thread.forkedFromId', 'principal'],
  ['session.thread.turns', [{ id: 'earlier' }]],
  ['session.thread.turns', null],
  ['session.thread.cwd', '/foreign'],
  ['session.cwd', '/foreign'],
  ['session.model', 'other'],
  ['session.reasoningEffort', 'other'],
  ['session.approvalPolicy', 'on-request'],
  ['session.sandbox.type', 'dangerFullAccess'],
  ['session.sandbox.networkAccess', true],
  ['session.sandbox.networkAccess', undefined],
])('rejects creation proof with unconfirmed %s = %j', async (path, value) => {
  const n = await nativeCouncil();
  const creation = readArtifactFile(n.created.receipt.locator) as Record<string, unknown>;
  const keys = String(path).split('.');
  let target = creation;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  const origin = readArtifactFile(n.request.origin.locator) as Record<string, unknown>;
  const request = {
    ...n.request,
    origin: await proof({ ...origin, creation: await proof(creation) }),
  };
  await expect(n.sessions.verifyReview(n.session, request, 'answer', n.evidence)).rejects.toThrow(
    'native-council-creation-unconfirmed',
  );
});

it('rejects unrelated history before the first council LOAD despite a safe answer and exact brief', async () => {
  const n = await nativeCouncil();
  n.thread.turns.unshift({
    id: 'unrelated-earlier-work',
    status: 'completed',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Unrelated earlier task' }] },
      { type: 'agentMessage', text: 'Earlier conclusions remain in the session context' },
    ],
  });
  await expect(n.observe()).rejects.toThrow('native-council-history-not-empty');
  expect(n.council.advisers).toEqual({});
  expect(n.rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
});

it('rejects a fictitious LOAD even when all claimed profile hashes and observed_read are correct', async () => {
  const n = await nativeCouncil();
  n.run.loaded!.observed_read = 'NONEXISTENT-NATIVE-LOAD';
  delete n.run.loaded!.native;
  await expect(n.observe()).rejects.toThrow('native-council-load-required');
  const fake = JSON.stringify({ session: 'session', turn: 'imaginary', refs: n.request.reads });
  const locator = resolve(out, 'fabricated.json');
  await writeFile(locator, fake);
  n.run.loaded!.native = { locator, hash: contentHash(fake) };
  await expect(n.observe()).rejects.toThrow('review-before-load');
  n.run.loaded!.native = n.request.load;
  n.load.items = [{ type: 'agentMessage', text: 'I read all required files' }];
  await expect(n.observe()).rejects.toThrow('procedure-read-unconfirmed');
});

it('cannot rebind an old answer to a changed profile, phase, brief or LOAD', async () => {
  const n = await nativeCouncil();
  const original = await n.observe();
  await f.file(f.profiles.architect[1]!.locator, '# Revised expertise\n');
  const changed = await f.ref(f.profiles.architect[1]!.locator);
  const requirements = [f.proof, f.profiles.architect[0]!, changed];
  const next = revisePlanning(
    original,
    { ...f.selection, architect: { ...f.selection.architect, requirements } },
    f.target,
  );
  const rules = [...f.spec.rules, f.profiles.architect[0]!, changed];
  const refreshed = structuredClone(n.run);
  refreshed.spec.rules = rules;
  refreshed.spec.sources = [...f.spec.sources, ...f.profiles.architect.slice(0, 1), changed];
  refreshed.loaded!.rules = rules;
  const newLoad = structuredClone(n.load);
  newLoad.id = 'reload';
  newLoad.items = [
    {
      type: 'commandExecution',
      exitCode: 0,
      aggregatedOutput: (
        await Promise.all(
          [...refreshed.spec.procedures, ...rules].map(async (ref) =>
            JSON.stringify({
              path: ref.locator,
              sha256: ref.hash,
              content: await readFile(resolve(f.root, ref.locator), 'utf8'),
            }),
          ),
        )
      ).join('\n'),
    },
  ];
  n.thread.turns.push(newLoad);
  const receipt = JSON.stringify({
    session: 'session',
    turn: 'reload',
    refs: [...refreshed.spec.procedures, ...rules].map(({ locator, hash }) => ({ locator, hash })),
  });
  const locator = resolve(out, 'reload.json');
  await writeFile(locator, receipt);
  refreshed.loaded!.native = { locator, hash: contentHash(receipt) };
  await expect(n.observe(next, refreshed)).rejects.toThrow('review-before-load');
  // Copying an old answer to a later turn still carries the original request revision.
  n.thread.turns.push({ ...n.answer, id: 'copied' });
  await expect(n.observe(next, refreshed, 'copied')).rejects.toThrow(
    'native-review-request-mismatch',
  );
  for (const request of [
    { ...n.request, phase: 'acceptance' as const },
    { ...n.request, assignment: changed },
    { ...n.request, requirements },
  ])
    await expect(n.sessions.verifyReview(n.session, request, 'answer', n.evidence)).rejects.toThrow(
      'native-review-request-mismatch',
    );
  const renewed = councilReviewRequest(next, 'architect', refreshed);
  const content = {
    type: 'userMessage',
    content: [
      {
        type: 'text',
        text: `Workflow delivery id: "repeat"\n${councilReviewBrief(renewed)}Review again.`,
      },
    ],
  };
  n.thread.turns.push({
    ...n.answer,
    id: 'renewed',
    items: [content, (n.answer.items as unknown[])[1]],
  });
  const renewedResult = await n.observe(next, refreshed, 'renewed');
  expect(renewedResult.history).toHaveLength(1);
  expect(renewedResult.review_turns).toHaveLength(2);
  expect(refreshed.loaded!.origin).toEqual(n.request.origin);
});

it('rejects changed or foreign LOAD receipts and missing native history', async () => {
  const n = await nativeCouncil();
  await expect(
    n.sessions.verifyReview({ ...n.session, id: 'other' }, n.request, 'answer', n.evidence),
  ).rejects.toThrow('review-session-mismatch');
  const original = await readFile(n.request.load.locator, 'utf8');
  await writeFile(n.request.load.locator, 'changed');
  await expect(n.verify()).rejects.toThrow('native-load-receipt-changed');
  for (const saved of [
    { session: 'other', refs: n.request.reads },
    { session: 'session', refs: null },
    { session: 'session', refs: [] },
  ]) {
    const text = JSON.stringify(saved);
    await writeFile(n.request.load.locator, text);
    await expect(
      n.sessions.verifyReview(
        n.session,
        { ...n.request, load: { ...n.request.load, hash: contentHash(text) } },
        'answer',
        n.evidence,
      ),
    ).rejects.toThrow('native-load-receipt-mismatch');
  }
  await writeFile(n.request.load.locator, original);
  n.thread.id = 'other';
  await expect(n.verify()).rejects.toThrow('wrong-thread-read');
  n.thread.id = 'session';
  const turns = n.thread.turns;
  n.thread.turns = null as unknown as typeof turns;
  await expect(n.verify()).rejects.toThrow('wrong-thread-read');
  n.thread.turns = [n.load, n.load, n.answer];
  await expect(n.verify()).rejects.toThrow('ambiguous-review-turns');
  for (const history of [[n.answer], [n.answer, n.load], [n.load]]) {
    n.thread.turns = history;
    await expect(n.verify()).rejects.toThrow('review-before-load');
  }
  n.thread.turns = turns;
  n.answer.status = 'inProgress';
  await expect(n.verify()).rejects.toThrow('review-turn-incomplete');
  n.answer.status = 'completed';
  n.answer.items = null;
  await expect(n.verify()).rejects.toThrow('review-turn-incomplete');
});

it('requires one exact user request and the same native answer snapshot', async () => {
  const n = await nativeCouncil();
  for (const items of [
    [],
    [{ type: 'userMessage' }],
    [
      {
        type: 'userMessage',
        content: [
          { type: 'image' },
          { type: 'text', text: 42 },
          { type: 'text', text: 'I claim the profile is current' },
        ],
      },
    ],
    [n.userMessage, n.userMessage],
  ]) {
    n.answer.items = items;
    await expect(n.verify()).rejects.toThrow('native-review-request-mismatch');
  }
  n.answer.items = [n.userMessage];
  await expect(n.verify()).rejects.toThrow('native-review-answer-changed');
});

it.each(['project_id', 'parent_run_id', 'identity'] as const)(
  'rejects rebinding a native answer to another %s',
  async (field) => {
    const n = await nativeCouncil();
    const request = {
      ...n.request,
      [field]: field === 'identity' ? { assignment_id: 'another-task' } : 'another',
    };
    await expect(n.sessions.verifyReview(n.session, request, 'answer', n.evidence)).rejects.toThrow(
      'native-review-request-mismatch',
    );
  },
);

it('binds Desktop review to the authorized sender turn and both exact delivery records', async () => {
  const n = await nativeCouncil();
  const file = await saveCouncilRequestFile(out, n.request);
  const sender = { threadId: 'controller', turnId: 'origin-turn', reason: 'F-01' };
  const prompt = nativeCouncilReviewBrief(n.request, file, sender.reason);
  const envelope =
    '<codex_delegation>\n  <source_thread_id>controller</source_thread_id>\n  <input>' +
    prompt +
    '</input>\n</codex_delegation>';
  const inbound = {
    type: 'functionCallOutput',
    namespace: 'codex_app',
    name: 'send_message_to_thread',
    output: envelope,
  };
  const call = {
    type: 'mcpToolCall',
    server: 'codex_app',
    tool: 'send_message_to_thread',
    arguments: {
      threadId: n.session.id,
      model: n.session.model,
      thinking: n.session.effort,
      prompt,
    },
    status: 'completed',
    error: null,
    result: { content: [{ type: 'text', text: JSON.stringify({ threadId: n.session.id }) }] },
  };
  const origin = { id: sender.threadId, turns: [{ id: sender.turnId, items: [call] }] };
  n.answer.rootTurnId = sender.turnId;
  const answerMessage = (n.answer.items as unknown[])[1];
  n.answer.items = [inbound, answerMessage];
  const rpc = {
    ...n.rpc,
    request: async (method: string, params: Record<string, unknown>) =>
      params.threadId === sender.threadId ? { thread: origin } : n.rpc.request(method, params),
  };
  const sessions = new AppServerSessions(rpc, f.root, 'project', out);
  const polled = await sessions.poll(n.session, 'answer');
  if (polled.status !== 'completed') throw new Error('fixture answer missing');
  const verify = () =>
    sessions.verifyReview(n.session, n.request, 'answer', polled.answer.evidence, sender);
  expect((await verify()).request_file).toEqual(file);
  n.answer.items = [inbound, n.userMessage, answerMessage];
  await expect(verify()).rejects.toThrow('native-review-request-mismatch');
  n.answer.items = [inbound, answerMessage];
  n.answer.rootTurnId = 'other';
  await expect(verify()).rejects.toThrow('council-delegation-origin');
  n.answer.rootTurnId = sender.turnId;
  inbound.output += '!';
  await expect(verify()).rejects.toThrow('council-delegation-inbound');
  inbound.output = envelope;
  origin.id = 'other';
  await expect(verify()).rejects.toThrow('council-delegation-sender');
  origin.id = sender.threadId;
  origin.turns[0]!.id = 'other';
  await expect(verify()).rejects.toThrow('council-delegation-turn');
  origin.turns[0]!.id = sender.turnId;
  call.arguments.prompt += '!';
  await expect(verify()).rejects.toThrow('council-delegation-outbound');
  call.arguments.prompt = prompt;
  call.status = 'failed';
  await expect(verify()).rejects.toThrow('council-delegation-outbound');
  call.status = 'completed';
  call.result.content[0]!.text = '{}';
  await expect(verify()).rejects.toThrow('council-delegation-outbound');
});
