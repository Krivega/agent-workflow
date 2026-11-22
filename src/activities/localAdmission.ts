import type { LocalAdmissionActivities } from '../contracts/localAdmission.js';
import type { LocalProjectRegistration } from './preparation.js';
import { preparationActivities, checkRegisteredCommands } from './preparation.js';
import { parseLocalAdmission } from '../policy/localAdmission.js';
import { validateLocalPlan } from '../policy/localPlanning.js';
import { parseReviewRequest } from '../policy/review.js';
import { relativePath, requireContract } from '../contracts/project.js';
import { artifactStore, digest, readProjectFile } from '../adapters/artifacts/files.js';

export function localAdmissionActivities(
  registration: LocalProjectRegistration,
): LocalAdmissionActivities {
  const store = artifactStore(registration.artifactRoot);
  return {
    async prepareLocalAdmission(value) {
      const input = parseLocalAdmission(value);
      const prepared = await preparationActivities(registration).prepareProject(input.preparation);
      const planBytes = readProjectFile(registration.workspaceRoot, input.plan.path);
      requireContract(digest(planBytes) === input.plan.sha256, 'local-plan-source-changed');
      const plan: unknown = JSON.parse(planBytes.toString('utf8'));
      validateLocalPlan(plan);
      const sources = [plan.requirement, ...plan.basis, plan.owner, ...plan.consumers];
      const files = sources.map((source) => {
        const path = relativePath(source.locator),
          bytes = readProjectFile(registration.workspaceRoot, path);
        requireContract(digest(bytes) === source.hash, 'local-admission-source-changed');
        return { path, sha256: source.hash, bytes: bytes.length };
      });
      const fixed = [
        input.plan.path,
        plan.requirement.locator,
        ...plan.basis.map((ref) => ref.locator),
        ...input.preparation.project.rules,
        ...input.preparation.project.roles.map((role) => role.profile),
        input.preparation.card,
      ];
      requireContract(
        fixed.every(
          (path) => !plan.paths.some((scope) => path === scope || path.startsWith(scope + '/')),
        ),
        'local-plan-authorizes-own-basis',
      );
      requireContract(
        input.preparation.project.checks.every((check) => plan.checks.includes(check)) &&
          plan.checks.every((check) => Object.hasOwn(registration.commands, check)),
        'local-plan-checks-incomplete',
      );
      checkRegisteredCommands(registration, plan.checks);
      const review = parseReviewRequest(
        JSON.parse(store.read(input.acceptance).toString('utf8')) as unknown,
        {
          schemaVersion: 1,
          preparation: input.preparation,
          reviewId: 'local-admission',
          request: input.acceptance,
        },
      );
      requireContract(
        review.phase === 'acceptance' &&
          review.roles.some((role) => role.applies === true) &&
          review.roles.every(
            (role) => role.applies !== null && role.complete && role.history.complete,
          ),
        'local-acceptance-incomplete',
      );
      const reviewPaths = [
        ...new Set([
          ...review.sharedPaths,
          ...review.roles.filter((role) => role.applies === true).flatMap((role) => role.paths),
        ]),
      ];
      if (review.schemaVersion !== 1) for (const evidence of review.evidence) store.read(evidence);
      const acceptanceFiles = reviewPaths.map((path) => {
        const bytes = readProjectFile(registration.workspaceRoot, path);
        return { path, sha256: digest(bytes), bytes: bytes.length };
      });
      return {
        status: 'admitted',
        manifest: store.publish(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              kind: 'local-admission',
              input,
              prepared,
              plan,
              files,
              acceptanceFiles,
            }),
          ),
        ),
      };
    },
  };
}
