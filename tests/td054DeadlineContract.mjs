// td054-reference:imports:begin
import * as referenceAuthority from './td054DeadlineReference.mjs';
// td054-reference:imports:end
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from '../adapters/storage/storeCodec.ts';
import { safeDirectory } from '../adapters/storage/storeFiles.ts';
import { publishFile } from '../src/adapters/artifacts/files.ts';
import { preparationInputs } from '../src/adapters/project/preparation.ts';
import { parseReaderInput } from '../src/policy/readerControl.ts';
import { requireTaskBackend } from '../src/adapters/project/taskBackend.ts';
import { parseSdkProcessTable } from './temporal/task-execution-sdk-processes.mjs';
import { h04Pin, readH04Pin } from './comparisonH04Contract.ts';
import { readH06NativeRequestSchema } from './comparisonH06NativeAttemptPlan.ts';
import {
  observeH06NativePrimaryGrant,
  observeH06NativePrimaryGrantHistory,
} from './comparisonH06NativeAttempt.ts';

const entry = fileURLToPath(import.meta.url),
  packageRoot = resolve(dirname(entry), '..');
const repository = packageRoot;
const require = createRequire(import.meta.url);

export const td054ProposedBounds = Object.freeze({
  maxElapsedMs: 90000,
  workWindowMs: 60000,
  activeLoadByMs: 45000,
  stopReserveMs: 27000,
  quietWindowMs: 3000,
  foregroundWaitMs: 120000,
  maxManagedStarts: 1,
  maxInputUncached: 120000,
  maxOutput: 4000,
});

export function exact(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function bounds(value) {
  exact(value, Object.keys(td054ProposedBounds));
  for (const limit of Object.values(value))
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit < 2 ** 31);
  assert.equal(value.maxManagedStarts, 1, 'only the primary LOAD start is allowed');
  assert.ok(value.activeLoadByMs < value.workWindowMs);
  assert.ok(value.workWindowMs + value.stopReserveMs + value.quietWindowMs <= value.maxElapsedMs);
  assert.ok(value.stopReserveMs >= 20000, 'Reader Host shutdown and primary read need reserve');
  assert.ok(
    value.foregroundWaitMs > value.maxElapsedMs,
    'foreground stimulus must outlast the probe',
  );
  return { ...value };
}
export function pin(path) {
  assert.equal(realpathSync(path), path, 'canonical file required');
  const info = lstatSync(path);
  assert.ok(info.isFile() && info.nlink === 1, 'regular single-link file required');
  return { path, sha256: digest(readFileSync(path)) };
}
export function json(value) {
  return JSON.parse(readH04Pin(h04Pin(value)).toString());
}
export function record(path, value) {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}
function files(root, select = () => true) {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((item) => {
      const path = join(root, item.name);
      if (item.isDirectory()) return files(path, select);
      if (item.isSymbolicLink()) {
        assert.ok(
          !select(path) || path.includes(sep + 'node_modules' + sep + '.bin' + sep),
          'unpinned runtime symlink',
        );
        return [];
      }
      return select(path) ? [pin(path)] : [];
    });
}

/** Pin installed dependency bytes in place; no acquisition or runtime copies. */
function runtimePins() {
  const seen = new Set(),
    packages = [];
  function dependency(name, resolver) {
    let manifest;
    try {
      manifest = resolver.resolve(name + '/package.json');
    } catch {
      let root = dirname(resolver.resolve(name));
      for (;;) {
        const path = join(root, 'package.json');
        if (
          lstatSync(path, { throwIfNoEntry: false })?.isFile() &&
          JSON.parse(readFileSync(path)).name === name
        ) {
          manifest = path;
          break;
        }
        assert.notEqual(root, dirname(root), 'dependency root unavailable');
        root = dirname(root);
      }
    }
    const root = realpathSync(dirname(manifest));
    if (seen.has(root)) return;
    seen.add(root);
    // Dependency directories are resolved and pinned separately below.
    packages.push(...files(root, (path) => relative(root, path).split(sep)[0] !== 'node_modules'));
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'))),
      local = createRequire(join(root, 'package.json'));
    for (const child of Object.keys(metadata.dependencies ?? {}).sort()) dependency(child, local);
    for (const child of Object.keys(metadata.optionalDependencies ?? {}).sort()) {
      try {
        local.resolve(child);
      } catch {
        continue;
      }
      dependency(child, local);
    }
  }
  for (const name of [
    '@temporalio/client',
    '@temporalio/worker',
    '@temporalio/common',
    '@temporalio/workflow',
    'tsx',
  ])
    dependency(name, require);
  const source = ['src', 'adapters', 'core', 'cli', 'dist'].flatMap((name) =>
    files(join(packageRoot, name)),
  );
  source.push(pin(join(packageRoot, 'package.json')));
  source.push(
    ...files(
      join(packageRoot, 'tests'),
      (path) => /\.(?:mjs|ts)$/u.test(path) && !path.includes('.test.'),
    ),
  );
  source.push(
    ...['package.json', 'yarn.lock', 'tsconfig.json', 'tsconfig.base.json'].map((name) =>
      pin(join(repository, name)),
    ),
  );
  return [...new Map([...source, ...packages].map((value) => [value.path, value])).values()].sort(
    (a, b) => a.path.localeCompare(b.path),
  );
}

/** An exact future request; its grant strings are proposals, never user-source records. */
export function prepareTD054DeadlineProbe(
  operationId,
  referenceValue,
  proposed = td054ProposedBounds,
  parent,
) {
  assert.match(operationId, /^td054-[a-z0-9-]{1,64}$/u);
  const proposedBounds = bounds(proposed);
  const reference = h04Pin(referenceValue),
    request = readH06NativeRequestSchema(json(reference));
  assert.equal(request.binding.variant, 'temporal');
  const bootstrap = json(request.bootstrap),
    preparation = bootstrap.input.admission.preparation;
  const input = parseReaderInput({
    preparation: { ...preparation, hostId: operationId, taskId: operationId },
    roleId: preparation.project.roles[0].id,
  });
  const evidenceParent = safeDirectory(parent === undefined ? dirname(reference.path) : parent);
  const evidenceRoot = join(evidenceParent, operationId),
    serverRoot = evidenceRoot + '-server';
  safeDirectory(dirname(evidenceRoot));
  const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  for (const root of [evidenceRoot, serverRoot])
    for (const protectedRoot of [request.binding.workspaceRoot, request.chat.workspace, repository])
      assert.ok(
        !overlaps(root, protectedRoot),
        'evidence/server must not overlap LOAD or working roots',
      );
  assert.notEqual(
    request.binding.workspaceRoot,
    repository,
    'dedicated qualification workspace required',
  );
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: request.binding.workspaceRoot,
    encoding: 'utf8',
    timeout: 2000,
  }).trim();
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: gitRoot,
    encoding: 'utf8',
    timeout: 2000,
  }).trim();
  assert.equal(gitRoot, request.binding.workspaceRoot, 'dedicated qualification Git root required');
  assert.equal(
    realpathSync(common),
    join(gitRoot, '.git'),
    'shared worktree registry is forbidden',
  );
  requireTaskBackend(
    request.binding.workspaceRoot,
    input.preparation.project.projectId,
    input.preparation.taskId,
    'temporal',
    'sdk',
    input.preparation.card,
  );
  const binaryPins = {
    node: request.binding.node,
    appServer: request.appServer,
    server: request.server,
    tsx: pin(fileURLToPath(import.meta.resolve('tsx'))),
  };
  for (const binary of Object.values(binaryPins)) readH04Pin(binary);
  const body = {
    kind: 'td054-native-load-deadline-request/1',
    operationId,
    referenceAttempt: reference,
    referenceScope: 'INPUT_AND_BINARIES_ONLY_NO_AUTHORITY_TRANSFER',
    evidenceParent,
    evidenceRoot,
    serverRoot,
    workspaceRoot: request.binding.workspaceRoot,
    chat: request.chat,
    input,
    workspaceFiles: preparationInputs(request.binding.workspaceRoot, input.preparation),
    profile: bootstrap.profile,
    disabledServers: bootstrap.disabledServers,
    taskQueue: operationId,
    workflows: pin(join(packageRoot, 'dist/workflows/controlledReader.js')),
    binaryPins,
    runtime: runtimePins(),
    server: {
      binary: binaryPins.server,
      address: bootstrap.address,
      httpPort: bootstrap.server.httpPort,
      metricsPort: bootstrap.server.metricsPort,
      sqlitePath: join(serverRoot, 'temporal.sqlite'),
    },
    proposedBounds,
    scope: {
      stage: 'deadline-load',
      primaryLoadOnly: true,
      nativeStarts: 1,
      foregroundWait:
        'one read-only foreground Atomics.wait before loading files; interrupted by host',
      noWriter: true,
      noWarmColdResume: true,
      noRetry: true,
      noRuntimeCopies: true,
    },
    authority: { issued: false, source: null, claim: null },
    acceptance: {
      preparationOnly: true,
      nativeDeadline: 'UNKNOWN',
      r12FormalColdStop: 'UNKNOWN',
      r13NormalCompletion: 'UNCHANGED',
      qualification: false,
      mayRun: false,
    },
  };
  assert.equal(body.profile.clientVersion, '0.154.0');
  assert.ok(Array.isArray(body.disabledServers));
  return { ...body, requestHash: digest(canonical(body)) };
}

export function checkTD054DeadlineProbe(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const expected = prepareTD054DeadlineProbe(
    value.operationId,
    value.referenceAttempt,
    value.proposedBounds,
    value.evidenceParent,
  );
  assert.deepEqual(value, expected, 'packet changed; prepare after the final source freeze');
  return {
    kind: 'td054-deadline-preparation-check/1',
    status: 'PREPARATION_PASS_NATIVE_UNKNOWN',
    requestHash: value.requestHash,
    verifiedSourceFiles: value.runtime.length,
    verifiedBinaries: 4,
    ...value.acceptance,
    remaining: ['new exact native and server primary-source grants'],
  };
}

export function planTD054DeadlineProbe(packet) {
  const checked = checkTD054DeadlineProbe(packet);
  const proposal = {
    ...checked,
    proposedBounds: packet.proposedBounds,
    expectedNativeGrantText: canonical({
      kind: 'td054-native-load-deadline-grant/1',
      operationId: packet.operationId,
      requestHash: packet.requestHash,
      evidenceRoot: packet.evidenceRoot,
      scope: packet.scope,
      budget: packet.proposedBounds,
    }),
    expectedServerGrantText: canonical({
      kind: 'td054-native-load-deadline-server-grant/1',
      operationId: packet.operationId,
      requestHash: packet.requestHash,
      server: packet.server,
      budget: {
        maxElapsedMs: packet.proposedBounds.workWindowMs + packet.proposedBounds.stopReserveMs,
        stopReserveMs: packet.proposedBounds.stopReserveMs,
      },
    }),
  };
  return {
    ...proposal,
    expectedGrantText: canonical({
      kind: 'td054-native-load-deadline-authorization/1',
      native: JSON.parse(proposal.expectedNativeGrantText),
      server: JSON.parse(proposal.expectedServerGrantText),
    }),
  };
}

export function grantPlan(packet) {
  const plan = planTD054DeadlineProbe(packet),
    request = readH06NativeRequestSchema(json(packet.referenceAttempt));
  return { request, expectedGrantText: plan.expectedGrantText };
}
export async function grants(packet, source) {
  // td054-reference:reference-grants:begin
  if (source?.kind === referenceAuthority.td054ReferenceSourceKind) {
    exact(source, ['kind', 'reference']);
    const reference = source.reference;
    exact(reference, ['kind', 'binding', 'packet']);
    assert.equal(reference.kind, referenceAuthority.td054ReferenceKind);
    assert.deepEqual(reference.packet, packet, 'td054-reference-source-packet');
    checkTD054DeadlineProbe(packet);
    return referenceAuthority.admitTD054Reference(reference.binding, packet);
  }
  // td054-reference:reference-grants:end
  const plan = grantPlan(packet);
  const nativeGrant = await observeH06NativePrimaryGrant(plan, source);
  const serverGrant = await observeH06NativePrimaryGrant(plan, source);
  return { nativeGrant, serverGrant };
}
async function historicalGrants(packet, source) {
  const grant = await observeH06NativePrimaryGrantHistory(grantPlan(packet), source);
  return { nativeGrant: grant, serverGrant: grant };
}
function authority(grant) {
  return { transcript: grant.transcript, turnId: grant.anchor.turn_id, source: grant.source };
}

function td054ClaimBody(value) {
  const receipt = h04Pin(value),
    claim = json(receipt);
  // td054-reference:reference-body:begin
  if (claim.kind === referenceAuthority.td054ReferenceClaimKind)
    return referenceAuthority.parseTD054ReferenceClaim(value);
  // td054-reference:reference-body:end
  exact(claim, [
    'kind',
    'packet',
    'startedAt',
    'workDeadlineMs',
    'stopDeadlineMs',
    'finalDeadlineMs',
    'nativeGrant',
    'serverGrant',
  ]);
  assert.equal(claim.kind, 'td054-native-load-deadline-claim/1');
  const { packet, startedAt } = claim,
    budget = packet.proposedBounds;
  assert.equal(receipt.path, join(packet.evidenceRoot, 'attempt-claim.json'));
  assert.ok(Number.isSafeInteger(startedAt) && startedAt <= Date.now());
  assert.equal(claim.workDeadlineMs, startedAt + budget.workWindowMs);
  assert.equal(claim.stopDeadlineMs, claim.workDeadlineMs + budget.stopReserveMs);
  assert.equal(claim.finalDeadlineMs, startedAt + budget.maxElapsedMs);
  return claim;
}

/** Starting a native stage always rechecks the current/latest primary source. */
export async function readTD054Claim(value) {
  const claim = td054ClaimBody(value);
  // td054-reference:reference-current:begin
  if (claim.kind === referenceAuthority.td054ReferenceClaimKind) {
    remainingTD054(claim.workDeadlineMs);
    checkTD054DeadlineProbe(claim.packet);
    const observed = await referenceAuthority.admitTD054Reference(
      claim.referenceApproval.binding,
      claim.packet,
    );
    assert.deepEqual(observed, {
      nativeGrant: claim.nativeGrant,
      serverGrant: claim.serverGrant,
      referenceApproval: claim.referenceApproval,
    });
    remainingTD054(claim.workDeadlineMs);
    return claim;
  }
  // td054-reference:reference-current:end
  remainingTD054(claim.workDeadlineMs);
  const observed = await grants(claim.packet, authority(claim.nativeGrant));
  assert.deepEqual(observed, { nativeGrant: claim.nativeGrant, serverGrant: claim.serverGrant });
  remainingTD054(claim.workDeadlineMs);
  return claim;
}

/** Historical evidence is readable after consumption, never a native-stage admission. */
export async function readTD054SavedClaim(value) {
  const claim = td054ClaimBody(value);
  // td054-reference:reference-saved:begin
  if (claim.kind === referenceAuthority.td054ReferenceClaimKind) {
    checkTD054DeadlineProbe(claim.packet);
    const observed = await referenceAuthority.inspectTD054Reference(
      claim.referenceApproval.binding,
      claim.packet,
      claim.referenceApproval,
    );
    assert.deepEqual(observed, {
      nativeGrant: claim.nativeGrant,
      serverGrant: claim.serverGrant,
      referenceApproval: claim.referenceApproval,
    });
    return claim;
  }
  // td054-reference:reference-saved:end
  const observed = await historicalGrants(claim.packet, authority(claim.nativeGrant));
  assert.deepEqual(observed, { nativeGrant: claim.nativeGrant, serverGrant: claim.serverGrant });
  return claim;
}

export function remainingTD054(deadline) {
  const ms = Math.floor(deadline - Date.now());
  assert.ok(Number.isSafeInteger(deadline) && ms > 0, 'td054-observation-deadline');
  return ms;
}

/** One bounded whole-process observation; no fresh timeout for each tracked PID. */
export function observeTD054Processes(identities, deadline) {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], {
    encoding: 'utf8',
    timeout: Math.min(2000, remainingTD054(deadline)),
    maxBuffer: 4 * 1024 * 1024,
  });
  remainingTD054(deadline);
  const table = parseSdkProcessTable(output, process.pid);
  const alive = identities.filter((identity) => {
    assert.ok(
      Number.isSafeInteger(identity.pid) &&
        identity.pid > 1 &&
        typeof identity.started === 'string',
    );
    const started = identity.started.trim().replace(/\s+/gu, ' ');
    return table.some((row) => row.pid === identity.pid && row.started === started);
  });
  remainingTD054(deadline);
  return alive;
}
// td054-reference:reference-api:begin
export async function prepareTD054Reference(value) {
  const binding = referenceAuthority.readTD054ReferenceBinding(value);
  const approved = json(binding.approvedPacket);
  const packet = prepareTD054DeadlineProbe(
    approved.operationId,
    approved.referenceAttempt,
    approved.proposedBounds,
    approved.evidenceParent,
  );
  const reference = { kind: referenceAuthority.td054ReferenceKind, binding, packet };
  await checkTD054Reference(reference);
  return reference;
}
export async function checkTD054Reference(value) {
  exact(value, ['kind', 'binding', 'packet']);
  assert.equal(value.kind, referenceAuthority.td054ReferenceKind);
  const checked = checkTD054DeadlineProbe(value.packet);
  const observed = await referenceAuthority.inspectTD054Reference(value.binding, value.packet);
  return {
    ...checked,
    kind: 'td054-reference-preparation-check/2',
    status: 'PREPARATION_PASS_REFERENCE_CONSENT',
    approvedRequestHash: observed.referenceApproval.approvedRequestHash,
    executionRequestHash: observed.referenceApproval.executionRequestHash,
    actualReferenceConsent: observed.referenceApproval,
    proposedBounds: value.packet.proposedBounds,
    operationId: value.packet.operationId,
    evidenceRoot: value.packet.evidenceRoot,
    serverRoot: value.packet.serverRoot,
    remaining: ['full validation of authority-only current source before native run'],
  };
}
export function td054ReferenceSource(reference) {
  return { kind: referenceAuthority.td054ReferenceSourceKind, reference };
}
// td054-reference:reference-api:end
