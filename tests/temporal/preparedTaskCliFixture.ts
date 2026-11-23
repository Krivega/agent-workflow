import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { digest } from '../../src/adapters/artifacts/files.js';
import { taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { prepareTaskStartAdmission } from '../../src/adapters/project/taskStartAdmission.js';
import { nativeTaskSource } from '../../src/adapters/codex/nativeTaskSource.js';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

export async function preparedTaskCliFixture(card: string, human: string, taskId = 'one') {
  const f = substantialTaskFixture(),
    declaration = f.substantialInput.admission,
    preparation = declaration.preparation,
    registration = {
      ...f.registration,
      taskBackend: 'required' as const,
      commands: {
        ...f.registration.commands,
        smoke: { ...f.registration.commands.smoke, timeoutMs: 30_000 },
      },
    };
  preparation.taskId = taskId;
  writeFileSync(join(f.workspace, preparation.card), card);
  f.proposal.requirement.hash = digest(card);
  const plan = Buffer.from(JSON.stringify(f.proposal));
  writeFileSync(join(f.workspace, declaration.plan.path), plan);

  const threadId = 'prepared-start-thread',
    turnId = 'prepared-start-turn',
    sessionsRoot = join(f.root, 'sessions'),
    transcript = join(sessionsRoot, 'rollout-' + threadId + '.jsonl'),
    message = 'Start this prepared task.';
  mkdirSync(sessionsRoot, { mode: 0o700 });
  vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
  vi.stubEnv('CODEX_HOME', f.root);
  vi.stubEnv('CODEX_THREAD_ID', threadId);
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
  const user = row('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: message }],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      create_time: 1,
      content_item_kinds: ['user.text'],
      content_item_metadata: [{ provenance: { type: 'user' } }],
    },
  });
  writeFileSync(
    transcript,
    [
      row('session_meta', {
        id: threadId,
        session_id: threadId,
        cli_version: '0.166.0-alpha.6',
        cwd: f.workspace,
        source: 'vscode',
        originator: 'codex_work_desktop',
        thread_source: 'user',
      }),
      row('event_msg', { type: 'task_started', turn_id: turnId }),
      row('turn_context', { turn_id: turnId, cwd: f.workspace }),
      user,
      row('event_msg', {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: message, text_elements: [] }],
        },
      }),
    ].join(''),
    { mode: 0o600 },
  );
  const source = nativeTaskSource(f.store, {
    sessionsRoot,
    chatWorkspace: f.workspace,
    threadId,
    owner: registration.owner,
  });
  const start = await prepareTaskStartAdmission(
    registration,
    {
      issue: () => source.issue({ transcript, turnId, user: { line: 4, sha256: digest(user) } }),
      verify: source.verify,
    },
    { preparation, previous: null, human: [human], inapplicable: [] },
  );
  const home = taskBackendHome(f.workspace);
  declareBackendFixture(f.workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'backend-policy.json'),
    JSON.stringify({
      schemaVersion: 2,
      newTasks: 'temporal',
      startAdmission: 'task-start-admission/1',
    }),
  );
  const input: HumanManagedTaskInput = {
    ...f.substantialInput,
    admission: { ...declaration, plan: { ...declaration.plan, sha256: digest(plan) } },
    schemaVersion: 12,
    startAdmission: start.ref,
    continuation: { attempt: 0, previous: null },
  };
  const config = {
    schemaVersion: 1,
    address: '127.0.0.1:7233',
    namespace: 'prepared-start',
    taskQueue: 'prepared-tasks',
    registration,
  };
  return {
    ...f,
    input,
    config,
    home,
    transcript,
    threadId,
    admitted: start,
    verify: source.verify,
  };
}
