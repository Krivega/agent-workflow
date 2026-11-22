import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { h01RawFile } from './comparisonH01Contract.js';
import type { H06NativeTransportOptions } from './comparisonH06NativeTransport.js';

type TransportTurn = Parameters<H06NativeTransportOptions['admitTurn']>[0];
type Turn = Omit<TransportTurn, 'role'> & { role: TransportTurn['role'] | 'legacy-writer' };
type AcceptedTurn = Turn & { turnId: string; response: unknown };
type LedgerRole<Legacy> = Legacy extends true ? 'legacy-writer' : TransportTurn['role'];

const writerOperationId =
  /^task-(?:profile|load|implement)-[a-f0-9]{64}-a(?:0|[1-9]\d*)(?:-r(?:0|[1-9]\d*))?$/u;
const legacyDeliveryId = /^coder:[a-zA-Z0-9_-]+:(?:profile|load|implementation)$/u;
const sha256 = /^[a-f0-9]{64}$/u;

interface Scope<Role extends Turn['role'] = Turn['role']> {
  role: Role;
  root: string;
  session: string;
  journal: string;
  operation: string | null;
  paramsHash: string;
  messageHash: string;
}

function scopePath(value: unknown): string {
  requireContract(
    typeof value === 'string' && isAbsolute(value) && resolve(value) === value,
    'h06-turn-ledger-scope-path',
  );
  return value;
}

function turnKey(scope: Scope): string {
  return digest(
    canonical(
      scope.role === 'reader'
        ? ['reader', scope.session, scope.paramsHash]
        : [scope.role, scope.operation],
    ),
  );
}

function turnScope(turn: Turn): Scope {
  const { role, params } = turn;
  requireContract(
    role === 'reader' || role === 'writer' || role === 'legacy-writer',
    'h06-turn-ledger-scope-role',
  );
  const session = identifier(turn.session);
  const root = scopePath(turn.root);
  const journal = scopePath(turn.journal);
  requireContract(
    params.threadId === session && Array.isArray(params.input) && params.input.length === 1,
    'h06-turn-ledger-params',
  );
  const item = object(params.input[0]);
  requireContract(item.type === 'text' && typeof item.text === 'string', 'h06-turn-ledger-message');
  let operation = null;
  if (role === 'writer') {
    const header = /^Workflow operation: ([^\n]+)\n/u.exec(item.text);
    requireContract(
      header !== null && writerOperationId.test(header[1]!),
      'h06-turn-ledger-writer-operation',
    );
    operation = header[1]!;
  }
  if (role === 'legacy-writer') {
    const header = /^Workflow delivery id: "([^"\n]+)"\n/u.exec(item.text);
    requireContract(
      header !== null && legacyDeliveryId.test(header[1]!),
      'h06-turn-ledger-legacy-delivery',
    );
    operation = header[1]!;
  }
  return {
    role,
    root,
    session,
    journal,
    operation,
    paramsHash: digest(canonical(params)),
    messageHash: digest(item.text),
  };
}

function readScope(value: unknown): Scope {
  const scope = object(value);
  exactFields(scope, [
    'role',
    'root',
    'session',
    'journal',
    'operation',
    'paramsHash',
    'messageHash',
  ]);
  requireContract(
    (scope.role === 'reader' && scope.operation === null) ||
      (scope.role === 'writer' &&
        typeof scope.operation === 'string' &&
        writerOperationId.test(scope.operation)) ||
      (scope.role === 'legacy-writer' &&
        typeof scope.operation === 'string' &&
        legacyDeliveryId.test(scope.operation)),
    'h06-turn-ledger-scope-role',
  );
  requireContract(
    typeof scope.paramsHash === 'string' &&
      sha256.test(scope.paramsHash) &&
      typeof scope.messageHash === 'string' &&
      sha256.test(scope.messageHash),
    'h06-turn-ledger-scope-digest',
  );
  return {
    role: scope.role,
    root: scopePath(scope.root),
    session: identifier(scope.session),
    journal: scopePath(scope.journal),
    operation: scope.operation,
    paramsHash: scope.paramsHash,
    messageHash: scope.messageHash,
  };
}

function acceptedId(response: unknown) {
  return identifier(object(object(response).turn).id);
}

function readRecord(path: string) {
  const bytes = h01RawFile(path);
  const value = object(JSON.parse(bytes.toString()));
  requireContract(
    bytes.equals(Buffer.from(canonical(value) + '\n')),
    'h06-turn-ledger-record-bytes',
  );
  return { value, pin: { path, sha256: digest(bytes) } satisfies H04Pin };
}

interface OpenOptions<Legacy extends true | undefined> {
  mode: 'create' | 'reopen';
  operationId: string;
  maxManagedStarts: number;
  legacy?: Legacy;
}

/** One persistent reservation per accepted native turn. Pending work cannot be retried. */
export function openH06NativeTurnLedger<Legacy extends true | undefined = undefined>(
  directory: string,
  options: OpenOptions<Legacy>,
) {
  const operationId = identifier(options.operationId);
  const maxManagedStarts = options.maxManagedStarts;
  requireContract(
    Number.isSafeInteger(maxManagedStarts) && maxManagedStarts > 0,
    'h06-turn-ledger-cap',
  );
  const legacy = options.legacy === true;
  const binding = {
    kind: legacy ? 'h06-native-legacy-turn-ledger' : 'h06-native-turn-ledger',
    operationId,
    maxManagedStarts,
  };
  const bindingBytes = Buffer.from(canonical(binding) + '\n');
  if (options.mode === 'create') createPrivateDirectory(directory);
  const root = safeDirectory(directory);
  const identity = lstatSync(root, { bigint: true });
  const bindingPath = join(root, 'ledger.json');
  if (options.mode === 'create') publishFile(bindingPath, bindingBytes);

  function assertBinding() {
    const current = lstatSync(safeDirectory(root), { bigint: true });
    requireContract(
      current.dev === identity.dev && current.ino === identity.ino,
      'h06-turn-ledger-root-changed',
    );
    requireContract(h01RawFile(bindingPath).equals(bindingBytes), 'h06-turn-ledger-binding');
  }

  function inspect() {
    assertBinding();
    const files = new Set(
      readdirSync(root).filter((name) => !/^\.pending-[a-f0-9-]{36}$/u.test(name)),
    );
    files.delete('ledger.json');
    const keys = new Set<string>();
    const turns = new Set<string>();
    const admissions = [];
    let unknown = false;
    for (let index = 1; files.delete(`${index}-admission.json`); index++) {
      requireContract(!unknown && index <= maxManagedStarts, 'h06-turn-ledger-order');
      const { value: admission, pin } = readRecord(join(root, `${index}-admission.json`));
      exactFields(admission, ['kind', 'operationId', 'index', 'key', 'scope']);
      const scope = readScope(admission.scope);
      requireContract((scope.role === 'legacy-writer') === legacy, 'h06-turn-ledger-variant');
      const key = turnKey(scope);
      requireContract(
        admission.kind === 'h06-native-turn-admission' &&
          admission.operationId === operationId &&
          admission.index === index &&
          admission.key === key &&
          !keys.has(key),
        'h06-turn-ledger-admission',
      );
      keys.add(key);
      const responseFile = `${index}-response.json`;
      let response: { pin: H04Pin; turnId: string; responseHash: string } | null = null;
      if (files.delete(responseFile)) {
        const { value, pin: responsePin } = readRecord(join(root, responseFile));
        exactFields(value, ['kind', 'admission', 'turnId', 'responseHash', 'response']);
        const turnId = acceptedId(value.response);
        const responseHash = digest(canonical(value.response));
        const turn = canonical([scope.session, turnId]);
        requireContract(
          value.kind === 'h06-native-turn-response' &&
            canonical(value.admission) === canonical(pin) &&
            value.turnId === turnId &&
            value.responseHash === responseHash &&
            !turns.has(turn),
          'h06-turn-ledger-response',
        );
        turns.add(turn);
        response = { pin: responsePin, turnId, responseHash };
      }
      admissions.push({ index, key, scope: scope as Scope<LedgerRole<Legacy>>, pin, response });
      unknown = response === null;
    }
    requireContract(files.size === 0, 'h06-turn-ledger-unexpected-records');
    assertBinding();
    return {
      binding: { path: bindingPath, sha256: digest(bindingBytes) } satisfies H04Pin,
      status: unknown ? 'UNKNOWN' : 'RECORDED',
      used: admissions.length,
      admissions,
    } as const;
  }

  // A reopened process may inspect a pending admission but cannot confirm it or resend it.
  let pending: { index: number; scope: Scope; pin: H04Pin } | null = null;
  assertBinding();
  return {
    inspect,
    async admitTurn(turn: Turn, expectedUsed?: number) {
      const scope = turnScope(turn);
      requireContract((scope.role === 'legacy-writer') === legacy, 'h06-turn-ledger-variant');
      const key = turnKey(scope);
      const retained = inspect();
      requireContract(retained.status === 'RECORDED', 'h06-turn-ledger-outcome-unknown');
      requireContract(
        expectedUsed === undefined || retained.used === expectedUsed,
        'h06-turn-ledger-admission-changed',
      );
      requireContract(
        !retained.admissions.some((entry) => entry.key === key),
        'h06-turn-ledger-duplicate',
      );
      const index = retained.used + 1;
      requireContract(index <= maxManagedStarts, 'h06-turn-ledger-cap');
      const value = { kind: 'h06-native-turn-admission', operationId, index, key, scope };
      const path = join(root, `${index}-admission.json`);
      const bytes = Buffer.from(canonical(value) + '\n');
      // Concurrent callers compete for one slot. An EEXIST loser never reaches dispatch.
      publishFile(path, bytes);
      assertBinding();
      pending = { index, scope, pin: { path, sha256: digest(bytes) } };
    },
    async recordTurn(turn: AcceptedTurn) {
      const reservation = pending;
      requireContract(
        reservation !== null && canonical(turnScope(turn)) === canonical(reservation.scope),
        'h06-turn-ledger-response-unbound',
      );
      const turnId = acceptedId(turn.response);
      requireContract(turn.turnId === turnId, 'h06-turn-ledger-response-turn');
      const retained = inspect();
      requireContract(
        retained.status === 'UNKNOWN' &&
          retained.admissions.at(-1)?.pin.sha256 === reservation.pin.sha256 &&
          !retained.admissions.some(
            (entry) =>
              entry.scope.session === reservation.scope.session &&
              entry.response?.turnId === turnId,
          ),
        'h06-turn-ledger-response-unbound',
      );
      const value = {
        kind: 'h06-native-turn-response',
        admission: reservation.pin,
        turnId,
        responseHash: digest(canonical(turn.response)),
        response: turn.response,
      };
      publishFile(
        join(root, `${reservation.index}-response.json`),
        Buffer.from(canonical(value) + '\n'),
      );
      assertBinding();
      pending = null;
    },
  } satisfies Pick<H06NativeTransportOptions, 'admitTurn' | 'recordTurn'> & {
    inspect: typeof inspect;
  };
}
