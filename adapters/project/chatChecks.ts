import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import type { InputRef } from '../../core/localRun.js';
import { spawn } from 'node:child_process';
import { open, writeFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { requireWorkflow, textField } from '../../core/connection.js';
import { compareInputs } from '../../core/evidence.js';
import type { InputManifest } from '../../core/evidence.js';
import { sameValue, stableJson } from '../../core/equality.js';
import type { Check } from '../../core/execution.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import type { Discovery } from './workflowInputs.js';
import { contentHash } from './projectFiles.js';
import { privateFileSource, readPrivateFile, safeDirectory } from '../storage/storeFiles.js';
import { encodeProofArtifact, readArtifactFile } from '../storage/sharedArtifacts.js';
import { locationPrefix } from '../storage/fileLocations.js';
import { checkEnvironment } from './checkEnvironment.js';

function relocatedCommand(path: string) {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return null;
  }
  return readPrivateFile(path, locationPrefix.length).toString('utf8') === locationPrefix
    ? privateFileSource(path)
    : null;
}

export interface ChatCheckRequest {
  id: string;
  criterion?: string;
  command: { file: string; args: string[] };
  discovery: Discovery;
  attested_by: string;
  reuse?: InputRef;
  environment?: 'workflow-v1';
  reject_output?: string[];
}
export interface ChatCheckProof {
  schema_version: 1;
  request_hash: string;
  runtime_hash?: string | null;
  runtime_after_hash?: string | null;
  reused_from?: InputRef;
  environment?: 'workflow-v1';
  reject_output?: string[];
  operation_id: string;
  before: InputManifest;
  after: InputManifest;
  command: ChatCheckRequest['command'];
  exit_code: number | null;
  signal: string | null;
  elapsed_ms: number;
  check: Check;
}
export function checkRuntime(
  root: string,
  command: ChatCheckRequest['command'],
  environment?: ChatCheckRequest['environment'],
): string | null {
  const candidates =
    isAbsolute(command.file) || command.file.includes('/')
      ? [resolve(root, command.file)]
      : (process.env.PATH ?? '/usr/bin:/bin')
          .split(delimiter)
          .map((path) => resolve(root, path, command.file));
  let executable: { path: string; realpath: string; hash: string } | null = null;
  for (const path of candidates) {
    const cached = relocatedCommand(path);
    const actual = cached?.kind === 'tool' ? cached.path : path;
    try {
      accessSync(actual, constants.X_OK);
      if (!statSync(actual).isFile()) continue;
    } catch {
      continue;
    }
    try {
      executable = {
        path: actual,
        realpath: realpathSync(actual),
        hash:
          cached?.kind === 'tool'
            ? cached.hash
            : contentHash(readFileSync(path).toString('base64')),
      };
    } catch {
      return null;
    }
    break;
  }
  if (executable === null) return null;
  return contentHash(
    stableJson({
      command,
      cwd: resolve(root),
      executable,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      environment: checkEnvironment(root, environment),
    }),
  );
}

export async function reusableChatCheck(
  root: string,
  evidenceRoot: string,
  request: ChatCheckRequest,
  before: InputManifest,
  runtime?: string | null,
): Promise<ChatCheckProof | null> {
  if (request.reuse === undefined) return null;
  const fingerprint =
    runtime === undefined ? checkRuntime(root, request.command, request.environment) : runtime;
  const inputs = new FileWorkflowInputs(root, evidenceRoot);
  await inputs.verify([request.reuse]);
  const proof = readArtifactFile(request.reuse.locator) as ChatCheckProof;
  await verifyChatCheck(root, evidenceRoot, proof.check);
  requireWorkflow(
    resolve(request.reuse.locator) === proof.check.evidence.locator.slice(0, -4) + '.json',
    'chat-check-reuse-proof-mismatch',
  );
  return fingerprint !== null &&
    proof.check.id === (request.criterion ?? request.id) &&
    proof.check.verdict === 'PASS' &&
    sameValue(proof.command, request.command) &&
    proof.environment === request.environment &&
    sameValue(proof.reject_output ?? [], request.reject_output ?? []) &&
    proof.runtime_hash === fingerprint &&
    compareInputs(proof.before, before) === 'applicable' &&
    compareInputs(before, await inputs.current(before)) === 'applicable' &&
    fingerprint === checkRuntime(root, request.command, request.environment)
    ? { ...proof, reused_from: request.reuse }
    : null;
}

async function checkPending(evidenceRoot: string, criterion: string) {
  for (const file of await readdir(evidenceRoot)) {
    if (!file.endsWith('.intent.json')) continue;
    const intent = readArtifactFile(resolve(evidenceRoot, file)) as {
      request?: ChatCheckRequest;
    };
    requireWorkflow(intent.request !== undefined, 'chat-check-outcome-unknown');
    if ((intent.request.criterion ?? intent.request.id) !== criterion) continue;
    try {
      const proof = readArtifactFile(
        resolve(evidenceRoot, file.replace(/\.intent\.json$/u, '.json')),
      ) as ChatCheckProof;
      requireWorkflow(
        proof.schema_version === 1 &&
          proof.operation_id === intent.request.id &&
          proof.request_hash === contentHash(stableJson(intent.request)),
        'chat-check-outcome-unknown',
      );
    } catch {
      throw new Error('chat-check-outcome-unknown');
    }
  }
}
async function releaseCheckLock(lock: string, operation: string) {
  try {
    const held = JSON.parse(readPrivateFile(lock).toString('utf8')) as { operation: string };
    if (held.operation === operation) await unlink(lock);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}
export const legacyValidationCommands = [
  { file: 'yarn', args: ['validate'] },
  { file: 'yarn', args: ['validate:brief'] },
];
export function validateChatCheck(request: ChatCheckRequest, allowed = legacyValidationCommands) {
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(request.id), 'chat-check-id-invalid');
  const criterion = request.criterion ?? request.id;
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(criterion), 'chat-check-criterion-invalid');
  textField(request.command.file);
  request.command.args.forEach(textField);
  request.reject_output?.forEach(textField);
  validateCheckCommand(criterion, request.command, allowed);
}
export function validateCheckCommand(
  criterion: string,
  command: ChatCheckRequest['command'],
  allowed = legacyValidationCommands,
) {
  requireWorkflow(
    criterion !== 'validate' || allowed.some((entry) => sameValue(entry, command)),
    'chat-validate-command-required',
  );
}
export async function runChatCheck(
  root: string,
  evidenceRoot: string,
  request: ChatCheckRequest,
  assertRuntime: () => void = () => {},
  allowed = legacyValidationCommands,
): Promise<ChatCheckProof> {
  validateChatCheck(request, allowed);
  const criterion = request.criterion ?? request.id;
  const environment = checkEnvironment(root, request.environment);
  safeDirectory(evidenceRoot);
  for (const argument of request.command.args) {
    const candidate = resolve(root, argument);
    requireWorkflow(relocatedCommand(candidate)?.kind !== 'archive', 'archived-command-input');
  }
  const commandPath = resolve(root, request.command.file);
  const located = relocatedCommand(commandPath);
  requireWorkflow(located?.kind !== 'archive', 'archived-command-input');
  const inputs = new FileWorkflowInputs(root, evidenceRoot);
  const name = resolve(evidenceRoot, request.id),
    hash = contentHash(stableJson(request));
  try {
    const proof = readArtifactFile(name + '.json') as ChatCheckProof;
    requireWorkflow(
      proof.schema_version === 1 && proof.request_hash === hash,
      'chat-check-conflict',
    );
    await inputs.verify([proof.check.evidence]);
    await releaseCheckLock(resolve(evidenceRoot, criterion + '.check.lock'), request.id);
    return proof;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const before = await inputs.capture(request.discovery, request.attested_by);
  await checkPending(evidenceRoot, criterion);
  const runtime = checkRuntime(root, request.command, request.environment);
  assertRuntime();
  const lock = resolve(evidenceRoot, criterion + '.check.lock');
  try {
    await writeFile(lock, JSON.stringify({ operation: request.id, request_hash: hash }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    throw new Error('chat-check-outcome-unknown');
  }
  try {
    const reused = await reusableChatCheck(root, evidenceRoot, request, before, runtime);
    if (reused !== null) {
      assertRuntime();
      await releaseCheckLock(lock, request.id);
      return reused;
    }
  } catch (error) {
    // No process or intent exists yet; release only this operation's reservation.
    await releaseCheckLock(lock, request.id);
    throw error;
  }
  try {
    await writeFile(
      name + '.intent.json',
      encodeProofArtifact(evidenceRoot, { request_hash: hash, request, before }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    throw new Error('chat-check-outcome-unknown');
  }
  const log = await open(name + '.log', 'wx', 0o600);
  const started = performance.now();
  let outcome: { exit_code: number | null; signal: string | null };
  try {
    assertRuntime();
    outcome = await new Promise((complete, reject) => {
      const child = spawn(
        located?.kind === 'tool' ? located.path : request.command.file,
        request.command.args.map((argument) => {
          const source = relocatedCommand(resolve(root, argument));
          return source?.kind === 'tool' ? source.path : argument;
        }),
        {
          cwd: root,
          env: environment,
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      child.on('error', reject);
      child.on('close', (exit_code, signal) => complete({ exit_code, signal }));
    });
  } finally {
    await log.close();
  }
  const after = await inputs.current(before);
  const runtimeAfter = checkRuntime(root, request.command, request.environment);
  const applicable =
    compareInputs(before, after) === 'applicable' && runtime !== null && runtime === runtimeAfter;
  const output = readPrivateFile(name + '.log').toString('utf8');
  const acceptedOutput = !(request.reject_output ?? []).some((marker) => output.includes(marker));
  const proof: ChatCheckProof = {
    schema_version: 1,
    runtime_hash: runtime,
    runtime_after_hash: runtimeAfter,
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    ...(request.reject_output === undefined ? {} : { reject_output: request.reject_output }),
    request_hash: hash,
    operation_id: request.id,
    before,
    after,
    command: request.command,
    ...outcome,
    elapsed_ms: performance.now() - started,
    check: {
      id: criterion,
      inputs: before,
      verdict: !applicable
        ? 'NOT RUN'
        : outcome.exit_code === 0 && acceptedOutput
          ? 'PASS'
          : 'FAIL',
      reason: applicable
        ? acceptedOutput
          ? 'Observed process exit and unchanged attested inputs'
          : 'Command output matched a declared failure marker'
        : 'Inputs changed or became unknown during the process',
      evidence: await inputs.ref(name + '.log'),
    },
  };
  assertRuntime();
  await writeFile(name + '.json', encodeProofArtifact(evidenceRoot, proof), {
    flag: 'wx',
    mode: 0o600,
  });
  await releaseCheckLock(lock, request.id);
  return proof;
}

export async function verifyChatCheck(root: string, evidenceRoot: string, check: Check) {
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(check.id), 'chat-check-id-invalid');
  safeDirectory(evidenceRoot);
  const log = check.evidence.locator;
  requireWorkflow(
    dirname(log) === resolve(evidenceRoot) && /^[a-zA-Z0-9_-]+\.log$/u.test(basename(log)),
    'chat-check-evidence-outside-root',
  );
  const name = log.slice(0, -4);
  const proof = readArtifactFile(name + '.json') as ChatCheckProof;
  const intent = readArtifactFile(name + '.intent.json') as {
    request_hash: string;
    request: ChatCheckRequest;
    before: InputManifest;
  };
  requireWorkflow(
    proof.schema_version === 1 &&
      proof.request_hash === intent.request_hash &&
      proof.operation_id === intent.request.id &&
      contentHash(stableJson(intent.request)) === intent.request_hash &&
      sameValue(proof.before, intent.before) &&
      sameValue(proof.check, check) &&
      sameValue(proof.command, intent.request.command) &&
      proof.environment === intent.request.environment &&
      sameValue(proof.reject_output ?? [], intent.request.reject_output ?? []) &&
      (check.verdict !== 'PASS' ||
        (proof.exit_code === 0 &&
          compareInputs(proof.before, proof.after) === 'applicable' &&
          (proof.runtime_hash === undefined ||
            (proof.runtime_hash !== null && proof.runtime_hash === proof.runtime_after_hash)))),
    'chat-check-proof-mismatch',
  );
  await new FileWorkflowInputs(root, evidenceRoot).verify([check.evidence]);
  if (check.verdict === 'PASS')
    requireWorkflow(
      !(intent.request.reject_output ?? []).some((marker) =>
        readPrivateFile(log).toString('utf8').includes(marker),
      ),
      'chat-check-output-rejected',
    );
  return proof;
}
