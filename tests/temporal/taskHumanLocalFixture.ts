import type { Client } from '@temporalio/client';
import { MockActivityEnvironment } from '@temporalio/testing';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type { TaskHumanAuthority, TaskHumanCommand } from '../../src/contracts/taskHuman.js';
import type { ReaderAuthority } from '../../src/contracts/readerControl.js';
import { requireContract } from '../../src/contracts/project.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { prepareTaskStartAdmission } from '../../src/adapters/project/taskStartAdmission.js';
import { bindTaskBackendClient, reserveNewTaskBackend } from '../../src/client/taskBackend.js';
import { taskHumanCanonical } from '../../src/policy/taskHuman.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { captureTaskBudget } from '../../src/worker/taskBudget.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

/** Real local stores/registration/assignment; all principal and model effects are explicit unit stubs. */
export async function taskHumanLocalFixture(human = true) {
  const base = substantialTaskFixture(),
    preparation = base.substantialInput.admission.preparation,
    criterion = 'Человек принимает понятность результата';
  writeFileSync(
    join(base.workspace, preparation.card),
    `# Task\n\n## Критерии\n\n- [ ] ${criterion}\n`,
  );
  const cardBytes = readFileSync(join(base.workspace, preparation.card));
  base.proposal.requirement.hash = digest(cardBytes);
  const planBytes = Buffer.from(JSON.stringify(base.proposal));
  writeFileSync(join(base.workspace, base.substantialInput.admission.plan.path), planBytes);
  base.substantialInput.admission.plan.sha256 = digest(planBytes);
  const principal = {
    owner: preparation.owner,
    threadId: 'synthetic-controller',
    turnId: 'synthetic-turn',
    source: { locator: '/synthetic/task-source.jsonl#L1', hash: 'a'.repeat(64) },
    proof: base.proof,
  };
  const startAuthority = {
    issue: vi.fn(async () => structuredClone(principal)),
    verify: vi.fn(async (value: unknown) => {
      requireContract(
        taskHumanCanonical(value) === taskHumanCanonical(principal),
        'synthetic-start-principal-refused',
      );
      base.store.read(principal.proof);
    }),
  };
  const declaration = await prepareTaskStartAdmission(base.registration, startAuthority, {
    preparation,
    previous: null,
    human: human ? [criterion] : [],
    inapplicable: [],
  });
  declareBackendFixture(base.workspace);
  const home = taskBackendHome(base.workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'backend-policy.json'),
    JSON.stringify({
      schemaVersion: 2,
      newTasks: 'temporal',
      startAdmission: 'task-start-admission/1',
    }),
  );
  const client = {} as Client;
  bindTaskBackendClient(client, base.registration, startAuthority);
  const assignment = await reserveNewTaskBackend(client, preparation, declaration.ref);
  const input: HumanManagedTaskInput = {
    ...base.substantialInput,
    schemaVersion: 12,
    continuation: { attempt: 0, previous: null },
    startAdmission: declaration.ref,
  };
  const permittedHuman = new Set<string>(),
    humanAuthority = {
      verify: vi.fn<TaskHumanAuthority['verify']>(async (_context, command) => {
        requireContract(
          permittedHuman.has(taskHumanCanonical(command)),
          'synthetic-human-source-refused',
        );
        base.store.read(command.source);
        return command.action === 'ASK'
          ? { kind: 'verified-task-human-command', action: 'ASK', command, proof: base.proof }
          : {
              kind: 'verified-task-human-command',
              action: 'DECIDE',
              command,
              accepted: command.accepted,
              proof: base.proof,
            };
      }),
    },
    verify = vi.fn<ReaderAuthority['verify']>(async (command) => ({
      origin: 'human',
      author: command.author,
      hash: command.hash,
      proof: base.proof,
    })),
    host = {
      ...base.host,
      authority: { verify },
      startAdmissionAuthority: startAuthority,
      humanAuthority,
    },
    budgetDirectory = join(base.root, 'human-budget'),
    taskQueue = 'test.control',
    namespace = 'default';
  mkdirSync(budgetDirectory);
  const consume = readerBudget(budgetDirectory, 20);
  function environment(name: string, runId = 'synthetic-run') {
    return new MockActivityEnvironment({
      workflowType: 'LocalTaskWorkflow',
      workflowExecution: { workflowId: localTaskKey(input), runId },
      activityType: name,
      taskQueue,
      namespace,
      isLocal: false,
    });
  }
  function runHuman<T>(name: string, run: () => Promise<T>, runId = 'synthetic-run') {
    return environment(name, runId).run(run);
  }
  function wrap<T extends object>(group: T): T {
    return Object.fromEntries(
      Object.entries(group).map(([name, method]) => {
        requireContract(typeof method === 'function', 'synthetic-activity-method');
        const invoke = method as (...args: unknown[]) => unknown;
        return [
          name,
          (...args: unknown[]) =>
            runHuman(name, async () => Reflect.apply(invoke, group, args) as unknown),
        ];
      }),
    ) as T;
  }
  function makeHumanService(
    instance = 'synthetic-host',
    ownership?: Pick<NonNullable<Parameters<typeof localTaskActivities>[5]>, 'owner' | 'admitted'>,
  ) {
    const service = localTaskActivities(base.registration, host, base.rpc, base.profile, consume, {
      instance,
      admitted: vi.fn(),
      ...ownership,
      taskQueue,
      namespace,
      budget: (_input, previous) => captureTaskBudget(budgetDirectory, base.store, previous),
    });
    return {
      ...service,
      activities: wrap(service.activities),
      controls: wrap(service.controls),
      executionControls: wrap(service.executionControls),
      humanActivities: wrap(service.humanActivities),
    };
  }
  const service = makeHumanService();
  return {
    ...base,
    input,
    host,
    service,
    declaration,
    assignment,
    startAuthority,
    humanAuthority,
    verify,
    criterion,
    client,
    budgetDirectory,
    taskQueue,
    namespace,
    environment,
    runHuman,
    allowHuman(command: TaskHumanCommand) {
      permittedHuman.add(taskHumanCanonical(command));
    },
    makeHumanService,
    makeService: () => makeHumanService(),
  };
}
