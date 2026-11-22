import { isAbsolute, resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import { compareInputs } from '../../core/evidence.js';
import type { InputManifest } from '../../core/evidence.js';
import type { InputRef } from '../../core/localRun.js';
import { sameValue } from '../../core/equality.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import {
  checkRuntime,
  verifyChatCheck,
  validateChatCheck,
  legacyValidationCommands,
} from './chatChecks.js';
import type { ChatCheckProof, ChatCheckRequest } from './chatChecks.js';
import { checkReadiness } from './checkReadiness.js';
import type { CriterionCheckPlan } from './checkReadiness.js';
import { readChatArtifact, saveChatArtifact } from '../storage/sharedArtifacts.js';
import { nativeStartupChecks } from './nativeStartup.js';
import type { NativeStartup } from './nativeStartup.js';
import { canonical, digest } from '../storage/storeCodec.js';
import { requireWorkflowDiskSpace } from './workflowDiskSpace.js';

export interface PreparedCheck {
  check: ChatCheckRequest;
  inputs: InputManifest;
  runtime_hash: string;
}
export interface PreparedChecks {
  schema_version: 1;
  purpose: 'prepared-checks';
  root: string;
  card: InputRef;
  checks: (PreparedCheck & CriterionCheckPlan)[];
  probes: PreparedCheck[];
}

export async function freezeChecks(
  root: string,
  evidence: string,
  card: string,
  checks: CriterionCheckPlan[],
  probes: ChatCheckRequest[] = [],
  native?: NativeStartup,
  allowed = legacyValidationCommands,
) {
  requireWorkflow(
    isAbsolute(evidence) && evidence !== root && !evidence.startsWith(root + '/'),
    'check-results-must-be-external',
  );
  const files = new FileWorkflowInputs(root, evidence);
  requireWorkflow(checks.length > 0, 'prepared-check-map-incomplete');
  const startupRequests = [
    ...probes,
    ...(native === undefined ? [] : await nativeStartupChecks(native)),
  ];
  const requests = [...checks.map((entry) => entry.check), ...startupRequests];
  requests.forEach((request) => validateChatCheck(request, allowed));
  await requireWorkflowDiskSpace(root, evidence);
  const discovery = {
    files: [
      ...new Set([
        card,
        ...checks.flatMap((entry) => [...entry.implementation, ...entry.verification]),
        ...requests.flatMap((entry) => entry.discovery.files),
      ]),
    ].sort(),
    directories: [...new Set(requests.flatMap((entry) => entry.discovery.directories))].sort(),
    repository: true as const,
  };
  const inputs = await files.capture(discovery, 'Prepared integration check sources');
  const prepare = async (check: ChatCheckRequest): Promise<PreparedCheck> => {
    const request: ChatCheckRequest = {
      ...check,
      environment: 'workflow-v1',
      discovery,
    };
    const runtime = checkRuntime(root, request.command, request.environment);
    requireWorkflow(runtime !== null, 'prepared-check-executable-missing');
    return {
      check: request,
      inputs,
      runtime_hash: runtime,
    };
  };
  const prepared = await Promise.all(
    checks.map(async (plan) => ({ ...plan, ...(await prepare(plan.check)) })),
  );
  requireWorkflow(
    (await checkReadiness(root, evidence, card, prepared)).ready,
    'prepared-check-map-incomplete',
  );
  const startup = await Promise.all(startupRequests.map(prepare));
  const ids = [...prepared, ...startup].map((entry) => entry.check.id);
  requireWorkflow(new Set(ids).size === ids.length, 'duplicate-prepared-check-id');
  const plan: PreparedChecks = {
    schema_version: 1,
    purpose: 'prepared-checks',
    root,
    card: await files.ref(card),
    checks: prepared,
    probes: startup,
  };
  return saveChatArtifact(evidence, 'check-plan', plan);
}

export async function preparedChecks(
  root: string,
  evidence: string,
  ref: InputRef,
  allowed = legacyValidationCommands,
) {
  const files = new FileWorkflowInputs(root, evidence);
  await files.verify([ref]);
  const plan = readChatArtifact(ref) as PreparedChecks;
  requireWorkflow(
    plan.schema_version === 1 &&
      plan.purpose === 'prepared-checks' &&
      plan.root === root &&
      Array.isArray(plan.checks) &&
      plan.checks.length > 0 &&
      Array.isArray(plan.probes),
    'invalid-prepared-check-plan',
  );
  await files.verify([plan.card]);
  const verified = new Set<string>();
  for (const entry of [...plan.probes, ...plan.checks]) {
    validateChatCheck(entry.check, allowed);
    requireWorkflow(
      entry.check.environment === 'workflow-v1',
      'invalid-prepared-check-environment',
    );
    requireWorkflow(
      typeof entry.runtime_hash === 'string' && /^[a-f0-9]{64}$/u.test(entry.runtime_hash),
      'invalid-prepared-check-runtime',
    );
    const key = digest(canonical(entry.inputs));
    if (!verified.has(key)) {
      requireWorkflow(
        entry.inputs.complete &&
          compareInputs(entry.inputs, await files.current(entry.inputs)) === 'applicable',
        'prepared-check-inputs-changed',
      );
      verified.add(key);
    }
  }
  return plan;
}

export function verifyPreparedRuntime(root: string, plan: PreparedChecks) {
  for (const entry of [...plan.probes, ...plan.checks])
    requireWorkflow(
      entry.runtime_hash === checkRuntime(root, entry.check.command, entry.check.environment),
      'prepared-check-runtime-changed',
    );
}

export async function preparedProof(
  root: string,
  evidence: string,
  entry: PreparedCheck,
  ref: InputRef,
): Promise<ChatCheckProof> {
  await new FileWorkflowInputs(root, evidence).verify([ref]);
  const proof = readChatArtifact(ref) as ChatCheckProof;
  await verifyChatCheck(root, evidence, proof.check);
  requireWorkflow(
    resolve(ref.locator) === proof.check.evidence.locator.slice(0, -4) + '.json' &&
      proof.environment === entry.check.environment &&
      sameValue(proof.reject_output ?? [], entry.check.reject_output ?? []) &&
      proof.check.id === (entry.check.criterion ?? entry.check.id) &&
      proof.check.verdict === 'PASS' &&
      sameValue(proof.command, entry.check.command) &&
      proof.runtime_hash === entry.runtime_hash &&
      compareInputs(entry.inputs, proof.before) === 'applicable',
    'prepared-check-proof-not-applicable',
  );
  return proof;
}

export async function packageChecks(
  root: string,
  evidence: string,
  ref: InputRef,
  proofs: InputRef[],
  artifacts: string[] = [],
  allowed = legacyValidationCommands,
) {
  const plan = await preparedChecks(root, evidence, ref, allowed);
  const entries = [...plan.probes, ...plan.checks];
  requireWorkflow(proofs.length === entries.length, 'prepared-check-proofs-incomplete');
  const verified = await Promise.all(
    entries.map((entry, index) => preparedProof(root, evidence, entry, proofs[index]!)),
  );
  const files = new FileWorkflowInputs(root, evidence);
  const sources = [
    ...new Set(entries.flatMap((entry) => entry.inputs.inputs.map((r) => r.locator))),
  ];
  const sourceInputs = plan.checks[0]!.inputs;
  const acceptance = await files.capture(
    {
      files: [
        ...new Set([
          ...sources,
          ref.locator,
          ...proofs.map((r) => r.locator),
          ...verified.map((p) => p.check.evidence.locator),
          ...artifacts,
        ]),
      ],
      directories: [],
      repository: true,
    },
    'Prepared check evidence package',
  );
  const bundle = {
    schema_version: 1,
    purpose: 'check-package',
    plan: ref,
    ready: true,
    source_inputs: sourceInputs,
    acceptance_inputs: acceptance,
    probes: proofs.slice(0, plan.probes.length),
    proofs,
    checks: verified.slice(plan.probes.length).map((p) => p.check),
  };
  await preparedChecks(root, evidence, ref, allowed);
  return { ready: true, details: saveChatArtifact(evidence, 'check-package', bundle) };
}

export async function runPreparedChecks(
  root: string,
  evidence: string,
  ref: InputRef,
  run: (check: ChatCheckRequest) => Promise<ChatCheckProof>,
  phase: 'preflight' | 'checks' = 'checks',
  write: (message: string) => void = () => {},
  allowed = legacyValidationCommands,
) {
  const plan = await preparedChecks(root, evidence, ref, allowed);
  verifyPreparedRuntime(root, plan);
  const proofs: InputRef[] = [];
  const files = new FileWorkflowInputs(root, evidence);
  for (const entry of phase === 'preflight' ? plan.probes : [...plan.probes, ...plan.checks]) {
    await preparedChecks(root, evidence, ref, allowed);
    verifyPreparedRuntime(root, plan);
    const proof = await run(entry.check);
    const source = await files.ref(resolve(evidence, proof.operation_id + '.json'));
    write(
      JSON.stringify({ criterion: proof.check.id, verdict: proof.check.verdict, proof: source }),
    );
    await preparedProof(root, evidence, entry, source);
    proofs.push(source);
  }
  if (phase === 'preflight') return { ready: true, scope: 'startup-only', plan: ref, proofs };
  return packageChecks(root, evidence, ref, proofs, [], allowed);
}
