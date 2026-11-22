import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { localTaskFixture } from './localTaskFixture.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import type { TaskHostAdmission } from '../../src/contracts/taskRecovery.js';
import { object, text } from '../../src/contracts/project.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { taskGateBinding } from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { inspectTaskAdmissions } from '../../src/worker/taskRecovery.js';

export async function inspectCompletedTaskFixture(
  f: ReturnType<typeof localTaskFixture>,
  value: LocalTaskInput,
) {
  const input = parseLocalTask(value),
    source = taskFiles(f.registration.artifactRoot).binding(f.workspace),
    directory = taskGateBinding(
      input,
      source,
      f.profile,
      f.registration.artifactRoot,
      'locate-existing-grant',
    ).directory,
    grant = readFileSync(join(directory, 'grant.json')),
    host = { pid: 999999, id: text(object(JSON.parse(grant.toString())).instance) },
    root = join(f.root, 'completed-task-inspection'),
    admissions = join(root, 'task-admissions'),
    record: TaskHostAdmission = {
      schemaVersion: 1,
      host,
      input,
      gate: { directory, grant: { sha256: digest(grant), bytes: grant.length }, mode: 'owned' },
    };
  mkdirSync(admissions, { recursive: true });
  writeFileSync(join(admissions, digest(taskAdmissionIdentity(input))), JSON.stringify(record));
  return inspectTaskAdmissions(
    [{ registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host }],
    root,
    host,
    [input],
  );
}
