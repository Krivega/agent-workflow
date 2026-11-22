import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { type artifactStore, digest, publishFile } from '../src/adapters/artifacts/files.js';
import {
  nativeReaderAuthority,
  type NativeReaderIssuer,
  type NativeReaderSource,
} from '../src/adapters/codex/readerAuthority.js';
import type {
  AuthorizedReaderCommand,
  PayloadReaderCommand,
} from '../src/contracts/readerControl.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { localTaskKey, parseLocalTask } from '../src/policy/localTask.js';
import { parsePayloadReaderCommand, readerCommandText } from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06TemporalAutonomousAuthority } from './comparisonH06TemporalAutonomousAuthority.js';

export interface H06TemporalAutonomousMode {
  kind: 'temporal-autonomous/3';
  authority: H04Pin;
}
export type H06TemporalControlPhase = 'warm-pause' | 'warm-resume' | 'cold-pause' | 'cold-resume';
export interface H06TemporalAutonomousPhase {
  kind: 'h06-temporal-autonomous-phase/3';
  mode: H06TemporalAutonomousMode;
  started: H04Pin;
  runId: string;
  phase: H06TemporalControlPhase;
}
export type H06TemporalControlSource = NativeReaderSource | H06TemporalAutonomousPhase;
type Store = ReturnType<typeof artifactStore>;

export function isH06TemporalAutonomousMode(value: unknown): value is H06TemporalAutonomousMode {
  return (
    typeof value === 'object' && value !== null && object(value).kind === 'temporal-autonomous/3'
  );
}
export function readH06TemporalControlMode(value: unknown) {
  const mode = object(value);
  exactFields(mode, ['kind', 'authority']);
  requireContract(mode.kind === 'temporal-autonomous/3', 'h06-temporal-control-mode');
  const authority = h04Pin(mode.authority);
  readH06TemporalAutonomousAuthority(authority);
  return { kind: 'temporal-autonomous/3', authority } as const;
}
function base(command: Omit<PayloadReaderCommand, 'hash' | 'source'>) {
  const { schemaVersion, commandId, target, expectedRevision, author, action, attempt, payload } =
    command;
  return { schemaVersion, commandId, target, expectedRevision, author, action, attempt, payload };
}
function observed(
  store: Store,
  modeValue: H06TemporalAutonomousMode,
  raw: AuthorizedReaderCommand,
) {
  const mode = readH06TemporalControlMode(modeValue),
    parent = readH06TemporalAutonomousAuthority(mode.authority);
  const command = parsePayloadReaderCommand(raw);
  requireContract(
    digest(readerCommandText(command)) === command.hash,
    'h06-temporal-control-command',
  );
  const source = object(JSON.parse(store.read(command.source).toString()));
  exactFields(source, ['kind', 'mode', 'started', 'workflowId', 'runId', 'phase', 'command']);
  const started = h04Pin(source.started),
    start = object(JSON.parse(readH04Pin(started).toString()));
  const bootstrap = object(JSON.parse(readH04Pin(parent.request.bootstrap).toString())),
    initial = parseLocalTask(bootstrap.input);
  requireContract(initial.schemaVersion === 11, 'h06-temporal-control-input');
  const phase = source.phase;
  const phases = [
    ['warm-pause', 'pause', 0, 0],
    ['warm-resume', 'resume', 1, 1],
    ['cold-pause', 'pause', 2, 1],
    ['cold-resume', 'resume', 3, 2],
  ] as const;
  const expected = phases.find(([name]) => name === phase);
  requireContract(expected !== undefined, 'h06-temporal-control-phase');
  requireContract(
    source.kind === 'h06-temporal-autonomous-control/3' &&
      same(source.mode, mode) &&
      started.path === join(parent.request.evidenceRoot, 'temporal-start.json') &&
      start.kind === 'h06-native-temporal-start' &&
      same(start.controlMode, mode) &&
      same(start.input, initial) &&
      start.workflowId === localTaskKey(initial) &&
      source.workflowId === start.workflowId &&
      source.runId === identifier(start.firstExecutionRunId) &&
      same(command.target, taskControlTarget(initial)) &&
      command.author === initial.admission.preparation.owner &&
      command.commandId === 'h06-' + phase &&
      command.action === expected[1] &&
      command.expectedRevision === expected[2] &&
      command.attempt === expected[3] &&
      same(source.command, base(command)),
    'h06-temporal-control-binding',
  );
  const intent = join(parent.request.evidenceRoot, `autonomous-${expected[0]}-intent.json`);
  const bytes = store.read(command.source);
  const pin = { path: intent, sha256: digest(bytes) };
  requireContract(readH04Pin(pin).equals(bytes), 'h06-temporal-control-intent');
  return { parent, command, source, intent: pin };
}

/** Bind one derived phase to the parent grant and exact live command, without a human impersonation. */
export function publishH06TemporalControlSource(
  store: Store,
  source: H06TemporalControlSource,
  command: Omit<PayloadReaderCommand, 'hash' | 'source'>,
) {
  if (source.kind === 'codex-user-command')
    return store.publish(Buffer.from(JSON.stringify(source)));
  requireContract(
    ['warm-pause', 'warm-resume', 'cold-pause', 'cold-resume'].includes(source.phase),
    'h06-temporal-control-phase',
  );
  const mode = readH06TemporalControlMode(source.mode),
    parent = readH06TemporalAutonomousAuthority(mode.authority);
  requireContract(Date.now() < parent.workDeadlineMs, 'h06-temporal-control-deadline');
  const started = h04Pin(source.started),
    start = object(JSON.parse(readH04Pin(started).toString()));
  const body = {
    kind: 'h06-temporal-autonomous-control/3',
    mode,
    started,
    workflowId: start.workflowId,
    runId: identifier(source.runId),
    phase: source.phase,
    command: base(command),
  };
  const bytes = Buffer.from(JSON.stringify(body)),
    path = join(parent.request.evidenceRoot, `autonomous-${source.phase}-intent.json`);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) publishFile(path, bytes);
  else
    requireContract(
      readH04Pin({ path, sha256: digest(bytes) }).equals(bytes),
      'h06-temporal-control-intent',
    );
  return store.publish(bytes);
}

export function h06TemporalControlAuthority(
  store: Store,
  issuer: NativeReaderIssuer,
  mode?: H06TemporalAutonomousMode,
) {
  if (mode === undefined) return nativeReaderAuthority(store, issuer);
  readH06TemporalControlMode(mode);
  function verify(command: AuthorizedReaderCommand) {
    const result = observed(store, mode!, command);
    requireContract(
      issuer.threadId === result.parent.request.chat.threadId &&
        issuer.workspaceRoot === result.parent.request.chat.workspace &&
        issuer.sessionsRoot === result.parent.grant.sessionsRoot &&
        issuer.owner === result.command.author,
      'h06-temporal-control-issuer',
    );
    requireContract(Date.now() < result.parent.workDeadlineMs, 'h06-temporal-control-deadline');
    return result;
  }
  return {
    async issue(command: AuthorizedReaderCommand) {
      verify(command);
      return JSON.stringify({
        kind: 'h06-temporal-derived-command/3',
        hash: command.hash,
        source: command.source,
      });
    },
    async verify(command: AuthorizedReaderCommand) {
      const result = verify(command);
      const proof = store.publish(
        Buffer.from(
          JSON.stringify({
            kind: 'reader-h06-temporal-initial-grant-authorization/3',
            command: result.command,
            source: result.source,
            authority: mode!.authority,
            intent: result.intent,
          }),
        ),
      );
      return { origin: 'initial-grant' as const, author: issuer.owner, hash: command.hash, proof };
    },
  };
}

/** Historical verification checks the pinned parent and phase intent but grants no fresh execution. */
export function verifyH06TemporalControlProof(
  store: Store,
  mode: H06TemporalAutonomousMode | undefined,
  command: PayloadReaderCommand,
  value: unknown,
) {
  const proof = object(value);
  if (mode === undefined) {
    requireContract(
      proof.kind === 'reader-native-human-authorization' &&
        same(proof.command, command) &&
        same(proof.source, JSON.parse(store.read(command.source).toString())),
      'h06-temporal-control-proof',
    );
    return;
  }
  const result = observed(store, mode, command);
  requireContract(
    same(proof, {
      kind: 'reader-h06-temporal-initial-grant-authorization/3',
      command: result.command,
      source: result.source,
      authority: mode.authority,
      intent: result.intent,
    }),
    'h06-temporal-control-proof',
  );
}
