import { requireWorkflow } from '../../core/connection.js';
import { cardCriteria } from './cardMarkdown.js';
import { projectText } from './projectFiles.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import { reusableChatCheck } from './chatChecks.js';
import type { ChatCheckRequest } from './chatChecks.js';
import type { InputManifest } from '../../core/evidence.js';
import { compareInputs } from '../../core/evidence.js';
import { stableJson } from '../../core/equality.js';
export interface CriterionCheckPlan {
  criterion: string;
  implementation: string[];
  verification: string[];
  check: ChatCheckRequest;
}
export async function checkReadiness(
  root: string,
  evidenceRoot: string,
  card: string,
  plans: CriterionCheckPlan[],
  acceptance?: InputManifest,
) {
  const criteria = cardCriteria(await projectText(root, card));
  requireWorkflow(criteria.length > 0, 'readiness-criteria-missing');
  const ids = criteria.map((text) => /^([a-zA-Z0-9_-]+): /u.exec(text)?.[1] ?? text);
  requireWorkflow(new Set(ids).size === ids.length, 'readiness-duplicate-criterion');
  requireWorkflow(
    new Set(plans.map((plan) => plan.criterion)).size === plans.length &&
      plans.every((plan) => [...ids, 'validate'].includes(plan.criterion)),
    'readiness-unknown-or-duplicate-plan',
  );
  const files = new FileWorkflowInputs(root, evidenceRoot);
  if (acceptance !== undefined)
    requireWorkflow(
      acceptance.complete &&
        compareInputs(acceptance, await files.current(acceptance)) === 'applicable',
      'readiness-acceptance-inputs-changed',
    );
  const checks = [];
  const manifests = new Map<string, InputManifest>();
  for (const id of [...new Set([...ids, 'validate'])]) {
    const plan = plans.find((plan) => plan.criterion === id);
    if (plan === undefined) {
      checks.push({ criterion: id, status: 'missing' as const });
      continue;
    }
    requireWorkflow(
      plan.implementation.length > 0 &&
        plan.verification.length > 0 &&
        (plan.check.criterion ?? plan.check.id) === id,
      'readiness-map-incomplete',
    );
    const key = stableJson({
      discovery: plan.check.discovery,
      attested_by: plan.check.attested_by,
    });
    let manifest = manifests.get(key);
    if (manifest === undefined) {
      manifest = await files.capture(plan.check.discovery, plan.check.attested_by);
      manifests.set(key, manifest);
    }
    requireWorkflow(
      [...plan.implementation, ...plan.verification, card].every((path) =>
        manifest.inputs.some((input) => input.locator === path),
      ),
      'readiness-dependencies-missing',
    );
    const reused = await reusableChatCheck(root, evidenceRoot, plan.check, manifest);
    if (acceptance !== undefined) {
      const required = reused === null ? [] : [plan.check.reuse!, reused.check.evidence];
      const missing = required.filter(
        (ref) =>
          !acceptance.inputs.some(
            (input) => input.locator === ref.locator && input.hash === ref.hash,
          ),
      );
      if (reused === null || missing.length > 0) {
        checks.push({ criterion: id, status: 'missing-evidence' as const, missing });
        continue;
      }
    }
    checks.push({
      criterion: id,
      status: 'covered' as const,
      implementation: plan.implementation,
      verification: plan.verification,
      command: plan.check.command,
      reusable: reused?.reused_from ?? null,
    });
  }
  return {
    ready: checks.every((check) => check.status === 'covered'),
    checks,
    limitation:
      acceptance === undefined
        ? 'Structural coverage only; this does not prove implementation correctness, PASS or human acceptance.'
        : 'Current check receipts and complete logs are included; council and human acceptance remain separate.',
  };
}
