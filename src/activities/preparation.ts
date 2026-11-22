import { realpathSync } from 'node:fs';
import type { LocalProjectRegistration } from '../contracts/preparation.js';
export type { LocalProjectRegistration } from '../contracts/preparation.js';
import type { PreparationActivities } from '../contracts/preparation.js';
import { parseProject } from '../contracts/project.js';
import { parsePreparation, checkRegistration } from '../policy/preparation.js';
import { artifactStore } from '../adapters/artifacts/files.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';

import {
  preparationInputs,
  checkRegisteredCommands,
  captureRegistration,
} from '../adapters/project/preparation.js';
export { preparationInputs, checkRegisteredCommands } from '../adapters/project/preparation.js';

export function preparationActivities(
  registration: LocalProjectRegistration,
): PreparationActivities {
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const project = parseProject(registration.project);
  const workspace = realpathSync(registration.workspaceRoot);
  const store = artifactStore(registration.artifactRoot);
  return {
    async prepareProject(value) {
      const input = parsePreparation(value);
      checkRegistration(input, registration);
      backend.require(project.projectId, input.taskId, 'temporal', 'worker', input.card);
      checkRegisteredCommands(registration, project.checks);
      const inputs = preparationInputs(workspace, input);
      const manifest = store.publish(
        Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'preparation', input, inputs })),
      );
      return { status: 'prepared', manifest };
    },
  };
}
