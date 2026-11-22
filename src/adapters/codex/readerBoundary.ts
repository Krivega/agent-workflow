import { mkdirSync, renameSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { ReaderInput } from '../../contracts/reader.js';
import type {
  ReaderCommand,
  ReaderCommandAck,
  ReaderEpoch,
  ReaderTarget,
  ReaderExecution,
} from '../../contracts/readerControl.js';
import { parseReaderExecution } from '../../policy/readerExecution.js';
import { exactFields, object, requireContract } from '../../contracts/project.js';
import { controlRef, readerKey, readerTarget, scopedReader } from '../../policy/readerControl.js';
import { parsePreparation } from '../../policy/preparation.js';
import {
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  readProjectFile,
  syncDirectory,
} from '../artifacts/files.js';
import type { artifactStore } from '../artifacts/files.js';

interface Permission {
  schemaVersion: 2;
  target: ReaderTarget;
  inputHash: string;
  cardHash: string;
  permit: ArtifactRef;
  revision: number;
  permission: 'active' | 'frozen' | 'released';
  workspace: { root: string; dev: string; ino: string };
  last: ReaderCommandAck | null;
  stop: ArtifactRef | null;
  dispatches: Record<string, string>;
}
export interface ReaderDispatch {
  operationId: string;
  revision: number;
  method: 'thread/start' | 'thread/resume' | 'turn/start';
  params: Record<string, unknown>;
  response: unknown | null;
}
export interface ReaderBoundary {
  assert(input: ReaderInput, epoch: ReaderEpoch): void;
  execution(input: ReaderInput, permit: ArtifactRef): ReaderExecution;
  dispatch(
    input: ReaderInput,
    epoch: ReaderEpoch,
    operationId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start',
    params: Record<string, unknown>,
    effect: () => Promise<unknown>,
  ): Promise<unknown>;
  response(
    input: ReaderInput,
    epoch: ReaderEpoch,
    operationId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start',
  ): unknown | null;
}

export function readerBoundary(
  directory: string,
  artifacts: ReturnType<typeof artifactStore>,
  workspaceRoot: string,
  configuration: ReaderExecution,
  beforeDispatch: () => void = () => {},
  consume: (key: string, hash: string) => void = () => {},
) {
  const root = privateDirectory(directory);
  const execution = parseReaderExecution(configuration);
  const json = (path: string): unknown =>
    JSON.parse(readPrivateFile(path).toString('utf8')) as unknown;
  function optional(path: string): unknown | null {
    try {
      return json(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const inputHash = (input: ReaderInput) =>
    digest(
      JSON.stringify(
        scopedReader(input)
          ? [parsePreparation(input.preparation), input.roleId, input.reviewId, input.review]
          : [parsePreparation(input.preparation), input.roleId],
      ),
    );
  function folder(input: ReaderInput) {
    return join(root, digest(JSON.stringify(readerTarget(input, readerKey(input)))));
  }
  function locked<T>(input: ReaderInput, run: (path: string) => T): T {
    const path = folder(input),
      lock = join(path, 'lock');
    mkdirSync(lock, { mode: 0o700 });
    try {
      return run(path);
    } finally {
      rmdirSync(lock);
    }
  }
  function state(input: ReaderInput, permit: ArtifactRef): Permission {
    const raw = object(json(join(folder(input), 'permission.json')));
    exactFields(raw, [
      'schemaVersion',
      'target',
      'inputHash',
      'cardHash',
      'permit',
      'revision',
      'permission',
      'workspace',
      'last',
      'stop',
      'dispatches',
    ]);
    requireContract(
      raw.schemaVersion === 2 &&
        raw.inputHash === inputHash(input) &&
        same(raw.target, readerTarget(input, readerKey(input))) &&
        same(raw.permit, permit) &&
        Number.isSafeInteger(raw.revision) &&
        Number(raw.revision) >= 0 &&
        ['active', 'frozen', 'released'].includes(String(raw.permission)),
      'reader-permit-unconfirmed',
    );
    const dispatches = object(raw.dispatches);
    requireContract(
      Object.entries(dispatches).every(
        ([name, hash]) =>
          /^request-[a-f0-9]{64}$/u.test(name) &&
          typeof hash === 'string' &&
          /^[a-f0-9]{64}$/u.test(hash),
      ),
      'reader-dispatch-index-invalid',
    );
    const workspace = object(raw.workspace);
    requireContract(
      typeof raw.cardHash === 'string' && /^[a-f0-9]{64}$/u.test(raw.cardHash),
      'reader-card-unconfirmed',
    );
    requireContract(
      workspace.root === workspaceRoot &&
        typeof workspace.dev === 'string' &&
        typeof workspace.ino === 'string',
      'reader-workspace-unconfirmed',
    );
    if (raw.stop !== null) controlRef(raw.stop);
    if (raw.last !== null) {
      const last = object(raw.last);
      requireContract(
        typeof last.commandId === 'string' &&
          typeof last.hash === 'string' &&
          Number.isSafeInteger(last.revision) &&
          last.revision === raw.revision,
        'reader-command-receipt-invalid',
      );
      controlRef(last.authorization);
    }
    const current = raw as unknown as Permission;
    readExecution(current);
    return current;
  }
  function readExecution(current: Permission): ReaderExecution {
    const proof = object(JSON.parse(artifacts.read(current.permit).toString('utf8')));
    exactFields(proof, ['schemaVersion', 'kind', 'target', 'workspace', 'id', 'execution']);
    requireContract(
      proof.schemaVersion === 2 &&
        proof.kind === 'reader-permit' &&
        same(proof.target, current.target) &&
        same(proof.workspace, current.workspace) &&
        typeof proof.id === 'string',
      'reader-permit-binding-invalid',
    );
    return parseReaderExecution(proof.execution);
  }
  function save(path: string, value: Permission) {
    const temporary = join(path, `permission-${randomUUID()}`);
    publishFile(temporary, Buffer.from(JSON.stringify(value)));
    renameSync(temporary, join(path, 'permission.json'));
    syncDirectory(path);
  }
  function active(input: ReaderInput, epoch: ReaderEpoch) {
    const current = state(input, epoch.permit);
    requireContract(same(readExecution(current), execution), 'reader-execution-changed');
    requireContract(
      current.revision === epoch.revision && current.permission === 'active',
      'reader-permit-revoked',
    );
    const actual = statSync(workspaceRoot, { bigint: true });
    requireContract(
      actual.dev.toString() === current.workspace.dev &&
        actual.ino.toString() === current.workspace.ino,
      'reader-workspace-replaced',
    );
    requireContract(
      digest(readProjectFile(workspaceRoot, input.preparation.card)) === current.cardHash,
      'reader-card-changed',
    );
    dispatchRecords(input, current);
    return current;
  }
  function dispatchRecords(input: ReaderInput, current: Permission) {
    const path = folder(input);
    const names = readdirSync(path).filter((name) => /^request-[a-f0-9]{64}$/u.test(name));
    requireContract(
      same(names.sort(), Object.keys(current.dispatches).sort()),
      'reader-dispatch-journal-incomplete',
    );
    return names.map((name) => {
      const bytes = readPrivateFile(join(path, name));
      requireContract(digest(bytes) === current.dispatches[name], 'reader-dispatch-corrupted');
      return { path: join(path, name), request: object(JSON.parse(bytes.toString('utf8'))) };
    });
  }
  function requestPath(input: ReaderInput, operation: string, method: string) {
    return join(folder(input), `request-${digest(JSON.stringify([method, operation]))}`);
  }
  function recorded(
    input: ReaderInput,
    current: Permission,
    maximumRevision: number,
  ): ReaderDispatch[] {
    return dispatchRecords(input, current).map(({ path, request }) => {
      requireContract(
        Number.isSafeInteger(request.revision) &&
          Number(request.revision) <= maximumRevision &&
          (request.method === 'thread/start' ||
            request.method === 'thread/resume' ||
            request.method === 'turn/start') &&
          typeof request.operationId === 'string',
        'reader-dispatch-unconfirmed',
      );
      const outcome = optional(path + '.response');
      return {
        operationId: request.operationId,
        revision: Number(request.revision),
        method: request.method,
        params: object(request.params),
        response: outcome === null ? null : jsonArtifact(outcome),
      };
    });
  }
  const boundary: ReaderBoundary = {
    execution(input, permit) {
      return readExecution(state(input, permit));
    },
    assert(input, epoch) {
      active(input, epoch);
    },
    async dispatch(input, epoch, operationId, method, params, effect) {
      const target = requestPath(input, operationId, method);
      const request = { operationId, revision: epoch.revision, method, params };
      const pending = locked(input, () => {
        const current = active(input, epoch);
        beforeDispatch();
        const previous = optional(target);
        if (previous !== null) {
          requireContract(same(previous, request), 'reader-dispatch-conflict');
          const outcome = optional(target + '.response');
          requireContract(outcome !== null, 'reader-dispatch-unknown');
          return Promise.resolve(jsonArtifact(outcome));
        }
        if (method === 'turn/start')
          consume(
            digest(JSON.stringify([readerTarget(input, readerKey(input)), operationId])),
            digest(JSON.stringify(params)),
          );
        save(folder(input), {
          ...current,
          dispatches: {
            ...current.dispatches,
            [`request-${digest(JSON.stringify([method, operationId]))}`]: digest(
              JSON.stringify(request),
            ),
          },
        });
        publishFile(target, Buffer.from(JSON.stringify(request)));
        return effect();
      });
      const response = await pending;
      const ref = artifacts.publish(Buffer.from(JSON.stringify(response)));
      try {
        publishFile(target + '.response', Buffer.from(JSON.stringify(ref)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireContract(same(json(target + '.response'), ref), 'reader-dispatch-outcome-conflict');
      }
      return response;
    },
    response(input, epoch, operationId, method) {
      dispatchRecords(input, state(input, epoch.permit));
      const ref = optional(requestPath(input, operationId, method) + '.response');
      return ref === null ? null : jsonArtifact(ref);
    },
  };
  function jsonArtifact(ref: unknown): unknown {
    return JSON.parse(artifacts.read(ref as ArtifactRef).toString('utf8')) as unknown;
  }
  return {
    boundary,
    execution: boundary.execution,
    inspect(input: ReaderInput, completedCard?: (original: string, current: string) => boolean) {
      const raw = object(json(join(folder(input), 'permission.json'))),
        permit = controlRef(raw.permit);
      const current = state(input, permit);
      requireContract(same(readExecution(current), execution), 'reader-execution-changed');
      activeWorkspace(current);
      const cardHash = digest(readProjectFile(workspaceRoot, input.preparation.card));
      requireContract(
        cardHash === current.cardHash || completedCard?.(current.cardHash, cardHash) === true,
        'reader-card-changed',
      );
      return {
        cardHash,
        permit,
        permission: current.permission,
        revision: current.revision,
        requests: recorded(input, current, current.revision),
      };
    },
    install(input: ReaderInput): ArtifactRef {
      const path = privateDirectory(folder(input));
      return locked(input, () => {
        const previous = optional(join(path, 'permission.json')) as Permission | null;
        if (previous !== null) {
          const current = active(input, { permit: previous.permit, revision: 0, attempt: 0 });
          return current.permit;
        }
        requireContract(
          readdirSync(path).every((name) => name === 'lock'),
          'reader-permission-journal-lost',
        );
        const actual = statSync(workspaceRoot, { bigint: true });
        const target = readerTarget(input, readerKey(input));
        const workspace = {
          root: workspaceRoot,
          dev: actual.dev.toString(),
          ino: actual.ino.toString(),
        };
        const permit = artifacts.publish(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 2,
              kind: 'reader-permit',
              target,
              workspace,
              id: randomUUID(),
              execution,
            }),
          ),
        );
        const cardHash = digest(readProjectFile(workspaceRoot, input.preparation.card));
        save(path, {
          schemaVersion: 2,
          target,
          inputHash: inputHash(input),
          cardHash,
          workspace,
          permit,
          revision: 0,
          permission: 'active',
          last: null,
          stop: null,
          dispatches: {},
        });
        return permit;
      });
    },
    commandAck(
      input: ReaderInput,
      permit: ArtifactRef,
      command: ReaderCommand,
    ): ReaderCommandAck | null {
      const previous = state(input, permit).last;
      if (previous === null || previous.commandId !== command.commandId) return null;
      requireContract(previous.hash === command.hash, 'reader-command-id-conflict');
      return previous;
    },
    freeze(input: ReaderInput, permit: ArtifactRef): number {
      return locked(input, (path) => {
        const current = state(input, permit);
        if (current.permission === 'released') return current.revision;
        requireContract(current.revision < Number.MAX_SAFE_INTEGER, 'reader-command-stale');
        const revision = current.revision + 1;
        save(path, {
          ...current,
          revision,
          permission: 'released',
          last: null,
          stop: current.permission === 'active' ? null : current.stop,
        });
        return revision;
      });
    },
    advance(
      input: ReaderInput,
      permit: ArtifactRef,
      command: ReaderCommand,
      authorization: ArtifactRef,
    ): ReaderCommandAck {
      return locked(input, (path) => {
        const current = state(input, permit);
        if (current.last?.commandId === command.commandId) {
          requireContract(current.last.hash === command.hash, 'reader-command-id-conflict');
          return current.last;
        }
        requireContract(
          current.revision === command.expectedRevision &&
            current.revision < Number.MAX_SAFE_INTEGER,
          'reader-command-stale',
        );
        requireContract(current.permission !== 'released', 'reader-control-terminal');
        if (command.action === 'resume') {
          requireContract(same(readExecution(current), execution), 'reader-execution-changed');
          requireContract(
            current.permission === 'frozen' && current.stop !== null,
            'reader-resume-not-stopped',
          );
          activeWorkspace(current);
          requireContract(
            digest(readProjectFile(workspaceRoot, input.preparation.card)) === current.cardHash,
            'reader-card-changed',
          );
        }
        const ack: ReaderCommandAck = {
          commandId: command.commandId,
          hash: command.hash,
          revision: current.revision + 1,
          authorization,
        };
        save(path, {
          ...current,
          revision: ack.revision,
          permission:
            command.action === 'resume'
              ? 'active'
              : command.action === 'cancel'
                ? 'released'
                : 'frozen',
          last: ack,
          stop:
            current.permission === 'active' || command.action === 'resume' ? null : current.stop,
        });
        return ack;
      });
    },
    requests(input: ReaderInput, permit: ArtifactRef, minimumRevision: number): ReaderDispatch[] {
      const current = state(input, permit);
      requireContract(
        current.revision >= minimumRevision && current.permission !== 'active',
        'reader-stop-not-fenced',
      );
      return recorded(input, current, current.revision - 1);
    },
    confirmStop(
      input: ReaderInput,
      permit: ArtifactRef,
      minimumRevision: number,
      receipt: ArtifactRef,
    ): void {
      locked(input, (path) => {
        const current = state(input, permit);
        requireContract(
          current.revision >= minimumRevision && current.permission !== 'active',
          'reader-stop-not-fenced',
        );
        artifacts.read(receipt);
        save(path, { ...current, stop: receipt });
      });
    },
  };
  function activeWorkspace(current: Permission) {
    const actual = statSync(workspaceRoot, { bigint: true });
    requireContract(
      actual.dev.toString() === current.workspace.dev &&
        actual.ino.toString() === current.workspace.ino,
      'reader-workspace-replaced',
    );
  }
}
