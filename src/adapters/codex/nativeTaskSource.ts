import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TaskStartPrincipalBinding } from '../../contracts/taskStartAdmission.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import { exactFields, identifier, object, requireContract, text } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest, readPrivateFile } from '../artifacts/files.js';
import type { artifactStore } from '../artifacts/files.js';
import {
  comparisonDesktopHistory,
  hasNativeDesktopInboundDelivery,
  isTaskStartDesktopRoot,
  isNativeDesktopUser166,
  nativeDesktopCommandTurn,
} from './nativeDesktopUser.js';

export interface NativeTaskIssuer {
  sessionsRoot: string;
  chatWorkspace: string;
  threadId: string;
  owner: string;
}
export interface NativeTaskPrimarySource {
  transcript: string;
  turnId: string;
  user: { line: number; sha256: string };
}
export interface NativeTaskRow {
  raw: string;
  ref: { locator: string; hash: string };
  record: Record<string, unknown>;
}

/** Reads actual private Desktop records; a historical proof grants no new action. */
export function nativeTaskSource(
  store: ReturnType<typeof artifactStore>,
  issuer: NativeTaskIssuer,
) {
  const sessionsRoot = realpathSync(issuer.sessionsRoot),
    workspace = realpathSync(issuer.chatWorkspace),
    threadId = identifier(issuer.threadId),
    owner = identifier(issuer.owner);
  function assertCurrentHost() {
    requireContract(
      process.env.CODEX_THREAD_ID === threadId && realpathSync(process.cwd()) === workspace,
      'task-native-current-host',
    );
  }
  function readActual(transcript: string, prefixRef?: ArtifactRef) {
    requireContract(
      isAbsolute(transcript) &&
        resolve(transcript) === transcript &&
        transcript.startsWith(sessionsRoot + sep) &&
        realpathSync(transcript) === transcript,
      'task-native-private-path',
    );
    const before = lstatSync(transcript);
    requireContract(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === process.getuid?.() &&
        (before.mode & 0o077) === 0,
      'task-native-private-file',
    );
    const actual = readPrivateFile(transcript),
      after = lstatSync(transcript);
    requireContract(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.mode === after.mode &&
        after.nlink === 1 &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        actual.length === after.size,
      'task-native-history-changed',
    );
    const ref = prefixRef === undefined ? null : controlRef(prefixRef),
      bytes = ref === null ? actual : actual.subarray(0, ref.bytes);
    requireContract(
      ref === null || (bytes.length === ref.bytes && digest(bytes) === ref.sha256),
      'task-native-principal-prefix',
    );
    const body = bytes.toString('utf8');
    requireContract(
      Buffer.from(body).equals(bytes) && body.endsWith('\n'),
      'task-native-history-changed',
    );
    const rows: NativeTaskRow[] = body
      .slice(0, -1)
      .split('\n')
      .map((line, index) => ({
        raw: line + '\n',
        ref: { locator: transcript + '#L' + (index + 1), hash: digest(line + '\n') },
        record: object(JSON.parse(line) as unknown),
      }));
    const sessions = rows.filter((row) => row.record.type === 'session_meta');
    requireContract(sessions.length === 1, 'task-native-session');
    const session = object(sessions[0]!.record.payload);
    requireContract(
      (isNativeDesktopUser166(session) || isTaskStartDesktopRoot(session)) &&
        session.id === threadId &&
        session.session_id === threadId &&
        session.cwd === workspace,
      'task-native-session',
    );
    return { transcript, bytes, rows, session };
  }
  function primary(source: NativeTaskPrimarySource, prefixRef?: ArtifactRef) {
    exactFields(object(source), ['transcript', 'turnId', 'user']);
    exactFields(object(source.user), ['line', 'sha256']);
    identifier(source.turnId);
    requireContract(
      Number.isSafeInteger(source.user.line) && source.user.line > 0,
      'task-native-source',
    );
    controlRef({ sha256: source.user.sha256, bytes: 0 });
    const observed = readActual(text(source.transcript), prefixRef),
      index = source.user.line - 1,
      selected = observed.rows[index];
    requireContract(selected?.ref.hash === source.user.sha256, 'task-native-source');
    const requiresRootTurn = isTaskStartDesktopRoot(observed.session);
    const history = requiresRootTurn ? comparisonDesktopHistory(observed.rows) : observed.rows;
    const contexts = history
      .filter((row) => row.record.type === 'turn_context')
      .map((row) => object(row.record.payload));
    requireContract(
      nativeDesktopCommandTurn(contexts, source.turnId, workspace) &&
        !hasNativeDesktopInboundDelivery(
          observed.rows.map((row) => row.record),
          source.turnId,
        ),
      'task-native-delegated',
    );
    if (requiresRootTurn) {
      const context = contexts.find((row) => row.turn_id === source.turnId)!;
      requireContract(
        context.root_turn_id === source.turnId &&
          (prefixRef !== undefined || contexts.at(-1) === context),
        'task-native-root-turn',
      );
    }
    const p = object(selected.record.payload),
      metadata = object(p.internal_chat_message_metadata_passthrough);
    requireContract(
      selected.record.type === 'response_item' &&
        p.type === 'message' &&
        p.role === 'user' &&
        metadata.turn_id === source.turnId &&
        typeof metadata.create_time === 'number' &&
        Number.isFinite(metadata.create_time) &&
        isDeepStrictEqual(metadata.content_item_kinds, ['user.text']) &&
        isDeepStrictEqual(metadata.content_item_metadata, [{ provenance: { type: 'user' } }]) &&
        Array.isArray(p.content) &&
        p.content.length === 1,
      'task-native-primary-user',
    );
    const content = object(p.content[0]);
    exactFields(content, ['type', 'text']);
    requireContract(
      content.type === 'input_text' &&
        typeof content.text === 'string' &&
        content.text.trim().length > 0 &&
        !(
          requiresRootTurn &&
          /^<(?:send_user_message_question_reply|external_codex_apps_open_page|skill)>/u.test(
            content.text.trimStart(),
          )
        ),
      'task-native-primary-user',
    );
    let turn = '',
      lastTurn = '',
      latestUser = -1;
    for (const [at, row] of observed.rows.entries()) {
      const value = object(row.record.payload);
      if (row.record.type === 'event_msg' && value.type === 'task_started')
        lastTurn = text(value.turn_id);
      if (at === index) turn = lastTurn;
      if (
        row.record.type === 'response_item' &&
        value.type === 'message' &&
        value.role === 'user'
      ) {
        const metadata = object(
          value.internal_chat_message_metadata_passthrough ?? {},
        ).content_item_metadata;
        if (
          Array.isArray(metadata) &&
          metadata.some((part) => object(object(part).provenance).type === 'user')
        )
          latestUser = at;
      }
    }
    requireContract(turn === source.turnId, 'task-native-turn');
    const delivery = observed.rows.filter((row, at) => {
      if (at <= index || row.record.type !== 'event_msg') return false;
      const value = object(row.record.payload);
      if (
        value.type !== 'item_completed' ||
        value.thread_id !== threadId ||
        value.turn_id !== source.turnId
      )
        return false;
      const item = object(value.item);
      return (
        item.type === 'UserMessage' &&
        isDeepStrictEqual(item.content, [{ type: 'text', text: content.text, text_elements: [] }])
      );
    });
    requireContract(delivery.length === 1, 'task-native-user-delivery');
    const end = observed.rows.indexOf(delivery[0]!) + 1;
    const prefix = Buffer.from(
      observed.rows
        .slice(0, end)
        .map((row) => row.raw)
        .join(''),
    );
    return { ...observed, selected, index, latestUser, lastTurn, prefix };
  }
  return {
    issuer: { ...issuer, sessionsRoot, chatWorkspace: workspace, threadId, owner },
    assertCurrentHost,
    readPrimary: primary,
    read: (transcript: string) => readActual(transcript),
    readPrefix: (transcript: string, prefix: ArtifactRef) => readActual(transcript, prefix),
    async issue(source: NativeTaskPrimarySource): Promise<TaskStartPrincipalBinding> {
      const observed = primary(source);
      assertCurrentHost();
      requireContract(
        observed.lastTurn === source.turnId && observed.latestUser === observed.index,
        'task-native-primary-superseded',
      );
      const base = { owner, threadId, turnId: source.turnId, source: observed.selected.ref },
        prefix = { sha256: digest(observed.prefix), bytes: observed.prefix.length },
        proof = store.publish(
          Buffer.from(
            JSON.stringify({
              kind: 'task-native-principal/1',
              ...base,
              transcript: source.transcript,
              user: source.user,
              prefix,
            }),
          ),
        );
      // Recheck the real current source after publishing immutable evidence.
      const fresh = primary(source);
      assertCurrentHost();
      requireContract(
        fresh.lastTurn === source.turnId &&
          fresh.latestUser === fresh.index &&
          fresh.prefix.equals(observed.prefix),
        'task-native-primary-superseded',
      );
      return { ...base, proof };
    },
    async verify(binding: TaskStartPrincipalBinding): Promise<void> {
      requireContract(
        binding.owner === owner && binding.threadId === threadId,
        'task-native-principal-owner',
      );
      const proof = object(
        JSON.parse(store.read(controlRef(binding.proof)).toString('utf8')) as unknown,
      );
      exactFields(proof, [
        'kind',
        'owner',
        'threadId',
        'turnId',
        'source',
        'transcript',
        'user',
        'prefix',
      ]);
      requireContract(
        proof.kind === 'task-native-principal/1' &&
          proof.owner === owner &&
          proof.threadId === threadId &&
          proof.turnId === binding.turnId &&
          isDeepStrictEqual(proof.source, binding.source),
        'task-native-principal-proof',
      );
      const user = object(proof.user);
      exactFields(user, ['line', 'sha256']);
      requireContract(
        Number.isSafeInteger(user.line) && Number(user.line) > 0,
        'task-native-source',
      );
      const source = {
          transcript: text(proof.transcript),
          turnId: binding.turnId,
          user: { line: Number(user.line), sha256: text(user.sha256) },
        },
        observed = primary(source, controlRef(proof.prefix));
      requireContract(
        isDeepStrictEqual(observed.selected.ref, binding.source) &&
          isDeepStrictEqual(controlRef(proof.prefix), {
            sha256: digest(observed.prefix),
            bytes: observed.prefix.length,
          }),
        'task-native-principal-prefix',
      );
    },
  };
}
