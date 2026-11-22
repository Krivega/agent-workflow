import type { ReaderInput } from '../contracts/reader.js';
import type { ReaderAuthority, ReaderControlActivities } from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { object, requireContract, text } from '../contracts/project.js';
import { checkRegistration, parsePreparation } from '../policy/preparation.js';
import {
  checkReaderTarget,
  parseReaderCommand,
  readerCommandText,
  readerKey,
  readerTarget,
} from '../policy/readerControl.js';
import { artifactStore, digest } from '../adapters/artifacts/files.js';
import type { readerBoundary } from '../adapters/codex/readerBoundary.js';
import { readerSession } from '../adapters/codex/readerSession.js';
import { recoverSentTurn, sentMessage } from '../adapters/codex/recoveredSend.js';
import { nativeReaderHeader, unpersistedReaderHistory } from '../adapters/codex/readerHeader.js';
import { isDeepStrictEqual as same } from 'node:util';

export function readerControlActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  boundary: ReturnType<typeof readerBoundary>,
  authority: ReaderAuthority,
): ReaderControlActivities {
  const store = artifactStore(registration.artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  function check(input: ReaderInput) {
    readerTarget(input, readerKey(input));
    checkRegistration(parsePreparation(input.preparation), registration);
    requireContract(
      input.preparation.project.roles.some((role) => role.id === input.roleId),
      'reader-role-not-declared',
    );
  }
  return {
    async registerReader(input, workflowId) {
      check(input);
      requireContract(workflowId === readerKey(input), 'reader-workflow-id-mismatch');
      return boundary.install(input);
    },
    async applyReaderCommand(input, permit, raw) {
      check(input);
      const command = parseReaderCommand(raw);
      checkReaderTarget(command, input, readerKey(input));
      requireContract(
        digest(readerCommandText(command)) === command.hash,
        'reader-command-hash-invalid',
      );
      const previous = boundary.commandAck(input, permit, command);
      if (previous !== null) return previous;
      const verified = await authority.verify(command);
      requireContract(
        verified.origin === 'human' || verified.origin === 'initial-grant',
        'reader-command-authority-mismatch',
      );
      requireContract(
        verified.author === command.author && verified.hash === command.hash,
        'reader-command-authority-mismatch',
      );
      requireContract(
        command.action !== 'resume' || verified.origin === 'human',
        'reader-resume-human-required',
      );
      store.read(verified.proof);
      const authorization = save({ kind: 'reader-control-authorization', command, verified });
      return boundary.advance(input, permit, command, authorization);
    },
    async freezeReader(input, permit) {
      check(input);
      return boundary.freeze(input, permit);
    },
    async stopReader(input, permit, minimumRevision) {
      check(input);
      const frozenProfile = boundary.execution(input, permit).profile;
      const requests = boundary.requests(input, permit, minimumRevision);
      const observations: unknown[] = [];
      try {
        const sessions = new Map<string, Record<string, unknown>>();
        let unknown = false;
        for (const request of requests.filter(
          (request) => request.method === 'thread/start' || request.method === 'thread/resume',
        )) {
          if (request.response === null) {
            unknown = true;
            continue;
          }
          const session = readerSession(
            request.response,
            registration.workspaceRoot,
            frozenProfile,
          );
          sessions.set(session.id, session.thread);
        }
        const terminal = ['completed', 'failed', 'interrupted'];
        for (const id of sessions.keys()) {
          async function observe() {
            const raw = await rpc.request('thread/read', { threadId: id, includeTurns: true });
            observations.push(save({ kind: 'reader-stop-observation', permit, raw }));
            const thread = object(object(raw).thread);
            requireContract(
              thread.id === id &&
                thread.cwd === registration.workspaceRoot &&
                Array.isArray(thread.turns),
              'reader-stop-history-unconfirmed',
            );
            return { thread, turns: thread.turns.map(object) };
          }
          let before: Awaited<ReturnType<typeof observe>>;
          try {
            before = await observe();
          } catch (error) {
            if (!unpersistedReaderHistory(error, frozenProfile.clientVersion)) throw error;
            requireContract(
              !unknown &&
                requests.length === 1 &&
                requests[0]!.method === 'thread/start' &&
                (sessions.get(id)!.turns as unknown[]).length === 0,
              'reader-unstarted-history-unconfirmed',
            );
            const first = await nativeReaderHeader(
              rpc,
              registration.workspaceRoot,
              frozenProfile,
              id,
            );
            requireContract(
              object(first.thread.status).type === 'idle',
              'reader-unstarted-session-active',
            );
            const second = await nativeReaderHeader(
              rpc,
              registration.workspaceRoot,
              frozenProfile,
              id,
            );
            requireContract(
              object(second.thread.status).type === 'idle' &&
                same(boundary.requests(input, permit, minimumRevision), requests),
              'reader-unstarted-stop-unconfirmed',
            );
            observations.push(
              save({
                kind: 'reader-unstarted-stop',
                permit,
                initialization: requests[0],
                first: first.raw,
                second: second.raw,
                historyError: String(error),
                basis:
                  'Frozen request journal contains only the confirmed fresh thread/start; no model turn was attempted.',
              }),
            );
            continue;
          }
          for (const turn of before.turns) {
            requireContract(
              turn.status === 'inProgress' || terminal.includes(String(turn.status)),
              'reader-stop-history-unconfirmed',
            );
            if (turn.status !== 'inProgress') continue;
            const turnId = text(turn.id);
            observations.push(save({ kind: 'reader-stop-intent', permit, threadId: id, turnId }));
            const interruption = await rpc.request('turn/interrupt', { threadId: id, turnId });
            observations.push(
              save({
                kind: 'reader-stop-interrupt-response',
                permit,
                threadId: id,
                turnId,
                interruption,
              }),
            );
            await rpc.completed(id, turnId, AbortSignal.timeout(30_000));
          }
          const after = await observe();
          const expected = new Set<string>();
          for (const request of requests.filter(
            (request) => request.method === 'turn/start' && request.params.threadId === id,
          )) {
            if (request.response !== null)
              expected.add(text(object(object(request.response).turn).id));
            else {
              const message = sentMessage(request.params.input);
              const found = recoverSentTurn({ thread: after.thread }, id, message);
              if (found === null) unknown = true;
              else expected.add(found);
            }
          }
          requireContract(
            after.turns.every((turn) => terminal.includes(String(turn.status))) &&
              [...expected].every(
                (turnId) =>
                  after.turns.filter(
                    (turn) => turn.id === turnId && terminal.includes(String(turn.status)),
                  ).length === 1,
              ),
            'reader-stop-unconfirmed',
          );
        }
        if (
          requests.some(
            (request) =>
              request.method === 'turn/start' && !sessions.has(String(request.params.threadId)),
          )
        )
          unknown = true;
        const receipt = save({
          kind: 'reader-stop',
          target: readerTarget(input, readerKey(input)),
          permit,
          minimumRevision,
          requests,
          observations,
          confirmed: !unknown,
        });
        requireContract(!unknown, `reader-stop-unknown:${receipt.sha256}`);
        boundary.confirmStop(input, permit, minimumRevision, receipt);
        return { status: 'stopped', receipt };
      } catch (failure) {
        const receipt = save({
          kind: 'reader-stop-failure',
          permit,
          requests,
          observations,
          error: String(failure),
        });
        throw new Error(`reader-stop-unknown:${receipt.sha256}`, { cause: failure });
      }
    },
  };
}
