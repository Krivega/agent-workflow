import { homedir } from 'node:os';
import { taskBackendPolicy, requireTaskBackend } from '../../src/adapters/project/taskBackend.js';
import { dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { sameValue, stableJson } from '../../core/equality.js';
import type { ChatAnchor } from '../../core/currentChat.js';
import type { InputRef } from '../../core/localRun.js';
import type { UserCommands, UserCommandTarget } from '../../ports/userCommands.js';
import { contentHash } from '../project/projectFiles.js';
import { readPrivateFile, safeDirectory, writePrivateFile } from '../storage/storeFiles.js';
import { FileCurrentChatHost, chatPath, isSupportedChatSession } from './currentChatHost.js';
import {
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
  nativeDesktopCommandTurn,
} from '../../src/adapters/codex/nativeDesktopUser.js';
import { nativeWorkspaceMatches } from '../../src/adapters/codex/nativeWorkspace.js';

interface Command {
  schema_version: 1;
  action: 'RESUME';
  target: UserCommandTarget;
  issuer: { transcript: string; anchor: ChatAnchor; source: InputRef };
}
export function userCommandNotice(authorization: InputRef) {
  return {
    user_command: authorization.hash,
    authorization: { locator: authorization.locator, hash: authorization.hash },
  };
}
export class NativeUserCommands implements UserCommands {
  constructor(private readonly root: string) {}

  private async records(transcript: string) {
    const nativeRoot = await realpath(
      resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'sessions'),
    );
    requireWorkflow(
      resolve(transcript) === transcript &&
        transcript.startsWith(nativeRoot + '/') &&
        (await realpath(transcript)) === transcript,
      'chat-command-native-source-required',
    );
    safeDirectory(dirname(transcript));
    const bytes = readPrivateFile(transcript).toString('utf8');
    requireWorkflow(bytes.endsWith('\n'), 'chat-command-history-partial');
    return bytes
      .slice(0, -1)
      .split('\n')
      .map((line, index) => ({
        record: object(JSON.parse(line) as unknown),
        ref: { locator: `${transcript}#L${index + 1}`, hash: contentHash(line + '\n') },
      }));
  }

  async issue(request: Record<string, unknown>) {
    if (taskBackendPolicy(this.root) !== null) {
      const target = object(request.target);
      requireTaskBackend(
        this.root,
        textField(target.project_id),
        textField(target.task_id),
        'legacy',
        'legacy',
      );
    }
    const transcript = textField(request.transcript);
    await this.records(transcript);
    const anchor = request.anchor as ChatAnchor;
    requireWorkflow(
      anchor.thread_id === process.env.CODEX_THREAD_ID,
      'chat-environment-identity-mismatch',
    );
    const host = new FileCurrentChatHost(this.root, transcript, anchor);
    await host.observe();
    const source = request.human_source as InputRef;
    await host.message(source);
    const target = object(request.target) as unknown as UserCommandTarget;
    [target.project_id, target.task_id, target.run_id, target.thread_id].forEach(textField);
    requireWorkflow(
      Number.isSafeInteger(target.generation) &&
        target.generation > 0 &&
        [target.control_revision, target.requirements_revision].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ),
      'chat-command-revision-required',
    );
    const command: Command = {
      schema_version: 1,
      action: 'RESUME',
      target,
      issuer: { transcript, anchor, source },
    };
    const bytes = stableJson(command) + '\n';
    const hash = contentHash(bytes);
    const directory = textField(request.command_root);
    requireWorkflow(
      !directory.startsWith(resolve(this.root) + '/') && directory !== resolve(this.root),
      'chat-command-must-be-external',
    );
    safeDirectory(directory);
    const authorization = { locator: resolve(directory, `user-command-${hash}.json`), hash };
    try {
      writePrivateFile(authorization.locator, bytes);
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        readPrivateFile(authorization.locator).toString('utf8') === bytes,
        'chat-command-conflict',
      );
    }
    return userCommandNotice(authorization);
  }

  async verify(source: InputRef, target: UserCommandTarget) {
    const bytes = readPrivateFile(source.locator).toString('utf8');
    requireWorkflow(contentHash(bytes) === source.hash, 'chat-command-changed');
    const command = object(JSON.parse(bytes) as unknown) as unknown as Command;
    requireWorkflow(
      command.schema_version === 1 &&
        command.action === 'RESUME' &&
        sameValue(command.target, target),
      'chat-command-target-mismatch',
    );
    const { transcript, anchor, source: human } = command.issuer;
    const records = await this.records(transcript);
    const sessions = records.filter((entry) => entry.record.type === 'session_meta');
    requireWorkflow(sessions.length === 1, 'chat-command-issuer-unconfirmed');
    const session = object(sessions[0]!.record.payload);
    const desktop166 = isNativeDesktopUser166(session);
    const workspace = await realpath(this.root);
    const contexts = () =>
      records
        .filter((entry) => entry.record.type === 'turn_context')
        .map((entry) => object(entry.record.payload));
    requireWorkflow(
      session.id === anchor.thread_id &&
        session.session_id === anchor.thread_id &&
        (chatPath(session.cwd) === workspace ||
          nativeWorkspaceMatches(session, contexts(), anchor.turn_id, workspace)) &&
        (!desktop166 || nativeDesktopCommandTurn(contexts(), anchor.turn_id, workspace)) &&
        chatPath(anchor.workspace) === workspace &&
        anchor.host_id === 'local' &&
        isSupportedChatSession(session),
      'chat-command-issuer-unconfirmed',
    );
    requireWorkflow(
      !desktop166 ||
        !hasNativeDesktopInboundDelivery(
          records.map(({ record }) => record),
          anchor.turn_id,
        ),
      'chat-command-human-delegated',
    );
    let turn = '';
    let humanIndex = -1;
    let issued = false;
    const notice = JSON.stringify(userCommandNotice(source));
    for (const [index, entry] of records.entries()) {
      const payload = object(entry.record.payload);
      if (entry.record.type === 'event_msg' && payload.type === 'task_started')
        turn = textField(payload.turn_id);
      if (sameValue(entry.ref, human)) {
        requireWorkflow(
          turn === anchor.turn_id &&
            entry.record.type === 'response_item' &&
            payload.type === 'message' &&
            payload.role === 'user' &&
            Array.isArray(payload.content) &&
            payload.content.some((part) => {
              const p = object(part);
              return p.type === 'input_text' && typeof p.text === 'string' && p.text.length > 0;
            }),
          'chat-command-human-unconfirmed',
        );
        humanIndex = index;
      }
      if (entry.record.type !== 'event_msg' || payload.type !== 'item_completed') continue;
      const item = object(payload.item);
      if (
        item.type !== 'CommandExecution' ||
        typeof item.aggregated_output !== 'string' ||
        !item.aggregated_output.split('\n').includes(notice)
      )
        continue;
      if (
        humanIndex >= 0 &&
        index > humanIndex &&
        payload.thread_id === anchor.thread_id &&
        payload.turn_id === anchor.turn_id &&
        turn === anchor.turn_id &&
        chatPath(item.cwd) === (await realpath(this.root)) &&
        item.status === 'completed' &&
        item.exit_code === 0
      )
        issued = true;
    }
    requireWorkflow(humanIndex >= 0 && issued, 'chat-command-issuance-unconfirmed');
  }
}
