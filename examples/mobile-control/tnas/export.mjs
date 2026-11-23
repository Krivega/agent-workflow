// A complete snapshot replaces the previous catalog, including removed registrations.
import { workerProjects } from '../workerProjects.mjs';
import { runTemporalTaskChat } from '../../../cli/temporalStart.ts';

const generatedAt = Date.now();
const file = process.argv[2];
const registrations = workerProjects(file);
const projects = [];
for (const [id, project] of registrations) {
  let tasks = null;
  try {
    const ids = await project.tasks();
    tasks = [];
    for (const task of ids) {
      const workflow = 'aw/task/' + id + '/' + task;
      let payload;
      const code = await runTemporalTaskChat(
        ['status', '--workflow-id', workflow, '--temporal-registration', project.registration],
        project.workspace,
        (value) => {
          payload = JSON.parse(value);
        },
        () => {},
      );
      if (code || payload.workflowId !== workflow) {
        tasks.push({ id: task, status: null });
        continue;
      }
      // Diagnostic errors may contain private paths. Export only known mobile fields.
      const { status, phase, reason } = payload;
      tasks.push({
        id: task,
        status,
        phase: phase && /^[a-z-]{1,50}$/.test(phase) ? phase : null,
        reason: [
          'task-human-decision-required',
          'task-execution-held',
          'task-human-paused',
          'task-cancelled',
        ].includes(reason)
          ? reason
          : reason
            ? 'unknown'
            : null,
        confirmedAt: new Date().toISOString(),
      });
    }
  } catch {
    tasks = null;
  }
  projects.push({ id, tasks });
}
const current = workerProjects(file);
if (
  current.size !== registrations.size ||
  [...registrations].some(([id, p]) => current.get(id)?.binding !== p.binding)
) {
  throw Error('registration-changed');
}
process.stdout.write(JSON.stringify({ generatedAt, version: 1, projects }) + '\n');
