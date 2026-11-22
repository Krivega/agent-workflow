import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { readerExecution, supportedReaderClient } from '../src/policy/readerExecution.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';

export interface H06NativeCapabilitiesScope {
  operationId: string;
  binary: H04Pin;
  role: 'reader' | 'writer';
  root: string;
  journal: string;
  session: string;
  profile: { model: string; effort: string; clientVersion: string };
  disabledServers: readonly string[];
}

const kind = 'h06-native-capabilities';

export function h06NativeSessionSandbox(
  raw: Record<string, unknown>,
  role: 'reader' | 'writer',
  root: string,
) {
  const sandbox = object(raw.sandbox);
  if (role === 'reader') return sandbox.type === 'readOnly' && sandbox.networkAccess === false;
  const thread = object(raw.thread);
  const roots = sandbox.writableRoots;
  // New clients report the workspace separately from additional writable roots.
  return (
    sandbox.type === 'workspaceWrite' &&
    sandbox.networkAccess === false &&
    sandbox.excludeSlashTmp === true &&
    sandbox.excludeTmpdirEnvVar === true &&
    (same(roots, [root]) || same(roots, [])) &&
    (raw.runtimeWorkspaceRoots === undefined
      ? same(roots, [root])
      : same(raw.runtimeWorkspaceRoots, [root])) &&
    (thread.environments === undefined
      ? same(roots, [root])
      : Array.isArray(thread.environments) &&
        thread.environments.length === 1 &&
        thread.environments.every((value) => {
          const environment = object(value);
          return (
            environment.environmentId === 'local' &&
            environment.cwd === root &&
            same(environment.runtimeWorkspaceRoots, [root])
          );
        }))
  );
}

function scope(expected: H06NativeCapabilitiesScope, sessionValue: H04Pin, path: string) {
  const { operationId, role, root, journal, session } = expected;
  const binary = { ...h04Pin(expected.binary) };
  const profile = readerExecution(expected.profile).profile;
  const disabledServers = [...expected.disabledServers].sort();
  const sessionReceipt = { ...h04Pin(sessionValue) };
  identifier(operationId);
  identifier(session);
  requireContract(
    (role === 'reader' || role === 'writer') &&
      [root, journal].every(
        (candidate) => isAbsolute(candidate) && resolve(candidate) === candidate,
      ) &&
      new RegExp(`^${role}-[0-9]+\\.jsonl$`, 'u').test(basename(journal)) &&
      supportedReaderClient(profile.clientVersion) &&
      disabledServers.every((name) => /^[A-Za-z0-9_-]+$/u.test(name)) &&
      new Set(disabledServers).size === disabledServers.length,
    'h06-capabilities-scope',
  );
  const prefix = basename(journal, '.jsonl') + '-session-';
  const leaf = basename(sessionReceipt.path);
  requireContract(
    dirname(sessionReceipt.path) === dirname(journal) &&
      leaf.startsWith(prefix) &&
      /^[0-9]+\.json$/u.test(leaf.slice(prefix.length)) &&
      path === sessionReceipt.path.replace(/\.json$/u, '-capabilities.json'),
    'h06-capabilities-path',
  );
  return {
    operationId,
    role,
    root,
    journal,
    session,
    binary,
    profile,
    disabledServers,
    sessionReceipt,
  };
}

function verifySession(binding: ReturnType<typeof scope>) {
  const bytes = readH04Pin(binding.sessionReceipt);
  const retained = object(JSON.parse(bytes.toString()));
  const raw = object(retained.response);
  const thread = object(raw.thread);
  const { operationId, role, root, journal, session, profile } = binding;
  requireContract(
    retained.kind === 'h06-native-transport-session' &&
      retained.operationId === operationId &&
      retained.role === role &&
      retained.root === root &&
      retained.journal === journal &&
      retained.session === session &&
      (retained.method === 'thread/start' || retained.method === 'thread/resume') &&
      thread.id === session &&
      thread.cwd === root &&
      raw.cwd === root &&
      raw.approvalPolicy === 'never' &&
      raw.model === profile.model &&
      raw.reasoningEffort === profile.effort &&
      h06NativeSessionSandbox(raw, role, root),
    'h06-capabilities-session',
  );
}

function verifyInventory(
  binding: ReturnType<typeof scope>,
  models: unknown,
  capabilities: unknown,
) {
  const catalog = object(models);
  requireContract(
    Array.isArray(catalog.data) && catalog.nextCursor == null,
    'h06-capabilities-model-inventory',
  );
  const matches = catalog.data.map(object).filter((row) => row.model === binding.profile.model);
  requireContract(
    matches.length === 1 &&
      Array.isArray(matches[0]!.supportedReasoningEfforts) &&
      matches[0]!.supportedReasoningEfforts
        .map(object)
        .some((row) => row.reasoningEffort === binding.profile.effort),
    'h06-capabilities-model-unavailable',
  );
  return assertCoderCapabilities(capabilities, binding.disabledServers);
}

/** Capture scoped read-only RPC responses before the retained session can admit a turn. */
export async function captureH06NativeCapabilities(
  rpc: Pick<AppServerRpc, 'request'>,
  expected: H06NativeCapabilitiesScope,
  sessionReceipt: H04Pin,
  path: string,
): Promise<H04Pin> {
  const binding = scope(expected, sessionReceipt, path);
  verifySession(binding);
  const models = structuredClone(await rpc.request('model/list', {}));
  const capabilities = structuredClone(
    await rpc.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
  );
  verifyInventory(binding, models, capabilities);
  verifySession(binding);
  readH04Pin(binding.binary);
  const bytes = Buffer.from(JSON.stringify({ kind, binding, models, capabilities }));
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

/** Verify what the recorded RPC responses show, without reopening the runtime or its workspace. */
export function checkH06NativeCapabilities(
  expected: H06NativeCapabilitiesScope,
  sessionReceipt: H04Pin,
  evidenceValue: H04Pin,
) {
  const evidence = h04Pin(evidenceValue);
  const binding = scope(expected, sessionReceipt, evidence.path);
  const receipt = object(JSON.parse(readH04Pin(evidence).toString()));
  exactFields(receipt, ['kind', 'binding', 'models', 'capabilities']);
  requireContract(
    receipt.kind === kind && same(receipt.binding, binding),
    'h06-capabilities-binding',
  );
  verifySession(binding);
  readH04Pin(binding.binary);
  const observedServers = verifyInventory(binding, receipt.models, receipt.capabilities);
  const { profile, role, root, journal, session, disabledServers } = binding;
  return {
    profile,
    role,
    root,
    journal,
    session,
    disabledServers,
    observedServers,
    qualification: false as const,
  };
}
