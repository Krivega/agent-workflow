import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { auditParentProfile } from '../../dist/adapters/codex/nativeAudit.js';
import { startAudit } from '../../dist/client/audit.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';

const nativeCancel = process.argv[2] === '--native-cancel',
  native = nativeCancel || process.argv[2] === '--native';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && native));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = realpathSync(
  mkdtempSync(join(root, native ? 'tmp/temporal-native-audit-' : 'tmp/temporal-audit-')),
);
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-audit-'))),
  artifacts = join(evidence, 'artifacts');
const store = artifactStore(artifacts),
  save = (v) => store.publish(Buffer.from(JSON.stringify(v)));
const read = (ref) => JSON.parse(store.read(ref).toString());
const record = (name, v) =>
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(v), { mode: 0o600 });
const started = Date.now(),
  usage = [],
  events = [],
  histories = [];
function inventory(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return inventory(path);
      assert.ok(entry.isFile());
      const bytes = readFileSync(path);
      return [{ path: path.slice(root.length + 1), bytes: bytes.length, sha256: digest(bytes) }];
    });
}
const source = [...inventory(join(root, 'src')), ...inventory(join(root, 'dist'))];
record('source-before', source);
let environment,
  rpc = null,
  stopped = !native,
  knownSession = null,
  safetyStarts = 0;
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
try {
  mkdirSync(join(workspace, 'tasks'));
  writeFileSync(
    join(workspace, 'RULES.md'),
    'Аудит ограничен неизменяемой карточкой. Он не заменяет техническую приёмку и не закрывает замечания.',
  );
  writeFileSync(
    join(workspace, 'tasks/one.md'),
    'Проверить перенос нативного аудита в Temporal: точный тип auditor, независимая история, gpt-6.2-sol/xhigh, read-only и выключенная сеть, полный LOAD и единственный локатор карточки. Дать направление следующего шага без права приёмки.',
  );
  const project = {
    schemaVersion: 1,
    projectId: 'neutral-audit',
    workspaceId: 'fixture',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'auditor', profile: '.codex/agents/auditor.toml' }],
    checks: ['syntax'],
  };
  mkdirSync(join(workspace, '.codex/agents'), { recursive: true });
  if (native) {
    copyFileSync(
      join(root, '.codex/agents/auditor.toml'),
      join(workspace, project.roles[0].profile),
    );
    mkdirSync(join(workspace, 'procedures'), { recursive: true });
    for (const name of ['audit', 'evidence'])
      copyFileSync(
        join(root, 'procedures', name + '.md'),
        join(workspace, 'procedures', name + '.md'),
      );
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  } else writeFileSync(join(workspace, project.roles[0].profile), 'SDK fixture; no native model');
  const preparation = {
    schemaVersion: 1,
    project,
    taskId: 'one',
    hostId: 'local',
    owner: 'qualification',
    generation: 1,
    revision: 1,
    card: 'tasks/one.md',
  };
  const registration = {
    project,
    workspaceRoot: workspace,
    artifactRoot: artifacts,
    hostId: preparation.hostId,
    owner: preparation.owner,
    generation: 1,
    commands: { syntax: { executable: process.execPath, args: ['--check'] } },
  };
  const version = (path) => {
    const bytes = readFileSync(join(workspace, path));
    return { path, sha256: digest(bytes), bytes: bytes.length };
  };
  const doubt = save({
    kind: 'qualification-risk',
    fact: 'Технический LOAD ранее проверен; содержательный аудит через Workflow ещё не квалифицирован. Эта карточка не является приёмкой миграции.',
  });
  const timing = {
    stage: 'audit-qualification',
    estimateMs: 60000,
    elapsedMs: Date.now() - started,
    externalWaitMs: 0,
    knownElapsedMs: Date.now() - started,
  };
  timing.knownElapsedMs = timing.elapsedMs;
  const card = save({
    schemaVersion: 1,
    kind: 'audit-card',
    preparation,
    goal: version(preparation.card),
    criteria: [
      'Профиль подтверждён первичными native receipts',
      'Единственный содержательный вход — локатор карточки',
      'Аудит не выдаёт техническую приёмку',
    ],
    completed: [doubt],
    openFindings: ['Содержательная граница аудита ещё не подтверждена'],
    checkpoint: 'native-load-qualified',
    timing,
    trigger: { kind: 'doubt', evidence: doubt },
    sources: [version(preparation.card), version('RULES.md')],
    nextAction:
      'Получить направление и следующий проверяемый результат, затем остановить обоих исполнителей',
  });
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      dbFilename: join(evidence, 'temporal.sqlite'),
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: join(root, 'tmp/temporal-downloads'),
      },
    },
  });
  const workflowsPath = join(root, 'dist/workflows/audit.js'),
    queue = 'audit-qualification';
  bindTaskBackendClient(environment.client, registration);
  async function history(handle, label) {
    const h = await handle.fetchHistory();
    histories.push({ workflowId: handle.workflowId, history: h });
    record(label + '-history', h);
  }
  if (native) {
    const binary =
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    assert.equal(
      execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
      'codex-cli ' + auditParentProfile.clientVersion,
    );
    const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
    rpc = new StdioAppServer(
      binary,
      [
        '-c',
        'features.apps=false',
        '-c',
        'features.plugins=false',
        '-c',
        'features.memories=false',
        '-c',
        `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
        'app-server',
        '--stdio',
      ],
      workspace,
      join(evidence, 'rpc.jsonl'),
    );
    rpc.observe((message) => {
      events.push(message);
      if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
    });
    await rpc.initialize();
    const host = await createReaderHost(
      environment.nativeConnection,
      queue,
      workflowsPath,
      [
        {
          registration,
          rpc,
          authority: {
            async verify() {
              throw new Error('No human commands in native audit qualification');
            },
          },
          auditor: true,
        },
      ],
      auditParentProfile,
      join(evidence, 'host'),
      nativeCancel ? 2 : 4,
    );
    await environment.client.connection.withDeadline(Date.now() + 45 * 60000, () =>
      host.runUntil(async () => {
        // Preflight is read-only; the Workflow owns registration, model sends, waits and stop.
        const { auditorActivities } = await import('../../dist/activities/audit.js');
        const { readerBoundary } = await import('../../dist/adapters/codex/readerBoundary.js');
        const { readerExecution } = await import('../../dist/policy/readerExecution.js');
        const preflightService = auditorActivities(
          registration,
          rpc,
          auditParentProfile,
          readerBoundary(
            join(evidence, 'preflight-permissions'),
            store,
            workspace,
            readerExecution(auditParentProfile),
          ),
          join(evidence, 'preflight'),
          () => {
            throw new Error('Preflight must not spend model credit');
          },
          {
            async verify() {
              throw new Error('No human command');
            },
          },
        );
        const preflight = await preflightService.activities.preflightAuditor(preparation),
          input = { schemaVersion: 1, preparation, auditId: 'native', card, preflight };
        record('input', input);
        const handle = await startAudit(environment.client, input, queue);
        if (nativeCancel) {
          await environment.client.connection.withDeadline(Date.now() + 120000, async () => {
            let status = await handle.query('auditStatus');
            while (status.phase !== 'loading') {
              assert.ok(
                !['blocked', 'audited', 'cancelled', 'stop-unknown'].includes(status.phase),
              );
              await new Promise((r) => setTimeout(r, 100));
              status = await handle.query('auditStatus');
            }
            knownSession = status.session;
            const before = (
              await rpc.request('thread/read', { threadId: knownSession.child, includeTurns: true })
            ).thread;
            assert.ok(
              before.turns.some((t) => t.status === 'inProgress'),
              'Cancellation must observe an active native child',
            );
            record('before-cancel', { status, child: before });
            await handle.cancel();
            for (;;) {
              status = await handle.query('auditStatus');
              if (status.phase === 'cancelled') break;
              if (status.phase === 'stop-unknown') {
                assert.equal(safetyStarts, 0, 'Only one reserved safety turn');
                safetyStarts++;
                const response = await rpc.request('turn/start', {
                  threadId: knownSession.parent.id,
                  input: [
                    {
                      type: 'text',
                      text: `Safety stop only. Use native interrupt_agent exactly once with ${JSON.stringify({ target: knownSession.path })}. Never spawn, follow up or use any other tool. Stop after the tool result.`,
                    },
                  ],
                });
                await rpc.completed(
                  knownSession.parent.id,
                  response.turn.id,
                  globalThis.AbortSignal.timeout(60000),
                );
                await handle.signal('auditReconcile');
              }
              await new Promise((r) => setTimeout(r, 100));
            }
          });
        }
        const result = await handle.result();
        record('result', result);
        await history(handle, 'native');
        assert.equal(result.status, nativeCancel ? 'cancelled' : 'audited', JSON.stringify(result));
        assert.equal(read(result.stop).confirmed, true);
        const session = nativeCancel ? knownSession : read(result.manifest).session;
        knownSession = session;
        if (!nativeCancel) assert.equal(read(result.manifest).acceptance, false);
        const parent = (
          await rpc.request('thread/read', { threadId: session.parent.id, includeTurns: true })
        ).thread;
        const child = (
          await rpc.request('thread/read', { threadId: session.child, includeTurns: true })
        ).thread;
        record('parent-primary', parent);
        record('child-primary', child);
        assert.equal(parent.turns.length + child.turns.length, nativeCancel ? 2 + safetyStarts : 4);
        if (nativeCancel) assert.equal(child.turns[0].status, 'interrupted');
        assert.ok(
          [...parent.turns, ...child.turns].every((t) =>
            ['completed', 'failed', 'interrupted'].includes(t.status),
          ),
        );
        stopped = true;
      }),
    );
    assert.equal(existsSync(join(evidence, 'host/host-owner')), false);
  } else {
    const preflight = save({ kind: 'sdk-preflight' });
    const progress = new Map(),
      notifications = [];
    const model = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath,
      activities: {
        async registerAuditor(input) {
          progress.set(input.auditId, 0);
          return preflight;
        },
        async launchAuditor(input) {
          notifications.push(input.auditId + ':launch');
          return {
            parent: { id: 'parent', creation: preflight },
            child: 'child',
            path: '/root/auditor',
            parentTurn: 'load',
          };
        },
        async observeAuditorLoad(input) {
          const n = progress.get(input.auditId);
          progress.set(input.auditId, n + 1);
          if (input.auditId === 'bad-load') throw new Error('primary LOAD missing');
          return n === 0 ? null : preflight;
        },
        async prepareAuditQuestion() {
          return card;
        },
        async answerAuditor() {
          return 'answer';
        },
        async observeAuditAnswer(input) {
          return input.auditId === 'cancel' ? null : preflight;
        },
        async finishAudit(input) {
          return {
            manifest: save({ kind: 'sdk-audit', input }),
            report: {
              coverage: input.auditId === 'partial' ? 'partial' : 'complete',
              direction: input.auditId === 'partial' ? null : 'continue',
            },
          };
        },
      },
    });
    let stopAttempts = 0;
    const control = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue + '.control',
      activities: {
        async stopAuditor(input) {
          notifications.push(input.auditId + ':stop');
          if (input.auditId === 'unknown-stop' && stopAttempts++ < 2)
            throw new Error('stop unknown');
          return save({ kind: 'sdk-stop', confirmed: true });
        },
      },
    });
    await control.runUntil(() =>
      model.runUntil(async () => {
        for (const auditId of ['complete', 'partial', 'bad-load', 'cancel', 'unknown-stop']) {
          const input = { schemaVersion: 1, preparation, auditId, card, preflight },
            handle = await startAudit(environment.client, input, queue);
          if (auditId === 'cancel' || auditId === 'unknown-stop') {
            await environment.client.connection.withDeadline(Date.now() + 60000, async () => {
              while (
                (await handle.query('auditStatus')).phase !==
                (auditId === 'cancel' ? 'auditing' : 'stop-unknown')
              )
                await new Promise((r) => setTimeout(r, 100));
              if (auditId === 'cancel') await handle.cancel();
              else await handle.signal('auditReconcile');
            });
          }
          const result = await handle.result();
          record(auditId + '-result', result);
          await history(handle, auditId);
          assert.equal(
            result.status,
            auditId === 'cancel'
              ? 'cancelled'
              : auditId === 'bad-load' || auditId === 'unknown-stop'
                ? 'blocked'
                : 'audited',
          );
          assert.ok(notifications.includes(auditId + ':stop'));
        }
      }),
    );
  }
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  for (const h of histories)
    await Worker.runReplayHistory({ workflowBundle }, h.history, h.workflowId);
  record('report', {
    status: 'PASS',
    native,
    nativeCancel,
    safetyStarts,
    starts: native ? (nativeCancel ? 2 + safetyStarts : 4) : 0,
    histories: histories.length,
    elapsedMs: Date.now() - started,
    usage,
    acceptance: false,
  });
  const after = [...inventory(join(root, 'src')), ...inventory(join(root, 'dist'))];
  record('source-after', after);
  assert.deepEqual(after, source);
  console.log(
    JSON.stringify({
      status: 'PASS',
      evidence,
      native,
      nativeCancel,
      safetyStarts,
      starts: native ? (nativeCancel ? 2 + safetyStarts : 4) : 0,
      histories: histories.length,
    }),
  );
} catch (error) {
  record('failure', { error: String(error), stack: error.stack });
  if (rpc !== null) {
    try {
      const ids = [
        ...new Set(
          events.filter((e) => e.method === 'thread/started').map((e) => e.params.thread.id),
          ...(knownSession === null ? [] : [knownSession.parent.id, knownSession.child]),
        ),
      ];
      const primary = [];
      for (const id of ids)
        primary.push(
          (await rpc.request('thread/read', { threadId: id, includeTurns: true })).thread,
        );
      const parent = primary.find((t) => t.parentThreadId === null);
      for (const t of primary.filter((t) => t.parentThreadId === null))
        for (const turn of t.turns.filter((v) => v.status === 'inProgress')) {
          await rpc.request('turn/interrupt', { threadId: t.id, turnId: turn.id });
          await rpc.completed(t.id, turn.id, globalThis.AbortSignal.timeout(30000));
        }
      let emergency = false;
      for (const t of primary.filter((t) => t.parentThreadId !== null)) {
        const current = (await rpc.request('thread/read', { threadId: t.id, includeTurns: true }))
          .thread;
        if (current.turns.some((v) => v.status === 'inProgress')) {
          assert.ok(parent && safetyStarts === 0, 'At most one reserved safety parent turn');
          safetyStarts++;
          emergency = true;
          const safety = await rpc.request('turn/start', {
            threadId: parent.id,
            input: [
              {
                type: 'text',
                text: `Use native interrupt_agent exactly once for existing auditor ${t.id}. Safety stop only. No spawn, followup or other tool. Stop after the tool result.`,
              },
            ],
          });
          await rpc.completed(parent.id, safety.turn.id, globalThis.AbortSignal.timeout(60000));
        }
      }
      const final = [];
      for (const id of ids) {
        const t = (await rpc.request('thread/read', { threadId: id, includeTurns: true })).thread;
        assert.ok(t.turns.every((v) => ['completed', 'failed', 'interrupted'].includes(v.status)));
        final.push(t);
      }
      stopped = true;
      record('safety-stop', { emergency, primary: final });
    } catch (stopError) {
      record('stop-unknown', { error: String(stopError) });
    }
  }
  throw error;
} finally {
  record('usage-events', usage);
  if (native) record('native-events', events);
  rpc?.close();
  await environment?.teardown();
  if (stopped) rmSync(workspace, { recursive: true, force: true });
  record('cleanup', { stopped, workspaceRemoved: stopped });
}
