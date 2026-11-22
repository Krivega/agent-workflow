import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ReaderAuthority,
  AuthorizedReaderCommand,
  PayloadReaderCommand,
  ArchiveCommand,
} from '../../contracts/readerControl.js';
import { exactFields, identifier, object, requireContract, text } from '../../contracts/project.js';
import {
  controlRef,
  parseReaderCommand,
  parsePayloadReaderCommand,
  parseArchiveCommand,
  readerCommandText,
} from '../../policy/readerControl.js';
import { digest, readPrivateFile } from '../artifacts/files.js';
import {
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
  nativeDesktopCommandTurn,
} from './nativeDesktopUser.js';
import { nativeQuestionAuthorization, type NativeQuestionProof } from './nativeQuestion.js';
import { nativeTaskSource } from './nativeTaskSource.js';
import { nativeWorkspaceMatches } from './nativeWorkspace.js';
import type { artifactStore } from '../artifacts/files.js';

export interface NativeReaderSource {
  schemaVersion: 1;
  kind: 'codex-user-command';
  transcript: string;
  threadId: string;
  turnId: string;
  user: { line: number; sha256: string };
}
export interface NativeReaderIssuer {
  sessionsRoot: string;
  workspaceRoot: string;
  threadId: string;
  owner: string;
}
function sourceValue(value: unknown): NativeReaderSource {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'transcript', 'threadId', 'turnId', 'user']);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'codex-user-command',
    'reader-native-source-version',
  );
  const user = object(v.user);
  exactFields(user, ['line', 'sha256']);
  requireContract(
    Number.isSafeInteger(user.line) && Number(user.line) > 0,
    'reader-native-source-line',
  );
  return {
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript: text(v.transcript),
    threadId: identifier(v.threadId),
    turnId: identifier(v.turnId),
    user: { line: Number(user.line), sha256: controlRef({ sha256: user.sha256, bytes: 0 }).sha256 },
  };
}
function localPath(value: unknown): string {
  const path = text(value);
  return path.startsWith('file:') ? fileURLToPath(path) : path;
}
export function nativeReaderNotice(command: AuthorizedReaderCommand): string {
  return JSON.stringify({
    readerCommand: {
      schemaVersion: command.schemaVersion,
      commandId: command.commandId,
      hash: command.hash,
      source: command.source,
      ...(command.schemaVersion !== 1 ? { payload: command.payload } : {}),
    },
  });
}
export function nativeHumanAuthorizationText(
  command: PayloadReaderCommand | ArchiveCommand,
): string {
  const t = command.target;
  return JSON.stringify({
    schemaVersion: command.schemaVersion,
    commandId: command.commandId,
    author: command.author,
    action: command.action,
    target: {
      workflowId: t.workflowId,
      projectId: t.projectId,
      taskId: t.taskId,
      roleId: t.roleId,
      hostId: t.hostId,
      workspaceId: t.workspaceId,
      owner: t.owner,
      generation: t.generation,
      requirementsRevision: t.requirementsRevision,
    },
    expectedRevision: command.expectedRevision,
    attempt: command.attempt,
    payload: { sha256: command.payload.sha256, bytes: command.payload.bytes },
  });
}

export function nativeReaderAuthority(
  store: ReturnType<typeof artifactStore>,
  issuer: NativeReaderIssuer,
): ReaderAuthority & { issue(command: AuthorizedReaderCommand): Promise<string> } {
  const root = realpathSync(issuer.sessionsRoot),
    workspace = realpathSync(issuer.workspaceRoot);
  identifier(issuer.threadId);
  identifier(issuer.owner);
  function observe(raw: AuthorizedReaderCommand) {
    const command =
      raw.schemaVersion === 3
        ? parseArchiveCommand(raw)
        : raw.schemaVersion === 2
          ? parsePayloadReaderCommand(raw)
          : parseReaderCommand(raw);
    requireContract(
      command.author === issuer.owner && digest(readerCommandText(command)) === command.hash,
      'reader-native-command-mismatch',
    );
    const source = sourceValue(JSON.parse(store.read(command.source).toString('utf8')) as unknown);
    requireContract(
      source.threadId === issuer.threadId &&
        resolve(source.transcript) === source.transcript &&
        source.transcript.startsWith(root + sep),
      'reader-native-source-untrusted',
    );
    const bytes = readPrivateFile(source.transcript),
      body = bytes.toString('utf8');
    requireContract(
      Buffer.from(body).equals(bytes) && body.endsWith('\n'),
      'reader-native-history-partial',
    );
    const records = body
      .slice(0, -1)
      .split('\n')
      .map((line, index) => ({
        line: index + 1,
        sha256: digest(line + '\n'),
        raw: object(JSON.parse(line) as unknown),
      }));
    const sessions = records.filter((r) => r.raw.type === 'session_meta');
    requireContract(sessions.length === 1, 'reader-native-session-unconfirmed');
    const session = object(sessions[0]!.raw.payload);
    const desktop166 = isNativeDesktopUser166(session);
    const contexts = () =>
      records
        .filter((entry) => entry.raw.type === 'turn_context')
        .map((entry) => object(entry.raw.payload));
    const desktopResume =
      session.cli_version === '0.169.1' &&
      command.schemaVersion === 2 &&
      command.action === 'resume' &&
      command.target.roleId === 'task';
    if (desktopResume) {
      nativeTaskSource(store, { ...issuer, chatWorkspace: workspace }).readPrimary(
        { transcript: source.transcript, turnId: source.turnId, user: source.user },
        { sha256: digest(bytes), bytes: bytes.length },
      );
    }
    requireContract(
      session.id === source.threadId &&
        session.session_id === source.threadId &&
        (localPath(session.cwd) === workspace ||
          nativeWorkspaceMatches(session, contexts(), source.turnId, workspace)) &&
        (desktopResume ||
          (desktop166 && nativeDesktopCommandTurn(contexts(), source.turnId, workspace)) ||
          session.cli_version === '0.164.0-alpha.11.1' ||
          (session.cli_version === '0.165.0-alpha.1.2' &&
            session.source === 'vscode' &&
            (session.forked_from_id === null ||
              (!Object.hasOwn(session, 'forked_from_id') &&
                session.originator === 'codex_work_desktop' &&
                session.thread_source === 'user')))),
      'reader-native-session-unconfirmed',
    );
    requireContract(
      !desktop166 ||
        !hasNativeDesktopInboundDelivery(
          records.map(({ raw }) => raw),
          source.turnId,
        ),
      'reader-native-human-delegated',
    );
    let turn = '',
      humanIndex = -1,
      latestHuman = -1;
    let question: NativeQuestionProof | null = null;
    const humanByRecord = new Map<number, number>();
    for (const [index, entry] of records.entries()) {
      const p = object(entry.raw.payload);
      if (entry.raw.type === 'event_msg' && p.type === 'task_started') turn = text(p.turn_id);
      if (
        entry.raw.type === 'response_item' &&
        p.type === 'message' &&
        p.role === 'user' &&
        Array.isArray(p.content)
      ) {
        const content = p.content
          .map(object)
          .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
          .map((part) => String(part.text))
          .join('\n');
        const human =
          content.trim().length > 0 &&
          !/^\s*(?:<external_codex_apps_|<skill>|<environment_context>|# AGENTS\.md instructions)/u.test(
            content,
          );
        if (human) latestHuman = index;
        if (entry.line === source.user.line) {
          requireContract(
            human && entry.sha256 === source.user.sha256 && turn === source.turnId,
            'reader-native-human-unconfirmed',
          );
          if (command.schemaVersion !== 1) {
            const expected = nativeHumanAuthorizationText(command);
            if (!desktopResume && content.trim() !== expected)
              question = nativeQuestionAuthorization(
                content,
                expected,
                records,
                index,
                source.threadId,
                session.cli_version,
              );
            requireContract(
              content.trim() === expected || question !== null,
              'reader-native-authorization-mismatch',
            );
          }
          humanIndex = index;
        }
      }
      humanByRecord.set(index, latestHuman);
    }
    requireContract(humanIndex >= 0, 'reader-native-human-unconfirmed');
    return {
      command,
      source,
      bytes,
      records,
      session,
      desktop166: desktop166 || desktopResume,
      humanIndex,
      humanByRecord,
      lastTurn: turn,
      question,
    };
  }
  return {
    async issue(command) {
      const observed = observe(command);
      requireContract(
        process.env.CODEX_THREAD_ID === issuer.threadId &&
          realpathSync(process.cwd()) === workspace &&
          observed.lastTurn === observed.source.turnId,
        'reader-native-issuer-mismatch',
      );
      requireContract(
        observed.humanByRecord.get(observed.records.length - 1) === observed.humanIndex,
        'reader-native-human-superseded',
      );
      return nativeReaderNotice(observed.command);
    },
    async verify(command) {
      const o = observe(command),
        notice = nativeReaderNotice(o.command);
      let turn = '',
        issued: (typeof o.records)[number] | null = null;
      for (const [index, entry] of o.records.entries()) {
        const p = object(entry.raw.payload);
        if (entry.raw.type === 'event_msg' && p.type === 'task_started') turn = text(p.turn_id);
        if (entry.raw.type !== 'event_msg' || p.type !== 'item_completed') continue;
        const item = object(p.item);
        if (
          item.type !== 'CommandExecution' ||
          typeof item.aggregated_output !== 'string' ||
          !item.aggregated_output.split('\n').includes(notice)
        )
          continue;
        if (
          index > o.humanIndex &&
          o.humanByRecord.get(index) === o.humanIndex &&
          turn === o.source.turnId &&
          p.thread_id === o.source.threadId &&
          p.turn_id === o.source.turnId &&
          localPath(item.cwd) === workspace &&
          item.status === 'completed' &&
          item.exit_code === 0
        )
          issued = entry;
      }
      requireContract(issued !== null, 'reader-native-issuance-unconfirmed');
      const proof = store.publish(
        Buffer.from(
          JSON.stringify({
            kind: 'reader-native-human-authorization',
            command: o.command,
            source: o.source,
            observed: {
              sha256: digest(o.bytes),
              bytes: o.bytes.length,
              session: {
                id: o.session.id,
                session_id: o.session.session_id,
                cwd: o.session.cwd,
                cli_version: o.session.cli_version,
                ...(o.desktop166 || o.session.cli_version === '0.165.0-alpha.1.2'
                  ? {
                      source: o.session.source,
                      ...(Object.hasOwn(o.session, 'forked_from_id')
                        ? { forked_from_id: o.session.forked_from_id }
                        : {
                            originator: o.session.originator,
                            thread_source: o.session.thread_source,
                          }),
                    }
                  : {}),
              },
              user: o.records[o.humanIndex],
              ...(o.question === null ? {} : { question: o.question }),
              issued,
            },
          }),
        ),
      );
      return { origin: 'human', author: issuer.owner, hash: command.hash, proof };
    },
  };
}
