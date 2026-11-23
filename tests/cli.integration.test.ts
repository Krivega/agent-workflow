import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileProjectManifestReader } from '../adapters/project/fileProjectManifestReader.js';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { vi } from 'vitest';
import type { WorkflowHandle } from '@temporalio/client';
import type { HumanManagedTaskInput } from '../src/contracts/localTask.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type {
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanExecutionCheckpoint,
} from '../src/contracts/taskHuman.js';
import type { TaskExecutionCompletion } from '../src/contracts/taskExecution.js';
import { digest } from '../src/adapters/artifacts/files.js';
import { taskHumanCommandText } from '../src/policy/taskHuman.js';
import { preparedTaskCliFixture } from './temporal/preparedTaskCliFixture.js';

const directories: string[] = [];
const manifest = { engines: { node: '>=26.0.0' }, scripts: { validate: 'must never execute' } };
async function project(content: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-workflow-aw1-'));
  directories.push(root);
  await writeFile(resolve(root, 'package.json'), content);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('reads the actual file without modifying it and propagates parse/read errors', async () => {
  const content = JSON.stringify(manifest);
  const root = await project(content);
  expect(await fileProjectManifestReader.read(root)).toEqual(manifest);
  expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(content);
  await writeFile(resolve(root, 'package.json'), '{broken');
  await expect(fileProjectManifestReader.read(root)).rejects.toThrow(SyntaxError);
  await rm(resolve(root, 'package.json'));
  await expect(fileProjectManifestReader.read(root)).rejects.toThrow('ENOENT');
});

it('runs the real CLI in a separate process from another working directory', async () => {
  const root = await project(JSON.stringify(manifest));
  const cli = resolve('cli/main.ts');
  const tsx = import.meta.resolve('tsx');
  const output = execFileSync(process.execPath, ['--import', tsx, cli, 'inspect-project'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(JSON.parse(output)).toEqual({
    scope: 'configuration-only',
    nodeRange: manifest.engines.node,
    validation: { command: 'yarn validate', script: manifest.scripts.validate },
  });
  expect(() =>
    execFileSync(process.execPath, ['--import', tsx, cli, 'start'], {
      cwd: root,
      stdio: 'pipe',
    }),
  ).toThrow(expect.objectContaining({ status: 2 }));
  await writeFile(resolve(root, 'package.json'), '{}');
  expect(() =>
    execFileSync(process.execPath, ['--import', tsx, cli, 'inspect-project'], {
      cwd: root,
      stdio: 'pipe',
    }),
  ).toThrow(expect.objectContaining({ status: 1 }));
});

it('discovers task chat through both entry points without a project registration', async () => {
  const root = await project('{}');
  for (const entry of [
    ['cli/entry.mjs'],
    ['--import', import.meta.resolve('tsx'), resolve('cli/main.ts')],
  ]) {
    const prefix = entry.map((arg) => (arg === 'cli/entry.mjs' ? resolve(arg) : arg));
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [...prefix, ...args], { cwd: root, encoding: 'utf8' });
    expect(run('--help')).toContain('task-chat --help');
    const help = run('task-chat', '--help');
    expect(help).toContain(
      'task-chat start --temporal-input <input12.json> --temporal-registration <registration.json>',
    );
    expect(help).toContain('task-chat preview');
    expect(help).toContain('task-chat status');
    expect(help).toContain('task-chat result');
    expect(help).toContain('с --state');
  }
});

it.each([
  [
    'temporal',
    ['--temporal-registration', '../registration.json'],
    'task-chat-temporal-input-required',
  ],
  ['temporal', ['--temporal-input', 'input.json'], 'task-chat-temporal-input-required'],
  ['temporal', ['--temporal-input'], 'task-chat-temporal-input-required'],
  [
    'temporal',
    ['--state', '../run', '--card', 'task.md', '--plan', 'proposal.md'],
    'task-chat-temporal-input-required',
  ],
  [
    'blocked',
    ['--temporal-input', 'input.json', '--temporal-registration', '../registration.json'],
    'backend-new-tasks-blocked',
  ],
  [
    'temporal',
    ['--temporal-input', 'input.json', '--temporal-registration', 'input.json'],
    'task-chat-temporal-registration-private',
  ],
] as const)(
  'refuses Temporal starts through the package bin without effects: %s %j',
  async (newTasks, args, reason) => {
    const outside = await mkdtemp(resolve(tmpdir(), 'agent-workflow-task-chat-bin-'));
    directories.push(outside);
    const root = resolve(outside, 'project');
    await mkdir(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    declareBackendFixture(root);
    const backend = resolve(root, '.git/agent-workflow');
    await mkdir(backend);
    const policy = resolve(backend, 'backend-policy.json');
    const policyBytes = JSON.stringify({
      schemaVersion: 2,
      newTasks,
      startAdmission: 'task-start-admission/1',
    });
    await writeFile(policy, policyBytes);
    await writeFile(resolve(root, 'input.json'), '{}');
    await writeFile(resolve(outside, 'registration.json'), '{}', { mode: 0o600 });
    await writeFile(resolve(outside, 'codex'), '#!/bin/sh\nprintf "called\\n" > "$0.called"\n', {
      mode: 0o700,
    });
    const socketLog = resolve(outside, 'connection.called');
    const preload =
      'data:text/javascript,' +
      encodeURIComponent(`
    import { appendFileSync } from 'node:fs';
    import { Socket } from 'node:net';
    import { tmpdir, userInfo } from 'node:os';
    import { join } from 'node:path';
    const loaderSocket = join(tmpdir(), 'tsx-' + (process.geteuid?.() ?? userInfo().username), process.ppid + '.pipe');
    const { registerHooks } = await import('node:module');
    registerHooks({load(url, context, next) {
      if (['/cli/legacyTaskChatCommand.', '/application/', '/adapters/storage/'].some(part => url.includes(part)))
        throw new Error('Temporal start loaded a Legacy module: ' + url);
      return next(url, context);
    }});
    const connect = Socket.prototype.connect;
    Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options === loaderSocket || options?.path === loaderSocket) return connect.apply(this, args);
      appendFileSync(${JSON.stringify(socketLog)}, 'called\\n');
      throw new Error('unexpected connection');
    };
  `);
    const result = spawnSync(
      process.execPath,
      ['--import', preload, resolve('cli/entry.mjs'), 'task-chat', 'start', ...args],
      {
        cwd: root,
        env: { ...process.env, PATH: outside + delimiter + process.env.PATH },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(reason);
    const diagnostic = JSON.parse(result.stdout) as { next_action: string };
    expect(diagnostic).toMatchObject({ status: 'refused', reason });
    expect(diagnostic.next_action).toContain(
      '--temporal-input <input12.json> --temporal-registration <registration.json>',
    );
    expect((await readdir(outside)).sort()).toEqual(['codex', 'project', 'registration.json']);
    expect((await readdir(root)).sort()).toEqual([
      '.agent-workflow-backend.json',
      '.git',
      'input.json',
    ]);
    expect(await readdir(backend)).toEqual(['backend-policy.json']);
    expect(await readFile(policy, 'utf8')).toBe(policyBytes);
    expect(await readFile(resolve(root, 'input.json'), 'utf8')).toBe('{}');
    expect(await readFile(resolve(outside, 'registration.json'), 'utf8')).toBe('{}');
  },
);

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../cli/entry.mjs', import.meta.url));
const workflowsPath = fileURLToPath(new URL('../dist/workflows/localTask.js', import.meta.url));
const executable = fileURLToPath(
  new URL('../tmp/temporal-downloads/temporal-v1.9.1', import.meta.url),
);
const queue = 'prepared-task-cli';
const human = 'Владелец подтверждает результат';
const card = [
  '# Задача',
  '',
  '## Критерии приёмки',
  '',
  '- [ ] K1: Проверить вычисление',
  '- [ ] ' + human,
  '',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function cli(
  f: Awaited<ReturnType<typeof preparedTaskCliFixture>>,
  args: string[],
  code = 0,
) {
  const { stdout, status } = await exec(process.execPath, [entry, 'task-chat', ...args], {
    cwd: f.workspace,
    timeout: 10000,
    env: { ...process.env, CODEX_HOME: f.root, CODEX_THREAD_ID: f.threadId },
  }).then(
    ({ stdout }) => ({ stdout, status: 0 }),
    ({ stdout, code }: { stdout: string; code: unknown }) => ({ stdout, status: code }),
  );
  expect(status).toBe(code);
  return JSON.parse(stdout) as Record<string, unknown>;
}

it('previews from the package bin and refuses a changed registration before reserving', async () => {
  const f = await preparedTaskCliFixture(card, human);
  const registration = join(f.root, 'private registration.json');
  const input = join(f.root, 'input12.json');
  writeFileSync(input, JSON.stringify(f.input), { mode: 0o600 });
  writeFileSync(registration, JSON.stringify(f.config), { mode: 0o600 });
  const flags = ['--temporal-input', input, '--temporal-registration', registration];
  const before = readdirSync(f.config.registration.artifactRoot).sort();
  const preview = await cli(f, ['preview', ...flags]);
  expect(preview).toMatchObject({ status: 'preview', summary: { workspaceRoot: f.workspace } });
  expect(await cli(f, ['preview', ...flags])).toEqual(preview);
  writeFileSync(registration, JSON.stringify({ ...f.config, taskQueue: 'changed-queue' }));
  const start = await cli(
    f,
    ['start', ...flags, '--preview-digest', String(preview.previewDigest)],
    1,
  );
  expect(start).toMatchObject({ status: 'refused', reason: 'task-chat-temporal-preview-changed' });
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
  expect(readdirSync(f.config.registration.artifactRoot).sort()).toEqual(before);
});

async function phase(handle: WorkflowHandle, expected: string, formerRun?: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await handle.query<{ phase: string; runId: string }>('localTaskStatus');
    if (value.phase === expected && value.runId !== formerRun) return value.runId;
    await delay(100);
  }
  throw Error('Expected Workflow phase ' + expected);
}

it('previews, starts and reads registered Input12 against a local Temporal service', async () => {
  const success = await preparedTaskCliFixture(card, human, 'success');
  const cancelled = await preparedTaskCliFixture(card, human, 'cancelled');
  const cases = new Map([
    ['success', success],
    ['cancelled', cancelled],
  ]);
  const task = (input: HumanManagedTaskInput) => cases.get(input.admission.preparation.taskId)!;
  const environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      executable: { type: 'existing-path', path: executable },
      dbFilename: join(success.root, 'temporal-cli.sqlite'),
      extraArgs: ['--dynamic-config-value', 'limit.historyCount.suggestContinueAsNew=40'],
    },
  });
  const paths = (f: typeof success) => {
    const registration = join(f.root, 'private registration.json');
    const input = join(f.root, 'input12.json');
    writeFileSync(input, JSON.stringify(f.input), { mode: 0o600 });
    writeFileSync(
      registration,
      JSON.stringify({
        ...f.config,
        address: environment.address,
        namespace: environment.client.options.namespace,
        taskQueue: queue,
      }),
      { mode: 0o600 },
    );
    return {
      registration,
      flags: ['--temporal-input', input, '--temporal-registration', registration],
    };
  };
  const successful = paths(success);
  const cancelledTask = paths(cancelled);
  const active = (f: typeof success, id: string) => (action: 'status' | 'result') =>
    cli(f, [
      action,
      '--workflow-id',
      id,
      '--temporal-registration',
      join(f.root, 'private registration.json'),
    ]);
  const ref = (input: HumanManagedTaskInput) => task(input).proof;
  let passBaseline = false;
  const controls = {
    prepareTaskExecution: ref,
    prepareTaskHuman: (input: HumanManagedTaskInput) => task(input).admitted.manifest,
    captureTaskExecutionBudget: (input: HumanManagedTaskInput) => ({
      limit: 15,
      used: 0,
      manifest: ref(input),
    }),
    stopLocalTask: ref,
    holdTaskExecution: (input: HumanManagedTaskInput) => ({ status: 'held', held: ref(input) }),
    finishTaskHuman: ({ input }: TaskHumanCommandContext) => ({
      status: 'done',
      result: ref(input),
      projection: ref(input),
    }),
    verifyTaskHumanCommand: ({ input }: TaskHumanCommandContext, command: TaskHumanCommand) => ({
      kind: 'verified-task-human-command',
      action: command.action,
      command,
      ...(command.action === 'DECIDE' ? { accepted: command.accepted } : {}),
      proof: ref(input),
    }),
    saveTaskHumanCheckpoint: (checkpoint: TaskHumanExecutionCheckpoint) =>
      task(checkpoint.input).save(checkpoint),
    loadTaskHumanCheckpoint: (input: HumanManagedTaskInput, checkpoint: ArtifactRef) =>
      JSON.parse(task(input).store.read(checkpoint).toString()) as TaskHumanExecutionCheckpoint,
  };
  const instructions = (input: HumanManagedTaskInput, reviewId: string) => ({
    schemaVersion: 1,
    preparation: input.admission.preparation,
    request: ref(input),
    reviewId,
  });

  const closed: { f: typeof success; workflowId: string; status: string; evidence: object }[] = [];
  try {
    const control = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue + '.control',
      activities: controls,
    });
    await control.runUntil(async () => {
      const main = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: queue,
        workflowBundle: await bundleWorkflowCode({ workflowsPath }),
        activities: {
          prepareSubstantialPlanning: (input: HumanManagedTaskInput) =>
            instructions(input, 'planning'),
          prepareReviewPlan: ({ request }: { request: ArtifactRef }) => ({
            manifest: request,
            decisions: [],
          }),
          finishReview: ({ plan }: { plan: ArtifactRef }) => ({ complete: true, manifest: plan }),
          prepareLocalTask: ref,
          async checkLocalTask(
            input: HumanManagedTaskInput,
            _snapshot: ArtifactRef,
            stage: string,
          ) {
            while (stage === 'baseline' && !passBaseline) {
              heartbeat();
              await delay(50, undefined, { signal: cancellationSignal() });
            }
            return { status: 'PASS', manifest: ref(input) };
          },
          writeLocalTask: (input: HumanManagedTaskInput) => ({
            session: 'fixture',
            answer: ref(input),
            stop: ref(input),
            tree: ref(input),
          }),
          planLocalIntegration: ref,
          integrateLocalTask: ref,
          prepareLocalAcceptance: (input: HumanManagedTaskInput) =>
            instructions(input, 'acceptance'),
        },
      });
      await main.runUntil(async () => {
        for (const [f, files, status] of [
          [success, successful, 'done'],
          [cancelled, cancelledTask, 'cancelled'],
        ] as const) {
          passBaseline = false;
          const before = readdirSync(f.config.registration.artifactRoot).sort();
          const preview = await cli(f, ['preview', ...files.flags]);
          expect(preview).toMatchObject({
            status: 'preview',
            summary: { workspaceRoot: f.workspace, gaps: { withoutReviewerCount: 1 } },
          });
          expect(await cli(f, ['preview', ...files.flags])).toEqual(preview);
          expect(readdirSync(f.config.registration.artifactRoot).sort()).toEqual(before);
          expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);

          const start = [
            'start',
            ...files.flags,
            '--preview-digest',
            String(preview.previewDigest),
          ];
          const accepted = await cli(f, start);
          const workflowId = `aw/task/neutral/${f.input.admission.preparation.taskId}`;
          expect(accepted).toMatchObject({
            status: 'accepted',
            workflowId,
          });
          expect(accepted.next_action).toContain(workflowId);
          const handle = environment.client.workflow.getHandle(workflowId);
          const firstRun = await phase(handle, 'baseline');
          const read = active(f, workflowId);
          expect(await read('status')).toMatchObject({
            status: 'running',
            phase: 'baseline',
            runId: firstRun,
          });
          passBaseline = true;
          const runId = await phase(handle, 'waiting-human-gates', firstRun);
          const pending = await read('result');
          expect(pending).toMatchObject({
            status: 'pending',
            reason: 'task-human-decision-required',
            runId,
          });
          const assignment = join(
            f.home,
            'backend-assignments/neutral',
            f.input.admission.preparation.taskId + '.json',
          );
          const prior = readFileSync(assignment);
          expect(await read('result')).toEqual(pending);
          expect(readFileSync(assignment)).toEqual(prior);
          if (status === 'cancelled') await handle.cancel();
          else {
            for (const action of ['ASK', 'DECIDE'] as const) {
              const { state } = await handle.query<TaskHumanCommandContext>('taskHumanState');
              const command: TaskHumanCommand = {
                action,
                ...(action === 'DECIDE' ? { accepted: true } : {}),
                schemaVersion: 1,
                commandId: action.toLowerCase(),
                hash: '0'.repeat(64),
                target: state.current.manifest.target,
                manifest: state.current.ref,
                expectedRevision: state.revision,
                author: f.config.registration.owner,
                source: f.proof,
                questionId: 'question',
                criterionId: human,
              } as TaskHumanCommand;
              command.hash = digest(taskHumanCommandText(command));
              await handle.executeUpdate('taskHuman', { args: [command] });
            }
          }
          expect(((await handle.result()) as TaskExecutionCompletion).status).toBe(status);
          closed.push({
            f,
            workflowId,
            status,
            evidence:
              status === 'done' ? { result: f.proof, projection: f.proof } : { stop: f.proof },
          });
        }
      });
    });
    for (const { f, workflowId, status, evidence } of closed)
      expect(await active(f, workflowId)('result')).toMatchObject({ status, workflowId, evidence });
    expect(
      await cli(
        success,
        [
          'status',
          '--workflow-id',
          'aw/task/neutral/missing',
          '--temporal-registration',
          successful.registration,
        ],
        1,
      ),
    ).toMatchObject({ status: 'not-found' });
  } finally {
    passBaseline = true;
    await environment.teardown();
  }
  expect(
    await cli(
      success,
      [
        'status',
        '--workflow-id',
        'aw/task/neutral/missing',
        '--temporal-registration',
        successful.registration,
      ],
      1,
    ),
  ).toMatchObject({ status: 'unavailable' });
}, 60_000);
