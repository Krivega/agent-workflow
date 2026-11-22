import { requireWorkflow } from '../../core/connection.js';
import { actionProcedureLoading, requiredProcedures } from '../../core/localRun.js';
import { configuredRoles, configuredProfileLocators } from '../../core/council.js';
import type { RunInputs } from '../../ports/localRuns.js';
import { fileConnectionReader } from './fileConnectionReader.js';
import { readCardMarkdown } from './cardMarkdown.js';
import { contentHash, projectText } from './projectFiles.js';
import { compareInputs } from '../../core/evidence.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import { sameValue } from '../../core/equality.js';

export function fileRunInputs(root: string, descriptorLocator: string): RunInputs {
  return {
    async verify(run) {
      const loaded = await fileConnectionReader.load(root, descriptorLocator);
      const spec = run.spec;
      actionProcedureLoading(spec);
      requireWorkflow(spec.project_id === loaded.descriptor.project_id, 'wrong-project');
      requireWorkflow(
        requiredProcedures(run.type, spec.role, spec.procedure_loading).every((id) =>
          spec.procedures.some((p) => p.id === id),
        ),
        'missing-procedure',
      );
      requireWorkflow(
        spec.procedures.every((p) =>
          loaded.procedures.some(
            (entry) =>
              p.id === entry.id &&
              p.locator === entry.locator &&
              p.version === entry.version &&
              p.hash === entry.hash &&
              (spec.context_loading === undefined || sameValue(p.fragments, entry.fragments)),
          ),
        ),
        'procedure-version-mismatch',
      );
      requireWorkflow(
        spec.rules.length > 0 &&
          spec.rules.every(
            (rule) =>
              (spec.role === 'council-adviser' &&
                configuredRoles(loaded.descriptor.council).some((role) =>
                  configuredProfileLocators(role, loaded.descriptor.council).includes(rule.locator),
                )) ||
              loaded.rules.some(
                (entry) => entry.locator === rule.locator && entry.hash === rule.hash,
              ),
          ),
        'rules-version-mismatch',
      );
      requireWorkflow(
        run.type === 'role' ||
          loaded.rules.every((rule) =>
            spec.rules.some((entry) => entry.locator === rule.locator && entry.hash === rule.hash),
          ),
        'required-rule-not-loaded',
      );
      const refs = [spec.assignment, ...spec.sources, ...spec.rules];
      if (
        (spec.route.kind === 'substantial' || spec.route.kind === 'local') &&
        spec.route.accepted_plan
      )
        refs.push(spec.route.accepted_plan);
      if (spec.route.kind === 'mechanical') refs.push(spec.route.accepted_material);
      if (run.projection !== null) {
        const manifest = {
          complete: true,
          attested_by: 'Run sources',
          discovery_rule: JSON.stringify({ version: 2, kind: 'explicit' }),
          inputs: [
            ...new Map(refs.map((ref) => [JSON.stringify([ref.locator, ref.hash]), ref])).values(),
          ],
        };
        requireWorkflow(
          compareInputs(
            manifest,
            await new FileWorkflowInputs(root).current(manifest, run.projection),
          ) === 'applicable',
          'source-revision-mismatch',
        );
      } else
        for (const ref of refs)
          requireWorkflow(
            contentHash(await projectText(root, ref.locator)) === ref.hash,
            'source-revision-mismatch',
          );
      // A pending projection may already have moved the card. Its saved plan/receipt owns recovery.
      if ('task_id' in spec.identity && run.projection?.result.status !== 'pending') {
        const ref = spec.identity.card;
        const card = readCardMarkdown(ref.locator, await projectText(root, ref.locator));
        requireWorkflow(
          card.revision === ref.hash &&
            card.task_id === spec.identity.task_id &&
            card.project_id === spec.project_id &&
            (card.notes_version === 1 || card.notes_version === 2),
          'card-identity-mismatch',
        );
      }
    },
  };
}
