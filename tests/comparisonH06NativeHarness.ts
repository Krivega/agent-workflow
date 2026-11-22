import { dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { confirmNativeRead } from '../adapters/codex/nativeRead.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { coderProtectedPath, validateCoderRun, type CoderRun } from '../core/coder.js';
import { localPathAllowed } from '../core/localPlanning.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { confirmObservedLoad } from '../src/adapters/codex/observedLoad.js';
import { readerContextCompacted } from '../src/adapters/codex/readerContext.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../src/contracts/project.js';
import {
  parseLocalTask,
  taskDelta,
  taskPathAllowed,
  taskPrivatePath,
} from '../src/policy/localTask.js';
import { controlRef } from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

const list = (value: unknown) => {
  requireContract(Array.isArray(value), 'h06-harness-list');
  return value.map(object);
};

function effectiveContext(
  value: unknown,
  root: string,
  profile: { model: unknown; effort: unknown },
) {
  const row = object(value);
  const sandbox = object(row.sandbox_policy);
  const permission = object(row.permission_profile);
  const filesystem = object(permission.file_system);
  const writes = list(filesystem.entries).filter(({ access }) => access !== 'read');
  requireContract(
    row.cwd === root &&
      row.model === profile.model &&
      row.effort === profile.effort &&
      row.approval_policy === 'never' &&
      sandbox.type === 'workspace-write' &&
      sandbox.network_access === false &&
      sandbox.exclude_slash_tmp === true &&
      sandbox.exclude_tmpdir_env_var === true &&
      permission.type === 'managed' &&
      permission.network === 'restricted' &&
      filesystem.type === 'restricted' &&
      writes.length > 0 &&
      writes.every(
        (entry) => entry.access === 'write' && same(entry.path, { type: 'path', path: root }),
      ),
    'h06-harness-effective-profile',
  );
  return identifier(row.turn_id);
}

function creation(
  value: unknown,
  session: string,
  root: string,
  profile: { model: unknown; effort: unknown },
) {
  const raw = object(value);
  const thread = object(raw.thread);
  const sandbox = object(raw.sandbox);
  requireContract(
    thread.id === session &&
      thread.projectId === null &&
      thread.parentThreadId === null &&
      thread.forkedFromId === null &&
      same(thread.turns, []) &&
      raw.cwd === root &&
      raw.model === profile.model &&
      raw.reasoningEffort === profile.effort &&
      raw.approvalPolicy === 'never' &&
      sandbox.type === 'workspaceWrite' &&
      sandbox.networkAccess === false &&
      sandbox.excludeSlashTmp === true &&
      sandbox.excludeTmpdirEnvVar === true &&
      same(sandbox.writableRoots, [root]),
    'h06-harness-creation',
  );
}

function temporal(request: Record<string, unknown>) {
  exactFields(request, ['variant', 'started', 'snapshot', 'result', 'checks']);
  const started = readH06NativeTemporalStart(h04Pin(request.started));
  const store = artifactStore(started.artifactRoot, { existingOnly: true });
  const read = (value: unknown) => object(JSON.parse(store.read(controlRef(value)).toString()));
  const snapshotRef = controlRef(request.snapshot);
  const snapshot = read(snapshotRef);
  const input = parseLocalTask(snapshot.input);
  requireContract(
    snapshot.kind === 'substantial-task' &&
      snapshot.schemaVersion === 3 &&
      input.schemaVersion === 11 &&
      same(taskControlTarget(input), taskControlTarget(started.input)) &&
      object(snapshot.source).root === started.start.workspaceRoot &&
      same(snapshot.profile, started.start.profile),
    'h06-harness-temporal-snapshot',
  );
  const profile = object(snapshot.profile);
  const copy = text(object(snapshot.copy).root);
  requireContract(
    copy ===
      join(
        started.artifactRoot,
        'copies',
        digest(started.workflowId) + '-a' + input.continuation.attempt,
      ),
    'h06-harness-temporal-copy',
  );
  const result = read(request.result);
  const session = identifier(result.session);
  const answer = read(result.answer);
  const created = read(answer.created);
  requireContract(
    answer.kind === 'task-writer-answer' &&
      same(answer.input, input) &&
      created.kind === 'task-writer-session' &&
      same(created.input, input) &&
      object(created.identity).session === session,
    'h06-harness-temporal-writer',
  );
  creation(created.raw, session, copy, { model: profile.model, effort: profile.effort });
  function tree(value: unknown) {
    const body = object(value);
    const mode = (value: unknown) => {
      requireContract(
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o777,
        'h06-harness-tree-mode',
      );
      return value;
    };
    const files = list(body.files).map((file) => {
      const version = object(file.version);
      const content = controlRef(version.content);
      store.read(content);
      return { path: relativePath(file.path), version: { content, mode: mode(version.mode) } };
    });
    const directories = list(body.directories).map((dir) => ({
      path: relativePath(dir.path),
      mode: mode(dir.mode),
    }));
    const paths = [...files, ...directories].map(({ path }) => path);
    requireContract(new Set(paths).size === paths.length, 'h06-harness-tree-paths');
    return { files, directories };
  }
  const before = tree(snapshot.tree);
  const after = tree(read(result.tree));
  const stop = read(result.stop);
  const thread = object(object(stop.primary).thread);
  const turns = list(thread.turns);
  const load = object(answer.load);
  const loadTurn = object(load.turn);
  const primary = object(answer.primary);
  const implementation = object(primary.turn);
  requireContract(
    stop.kind === 'task-writers-stopped' &&
      stop.schemaVersion === 2 &&
      stop.confirmed === true &&
      stop.session === session &&
      same(stop.input, input) &&
      same(stop.source, snapshot.source) &&
      same(stop.copy, snapshot.copy) &&
      same(stop.before, after) &&
      same(stop.after, after) &&
      thread.id === session &&
      thread.cwd === copy &&
      turns.length === 3 &&
      turns.every((turn) => turn.status === 'completed') &&
      new Set(turns.map(({ id }) => identifier(id))).size === 3 &&
      same(turns[1], loadTurn) &&
      same(turns[2], implementation) &&
      object(load.thread).id === session &&
      object(primary.thread).id === session &&
      !readerContextCompacted({ thread }, session, identifier(loadTurn.id)),
    'h06-harness-temporal-stop-turns',
  );
  requireContract(
    Array.isArray(answer.effectiveProfiles) && answer.effectiveProfiles.length === turns.length,
    'h06-harness-temporal-profile-inventory',
  );
  for (const [index, ref] of answer.effectiveProfiles.entries()) {
    const effective = read(ref);
    const contexts = list(effective.contexts);
    const turnId = turns[index]!.id;
    requireContract(
      effective.kind === 'task-effective-profile' &&
        effective.session === session &&
        effective.turnId === turnId &&
        contexts.length > 0 &&
        contexts.every(
          (row) =>
            effectiveContext(row, copy, { model: profile.model, effort: profile.effort }) ===
            turnId,
        ),
      'h06-harness-temporal-effective-profile',
    );
  }
  const ready = read(answer.ready);
  controlRef(ready.grant);
  requireContract(
    ready.kind === 'task-writer-ready' &&
      same(ready.input, input) &&
      ready.session === session &&
      ready.loadTurnId === loadTurn.id &&
      same(read(ready.load), load),
    'h06-harness-temporal-ready',
  );
  requireContract(before.files.length > 0, 'h06-harness-temporal-load-input');
  confirmObservedLoad(
    loadTurn,
    before.files.map(({ path, version }) => ({
      path: join(copy, path),
      sha256: version.content.sha256,
    })),
  );
  const plan = object(snapshot.plan);
  requireContract(
    Array.isArray(plan.paths) &&
      Array.isArray(plan.basis) &&
      Array.isArray(plan.checks) &&
      plan.paths.length > 0 &&
      plan.checks.length > 0,
    'h06-harness-temporal-plan',
  );
  const scope = plan.paths.map(relativePath);
  const checks = plan.checks.map(identifier);
  const preparation = input.admission.preparation;
  const fixed = [
    input.admission.plan.path,
    input.executor.path,
    preparation.card,
    ...preparation.project.rules,
    ...preparation.project.roles.map(({ profile: path }) => path),
    object(plan.requirement).locator,
    ...plan.basis.map((ref) => object(ref).locator),
  ];
  const changed = taskDelta(before, after).map(({ path }) => path);
  requireContract(
    changed.length > 0 &&
      same(before.directories, after.directories) &&
      changed.every(
        (path) =>
          path.startsWith('evidence/') &&
          taskPathAllowed(scope, path) &&
          !fixed.includes(path) &&
          !taskPrivatePath(path),
      ),
    'h06-harness-temporal-diff',
  );
  const manifest = read(request.checks);
  const outcomes = list(manifest.outcomes);
  requireContract(
    manifest.kind === 'task-checks' &&
      manifest.stage === 'candidate' &&
      manifest.status === 'PASS' &&
      same(manifest.input, input) &&
      same(manifest.snapshot, snapshotRef) &&
      same(manifest.tree, after) &&
      new Set(checks).size === checks.length &&
      same(
        outcomes.map(({ name }) => name),
        checks,
      ),
    'h06-harness-temporal-check-inventory',
  );
  const commands = object(snapshot.commands);
  requireContract(
    checks.includes('validate') && same(object(commands.validate).args, ['checks.mjs']),
    'h06-harness-temporal-validation-command',
  );
  for (const outcome of outcomes) {
    const proof = read(outcome.proof);
    const check = identifier(outcome.name);
    const command = object(commands[check]);
    const process = object(proof.stop);
    requireContract(
      outcome.status === 'PASS' &&
        proof.kind === 'task-check' &&
        proof.name === check &&
        proof.stage === 'candidate' &&
        proof.status === 'PASS' &&
        same(proof.input, input) &&
        same(proof.command, command) &&
        proof.code === 0 &&
        proof.signal === null &&
        proof.error === null &&
        same(proof.before, after) &&
        same(proof.after, after) &&
        process.confirmed === true &&
        list(process.processes).length > 0,
      'h06-harness-temporal-check-proof',
    );
  }
  return {
    session,
    loadTurn: identifier(loadTurn.id),
    implementationTurn: identifier(implementation.id),
    checks,
    changed,
  };
}

function legacy(request: Record<string, unknown>) {
  exactFields(request, ['variant', 'coder', 'integrated']);
  const run = object(
    JSON.parse(readH04Pin(h04Pin(request.coder)).toString()),
  ) as unknown as CoderRun;
  validateCoderRun(run);
  const { brief, copy, session, writer, result, integration, stopped, receipt } = run;
  requireContract(
    run.status === 'integrated' &&
      copy !== null &&
      session !== null &&
      writer?.loaded != null &&
      result?.outcome === 'PASS' &&
      integration !== null &&
      stopped !== null &&
      receipt !== null,
    'h06-harness-legacy-run',
  );
  const inputPin = (value: unknown) => {
    const ref = object(value);
    return h04Pin({ path: ref.locator, sha256: ref.hash });
  };
  function read(value: unknown) {
    const pin = inputPin(value);
    return object(decodeChatArtifact(dirname(pin.path), readH04Pin(pin).toString()));
  }
  requireContract(
    same(read(run.baseline.evidence), {
      kind: 'coder-baseline',
      brief,
      source: run.baseline.source,
      files: run.baseline.files,
    }) &&
      same(read(copy.evidence), {
        kind: 'coder-copy',
        baseline: run.baseline.evidence,
        binding: copy.binding,
        directories: copy.directories,
      }),
    'h06-harness-legacy-workspace',
  );
  const load = read(writer.loaded.native);
  const origin = read(writer.loaded.origin);
  const loadTurn = identifier(load.turn);
  const implementationTurn = identifier(run.turn);
  const nativeCreation = read(session.receipt);
  creation(nativeCreation.result, session.id, brief.copy_root, brief.profile);
  const required = [...writer.loaded.procedures, ...writer.loaded.rules].map(
    ({ locator, hash }) => ({ locator, hash }),
  );
  requireContract(
    new Set(run.baseline.files.map(({ path }) => path)).size === run.baseline.files.length &&
      [...brief.files, ...required].every(({ locator, hash }) =>
        run.baseline.files.some(
          ({ path, version }) => path === locator && version.content.hash === hash,
        ),
      ),
    'h06-harness-legacy-baseline',
  );
  for (const { version } of run.baseline.files) readH04Pin(inputPin(version.content));
  requireContract(
    load.session === session.id &&
      same(load.refs, required) &&
      required.length > 0 &&
      same(load.creation, session.receipt) &&
      writer.loaded.observed_read === writer.loaded.native?.locator &&
      same(origin.creation, session.receipt) &&
      same(origin.load, writer.loaded.native) &&
      object(load.observation).id === loadTurn,
    'h06-harness-legacy-load-binding',
  );
  confirmNativeRead(object(load.observation), required);
  const completed = read(result.evidence);
  const turn = object(completed.turn);
  requireContract(
    completed.session === session.id &&
      turn.id === implementationTurn &&
      turn.status === 'completed' &&
      same(completed.errors, []) &&
      same(result.errors, []),
    'h06-harness-legacy-result',
  );
  let profileTranscript: string | undefined;
  let transcript: string[] | undefined;
  function profile(ref: unknown, expected: string) {
    const proof = read(ref);
    const contexts = list(proof.contexts);
    const start = contexts.findIndex(
      (row) => object(object(row.record).payload).turn_id === expected,
    );
    requireContract(
      proof.kind === 'coder-profile' &&
        proof.session === session!.id &&
        same(proof.creation, session!.receipt) &&
        same(proof.policy, session!.policy) &&
        proof.operation === brief.id &&
        proof.expected_turn === expected &&
        start >= 0,
      'h06-harness-legacy-profile-binding',
    );
    const turns = contexts.slice(start).map((entry) => {
      const record = object(entry.record);
      const source = object(entry.ref);
      const locator = text(source.locator);
      const line = /^(.*)#L([1-9]\d*)$/u.exec(locator);
      requireContract(line !== null, 'h06-harness-legacy-context-source');
      const path = line[1]!;
      requireContract(
        profileTranscript === undefined || profileTranscript === path,
        'h06-harness-legacy-context-source',
      );
      profileTranscript = path;
      if (transcript === undefined) {
        const raw = h01RawFile(path).toString();
        requireContract(raw.endsWith('\n'), 'h06-harness-legacy-context-source');
        transcript = raw.slice(0, -1).split('\n');
        const metadata = transcript
          .map((row) => object(JSON.parse(row)))
          .filter(({ type }) => type === 'session_meta');
        const identity = object(metadata[0]?.payload);
        requireContract(
          metadata.length === 1 &&
            identity.id === session!.id &&
            identity.session_id === session!.id &&
            identity.cwd === brief.copy_root &&
            identity.thread_source !== 'subagent',
          'h06-harness-legacy-context-session',
        );
      }
      const observed = transcript[Number(line[2]) - 1];
      requireContract(
        observed !== undefined &&
          digest(observed + '\n') === source.hash &&
          same(JSON.parse(observed), record) &&
          record.type === 'turn_context',
        'h06-harness-legacy-context-source',
      );
      return effectiveContext(record.payload, brief.copy_root, brief.profile);
    });
    return turns;
  }
  const probe = read(origin.profile);
  const probeTurn = identifier(probe.expected_turn);
  profile(origin.profile, probeTurn);
  requireContract(
    probeTurn !== loadTurn &&
      loadTurn !== implementationTurn &&
      profile(completed.profile, loadTurn).includes(implementationTurn),
    'h06-harness-legacy-profile-turns',
  );
  const checks = brief.checks;
  requireContract(
    checks.length > 0 &&
      new Set(checks).size === checks.length &&
      same(result.checks.map(({ command }) => command).sort(), [...checks].sort()),
    'h06-harness-legacy-check-inventory',
  );
  const items = list(turn.items);
  for (const check of result.checks) {
    const proof = read(check.evidence);
    requireContract(
      proof.type === 'commandExecution' &&
        proof.command === check.command &&
        proof.status === 'completed' &&
        proof.exitCode === 0 &&
        check.exit_code === 0 &&
        items.filter((item) => same(item, proof)).length === 1,
      'h06-harness-legacy-check-proof',
    );
  }
  const stop = read(stopped);
  const owned = object(stop.owned);
  requireContract(
    stop.kind === 'writers-stopped' &&
      stop.thread === session.id &&
      stop.active_turn === false &&
      stop.remaining_terminals === 0 &&
      stop.remaining_processes === 0 &&
      typeof stop.before_hash === 'string' &&
      stop.before_hash === stop.after_hash &&
      owned.tree === brief.copy_root &&
      owned.thread === session.id &&
      owned.turn === implementationTurn &&
      owned.complete === true &&
      same(owned.markers, [copy.evidence.locator, session.receipt.locator]),
    'h06-harness-legacy-stop',
  );
  const { evidence, ...intent } = integration;
  const integratedPin = h04Pin(request.integrated);
  const integrated = object(
    decodeChatArtifact(dirname(integratedPin.path), readH04Pin(integratedPin).toString()),
  );
  requireContract(
    same(inputPin(receipt), integratedPin) &&
      same(read(evidence), { kind: 'coder-integration-intent', ...intent }) &&
      integrated.kind === 'coder-integrated' &&
      integrated.operation === intent.operation &&
      same(integrated.intent, evidence) &&
      same(integrated.changes, intent.changes),
    'h06-harness-legacy-integration',
  );
  const changed = intent.changes.map(({ path, before, after }) => {
    requireContract(
      path.startsWith('evidence/') &&
        localPathAllowed(brief.paths, path) &&
        !coderProtectedPath(brief, path) &&
        !taskPrivatePath(path),
      'h06-harness-legacy-diff',
    );
    for (const version of [before, after])
      if (version !== null) readH04Pin(inputPin(version.content));
    return path;
  });
  requireContract(changed.length > 0, 'h06-harness-legacy-diff');
  return { session: session.id, loadTurn, implementationTurn, checks, changed };
}

/** Independently check a retained completed Writer evidence set, without execution or qualification. */
export function checkH06NativeHarness(value: unknown) {
  const request = object(value);
  const variant = request.variant;
  requireContract(variant === 'legacy' || variant === 'temporal', 'h06-harness-variant');
  const result = variant === 'temporal' ? temporal(request) : legacy(request);
  return { status: 'HARNESS_EVIDENCE_VERIFIED', variant, ...result, qualification: false } as const;
}
