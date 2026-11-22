import { join, sep } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import type { beginChatExecution, readyCurrentChat } from '../application/currentChatWorkflow.js';
import { executeChatRequest } from '../cli/chatRuntime.js';
import { taskChatGates } from '../cli/taskChatInputs.js';
import { localLocator } from '../core/connection.js';
import type { ChatAnchor } from '../core/currentChat.js';
import { evidenceSchema, type EvidenceGrant, type TechnicalState } from '../core/evidence.js';
import { startLocalRun, type RunSpec } from '../core/localRun.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { checkH06NativeFailure } from './comparisonH06NativeFailure.js';

interface LegacyPreparation {
  claim: H04Pin;
  initialFailure: H04Pin;
  input: H04Pin;
  transcript: string;
  anchor: ChatAnchor;
}

function preparationGates(value: unknown, spec: RunSpec) {
  requireContract(Array.isArray(value), 'h06-legacy-preparation-gates');
  const supplied = value.map(object);
  const human = supplied.filter(({ kind }) => kind === 'human').map(({ id }) => text(id));
  const expected = taskChatGates(spec.criteria, human);
  requireContract(same(supplied, expected), 'h06-legacy-preparation-gates');
  return expected;
}

/** Enter the existing Legacy chat workflow after F-01, without opening or sending a native Writer. */
export async function prepareH06NativeLegacy(value: LegacyPreparation, verify: () => void) {
  const { claim, initialFailure, input, transcript, anchor } = structuredClone(value);
  verify();
  const { request, grant: authority, workDeadlineMs } = readH06NativeAttemptForReopen(claim);
  const { binding, evidenceRoot } = request;
  requireContract(
    binding.variant === 'legacy' &&
      request.runtime.some((pin) => same(pin, input)) &&
      initialFailure.path === join(evidenceRoot, 'f01', 'receipt.json'),
    'h06-legacy-preparation-attempt',
  );
  checkH06NativeFailure(binding, initialFailure);

  const bootstrap = object(JSON.parse(readH04Pin(request.bootstrap).toString('utf8')));
  const configuration = object(JSON.parse(readH04Pin(h04Pin(input)).toString('utf8')));
  const fields = ['kind', 'descriptor', 'planningFile', 'marker', 'spec'];
  if (configuration.gates !== undefined) fields.push('gates');
  exactFields(configuration, fields);
  const spec = object(configuration.spec) as unknown as RunSpec;
  const descriptor = localLocator(configuration.descriptor);
  const planningFile = localLocator(configuration.planningFile);
  const marker = text(configuration.marker);
  const { generation, permissions } = bootstrap;
  const actorId = identifier(bootstrap.actorId);
  const runId = identifier(bootstrap.runId);
  const projectId = identifier(bootstrap.projectId);
  const permitted = new Set<unknown>(['read', 'manage', 'produce', 'resolve']);
  requireContract(
    configuration.kind === 'comparison-h06-native-legacy-preparation/2' &&
      bootstrap.kind === 'comparison-h06-native-legacy-bootstrap/2' &&
      generation === 1 &&
      Array.isArray(permissions) &&
      permissions.every((permission): permission is EvidenceGrant['permissions'][number] =>
        permitted.has(permission),
      ) &&
      new Set(permissions).size === permissions.length &&
      permissions.includes('read') &&
      permissions.includes('manage') &&
      spec.project_id === projectId &&
      'task_id' in spec.identity &&
      spec.identity.task_id === binding.operationId &&
      spec.run_id === runId &&
      spec.session_id === actorId &&
      spec.host_id === 'local' &&
      spec.workspace === binding.workspaceRoot &&
      spec.parent_run_id === null &&
      (spec.route.kind === 'local' || spec.route.kind === 'substantial') &&
      spec.route.accepted_plan?.locator === planningFile,
    'h06-legacy-preparation-binding',
  );
  const gates =
    configuration.gates === undefined ? null : preparationGates(configuration.gates, spec);
  requireContract(
    transcript.startsWith(authority.sessionsRoot + sep) &&
      anchor.thread_id === actorId &&
      anchor.host_id === spec.host_id &&
      anchor.workspace === spec.workspace &&
      process.env.CODEX_THREAD_ID === actorId,
    'h06-legacy-preparation-actor',
  );
  h01RawFile(transcript);
  const host = new FileCurrentChatHost(binding.workspaceRoot, transcript, anchor);
  const observed = await host.observe();
  requireContract(
    observed.sandbox_policy === 'danger-full-access' &&
      observed.approval_policy === 'never' &&
      observed.permission_profile === 'disabled' &&
      observed.model === spec.requested.model &&
      observed.effort === spec.requested.effort,
    'h06-legacy-preparation-profile',
  );
  const load = await host.load(startLocalRun(spec, generation), marker);
  const storeRoot = safeDirectory(join(evidenceRoot, 'legacy-store'));
  const grant: EvidenceGrant = {
    context: {
      schema_version: evidenceSchema,
      project_id: projectId,
      task_id: binding.operationId,
      subtask_id: null,
      run_id: runId,
      actor_id: actorId,
    },
    permissions,
  };
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  const connections = new FileTaskConnection(binding.workspaceRoot);
  const connection = await connections.preview(
    descriptor,
    spec.identity.card.locator,
    binding.operationId,
  );
  requireContract(
    connection.from_version === 2 &&
      connection.before === connection.after &&
      digest(connection.before) === spec.identity.card.hash,
    'h06-legacy-preparation-card',
  );
  const beforeEffect = async () => {
    requireContract(same(await host.observe(), observed), 'h06-legacy-preparation-actor-changed');
    verify();
    readH04Pin(claim);
    readH04Pin(input);
    readH04Pin(initialFailure);
    requireContract(Date.now() < workDeadlineMs, 'h06-legacy-preparation-deadline');
  };
  await beforeEffect();
  const state = unwrap<TechnicalState>(
    store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
  );
  requireContract(
    state.owner === actorId &&
      state.generation === generation &&
      !state.released &&
      !state.frozen &&
      state.lease_until > Date.now() &&
      state.checkpoint === null,
    'h06-legacy-preparation-store',
  );
  // Keep the intent on failure so a partially persisted LOAD cannot be repeated.
  publishFile(
    join(evidenceRoot, 'legacy-preparation-intent.json'),
    Buffer.from(
      JSON.stringify({ claim, input, initialFailure, anchor, source: observed.source, load }),
    ),
  );
  const connectionJournal = join(evidenceRoot, 'legacy-connection');
  await connections.apply(connection, connectionJournal);
  const chatRequest = {
    root: binding.workspaceRoot,
    evidence_root: evidenceRoot,
    storage: { root: storeRoot, grant },
    generation,
    descriptor,
    connection_journal: connectionJournal,
    planning_file: planningFile,
    marker,
    spec,
    transcript,
    anchor,
  };
  await beforeEffect();
  await executeChatRequest('prepare-chat', chatRequest);
  await beforeEffect();
  const ready = (await executeChatRequest('bootstrap-chat', chatRequest)) as Awaited<
    ReturnType<typeof readyCurrentChat>
  >;
  await beforeEffect();
  requireContract(
    ready.run.status === 'ready' && same(ready.run.loaded, load) && same(ready.observed, observed),
    'h06-legacy-preparation-ready',
  );
  if (gates === null) return { request: chatRequest, ready, execution: null };
  const execution = (await executeChatRequest('execution-chat', {
    ...chatRequest,
    code: true,
    gates,
  })) as Awaited<ReturnType<typeof beginChatExecution>>;
  await beforeEffect();
  requireContract(
    execution.status === 'implementing' &&
      execution.generation === generation &&
      execution.task_id === binding.operationId,
    'h06-legacy-preparation-execution',
  );
  return { request: chatRequest, ready, execution };
}
