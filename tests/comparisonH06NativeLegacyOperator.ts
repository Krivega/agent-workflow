import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { bindChatEvidence, withChatWriter } from '../adapters/storage/chatWriter.js';
import { unwrap, SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import type { ChatAnchor } from '../core/currentChat.js';
import {
  evidenceSchema,
  type EffectRecord,
  type EvidenceGrant,
  type TechnicalState,
} from '../core/evidence.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h01RawFile, parseH01DisabledMcpServers } from './comparisonH01Contract.js';
import {
  beginH06NativeAttempt,
  h06NativeSessionsRoot,
  planH06NativeAttempt,
} from './comparisonH06NativeAttempt.js';
import { checkH06NativeLegacyCrossing, runH06NativeLegacy } from './comparisonH06NativeLegacy.js';
import { captureH06NativeLegacyParentStart } from './comparisonH06NativeLegacyParentUsage.js';

type LegacyClaim = Awaited<ReturnType<typeof beginH06NativeAttempt>>;
type Permission = EvidenceGrant['permissions'][number];
const legacyPermissions = new Set<unknown>(['read', 'manage', 'produce', 'resolve']);

interface LegacyStorePreparation {
  claim: LegacyClaim;
  storeRoot: string;
  grant: EvidenceGrant;
  generation: number;
  oldDeadline: number;
}

export function legacyDisabledMcpServers(bootstrap: Record<string, unknown>) {
  return Object.hasOwn(bootstrap, 'disabledMcpServers')
    ? parseH01DisabledMcpServers(bootstrap.disabledMcpServers)
    : undefined;
}

function legacyBootstrap(request: LegacyClaim['request']) {
  requireContract(request.binding.variant === 'legacy', 'h06-legacy-operator-variant');
  const bootstrap = object(JSON.parse(readH04Pin(request.bootstrap).toString('utf8')));
  const fields = ['kind', 'projectId', 'runId', 'actorId', 'generation', 'permissions'];
  if (legacyDisabledMcpServers(bootstrap) !== undefined) fields.push('disabledMcpServers');
  exactFields(bootstrap, fields);
  const { generation, permissions } = bootstrap;
  requireContract(
    bootstrap.kind === 'comparison-h06-native-legacy-bootstrap/2' &&
      typeof generation === 'number' &&
      Number.isSafeInteger(generation) &&
      generation > 0,
    'h06-legacy-operator-bootstrap',
  );
  requireContract(
    Array.isArray(permissions) &&
      permissions.every((permission): permission is Permission =>
        legacyPermissions.has(permission),
      ) &&
      new Set(permissions).size === permissions.length &&
      permissions.includes('read') &&
      permissions.includes('manage'),
    'h06-legacy-operator-permissions',
  );
  const grant: EvidenceGrant = {
    context: {
      schema_version: evidenceSchema,
      project_id: identifier(bootstrap.projectId),
      task_id: request.binding.operationId,
      subtask_id: null,
      run_id: identifier(bootstrap.runId),
      actor_id: identifier(bootstrap.actorId),
    },
    permissions,
  };
  return { grant, generation };
}

/** Validate the Legacy bootstrap without acquiring the Store or consuming a grant. */
export function planH06NativeLegacyOperator(value: unknown) {
  const proposal = planH06NativeAttempt(value);
  legacyBootstrap(proposal.request);
  return proposal;
}

/** Prepare the isolated Store for an existing native actor, leaving renew to H06. */
export async function runH06NativeLegacyWithActor<T>(
  value: unknown,
  authority: unknown,
  actorValue: { transcript: string; anchor: ChatAnchor },
  stage: Parameters<typeof runH06NativeLegacyOperator<T>>[3],
) {
  const { request } = planH06NativeAttempt(value);
  const { grant, generation } = legacyBootstrap(request);
  const { transcript, anchor } = structuredClone(actorValue);
  const sessionsRoot = h06NativeSessionsRoot();
  requireContract(
    generation === 1 &&
      transcript.startsWith(join(sessionsRoot, '/')) &&
      anchor.thread_id === grant.context.actor_id &&
      anchor.workspace === request.binding.workspaceRoot,
    'h06-legacy-operator-actor-binding',
  );
  h01RawFile(transcript);
  const host = new FileCurrentChatHost(request.binding.workspaceRoot, transcript, anchor);
  const observed = await host.observe();
  requireContract(
    observed.sandbox_policy === 'danger-full-access' &&
      observed.approval_policy === 'never' &&
      observed.permission_profile === 'disabled',
    'h06-legacy-operator-actor-profile',
  );
  let parentUsage: H04Pin | undefined;
  const result = await runH06NativeLegacyOperator(
    request,
    authority,
    async (preparation) => {
      const { claim, storeRoot, oldDeadline } = preparation;
      requireContract(
        claim.grant.sessionsRoot === sessionsRoot &&
          same(await host.observe(), observed) &&
          Date.now() + request.binding.timeoutMs < oldDeadline,
        'h06-legacy-operator-actor-changed',
      );
      return withChatWriter(storeRoot, async () => {
        parentUsage = captureH06NativeLegacyParentStart(claim.receipt, transcript, observed);
        const { context } = grant;
        initializeStore(storeRoot, context);
        const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
        const command = {
          type: 'mutate' as const,
          mutation: {
            operation_id: 'chat:initial-owner',
            expected_revision: 0,
            owner_generation: 0,
            payload_hash: '',
          },
          change: { type: 'claim' as const, lease_until: oldDeadline },
        };
        command.mutation.payload_hash = requestHash({ context, command });
        unwrap(store.execute({ context, command }));
        return store;
      });
    },
    stage,
  );
  requireContract(parentUsage !== undefined, 'h06-legacy-operator-parent-usage');
  return { ...result, parentUsage };
}

/** Bind an already-owned Store to the approved attempt before running F-01 or renewing its lease. */
export async function runH06NativeLegacyOperator<T>(
  value: unknown,
  authority: unknown,
  prepareStore: (preparation: LegacyStorePreparation) => Promise<SqliteEvidenceStore>,
  stage: (
    verify: () => void,
    initialFailure: H04Pin,
    preparation: LegacyStorePreparation,
  ) => Promise<T>,
) {
  const proposal = planH06NativeAttempt(value);
  const { grant, generation } = legacyBootstrap(proposal.request);
  const claim = await beginH06NativeAttempt(proposal.request, authority);
  const { request } = claim;
  const { binding, evidenceRoot, stimulus } = request;
  requireContract(
    claim.requestHash === proposal.requestHash && stimulus.initialLeaseMs !== null,
    'h06-legacy-operator-request-changed',
  );
  const oldDeadline = claim.startedAt + stimulus.initialLeaseMs;
  const storeRoot = join(evidenceRoot, 'legacy-store');
  const preparation = { claim, storeRoot, grant, generation, oldDeadline };
  const store = await prepareStore(structuredClone(preparation));
  function verifyInputs() {
    for (const pin of [
      claim.receipt,
      binding.node,
      request.appServer,
      request.bootstrap,
      ...request.runtime,
      ...Object.values(claim.assets),
    ])
      readH04Pin(pin);
  }
  function verifyStore() {
    requireContract(
      store.root === storeRoot &&
        safeDirectory(store.root) === storeRoot &&
        same(store.grant, grant),
      'h06-legacy-operator-store-binding',
    );
  }
  verifyInputs();
  verifyStore();
  const context = grant.context;
  const readState = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const state = readState();
  const effects = unwrap<EffectRecord[]>(store.execute({ context, command: { type: 'effects' } }));
  requireContract(
    state.owner === context.actor_id &&
      state.generation === generation &&
      !state.released &&
      !state.frozen &&
      state.lease_until === oldDeadline &&
      effects.length === 0,
    'h06-legacy-operator-store-state',
  );
  const now = Date.now();
  requireContract(
    now + binding.timeoutMs < oldDeadline &&
      now + binding.timeoutMs + stimulus.longStageMs < claim.workDeadlineMs,
    'h06-legacy-operator-deadline',
  );
  const verifyRuntime = bindChatEvidence(storeRoot, evidenceRoot, state);
  const startPath = join(evidenceRoot, 'legacy-operator-start.json');
  const startBytes = Buffer.from(
    canonical({
      kind: 'h06-native-legacy-operator-start',
      claim: claim.receipt,
      bootstrap: request.bootstrap,
      storeRoot,
      context,
      generation: state.generation,
      revision: state.revision,
      oldDeadline: state.lease_until,
    }) + '\n',
  );
  publishFile(startPath, startBytes);
  const start = { path: startPath, sha256: digest(startBytes) };
  const completed = await runH06NativeLegacy(
    binding,
    evidenceRoot,
    store,
    oldDeadline,
    claim.workDeadlineMs,
    async (verifyLease, initialFailure) => {
      const verify = () => {
        verifyStore();
        verifyRuntime();
        verifyLease();
        requireContract(readState().generation === generation, 'h06-legacy-operator-store-state');
      };
      verifyInputs();
      verify();
      readH04Pin(start);
      requireContract(
        Date.now() + stimulus.longStageMs < claim.workDeadlineMs,
        'h06-legacy-operator-deadline',
      );
      const result = await stage(verify, initialFailure, structuredClone(preparation));
      verify();
      verifyInputs();
      readH04Pin(start);
      return result;
    },
  );
  const { renewal, crossing } = completed.writer;
  const continuity = checkH06NativeLegacyCrossing(binding, renewal, crossing, stimulus.longStageMs);
  return { ...completed, claim: claim.receipt, start, continuity, qualification: false } as const;
}
