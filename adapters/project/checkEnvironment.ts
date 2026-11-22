import { resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';

export function checkEnvironment(root: string, profile?: 'workflow-v1'): NodeJS.ProcessEnv {
  requireWorkflow(profile === undefined || profile === 'workflow-v1', 'unknown-check-environment');
  const environment = { ...process.env };
  if (profile === 'workflow-v1') {
    // Invocation metadata belongs to the caller, not the command being checked.
    for (const name of [
      'npm_config_argv',
      'npm_lifecycle_event',
      'npm_lifecycle_script',
      'CODEX_TOOL_CALL_ID',
    ])
      delete environment[name];
    environment.PWD = resolve(root);
    environment.INIT_CWD = resolve(root);
  }
  return environment;
}
