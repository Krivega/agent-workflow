import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type {
  TaskHumanCommandContext,
  TaskHumanManifest,
  TaskHumanTarget,
} from '../../src/contracts/taskHuman.js';
import type {
  TaskStartAdmission,
  VerifiedStartAdmission,
} from '../../src/contracts/taskStartAdmission.js';
import { nativeTaskSource } from '../../src/adapters/codex/nativeTaskSource.js';
import { nativeTaskHumanAuthority } from '../../src/adapters/codex/taskHumanAuthority.js';
import {
  nativeHumanContext,
  nativeHumanQuestion,
  taskHumanChoices,
  verifyNativeHumanChoice,
} from '../../src/adapters/codex/nativeHumanChoice.js';
import type { NativeHumanReferences } from '../../src/adapters/codex/nativeHumanChoice.js';
import {
  applyTaskHumanCommand,
  createTaskHumanState,
  taskHumanBlockers,
  taskHumanCommandText,
} from '../../src/policy/taskHuman.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import { controlFixture } from './controlFixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
type RecordValue = { type: string; payload: Record<string, unknown> };
async function fixture() {
  const f = controlFixture(),
    sessions = join(f.root, 'synthetic-sessions'),
    transcript = join(sessions, 'synthetic.jsonl'),
    threadId = 'synthetic-thread';
  mkdirSync(sessions, { mode: 0o700 });
  vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
  vi.stubEnv('CODEX_THREAD_ID', threadId);
  const start = (turnId: string): RecordValue => ({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId },
    }),
    turn = (turnId: string): RecordValue => ({
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd: f.workspace,
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    }),
    user = (turnId: string, body: string): RecordValue => ({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'synthetic-message-' + turnId,
        role: 'user',
        content: [{ type: 'input_text', text: body }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          create_time: 1,
          content_item_kinds: ['user.text'],
          content_item_metadata: [{ provenance: { type: 'user' } }],
        },
      },
    }),
    completed = (turnId: string, item: unknown): RecordValue => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item,
        started_at_ms: 1,
        completed_at_ms: 2,
      },
    }),
    delivered = (turnId: string, body: string) =>
      completed(turnId, {
        type: 'UserMessage',
        id: 'synthetic-delivery-' + turnId,
        client_id: 'synthetic-client',
        content: [{ type: 'text', text: body, text_elements: [] }],
      }),
    records: RecordValue[] = [
      {
        type: 'session_meta',
        payload: {
          id: threadId,
          session_id: threadId,
          cli_version: '0.166.0-alpha.6',
          cwd: f.workspace,
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
        },
      },
      start('initial'),
      turn('initial'),
      user('initial', 'Synthetic unit controller request; not native acceptance.'),
      delivered('initial', 'Synthetic unit controller request; not native acceptance.'),
    ];
  const rows = () =>
    records.map((r, index) => {
      const raw = JSON.stringify(r) + '\n';
      return { raw, ref: { locator: transcript + '#L' + (index + 1), hash: digest(raw) } };
    });
  const write = () =>
    writeFileSync(
      transcript,
      rows()
        .map((r) => r.raw)
        .join(''),
      { mode: 0o600 },
    );
  write();
  const observer = nativeTaskSource(f.store, {
      sessionsRoot: sessions,
      chatWorkspace: f.workspace,
      threadId,
      owner: f.registration.owner,
    }),
    source = { transcript, turnId: 'initial', user: { line: 4, sha256: rows()[3]!.ref.hash } },
    principal = await observer.issue(source),
    target: TaskHumanTarget = {
      workflowId: 'aw/task/neutral/one',
      projectId: 'neutral',
      taskId: 'one',
      roleId: 'task',
      hostId: 'mac',
      workspaceId: 'main',
      owner: 'user',
      generation: 1,
      requirementsRevision: 1,
    },
    card = {
      path: 'tasks/one.md',
      ...f.store.publish(readFileSync(join(f.workspace, 'tasks/one.md'))),
    },
    admission: TaskStartAdmission = {
      schemaVersion: 1,
      kind: 'task-start-admission',
      previous: null,
      target,
      card,
      requirements: f.proof,
      principal,
      criteria: [
        {
          id: 'C1: результат проверен',
          text: 'Проверить *результат* [без ссылки](file:///tmp/fake) 🧩',
          kind: 'human',
          applicable: true,
          reason: 'Synthetic unit criterion',
        },
      ],
    },
    admissionRef = f.save(admission),
    manifest: TaskHumanManifest = {
      schemaVersion: 1,
      kind: 'task-human-gate-manifest',
      target,
      card,
      requirements: f.proof,
      declaration: admissionRef,
      criteria: admission.criteria,
    },
    bound = { manifest, ref: f.save(manifest) },
    input: HumanManagedTaskInput = {
      schemaVersion: 12,
      admission: {
        schemaVersion: 3,
        preparation: f.input.preparation,
        plan: { path: 'tasks/one.md', sha256: card.sha256 },
        planning: f.proof,
        acceptance: f.proof,
      },
      executor: { path: 'reviewer.md', sha256: card.sha256 },
      baseline: 'syntax',
      continuation: { attempt: 0, previous: null },
      startAdmission: admissionRef,
    },
    verified: VerifiedStartAdmission = {
      ref: admissionRef,
      admission,
      initial: { ref: admissionRef, admission },
      manifest: bound,
    },
    verifyStart = vi.fn(async () => verified),
    authority = nativeTaskHumanAuthority(f.store, observer, verifyStart),
    context: TaskHumanCommandContext = {
      input,
      state: createTaskHumanState(bound),
      technical: {
        input,
        snapshot: f.proof,
        packet: {
          schemaVersion: 1,
          preparation: f.input.preparation,
          reviewId: f.proof.sha256,
          request: f.proof,
        },
        acceptance: f.proof,
        records: [f.proof],
        stopped: f.proof,
      },
    };
  async function pending() {
    const ask = await authority.prepareAsk(context, {
        commandId: 'ask',
        questionId: 'question',
        criterionId: manifest.criteria[0]!.id,
      }),
      verifiedAsk = await authority.verify(context, ask);
    context.state = applyTaskHumanCommand(context.state, ask, verifiedAsk).state;
    return ask;
  }
  async function choice(answer: string = taskHumanChoices[0]) {
    const question = await authority.prepareQuestion(context),
      questionTurn = 'question-turn',
      replyTurn = 'reply-turn',
      callId = 'synthetic-call',
      args = { questions: [{ title: question.title, options: question.options }] },
      call: RecordValue = {
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          id: 'synthetic-function',
          name: 'request_user_input_async',
          arguments: JSON.stringify(args),
          call_id: callId,
          internal_chat_message_metadata_passthrough: { turn_id: questionTurn, create_time: 1 },
        },
      },
      publication = completed(questionTurn, {
        type: 'AgentMessage',
        id: callId,
        content: [{ type: 'Text', text: question.title + '\n- Принять\n- Отклонить' }],
        phase: 'final_answer',
        delivery: 'async',
        questions: args.questions,
      }),
      body =
        '<send_user_message_question_reply>\n' +
        JSON.stringify([
          {
            questionItemId: JSON.stringify(['request_user_input_async', callId, 0]),
            question: question.title,
            answer,
          },
        ]) +
        '\n</send_user_message_question_reply>\n',
      reply = user(replyTurn, body),
      delivery = delivered(replyTurn, body);
    records.push(
      start(questionTurn),
      turn(questionTurn),
      call,
      publication,
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' },
      },
      start(replyTurn),
      turn(replyTurn),
      reply,
      delivery,
    );
    write();
    const references = (): NativeHumanReferences =>
      Object.fromEntries(
        Object.entries({ call, publication, reply, delivery }).map(([k, row]) => [
          k,
          rows()[records.indexOf(row)]?.ref ?? {
            locator: transcript + '#L999',
            hash: '0'.repeat(64),
          },
        ]),
      ) as NativeHumanReferences;
    const pure = () => ({
      context: question.context,
      links: question.links,
      transcript,
      rows: rows(),
      references: references(),
    });
    return {
      question,
      call,
      publication,
      reply,
      delivery,
      references,
      pure,
      body,
      replyTurn,
      questionTurn,
      callId,
    };
  }
  return {
    ...f,
    sessions,
    transcript,
    records,
    observer,
    source,
    principal,
    target,
    context,
    authority,
    verifyStart,
    pending,
    choice,
    rows,
    write,
    start,
    turn,
    user,
    delivered,
  };
}

describe('task human actual private source and native choice boundary (synthetic unit files only)', () => {
  it.each(['0.169.0-alpha.11.1', '0.169.1', '0.171.0-alpha.13'])(
    'binds Desktop %s direct requests to the current root turn and private workspace',
    async (version) => {
      const f = await fixture();
      const session = f.records[0]!.payload;
      const context = f.records[2]!.payload;
      session.cli_version = version;
      context.root_turn_id = 'initial';
      f.write();
      const principal = await f.observer.issue(f.source);
      await f.observer.verify(principal);
      f.records.push(f.turn('other'));
      f.write();
      await expect(f.observer.issue(f.source)).rejects.toThrow('task-native-root-turn');
      await f.observer.verify(principal);
      f.records.pop();
      context.root_turn_id = 'foreign';
      f.write();
      await expect(f.observer.issue(f.source)).rejects.toThrow('task-native-root-turn');
      context.root_turn_id = 'initial';
      for (const override of [
        { cwd: f.sessions },
        { thread_source: 'agent_created_thread' },
        { cli_version: '0.169.0-alpha.11.2' },
        { cli_version: '0.169.2' },
        { cli_version: '0.171.0-alpha.14' },
      ]) {
        const saved = { ...session };
        Object.assign(session, override);
        f.write();
        await expect(f.observer.issue(f.source)).rejects.toThrow('task-native-session');
        Object.assign(session, saved);
      }
      f.write();
      for (const envelope of [
        'send_user_message_question_reply',
        'external_codex_apps_open_page',
        'skill',
      ]) {
        const text = '<' + envelope + '>scoped answer</' + envelope + '>';
        f.records[3] = f.user('initial', text);
        f.records[4] = f.delivered('initial', text);
        f.write();
        await expect(
          f.observer.issue({ ...f.source, user: { line: 4, sha256: f.rows()[3]!.ref.hash } }),
        ).rejects.toThrow('task-native-primary-user');
      }
      chmodSync(f.transcript, 0o644);
      await expect(f.observer.issue(f.source)).rejects.toThrow('task-native-private-file');
    },
  );
  it('does not treat an injected user-shaped environment preface as the primary controller', async () => {
    const f = await fixture();
    f.records.push({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '# AGENTS.md instructions: synthetic environment preface' },
        ],
      },
    });
    f.records.push({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic harness preface' }],
        internal_chat_message_metadata_passthrough: {
          content_item_metadata: [{ provenance: { type: 'harness' } }],
        },
      },
    });
    f.records.push({ type: 'event_msg', payload: { type: 'token_count' } });
    f.write();
    await expect(f.observer.issue(f.source)).resolves.toEqual(f.principal);
  });
  it('blocks stale current issuance after a same-turn mixed genuine user while retaining historical proof', async () => {
    const f = await fixture(),
      newer = f.user('initial', 'Synthetic newer user with image');
    newer.payload.content = [
      { type: 'input_text', text: 'Synthetic newer user with image' },
      { type: 'input_image', image_url: 'unit://synthetic-image' },
    ];
    const metadata = object(newer.payload.internal_chat_message_metadata_passthrough);
    metadata.content_item_kinds = ['user.text', 'user.image'];
    metadata.content_item_metadata = [
      { provenance: { type: 'user' } },
      { provenance: { type: 'user' } },
    ];
    f.records.push(newer);
    f.write();
    await expect(f.observer.issue(f.source)).rejects.toThrow('primary-superseded');
    await expect(f.observer.verify(f.principal)).resolves.toBeUndefined();
  });
  it.each(['inbound', 'duplicate-delivery', 'partial-json'] as const)(
    'preserves actual historical source prefix after later same-turn %s',
    async (kind) => {
      const f = await fixture();
      if (kind === 'inbound')
        f.records.push({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            namespace: 'codex_app',
            name: 'send_message_to_thread',
            internal_chat_message_metadata_passthrough: { turn_id: 'initial' },
          },
        });
      if (kind === 'duplicate-delivery') f.records.push(structuredClone(f.records[4]!));
      f.write();
      if (kind === 'partial-json')
        writeFileSync(
          f.transcript,
          Buffer.concat([readFileSync(f.transcript), Buffer.from('{"unfinished":')]),
        );
      await expect(f.observer.issue(f.source)).rejects.toThrow();
      await expect(f.observer.verify(f.principal)).resolves.toBeUndefined();
    },
  );
  it('verifies a retained DECIDE from its actual pinned prefix despite a malformed later tail', async () => {
    const f = await fixture();
    await f.pending();
    const q = await f.choice(),
      decision = await f.authority.makeDecision(f.context, {
        commandId: 'decision',
        transcript: f.transcript,
        references: q.references(),
      }),
      verified = await f.authority.verify(f.context, decision),
      original = readFileSync(f.transcript);
    writeFileSync(f.transcript, Buffer.concat([original, Buffer.from('{"unfinished":')]));
    await expect(f.authority.verify(f.context, decision)).resolves.toEqual(verified);
    await expect(
      f.authority.makeDecision(f.context, {
        commandId: 'new',
        transcript: f.transcript,
        references: q.references(),
      }),
    ).rejects.toThrow('history-changed');
    writeFileSync(f.transcript, original.subarray(0, original.length - 3));
    await expect(f.authority.verify(f.context, decision)).rejects.toThrow('principal-prefix');
  });
  it.each([
    ['Принять', true],
    ['Отклонить', false],
  ] as const)(
    'derives %s from actual published option and preserves historical proof',
    async (label, accepted) => {
      const f = await fixture();
      await expect(f.authority.prepareQuestion(f.context)).rejects.toThrow('question-not-durable');
      const ask = await f.pending(),
        question = await f.choice(label),
        decision = await f.authority.makeDecision(f.context, {
          commandId: 'decision',
          transcript: f.transcript,
          references: question.references(),
        });
      expect(decision.action === 'DECIDE' && decision.accepted).toBe(accepted);
      expect(question.question.title).toContain('\\*результат\\*');
      expect(question.question.options).toEqual(['Принять', 'Отклонить']);
      const before = structuredClone(f.context),
        verified = await f.authority.verify(f.context, decision);
      expect(verified.action === 'DECIDE' && verified.accepted).toBe(accepted);
      const applied = applyTaskHumanCommand(f.context.state, decision, verified);
      expect(taskHumanBlockers(applied.state).length === 0).toBe(accepted);
      f.records.push(
        f.start('later'),
        f.turn('later'),
        f.user('later', 'Synthetic later user'),
        f.delivered('later', 'Synthetic later user'),
      );
      f.write();
      vi.stubEnv('CODEX_THREAD_ID', 'cold-worker');
      await expect(f.observer.verify(f.principal)).resolves.toBeUndefined();
      await expect(f.authority.verify(before, decision)).resolves.toEqual(verified);
      await expect(
        f.authority.makeDecision(before, {
          commandId: 'new',
          transcript: f.transcript,
          references: question.references(),
        }),
      ).rejects.toThrow('current-host');
      vi.stubEnv('CODEX_THREAD_ID', 'synthetic-thread');
      await expect(
        f.authority.makeDecision(before, {
          commandId: 'new',
          transcript: f.transcript,
          references: question.references(),
        }),
      ).rejects.toThrow('other-user');
      expect(ask.action).toBe('ASK');
    },
  );
  it('verifies ASK intent historically in a cold Worker and refuses caller answer/command substitution', async () => {
    const f = await fixture(),
      ask = await f.authority.prepareAsk(f.context, {
        commandId: 'ask',
        questionId: 'q',
        criterionId: 'C1: результат проверен',
      });
    vi.stubEnv('CODEX_THREAD_ID', 'cold-worker');
    await expect(f.authority.verify(f.context, ask)).resolves.toMatchObject({ action: 'ASK' });
    await expect(
      f.authority.prepareAsk(f.context, {
        commandId: 'other',
        questionId: 'other',
        criterionId: ask.criterionId,
      }),
    ).rejects.toThrow('current-host');
    await expect(f.authority.verify(f.context, { ...ask, hash: '0'.repeat(64) })).rejects.toThrow(
      'command-hash',
    );
    vi.stubEnv('CODEX_THREAD_ID', 'synthetic-thread');
    await f.pending();
    const q = await f.choice('Отклонить'),
      command = await f.authority.makeDecision(f.context, {
        commandId: 'no',
        transcript: f.transcript,
        references: q.references(),
      });
    if (command.action !== 'DECIDE') throw Error('fixture');
    const forged = { ...command, accepted: true, hash: '0'.repeat(64) };
    forged.hash = digest(taskHumanCommandText(forged));
    await expect(f.authority.verify(f.context, forged)).rejects.toThrow('command-frame');
    const forgedSource = object(
      JSON.parse(f.store.read(command.source).toString('utf8')) as unknown,
    );
    object(forgedSource.frame).accepted = true;
    const forgedWithSource = { ...forged, source: f.save(forgedSource) };
    forgedWithSource.hash = digest(taskHumanCommandText(forgedWithSource));
    await expect(f.authority.verify(f.context, forgedWithSource)).rejects.toThrow(
      'answer-mismatch',
    );
    const wrong = structuredClone(f.context);
    wrong.state.current.manifest.target.taskId = 'foreign';
    await expect(f.authority.prepareQuestion(wrong)).rejects.toThrow('manifest');
  });
  it('rejects stale pending, altered retained bytes and fake source filesystem ownership', async () => {
    const f = await fixture();
    await f.pending();
    const q = await f.choice(),
      decision = await f.authority.makeDecision(f.context, {
        commandId: 'yes',
        transcript: f.transcript,
        references: q.references(),
      });
    const stale = structuredClone(f.context);
    stale.state.revision++;
    await expect(f.authority.prepareQuestion(stale)).rejects.toThrow('not-durable');
    const original = readFileSync(f.transcript);
    writeFileSync(
      f.transcript,
      original
        .toString()
        .replace('Synthetic unit controller request', 'Altered controller request'),
    );
    await expect(f.authority.verify(f.context, decision)).rejects.toThrow();
    writeFileSync(f.transcript, original);
    chmodSync(f.transcript, 0o644);
    await expect(f.observer.verify(f.principal)).rejects.toThrow('private-file');
    chmodSync(f.transcript, 0o600);
    const link = join(f.sessions, 'symlink.jsonl');
    symlinkSync(f.transcript, link);
    expect(() => f.observer.read(link)).toThrow('private-path');
    vi.spyOn(process, 'getuid').mockReturnValue(999999);
    expect(() => f.observer.read(f.transcript)).toThrow('private-file');
  });
  it.each(['нет', 'Да', 'продолжай', 'Принять ', ' Принять', 'Принять\n', '{}', ''])(
    'refuses non-option answer %j',
    async (answer) => {
      const f = await fixture();
      await f.pending();
      const q = await f.choice(answer);
      await expect(
        f.authority.makeDecision(f.context, {
          commandId: 'decision',
          transcript: f.transcript,
          references: q.references(),
        }),
      ).rejects.toThrow();
    },
  );
  const defects: Record<
    string,
    (
      f: Awaited<ReturnType<typeof fixture>>,
      q: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['choice']>>,
    ) => void
  > = {
    unpublished: (f, q) => {
      f.records.splice(f.records.indexOf(q.publication), 1);
    },
    'missing-delivery': (f, q) => {
      f.records.splice(f.records.indexOf(q.delivery), 1);
    },
    'wrong-publication-thread': (_f, q) => {
      q.publication.payload.thread_id = 'foreign';
    },
    'wrong-publication-title': (_f, q) => {
      object(q.publication.payload.item).content = [{ type: 'Text', text: 'unpublished' }];
    },
    'wrong-options': (_f, q) => {
      q.call.payload.arguments = JSON.stringify({
        questions: [{ title: q.question.title, options: null }],
      });
    },
    'wrong-call': (_f, q) => {
      q.call.payload.name = 'other';
    },
    'incomplete-call': (_f, q) => {
      q.call.payload.status = 'in_progress';
    },
    'forged-provenance': (_f, q) => {
      object(q.reply.payload.internal_chat_message_metadata_passthrough).content_item_metadata = [
        { provenance: { type: 'harness' } },
      ];
    },
    'wrong-reply-turn': (_f, q) => {
      object(q.reply.payload.internal_chat_message_metadata_passthrough).turn_id = q.questionTurn;
    },
    'wrong-delivery-body': (_f, q) => {
      object(q.delivery.payload.item).content = [
        { type: 'text', text: 'Принять', text_elements: [] },
      ];
    },
    'foreign-session': (f) => {
      f.records[0]!.payload.id = 'foreign';
    },
    'unknown-client': (f) => {
      f.records[0]!.payload.cli_version = '0.167';
    },
    'forked-session': (f) => {
      f.records[0]!.payload.forked_from_id = null;
    },
    'foreign-workspace': (f, q) => {
      f.records.find(
        (r) => r.type === 'turn_context' && r.payload.turn_id === q.replyTurn,
      )!.payload.cwd = '/other';
    },
    'changed-permissions': (f, q) => {
      f.records.find(
        (r) => r.type === 'turn_context' && r.payload.turn_id === q.replyTurn,
      )!.payload.permission_profile = { type: 'managed' };
    },
    delegated: (f, q) => {
      f.records.push({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          internal_chat_message_metadata_passthrough: { turn_id: q.replyTurn },
        },
      });
    },
    'duplicate-call': (f, q) => {
      f.records.push(structuredClone(q.call));
    },
    'duplicate-publication': (f, q) => {
      f.records.push(structuredClone(q.publication));
    },
    'duplicate-delivery': (f, q) => {
      f.records.push(structuredClone(q.delivery));
    },
    'later-user': (f, q) => {
      f.records.push(f.user(q.replyTurn, 'stop'));
    },
  };
  it.each(Object.entries(defects))('rejects actual native defect: %s', async (_name, mutate) => {
    const f = await fixture();
    await f.pending();
    const q = await f.choice();
    mutate(f, q);
    f.write();
    await expect(
      f.authority.makeDecision(f.context, {
        commandId: 'decision',
        transcript: f.transcript,
        references: q.references(),
      }),
    ).rejects.toThrow();
  });
  it('binds raw refs, full context and exact CommonMark links without shortening opaque criteria', async () => {
    const f = await fixture();
    await f.pending();
    const q = await f.choice();
    const original = q.pure(),
      changed = { ...original, rows: structuredClone(original.rows) };
    changed.rows[0]!.ref.hash = '0'.repeat(64);
    expect(() => verifyNativeHumanChoice(changed)).toThrow();
    for (const key of ['candidate', 'technicalAcceptance', 'manifest', 'card'] as const) {
      const value = structuredClone(original);
      value.context[key].sha256 = '0'.repeat(64);
      expect(() => verifyNativeHumanChoice(value)).toThrow();
    }
    const context = structuredClone(q.question.context);
    context.criterion = {
      id: '  C1: ' + 'ёж'.repeat(15000),
      text: '\n# Title\n[text](file:///bad)\n```\n' + 'ю'.repeat(30000),
    };
    const prepared = nativeHumanContext(context),
      links = {
        ...q.question.links,
        context: { ...prepared.ref, path: join(f.registration.artifactRoot, prepared.ref.sha256) },
      },
      shown = nativeHumanQuestion(context, links);
    expect(shown.title).toContain('\\# Title');
    expect(shown.title).toContain('\\[text\\]\\(file\\:\\/\\/\\/bad\\)');
    expect(shown.contextHash).toBe(prepared.ref.sha256);
    expect(object(JSON.parse(prepared.body) as unknown).criterion).toEqual(context.criterion);
  });
});
