import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { Connection } from '@temporalio/client';
import { privateConfigBytes } from '../../cli/temporalStart.ts';
import { parsePreparedTaskRegistration } from '../../src/client/localTask.ts';
import { listTemporalTaskIds } from '../../src/adapters/project/taskBackend.ts';

export function workerProjects(workerConfig) {
  const config = JSON.parse(privateConfigBytes(workerConfig));
  const projects = new Map();
  for (const { file } of config.projects) {
    const bytes = privateConfigBytes(file);
    const settings = JSON.parse(bytes);
    const workspace = realpathSync(settings.registration.workspaceRoot);
    if (file.startsWith(workspace + sep)) throw Error('Регистрация должна храниться вне проекта');
    const route = parsePreparedTaskRegistration(settings, workspace);
    const key = route.registration.project.projectId;
    if (projects.has(key)) throw Error('Повторяющийся ID проекта');
    projects.set(key, {
      workspace,
      registration: file,
      binding: createHash('sha256').update(file).update(bytes).digest('hex'),
      async tasks() {
        const connection = Connection.lazy({ address: route.address });
        try {
          return listTemporalTaskIds(workspace, key, {
            ...route,
            address: connection.options.address,
          });
        } finally {
          await connection.close();
        }
      },
    });
  }
  return projects;
}
