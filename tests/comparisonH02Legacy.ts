import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { nativeCouncilReviewBrief } from '../adapters/codex/councilReviewBrief.js';
import { saveCouncilRequestFile } from '../adapters/codex/councilRequestFile.js';
import type { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { encodeProofArtifact } from '../adapters/storage/sharedArtifacts.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  readPrivateFile,
  safeDirectory,
  writePrivateFile,
} from '../adapters/storage/storeFiles.js';
import { observeChatCouncil } from '../application/chatCouncil.js';
import { refreshCouncilInputs } from '../cli/refreshCouncilInputs.js';
import type { CouncilConfiguration } from '../core/connection.js';
import { requireWorkflow } from '../core/connection.js';
import {
  configuredRoles,
  createCouncil,
  councilAdviserName,
  councilBlockers,
  councilProfileRefs,
  councilReviewBasis,
  councilReviewRequest,
  changedPlanningRoles,
  repeatCouncil,
  selectedRole,
} from '../core/council.js';
import type { CouncilRole, ReviewTarget, Selection } from '../core/council.js';
import type { AgentSession, DataQuery } from '../core/dataRoute.js';
import { applyLocalEvent, startLocalRun } from '../core/localRun.js';
import type { InputRef, LocalRun, RunSpec } from '../core/localRun.js';
import type { AgentSessions, CouncilSessions } from '../ports/agentSessions.js';
import { checkH02Material, h02Material, h02Scenario } from './comparisonH02Contract.js';
import type { H02CaseSummary, H02Counts } from './comparisonH02Contract.js';

export interface H02LegacyRpcTurn {
  role: string;
  session: string;
  turn: string;
  kind: 'load' | 'review';
}
export interface H02LegacyContext {
  workspaceRoot: string;
  evidenceRoot: string;
  spec: RunSpec;
  configuration: CouncilConfiguration;
  inputs: FileWorkflowInputs;
  nativeSessions: AgentSessions & CouncilSessions;
  rpc: AppServerRpc;
  counts(): H02Counts;
  observations(): H02LegacyRpcTurn[];
  stop(): Promise<{ readersStopped: boolean; transportClosed: boolean; evidence: InputRef[] }>;
  signal?: AbortSignal;
}
export interface H02LegacyResult extends H02CaseSummary {
  localRpcTurns: number;
  localRpcObservations: H02LegacyRpcTurn[];
  rounds: { initial: InputRef | null; corrected: InputRef | null };
  probes: Record<string, InputRef>;
  manifest: InputRef;
  stop: { readersStopped: boolean; transportClosed: boolean };
}
const names = ['pricing', 'logging', 'storage'] as const;

/** Fixed H02 experiment using existing Legacy council policy and primary-review ports. */
export async function runH02LegacyCase(context: H02LegacyContext): Promise<H02LegacyResult> {
  const checks = Object.fromEntries(h02Scenario.checks.map((name) => [name, false]));
  const evidence: InputRef[] = [],
    probes: Record<string, InputRef> = {},
    byPhase: Record<string, H02Counts> = {};
  let initial: InputRef | null = null,
    corrected: InputRef | null = null,
    outcome: H02CaseSummary['outcome'] = 'unknown';
  const blocking: string[] = [];
  let stopped = { readersStopped: false, transportClosed: false };
  const save = (value: unknown) => {
    const bytes = encodeProofArtifact(context.evidenceRoot, value),
      ref = {
        locator: join(context.evidenceRoot, 'h02-' + digest(bytes) + '.json'),
        hash: digest(bytes),
      };
    if (!existsSync(ref.locator)) writePrivateFile(ref.locator, bytes);
    requireWorkflow(
      readPrivateFile(ref.locator).toString() === bytes,
      'h02-legacy-evidence-changed',
    );
    evidence.push(ref);
    return ref;
  };
  const signal = () => context.signal?.throwIfAborted();
  const price = join(context.workspaceRoot, 'pricing.json');
  try {
    signal();
    safeDirectory(context.workspaceRoot);
    safeDirectory(context.evidenceRoot);
    requireWorkflow(
      realpathSync(context.workspaceRoot) === context.spec.workspace &&
        context.workspaceRoot !== context.evidenceRoot &&
        !context.workspaceRoot.startsWith(context.evidenceRoot + sep) &&
        !context.evidenceRoot.startsWith(context.workspaceRoot + sep),
      'h02-legacy-roots',
    );
    const roles = configuredRoles(context.configuration);
    requireWorkflow(
      canonical([...roles].sort()) === canonical([...names].sort()),
      'h02-legacy-roles',
    );
    for (const [name, bytes] of Object.entries(h02Material.files))
      requireWorkflow(
        readFileSync(join(context.workspaceRoot, name), 'utf8') === bytes,
        'h02-legacy-material',
      );
    const paths = [
      ...new Set([
        ...Object.keys(h02Material.files),
        context.spec.assignment.locator,
        ...context.spec.rules.map((ref) => ref.locator),
        context.configuration.catalog,
        ...Object.values(context.configuration.profiles),
      ]),
    ];
    const target = async (scope = 'H-02'): Promise<ReviewTarget> => {
      const inputs = await context.inputs.capture(
        { files: paths, directories: [] },
        'H02 fixed common scope',
      );
      signal();
      return {
        scope,
        base: 'H02 original material',
        diff: save({ kind: 'h02-target', scope, inputs }),
        inputs,
      };
    };
    const selection = Object.fromEntries(
      await Promise.all(
        roles.map(async (role) => {
          const files = [
            ...new Set([
              context.spec.assignment.locator,
              ...context.spec.rules.map((ref) => ref.locator),
              context.configuration.catalog,
              context.configuration.profiles[role]!,
              role + '.json',
            ]),
          ];
          const inputs = await context.inputs.capture(
            { files, directories: [] },
            'H02 subject ' + role,
          );
          signal();
          return [
            role,
            {
              trigger: true,
              reason: 'Inspect only ' + role + ' dependency',
              requirements: inputs.inputs,
              inputs,
            },
          ];
        }),
      ),
    ) as Selection;
    signal();
    let council = createCouncil('acceptance', selection, await target(), context.configuration);
    const pricing = roles.find((role) => role === 'pricing')!;
    const runRole = async (role: CouncilRole) => {
      signal();
      await context.inputs.verify(selectedRole(council.selection, role).requirements);
      signal();
      const previous = council.advisers[role];
      const profile = {
        model: context.spec.requested.model,
        effort: context.spec.requested.effort,
        reason: role,
      };
      const session: AgentSession | null =
        previous === undefined
          ? await context.nativeSessions.create(profile)
          : await context.nativeSessions.inspect(previous.run.spec.session_id);
      signal();
      requireWorkflow(session !== null, 'h02-legacy-session-missing');
      await context.rpc.request('thread/name/set', {
        threadId: session.id,
        name: councilAdviserName(role),
      });
      signal();
      const rules = councilProfileRefs(
        role,
        selectedRole(council.selection, role).requirements,
        context.configuration,
      );
      const query: DataQuery = {
        kind: 'unknown-source',
        entrypoints: [context.spec.assignment.locator],
        question: 'H02 role LOAD',
        scope: [role + '.json'],
        sources: selectedRole(council.selection, role).requirements,
        criterion: 'LOAD',
        format: 'native full read',
        procedures: context.spec.procedures,
        rules,
      };
      const native = await context.nativeSessions.load(session, query);
      signal();
      const spec: RunSpec = {
        ...context.spec,
        product: false,
        run_id: context.spec.run_id + '-' + role,
        session_id: session.id,
        parent_run_id: context.spec.run_id,
        role: 'council-adviser',
        fork_turns: 'none',
        writer: session.id,
        scope: [role + '.json'],
        sources: selectedRole(council.selection, role).requirements,
        rules,
        requested: { ...profile, permissions: ['read'] },
        effective: { ...profile, permissions: ['read'] },
        route: { kind: 'nonproduct' },
      };
      let run: LocalRun = startLocalRun(spec, 1);
      run = applyLocalEvent(run, {
        type: 'LOAD',
        event_id: 'load',
        expected_revision: run.revision,
        generation: 1,
        receipt: {
          run_id: spec.run_id,
          session_id: session.id,
          procedures: spec.procedures,
          rules,
          observed_read: 'H02 primary port LOAD',
          native,
          origin: previous?.run.loaded?.origin ?? native,
        },
      });
      run = applyLocalEvent(run, {
        type: 'READY',
        event_id: 'ready',
        expected_revision: run.revision,
        generation: 1,
      });
      const request = councilReviewRequest(council, role, run),
        requestFile = await saveCouncilRequestFile(context.evidenceRoot, request);
      signal();
      evidence.push(requestFile, native);
      const turn = await context.nativeSessions.send(
        session,
        nativeCouncilReviewBrief(
          request,
          requestFile,
          selectedRole(council.selection, role).reason,
        ),
        context.spec.run_id + ':' + role + ':' + council.history.length,
      );
      signal();
      await context.rpc.completed(session.id, turn, context.signal);
      signal();
      council = await observeChatCouncil(
        council,
        role,
        run,
        turn,
        context.spec.session_id,
        context.nativeSessions,
        context.inputs,
      );
      signal();
    };
    const phase = async (name: string, work: () => Promise<void>) => {
      const before = context.counts();
      await work();
      signal();
      const after = context.counts();
      byPhase[name] = {
        threadStarts: after.threadStarts - before.threadStarts,
        turnStarts: after.turnStarts - before.turnStarts,
      };
    };
    await phase('initial', async () => {
      for (const role of roles) await runRole(role);
    });
    const initialTurns = context.observations();
    requireWorkflow(
      initialTurns
        .filter((turn) => turn.kind === 'review')
        .map((turn) => turn.role)
        .sort()
        .join(',') === 'logging,pricing,storage',
      'h02-legacy-initial-turns',
    );
    initial = save({ kind: 'h02-initial-council', council });
    const first = structuredClone(council);
    requireWorkflow(
      first.advisers[pricing]!.answer!.verdict === 'FAIL' &&
        roles
          .filter((role) => role !== pricing)
          .every(
            (role) =>
              first.advisers[role]!.answer!.verdict === 'PASS' &&
              first.advisers[role]!.answer!.coverage === 'complete',
          ),
      'h02-legacy-initial-oracle',
    );
    const beforeProbes = context.counts();
    const noPrice = {
      ...structuredClone(first),
      selection: {
        ...structuredClone(first.selection),
        [pricing]: { ...first.selection[pricing], trigger: false },
      },
    };
    checks['open-fail'] = councilBlockers(noPrice).includes('pricing:unresolved-failure');
    probes['open-fail'] = save({
      kind: 'h02-open-fail',
      blockers: councilBlockers(noPrice),
      history: first.history,
    });
    signal();
    writeFileSync(price, '{"rate":7}\n');
    council = await refreshCouncilInputs(council, await target(), context.inputs);
    signal();
    requireWorkflow(
      roles.filter((role) => council.advisers[role]?.status === 'running').join(',') === 'pricing',
      'h02-legacy-targeted-repeat',
    );
    await phase('correction', async () => runRole(pricing));
    const correctionTurns = context.observations().slice(initialTurns.length);
    requireWorkflow(
      correctionTurns
        .filter((turn) => turn.kind === 'review')
        .map((turn) => turn.role)
        .join(',') === 'pricing',
      'h02-legacy-correction-turns',
    );
    corrected = save({ kind: 'h02-corrected-council', council });
    requireWorkflow(
      councilBlockers(council).length === 0 && (await checkH02Material(context.workspaceRoot)),
      'h02-legacy-correction-oracle',
    );
    signal();
    const base = structuredClone(council);
    const unchanged = await refreshCouncilInputs(base, await target(), context.inputs);
    signal();
    checks['unchanged-pass'] =
      roles
        .filter((role) => role !== pricing)
        .every((role) => canonical(unchanged.advisers[role]) === canonical(first.advisers[role])) &&
      roles.every((role) => unchanged.advisers[role]!.status === 'answered');
    probes['unchanged-pass'] = save({ kind: 'h02-unchanged-pass', council: unchanged });
    writeFileSync(price, '{"rate":8}\n');
    try {
      const changed = await refreshCouncilInputs(base, await target(), context.inputs);
      signal();
      checks['changed-dependency'] =
        roles.filter((role) => changed.advisers[role]?.status === 'running').join(',') ===
        'pricing';
      probes['changed-dependency'] = save({
        kind: 'h02-changed-dependency',
        council: changed,
        basis: councilReviewBasis(changed, pricing),
      });
    } finally {
      writeFileSync(price, '{"rate":7}\n');
    }
    const add = structuredClone(base.selection);
    selectedRole(add, pricing).inputs = await context.inputs.capture(
      {
        files: [
          ...selectedRole(add, pricing).inputs.inputs.map((ref) => ref.locator),
          'logging.json',
        ],
        directories: [],
      },
      'H02 added dependency',
    );
    signal();
    selectedRole(add, pricing).requirements = selectedRole(add, pricing).inputs.inputs;
    const addedRoles = changedPlanningRoles(base, add),
      added = repeatCouncil(base, base.target, addedRoles, add);
    checks['new-dependency'] =
      addedRoles.join(',') === 'pricing' && added.advisers[pricing]!.status === 'running';
    probes['new-dependency'] = save({
      kind: 'h02-new-dependency',
      roles: addedRoles,
      council: added,
    });
    const shared = await refreshCouncilInputs(
      base,
      await target('H-02 shared scope'),
      context.inputs,
    );
    signal();
    checks['shared-scope'] = roles.every((role) => shared.advisers[role]!.status === 'running');
    probes['shared-scope'] = save({ kind: 'h02-shared-scope', council: shared });
    const rationale = structuredClone(base.selection);
    selectedRole(rationale, pricing).reason = 'An explicitly changed pricing obligation';
    const rationaleRoles = changedPlanningRoles(base, rationale),
      explained = repeatCouncil(base, base.target, rationaleRoles, rationale);
    checks['role-rationale'] =
      rationaleRoles.join(',') === 'pricing' &&
      councilReviewBasis(explained, pricing).rationale === 'changed';
    probes['role-rationale'] = save({
      kind: 'h02-role-rationale',
      roles: rationaleRoles,
      basis: councilReviewBasis(explained, pricing),
    });
    let missing = false,
      incomplete = false;
    let missingError: string | null = null,
      incompleteError: string | null = null;
    const removed = { ...base.selection };
    delete removed[pricing];
    try {
      createCouncil(base.phase, removed, base.target, context.configuration);
    } catch (error) {
      missingError = error instanceof Error ? error.message : null;
      missing = error instanceof Error && error.message === 'missing-role-selection';
    }
    const partial = structuredClone(base);
    selectedRole(partial.selection, pricing).inputs.complete = false;
    try {
      await refreshCouncilInputs(partial, base.target, context.inputs);
    } catch (error) {
      incompleteError = error instanceof Error ? error.message : null;
      incomplete = error instanceof Error && error.message === 'pricing:incomplete-inputs';
    }
    signal();
    checks['incomplete-map'] = missing && incomplete;
    probes['incomplete-map'] = save({
      kind: 'h02-incomplete-map',
      missing,
      incomplete,
      missingError,
      incompleteError,
      missingBasis: {
        phase: base.phase,
        selection: removed,
        target: base.target,
        configuration: context.configuration,
      },
      incompleteBasis: { council: partial, target: base.target },
    });
    const after = context.counts();
    byPhase.probes = {
      threadStarts:
        after.threadStarts - beforeProbes.threadStarts - byPhase.correction!.threadStarts,
      turnStarts: after.turnStarts - beforeProbes.turnStarts - byPhase.correction!.turnStarts,
    };
    requireWorkflow(
      byPhase.probes.threadStarts === 0 &&
        byPhase.probes.turnStarts === 0 &&
        (await checkH02Material(context.workspaceRoot)),
      'h02-legacy-probe-effect',
    );
    signal();
    save({
      kind: 'h02-preserved-history',
      initial: first.history,
      current: base.history,
      unchanged: checks['unchanged-pass'],
    });
    outcome = Object.values(checks).every(Boolean) ? 'accepted' : 'failed';
  } catch (error) {
    if (error instanceof Error && /^[a-z][a-z0-9:-]*$/u.test(error.message))
      blocking.push(error.message);
    blocking.push('h02-legacy-case-incomplete');
  } finally {
    try {
      const stop = await context.stop();
      stopped = { readersStopped: stop.readersStopped, transportClosed: stop.transportClosed };
      evidence.push(...stop.evidence);
    } catch {
      blocking.push('h02-legacy-stop-unknown');
    }
  }
  if (context.signal?.aborted) {
    outcome = 'unknown';
    blocking.push('h02-legacy-cancelled');
  }
  if (!stopped.readersStopped || !stopped.transportClosed) {
    outcome = 'unknown';
    blocking.push('h02-legacy-stop-unconfirmed');
  }
  for (const [check, passed] of Object.entries(checks)) if (!passed) blocking.push(check);
  const counts = context.counts();
  const summary = {
    variant: 'legacy' as const,
    engine: 'legacy-council' as const,
    outcome,
    checks,
    blocking,
    effects: { ...counts, byPhase },
    evidence,
    nativeUsage: null,
    nativeAcceptance: false as const,
    qualification: false as const,
    partialScope: true as const,
    localRpcTurns: counts.turnStarts,
    localRpcObservations: context.observations(),
    rounds: { initial, corrected },
    probes,
    stop: stopped,
  };
  const manifest = save({ kind: 'h02-legacy-technical-result', ...summary });
  return { ...summary, manifest };
}
