import { inspectProject } from '../application/inspectProject.js';
import type { ProjectManifestReader } from '../ports/projectManifestReader.js';
import type { ProjectConnectionReader } from '../ports/projectConnection.js';
import { inspectConnection } from '../application/inspectConnection.js';
import { chatUsage } from './chatCommand.js';
import { connectionUsage } from './taskConnectionCommand.js';

const usage =
  'Использование: agent-workflow init | doctor | inspect-project [каталог] | inspect-connection <дескриптор> [каталог] | ' +
  connectionUsage +
  ' | ' +
  chatUsage;

export interface WorkflowCliDependencies {
  projectReader: ProjectManifestReader;
  connectionReader: ProjectConnectionReader;
  cwd: string;
  write: (text: string) => void;
  writeError: (text: string) => void;
}

export async function runAgentWorkflow(
  args: readonly string[],
  dependencies: WorkflowCliDependencies,
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    dependencies.write(usage);
    return 0;
  }
  const connection = args[0] === 'inspect-connection';
  if (
    connection
      ? !args[1] || args.length > 3 || args[2] === ''
      : args[0] !== 'inspect-project' || args.length > 2 || args[1] === ''
  ) {
    dependencies.writeError(usage);
    return 2;
  }
  try {
    const result = connection
      ? await inspectConnection(
          args[2] ?? dependencies.cwd,
          args[1]!,
          dependencies.connectionReader,
        )
      : await inspectProject(args[1] ?? dependencies.cwd, dependencies.projectReader);
    dependencies.write(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    dependencies.writeError(
      error instanceof Error ? error.message : 'Не удалось прочитать проект.',
    );
    return 1;
  }
}
