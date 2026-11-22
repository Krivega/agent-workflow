import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskBackendHome } from '../src/adapters/project/taskBackend.js';

export function declareBackendFixture(workspace: string) {
  const bytes = JSON.stringify({ schemaVersion: 1, required: true });
  writeFileSync(join(workspace, '.agent-workflow-backend.json'), bytes);
  writeFileSync(join(dirname(taskBackendHome(workspace)), 'agent-workflow-backend.json'), bytes);
}
