import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture.js';
import {
  nativeReaderAuthority,
  nativeReaderNotice,
  nativeHumanAuthorizationText,
} from '../../src/adapters/codex/readerAuthority.js';
import type { NativeReaderSource } from '../../src/adapters/codex/readerAuthority.js';
import { makeReaderCommand } from '../../src/client/reader.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { readerControlActivities } from '../../src/activities/readerControl.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { makeTaskPlanningCommand } from '../../src/client/taskContinuation.js';
import { makeArchiveCommand } from '../../src/client/finalization.js';
import {
  readerCommandText,
  parsePayloadReaderCommand,
  parseArchiveCommand,
} from '../../src/policy/readerControl.js';
import type {
  PayloadReaderCommand,
  ArchiveCommand,
  AuthorizedReaderCommand,
} from '../../src/contracts/readerControl.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const f = controlFixture(),
    sessions = join(f.root, 'sessions');
  mkdirSync(sessions);
  const transcript = join(sessions, 'rollout-issuer.jsonl');
  const records: Record<string, unknown>[] = [
    {
      type: 'session_meta',
      payload: {
        id: 'issuer',
        session_id: 'issuer',
        cwd: f.workspace,
        cli_version: '0.164.0-alpha.11.1',
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'human-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Продолжи в прежнем scope' }],
      },
    },
    { type: 'turn_context', payload: { turn_id: 'human-turn' } },
  ];
  const source: NativeReaderSource = {
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript,
    threadId: 'issuer',
    turnId: 'human-turn',
    user: { line: 3, sha256: digest(JSON.stringify(records[2]) + '\n') },
  };
  const config = {
    sessionsRoot: sessions,
    workspaceRoot: f.workspace,
    threadId: 'issuer',
    owner: 'user',
  };
  const authority = nativeReaderAuthority(f.store, config);
  const save = () =>
    writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  save();
  const command = (input = source) =>
    makeReaderCommand({ ...f.command('resume', 1, 1), source: f.save(input) });
  const payload = (i: number) => records[i]!.payload as Record<string, unknown>;
  function issuedCommand<T extends AuthorizedReaderCommand>(c: T) {
    records.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'issuer',
        turn_id: 'human-turn',
        item: {
          type: 'CommandExecution',
          cwd: f.workspace,
          status: 'completed',
          exit_code: 0,
          aggregated_output: nativeReaderNotice(c),
        },
      },
    });
    save();
    return c;
  }
  const replaceHuman = (changes: Record<string, unknown>) => {
    Object.assign(payload(2), changes);
    source.user.sha256 = digest(JSON.stringify(records[2]) + '\n');
    save();
  };
  function authorize<T extends PayloadReaderCommand | ArchiveCommand>(command: T) {
    replaceHuman({
      content: [{ type: 'input_text', text: nativeHumanAuthorizationText(command) }],
    });
    const authorized = { ...command, source: f.save(source) };
    return { ...authorized, hash: digest(readerCommandText(authorized)) };
  }
  function card<T extends PayloadReaderCommand | ArchiveCommand>(
    command: T,
    answer = nativeHumanAuthorizationText(command),
    id = 'call_question',
  ) {
    const title =
        'Confirm this exact task intent after the retained FAIL. '.repeat(16) +
        nativeHumanAuthorizationText(command),
      content =
        '<send_user_message_question_reply>\n' +
        JSON.stringify([
          {
            questionItemId: JSON.stringify(['request_user_input_async', id, 0]),
            question: title,
            answer,
          },
        ]) +
        '\n</send_user_message_question_reply>';
    Object.assign(payload(0), {
      cli_version: '0.165.0-alpha.1.2',
      source: 'vscode',
      originator: 'codex_work_desktop',
      thread_source: 'user',
    });
    records.splice(
      1,
      records.length - 1,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'question-turn' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input_async',
          call_id: 'call_question',
          arguments: JSON.stringify({ questions: [{ title }] }),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'issuer',
          turn_id: 'question-turn',
          item: {
            type: 'AgentMessage',
            id: 'call_question',
            content: title,
            phase: null,
            delivery: null,
            questions: [{ title, options: null }],
          },
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'human-turn' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: content }],
        },
      },
      { type: 'turn_context', payload: { turn_id: 'human-turn' } },
    );
    source.user = { line: 6, sha256: digest(JSON.stringify(records[5]) + '\n') };
    save();
    const result = { ...command, source: f.save(source) };
    return { ...result, hash: digest(readerCommandText(result)) };
  }
  return {
    ...f,
    sessions,
    transcript,
    records,
    source,
    config,
    authority,
    save,
    command,
    payload,
    issued: () => issuedCommand(command()),
    issuedCommand,
    replaceHuman,
    authorize,
    card,
    localCommand: f.command,
  };
}

function registeredFixture() {
  const f = fixture(),
    origin = join(f.root, 'issuer-origin'),
    gitdir = join(origin, '.git/worktrees/current');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(f.workspace, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(gitdir, 'gitdir'), join(f.workspace, '.git') + '\n');
  Object.assign(f.payload(0), {
    cwd: origin,
    cli_version: '0.165.0-alpha.1.2',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  });
  f.payload(3).cwd = f.workspace;
  f.save();
  return f;
}

it('binds worktree controls to their original primary command turn after later issuer activity', async () => {
  const f = registeredFixture(),
    command = f.issued();
  f.records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } },
    { type: 'turn_context', payload: { turn_id: 'later', cwd: f.root } },
  );
  f.save();
  expect(await f.authority.verify(command)).toMatchObject({
    origin: 'human',
    author: 'user',
    hash: command.hash,
  });
  await expect(f.authority.verify({ ...command, author: 'foreign' })).rejects.toThrow(
    'reader-native-command-mismatch',
  );
});

it.each([2, 3] as const)(
  'retains exact human payload and native issuance for worktree command v%s',
  async (version) => {
    const f = registeredFixture(),
      base = f.command();
    const command = f.authorize(
      version === 2
        ? makeTaskPlanningCommand({
            ...base,
            schemaVersion: 2,
            target: { ...base.target, roleId: 'task' },
            payload: f.proof,
          })
        : makeArchiveCommand({
            ...base,
            schemaVersion: 3,
            action: 'archive',
            target: { ...base.target, roleId: 'task' },
            payload: f.proof,
          }),
    );
    await expect(f.authority.verify(command)).rejects.toThrow('reader-native-issuance-unconfirmed');
    expect((await f.authority.verify(f.issuedCommand(command))).origin).toBe('human');
    const changed =
      version === 2
        ? makeTaskPlanningCommand({
            ...command,
            schemaVersion: 2,
            action: 'resume',
            payload: command.source,
          })
        : makeArchiveCommand({
            ...command,
            schemaVersion: 3,
            action: 'archive',
            payload: command.source,
          });
    await expect(f.authority.verify(changed)).rejects.toThrow(
      'reader-native-authorization-mismatch',
    );
  },
);

it.each(['missing', 'foreign-turn', 'duplicate', 'foreign-workspace', 'later-substitution'])(
  'refuses worktree controls without their exact primary command context: %s',
  async (kind) => {
    const f = registeredFixture(),
      command = f.issued();
    if (kind === 'missing' || kind === 'later-substitution') f.records.splice(3, 1);
    if (kind === 'foreign-turn') f.payload(3).turn_id = 'foreign';
    if (kind === 'duplicate') f.records.push(structuredClone(f.records[3]!));
    if (kind === 'foreign-workspace') f.payload(3).cwd = f.root;
    if (kind === 'later-substitution')
      f.records.push({ type: 'turn_context', payload: { turn_id: 'later', cwd: f.workspace } });
    f.save();
    await expect(f.authority.verify(command)).rejects.toThrow('reader-native-session-unconfirmed');
  },
);
describe('native human reader command authority', () => {
  it.each([2, 3] as const)(
    'accepts a complete native card answer for v%s in a later turn and retains the full primary records',
    async (version) => {
      const f = fixture(),
        base = f.command(),
        command = f.card(
          version === 2
            ? makeTaskPlanningCommand({
                ...base,
                schemaVersion: 2,
                target: { ...base.target, roleId: 'task' },
                payload: f.proof,
              })
            : makeArchiveCommand({
                ...base,
                schemaVersion: 3,
                action: 'archive',
                target: { ...base.target, roleId: 'finalization' },
                payload: f.proof,
              }),
        );
      vi.stubEnv('CODEX_THREAD_ID', 'issuer');
      vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
      expect(await f.authority.issue(command)).toBe(nativeReaderNotice(command));
      const verified = await f.authority.verify(f.issuedCommand(command)),
        proof = JSON.parse(f.store.read(verified.proof).toString()) as {
          observed: {
            user: { raw: { payload: { content: { text: string }[] } }; sha256: string };
            question: {
              call: { raw: { payload: { call_id: string } } };
              completed: { raw: { payload: { turn_id: string } } };
            };
          };
        };
      expect(proof.observed.user.raw.payload.content[0]!.text).toContain(
        '<send_user_message_question_reply>',
      );
      expect(proof.observed.user.sha256).toBe(f.source.user.sha256);
      expect(proof.observed.question.call.raw.payload.call_id).toBe('call_question');
      expect(proof.observed.question.completed.raw.payload.turn_id).toBe('question-turn');
      expect(f.source.turnId).toBe('human-turn');
      const changed = { ...command, payload: command.source };
      await expect(
        f.authority.verify({ ...changed, hash: digest(readerCommandText(changed)) }),
      ).rejects.toThrow('reader-native-authorization-mismatch');
    },
  );
  it.each(['question-only', 'unknown-question', 'assistant', 'no-issuance'])(
    'refuses an unbound card source: %s',
    async (defect) => {
      const f = fixture(),
        base = f.command();
      let command = f.card(
        makeTaskPlanningCommand({
          ...base,
          schemaVersion: 2,
          target: { ...base.target, roleId: 'task' },
          payload: f.proof,
        }),
        defect === 'question-only' ? 'Yes, the command is in the question' : undefined,
        defect === 'unknown-question' ? 'call_other' : undefined,
      );
      if (defect === 'assistant') {
        f.payload(5).role = 'assistant';
        f.source.user.sha256 = digest(JSON.stringify(f.records[5]) + '\n');
        const changed = {
          ...command,
          source: f.store.publish(Buffer.from(JSON.stringify(f.source))),
        };
        command = { ...changed, hash: digest(readerCommandText(changed)) };
        f.save();
      }
      if (defect !== 'no-issuance') f.issuedCommand(command);
      await expect(f.authority.verify(command)).rejects.toThrow(
        defect === 'assistant'
          ? 'reader-native-human-unconfirmed'
          : defect === 'no-issuance'
            ? 'reader-native-issuance-unconfirmed'
            : 'reader-native-authorization-mismatch',
      );
    },
  );
  it.each(['0.164.0-alpha.11.1', '0.165.0-alpha.1.2'])(
    'supports the observed primary source format %s',
    async (version) => {
      const f = fixture();
      Object.assign(f.payload(0), { cli_version: version, source: 'vscode', forked_from_id: null });
      f.save();
      const command = f.issued(),
        proof = await f.authority.verify(command);
      expect(proof.origin).toBe('human');
      const record = JSON.parse(f.store.read(proof.proof).toString()) as {
        observed: {
          session: { cli_version: string; source?: string; forked_from_id?: string | null };
        };
      };
      expect(record.observed.session.cli_version).toBe(version);
      if (version === '0.165.0-alpha.1.2')
        expect(record.observed.session).toMatchObject({ source: 'vscode', forked_from_id: null });
    },
  );
  it.each(['0.165.0-alpha.1.2', '0.166.0-alpha.6'])(
    'supports the observed desktop user source %s with an omitted fork field and exact human payload',
    async (version) => {
      const f = fixture();
      Object.assign(f.payload(0), {
        cli_version: version,
        source: 'vscode',
        originator: 'codex_work_desktop',
        thread_source: 'user',
      });
      f.payload(3).cwd = f.workspace;
      const base = f.command(),
        command = f.authorize(
          makeTaskPlanningCommand({
            ...base,
            schemaVersion: 2,
            target: { ...base.target, roleId: 'task' },
            payload: f.proof,
          }),
        );
      vi.stubEnv('CODEX_THREAD_ID', 'issuer');
      vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
      expect(await f.authority.issue(command)).toBe(nativeReaderNotice(command));
      const proof = await f.authority.verify(f.issuedCommand(command));
      expect(proof.origin).toBe('human');
      expect(JSON.parse(f.store.read(proof.proof).toString()) as unknown).toMatchObject({
        observed: {
          session: {
            cli_version: version,
            source: 'vscode',
            originator: 'codex_work_desktop',
            thread_source: 'user',
          },
        },
      });
      await expect(
        f.authority.verify(makeTaskPlanningCommand({ ...command, payload: command.source })),
      ).rejects.toThrow('reader-native-authorization-mismatch');
      if (version === '0.166.0-alpha.6') {
        f.records.push({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            namespace: 'codex_app',
            name: 'send_message_to_thread',
            internal_chat_message_metadata_passthrough: { turn_id: 'human-turn' },
          },
        });
        f.save();
        await expect(f.authority.issue(command)).rejects.toThrow('reader-native-human-delegated');
        await expect(f.authority.verify(command)).rejects.toThrow('reader-native-human-delegated');
      }
    },
  );
  describe.each(['0.169.1', '0.171.0-alpha.13', '0.171.0-alpha.13.2'])('Desktop %s', (version) => {
    it.each([
      'direct',
      'delegated',
      'harness',
      'missing-delivery',
      'fork',
      'wrong-root',
      'wrong-text',
      'other-action',
      'other-role',
      'superseded',
      'no-notice',
    ])('qualifies task RESUME from its exact direct owner message: %s', async (defect) => {
      const f = fixture(),
        turn = f.source.turnId;
      Object.assign(f.payload(0), {
        cli_version: version,
        originator: 'codex_work_desktop',
        source: 'vscode',
        thread_source: 'user',
      });
      Object.assign(f.payload(3), {
        cwd: f.workspace,
        root_turn_id: defect === 'wrong-root' ? 'other' : turn,
      });
      if (defect === 'fork') f.payload(0).parent_thread_id = 'parent';
      const base = f.command(),
        command = makeTaskExecutionCommand({
          ...base,
          schemaVersion: 2,
          action: defect === 'other-action' ? 'cancel' : 'resume',
          target: { ...base.target, roleId: 'task' },
          payload: f.proof,
        });
      const fields = {
        ...command,
        target: { ...command.target, roleId: defect === 'other-role' ? 'reviewer' : 'task' },
      };
      const content = defect === 'wrong-text' ? 'resume' : nativeHumanAuthorizationText(fields);
      f.replaceHuman({
        content: [{ type: 'input_text', text: content }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turn,
          create_time: 42,
          content_item_kinds: ['user.text'],
          content_item_metadata: [
            { provenance: { type: defect === 'harness' ? 'harness' : 'user' } },
          ],
        },
      });
      if (defect !== 'missing-delivery')
        f.records.push({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'issuer',
            turn_id: turn,
            item: {
              type: 'UserMessage',
              content: [{ type: 'text', text: content, text_elements: [] }],
            },
          },
        });
      if (defect === 'delegated')
        f.records.push({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            namespace: 'codex_app',
            name: 'send_message_to_thread',
            internal_chat_message_metadata_passthrough: { turn_id: turn },
          },
        });
      const updated = { ...fields, source: f.store.publish(Buffer.from(JSON.stringify(f.source))) },
        c = { ...updated, hash: digest(readerCommandText(updated)) };
      f.save();
      chmodSync(f.transcript, 0o600);
      vi.stubEnv('CODEX_THREAD_ID', 'issuer');
      vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
      if (defect === 'superseded') {
        f.records.push({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'другое поручение' }],
          },
        });
        f.save();
      }
      if (defect === 'direct') {
        expect(await f.authority.issue(c)).toBe(nativeReaderNotice(c));
        expect((await f.authority.verify(f.issuedCommand(c))).origin).toBe('human');
      } else if (defect === 'no-notice')
        await expect(f.authority.verify(c)).rejects.toThrow('reader-native-issuance-unconfirmed');
      else {
        await expect(f.authority.issue(c)).rejects.toThrow();
        await expect(f.authority.verify(f.issuedCommand(c))).rejects.toThrow();
      }
    });
  });
  it.each(['wrong-root', 'duplicate-context', 'fork', 'wrong-originator'])(
    'refuses an unqualified .166 same-root authorization %s',
    async (defect) => {
      const f = fixture();
      Object.assign(f.payload(0), {
        cli_version: '0.166.0-alpha.6',
        source: 'vscode',
        originator: 'codex_work_desktop',
        thread_source: 'user',
      });
      f.payload(3).cwd = defect === 'wrong-root' ? f.sessions : f.workspace;
      if (defect === 'duplicate-context') f.records.push(structuredClone(f.records[3]!));
      if (defect === 'fork') f.payload(0).forked_from_id = 'foreign';
      if (defect === 'wrong-originator') f.payload(0).originator = 'other';
      f.save();
      await expect(f.authority.verify(f.issued())).rejects.toThrow(
        'reader-native-session-unconfirmed',
      );
    },
  );
  it.each([
    { originator: 'other', thread_source: 'user' },
    { originator: 'codex_work_desktop', thread_source: 'subagent' },
    { originator: 'codex_work_desktop' },
    { thread_source: 'user' },
    { originator: 'codex_work_desktop', thread_source: 'user', forked_from_id: 'parent' },
    { originator: 'codex_work_desktop', thread_source: 'user', source: 'cli' },
    { originator: 'codex_work_desktop', thread_source: 'user', cli_version: '0.165.0-alpha.2' },
  ])('refuses an omitted-fork source outside the exact observed user form %j', async (metadata) => {
    const f = fixture();
    Object.assign(f.payload(0), {
      cli_version: '0.165.0-alpha.1.2',
      source: 'vscode',
      ...metadata,
    });
    f.save();
    await expect(f.authority.verify(f.issued())).rejects.toThrow(
      'reader-native-session-unconfirmed',
    );
  });
  it.each([
    { source: 'other', forked_from_id: null },
    { source: 'vscode', forked_from_id: 'parent' },
    { source: 'vscode' },
  ])('refuses an unqualified current primary source %j', async (metadata) => {
    const f = fixture();
    Object.assign(f.payload(0), { cli_version: '0.165.0-alpha.1.2', ...metadata });
    f.save();
    await expect(f.authority.verify(f.issued())).rejects.toThrow(
      'reader-native-session-unconfirmed',
    );
  });
  it.each([2, 3] as const)(
    'binds every significant version %s field to the primary human message',
    async (version) => {
      const f = fixture(),
        base = f.command();
      const command = f.authorize(
        version === 2
          ? makeTaskPlanningCommand({
              ...base,
              schemaVersion: 2,
              target: { ...base.target, roleId: 'task' },
              payload: f.proof,
            })
          : makeArchiveCommand({
              ...base,
              schemaVersion: 3,
              action: 'archive',
              target: { ...base.target, roleId: 'finalization' },
              payload: f.proof,
            }),
      );
      const rebuild = (value: typeof command) => {
        const parsed =
          value.schemaVersion === 2 ? parsePayloadReaderCommand(value) : parseArchiveCommand(value);
        return { ...parsed, hash: digest(readerCommandText(parsed)) };
      };
      for (const delta of [
        { commandId: 'other' },
        { expectedRevision: 2 },
        { attempt: 2 },
        { payload: f.store.publish(Buffer.from(JSON.stringify({ requirementsRevision: 2 }))) },
        ...Object.keys(command.target).map((name) => ({
          target: {
            ...command.target,
            [name]:
              typeof command.target[name as keyof typeof command.target] === 'number'
                ? 2
                : 'different',
          },
        })),
      ]) {
        await expect(f.authority.verify(rebuild({ ...command, ...delta }))).rejects.toThrow(
          'reader-native-authorization-mismatch',
        );
      }
      const content: unknown = JSON.parse(nativeHumanAuthorizationText(command));
      expect(content).not.toHaveProperty('source');
      expect(content).not.toHaveProperty('hash');
      f.replaceHuman({
        content: [
          {
            type: 'input_text',
            text: 'Please execute this: ' + nativeHumanAuthorizationText(command),
          },
        ],
      });
      const changed = rebuild({
        ...command,
        source: f.store.publish(Buffer.from(JSON.stringify(f.source))),
      });
      await expect(f.authority.verify(changed)).rejects.toThrow(
        'reader-native-authorization-mismatch',
      );
    },
  );
  it('requires an independently issued archive action bound to its exact payload', async () => {
    const f = fixture(),
      reader = f.issued();
    let command = makeArchiveCommand({
      ...reader,
      schemaVersion: 3,
      action: 'archive',
      target: { ...reader.target, roleId: 'finalization' },
      payload: f.proof,
    });
    await expect(f.authority.verify(command)).rejects.toThrow(
      'reader-native-authorization-mismatch',
    );
    command = f.authorize(command);
    await expect(f.authority.verify(command)).rejects.toThrow('reader-native-issuance-unconfirmed');
    vi.stubEnv('CODEX_THREAD_ID', 'issuer');
    vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
    expect(await f.authority.issue(command)).toBe(nativeReaderNotice(command));
    f.records.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'issuer',
        turn_id: 'human-turn',
        item: {
          type: 'CommandExecution',
          cwd: f.workspace,
          status: 'completed',
          exit_code: 0,
          aggregated_output: nativeReaderNotice(command),
        },
      },
    });
    f.save();
    expect((await f.authority.verify(command)).origin).toBe('human');
    await expect(
      f.authority.verify(makeArchiveCommand({ ...command, payload: command.source })),
    ).rejects.toThrow('reader-native-authorization-mismatch');
    await expect(
      f.authority.verify(
        makeTaskPlanningCommand({
          ...command,
          schemaVersion: 2,
          action: 'resume',
          target: { ...command.target, roleId: 'task' },
        }),
      ),
    ).rejects.toThrow('reader-native-authorization-mismatch');
  });
  it('binds a version 2 payload to the same primary human issuance without changing version 1', async () => {
    const f = fixture(),
      before = f.issued();
    expect(
      (JSON.parse(nativeReaderNotice(before)) as { readerCommand: { schemaVersion: number } })
        .readerCommand.schemaVersion,
    ).toBe(1);
    expect((await f.authority.verify(before)).origin).toBe('human');
    let command = makeTaskPlanningCommand({
      ...before,
      schemaVersion: 2,
      target: { ...before.target, roleId: 'task' },
      payload: f.proof,
    });
    await expect(f.authority.verify(command)).rejects.toThrow(
      'reader-native-authorization-mismatch',
    );
    command = f.authorize(command);
    await expect(f.authority.verify(command)).rejects.toThrow('reader-native-issuance-unconfirmed');
    vi.stubEnv('CODEX_THREAD_ID', 'issuer');
    vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
    expect(await f.authority.issue(command)).toBe(nativeReaderNotice(command));
    f.records.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'issuer',
        turn_id: 'human-turn',
        item: {
          type: 'CommandExecution',
          cwd: f.workspace,
          status: 'completed',
          exit_code: 0,
          aggregated_output: nativeReaderNotice(command),
        },
      },
    });
    f.save();
    expect(await f.authority.verify(command)).toMatchObject({
      origin: 'human',
      hash: command.hash,
    });
    await expect(
      f.authority.verify(makeTaskPlanningCommand({ ...command, payload: command.source })),
    ).rejects.toThrow('reader-native-authorization-mismatch');
  });
  it('requires native issuance after the human source and preserves a valid command after a later turn', async () => {
    const f = fixture(),
      c = f.command();
    await expect(f.authority.verify(c)).rejects.toThrow('reader-native-issuance-unconfirmed');
    vi.stubEnv('CODEX_THREAD_ID', 'issuer');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
    expect(await f.authority.issue(c)).toBe(nativeReaderNotice(c));
    cwd.mockRestore();
    f.issuedCommand(c);
    const verified = await f.authority.verify(c);
    expect(verified).toMatchObject({ origin: 'human', author: 'user', hash: c.hash });
    const proof = JSON.parse(f.store.read(verified.proof).toString()) as {
      observed: { user: unknown; issued: unknown };
      source: NativeReaderSource;
    };
    expect(proof.source).toEqual(f.source);
    expect(proof.observed.user).toMatchObject({ line: 3 });
    f.records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } });
    f.save();
    expect((await f.authority.verify(c)).origin).toBe('human');
    await expect(f.authority.issue(c)).rejects.toThrow('reader-native-issuer-mismatch');
  });
  it('binds every command field and the source reference to its native notice', async () => {
    const f = fixture(),
      c = f.issued();
    for (const change of [{ author: 'other' }, { hash: 'b'.repeat(64) }])
      await expect(f.authority.verify({ ...c, ...change })).rejects.toThrow(
        'reader-native-command-mismatch',
      );
    for (const change of [
      { commandId: 'other' },
      { expectedRevision: 2 },
      { attempt: 2 },
      { action: 'cancel' as const },
      ...Object.keys(c.target).map((key) => ({
        target: {
          ...c.target,
          [key]: typeof c.target[key as keyof typeof c.target] === 'number' ? 2 : 'foreign',
        },
      })),
    ])
      await expect(f.authority.verify(makeReaderCommand({ ...c, ...change }))).rejects.toThrow(
        'reader-native-issuance-unconfirmed',
      );
    const source = { ...f.source, user: { ...f.source.user, sha256: 'a'.repeat(64) } };
    await expect(f.authority.verify(f.command(source))).rejects.toThrow(
      'reader-native-human-unconfirmed',
    );
  });
  it('rejects undeclared source paths, aliases, malformed artifacts and partial native records', async () => {
    const f = fixture();
    for (const change of [
      { schemaVersion: 2 },
      { kind: 'service' },
      { user: { line: 0, sha256: f.source.user.sha256 } },
      { user: { line: 1.5, sha256: f.source.user.sha256 } },
      { user: { line: 3, sha256: 'x' } },
      { threadId: 'foreign' },
      { transcript: 'relative.jsonl' },
      { transcript: join(f.root, 'elsewhere.jsonl') },
    ])
      await expect(
        f.authority.verify(f.command({ ...f.source, ...change } as NativeReaderSource)),
      ).rejects.toThrow();
    const alias = join(f.sessions, 'alias.jsonl');
    symlinkSync(f.transcript, alias);
    await expect(f.authority.verify(f.command({ ...f.source, transcript: alias }))).rejects.toThrow(
      'unsafe-private-file',
    );
    writeFileSync(f.transcript, readFileSync(f.transcript).subarray(0, -1));
    await expect(f.authority.verify(f.command())).rejects.toThrow('reader-native-history-partial');
    writeFileSync(f.transcript, Buffer.from([0xff, 10]));
    await expect(f.authority.verify(f.command())).rejects.toThrow('reader-native-history-partial');
    writeFileSync(f.transcript, 'broken\n');
    await expect(f.authority.verify(f.command())).rejects.toThrow();
  });
  it('rejects foreign native identity, workspace, version and missing or duplicated session metadata', async () => {
    const f = fixture(),
      original = { ...f.payload(0) };
    for (const change of [
      { id: 'other' },
      { session_id: 'other' },
      { cwd: '/other' },
      { cli_version: '0.154.0' },
    ]) {
      f.records[0] = { type: 'session_meta', payload: { ...original, ...change } };
      f.save();
      await expect(f.authority.verify(f.command())).rejects.toThrow(
        'reader-native-session-unconfirmed',
      );
    }
    f.records[0] = {
      type: 'session_meta',
      payload: { ...original, cwd: pathToFileURL(f.workspace).href },
    };
    f.issued();
    expect((await f.authority.verify(f.command())).origin).toBe('human');
    f.records.push(f.records[0]!);
    f.save();
    await expect(f.authority.verify(f.command())).rejects.toThrow(
      'reader-native-session-unconfirmed',
    );
    f.records.splice(-1);
    f.records[0] = { type: 'other', payload: {} };
    f.save();
    await expect(f.authority.verify(f.command())).rejects.toThrow(
      'reader-native-session-unconfirmed',
    );
  });
  it('never accepts assistant, tool, service, empty, absent or foreign-turn text as a human grant', async () => {
    for (const change of [
      { role: 'assistant' },
      { type: 'function_call_output' },
      { content: null },
      { content: [] },
      {
        content: [
          { type: 'other', text: 'resume' },
          { type: 'input_text', text: 0 },
        ],
      },
      ...[
        '',
        '  ',
        '<skill>resume',
        ' <external_codex_apps_open_page>resume',
        '<environment_context>resume',
        '# AGENTS.md instructions for /a',
      ].map((text) => ({ content: [{ type: 'input_text', text }] })),
    ]) {
      const f = fixture();
      f.replaceHuman(change);
      await expect(f.authority.verify(f.command())).rejects.toThrow(
        'reader-native-human-unconfirmed',
      );
    }
    const f = fixture();
    f.payload(1).turn_id = 'foreign';
    f.save();
    await expect(f.authority.verify(f.command())).rejects.toThrow(
      'reader-native-human-unconfirmed',
    );
    await expect(
      f.authority.verify(f.command({ ...f.source, user: { ...f.source.user, line: 99 } })),
    ).rejects.toThrow('reader-native-human-unconfirmed');
  });
  it('rejects an unsuccessful, foreign, reordered or non-native issuance', async () => {
    for (const change of [
      { type: 'AgentMessage' },
      { aggregated_output: 0 },
      { aggregated_output: 'not the notice' },
      { cwd: '/other' },
      { status: 'failed' },
      { exit_code: 1 },
    ]) {
      const f = fixture(),
        c = f.issued();
      Object.assign(f.payload(4).item as object, change);
      f.save();
      await expect(f.authority.verify(c)).rejects.toThrow('reader-native-issuance-unconfirmed');
    }
    for (const change of [{ thread_id: 'foreign' }, { turn_id: 'foreign' }]) {
      const f = fixture(),
        c = f.issued();
      Object.assign(f.payload(4), change);
      f.save();
      await expect(f.authority.verify(c)).rejects.toThrow('reader-native-issuance-unconfirmed');
    }
    const f = fixture(),
      c = f.issued();
    const item = f.payload(4).item as Record<string, unknown>;
    item.cwd = pathToFileURL(f.workspace).href;
    f.save();
    expect((await f.authority.verify(c)).origin).toBe('human');
    f.records.unshift(f.records.pop()!);
    f.source.user.line = 4;
    f.save();
    await expect(f.authority.verify(f.command())).rejects.toThrow(
      'reader-native-issuance-unconfirmed',
    );
    const g = fixture(),
      other = g.issued();
    g.records.splice(4, 0, {
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'foreign' },
    });
    g.save();
    await expect(g.authority.verify(other)).rejects.toThrow('reader-native-issuance-unconfirmed');
  });
  it('does not mint a notice from another running chat, workspace or superseded human source', async () => {
    const f = fixture();
    vi.stubEnv('CODEX_THREAD_ID', 'foreign');
    await expect(f.authority.issue(f.command())).rejects.toThrow('reader-native-issuer-mismatch');
    vi.stubEnv('CODEX_THREAD_ID', 'issuer');
    await expect(f.authority.issue(f.command())).rejects.toThrow('reader-native-issuer-mismatch');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
    f.records.push({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Стоп' }] },
    });
    f.save();
    await expect(f.authority.issue(f.command())).rejects.toThrow('reader-native-human-superseded');
    f.issued();
    await expect(f.authority.verify(f.command())).rejects.toThrow(
      'reader-native-issuance-unconfirmed',
    );
    cwd.mockRestore();
  });
  it('is consumed by the existing receiver before any permission changes', async () => {
    const f = fixture(),
      controls = readerControlActivities(f.registration, f.rpc, f.gate, f.authority);
    f.gate.advance(f.input, f.permit, f.localCommand('pause'), f.proof);
    f.gate.confirmStop(f.input, f.permit, 1, f.proof);
    const c = f.issued();
    expect((await controls.applyReaderCommand(f.input, f.permit, c)).revision).toBe(2);
    f.gate.boundary.assert(f.input, { permit: f.permit, revision: 2, attempt: 1 });
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
});
