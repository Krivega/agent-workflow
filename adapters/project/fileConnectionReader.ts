import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConnection, object, requireWorkflow, textField } from '../../core/connection.js';
import type { ProjectConnectionReader } from '../../ports/projectConnection.js';
import { contentHash, projectText } from './projectFiles.js';

export function projectDescriptor(root: string): string {
  const fallback = 'tools/agent-workflow/project/workflow.json';
  return existsSync(resolve(root, fallback)) && !existsSync(resolve(root, 'project/workflow.json'))
    ? fallback
    : 'project/workflow.json';
}
export const fileConnectionReader: ProjectConnectionReader = {
  async load(root, locator) {
    const source = await projectText(root, locator);
    const descriptor = parseConnection(JSON.parse(source) as unknown);
    if (descriptor.validation_commands === undefined) {
      const manifest = object(JSON.parse(await projectText(root, 'package.json')) as unknown);
      const scripts = object(manifest.scripts);
      for (const command of descriptor.commands) textField(scripts[command]);
    }
    for (const directory of Object.values(descriptor.plans))
      await projectText(root, `${directory}/README.md`);
    for (const link of descriptor.mutable_links) await projectText(root, link);
    const rules = await Promise.all(
      descriptor.rules.map(async (rule) => {
        const content = await projectText(root, rule);
        return { locator: rule, hash: contentHash(content), content };
      }),
    );
    const procedures = await Promise.all(
      descriptor.procedures.map(async (procedure) => {
        const content = await projectText(root, procedure.locator);
        requireWorkflow(contentHash(content) === procedure.hash, 'procedure-version-mismatch');
        requireWorkflow(
          content.includes(`Procedure: ${procedure.id}\nVersion: ${procedure.version}\n`),
          'procedure-header-mismatch',
        );
        return { ...procedure, content };
      }),
    );
    return { descriptor, revision: contentHash(source), rules, procedures };
  },
};
