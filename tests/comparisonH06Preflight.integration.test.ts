import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { vi, afterEach, expect, it } from 'vitest';
import { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { type AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { TransportJournal } from '../adapters/codex/transportJournal.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { FileCoderWorkspaces } from '../adapters/project/coderWorkspaces.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import {
  type CoderDependencies,
  cancelCoder,
  integrateCoder,
  launchCoder,
  runCoder,
  startCoder,
} from '../application/coderWorkflow.js';
import { taskChatGates } from '../cli/taskChatInputs.js';
import { type CoderBrief, type CoderRun } from '../core/coder.js';
import { type TechnicalState } from '../core/evidence.js';
import { requiredProcedures, selectedProcedures, type RunSpec } from '../core/localRun.js';
import { object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  consumeH06DelegatedAuthority,
  h06DelegatedPhaseAction,
  openH06DelegatedPhaseLedger,
  planH06AutonomousGrant,
  type H06DelegatedInput,
  type H06DelegatedStage,
} from './comparisonH06DelegatedAuthority.js';
import { planH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import {
  prepareH06DelegatedLegacy,
  applyH06DelegatedLegacyControl,
} from './comparisonH06DelegatedLegacy.js';
import { startH06NativeVariant } from './comparisonH06Native.js';
import { grant, signed } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { restoreStore } from '../adapters/storage/storeBackup.js';
import { verifyH06RetainedWarmContinuation } from './comparisonH06RetainedWarmContinuation.js';

type PreflightCleanup = Array<() => void | Promise<void>>;
type NativeRow = { type: string; payload: Record<string, unknown> };
const event = (type: string, fields: Record<string, unknown> = {}): NativeRow => ({
  type: 'event_msg',
  payload: { type, ...fields },
});
const session = (id: string, cwd: string): NativeRow => ({
  type: 'session_meta',
  payload: {
    id,
    session_id: id,
    cwd,
    cli_version: '0.166.0-alpha.6',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  },
});

/** Only native primary-source records and model RPC responses are fixtures. */
async function h06PreflightFixture(cleanups: PreflightCleanup) {
  const f = await workflowFixture(),
    root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-preflight-'));
  cleanups.push(f.dispose, () => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  const evidenceRoot = join(root, 'task'),
    sessionsRoot = join(root, 'sessions'),
    chat = join(root, 'controller');
  mkdirSync(sessionsRoot);
  mkdirSync(chat);
  vi.stubEnv('CODEX_HOME', root);
  const pin = (name: string, value: unknown): H04Pin => {
    const path = join(root, name),
      bytes = typeof value === 'string' ? value : canonical(value) + '\n';
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes) };
  };
  const assets = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, content] of Object.entries(assets.cases.find(({ id }) => id === 'H-06')!.files))
    await f.file(name, content);
  await f.file(
    'tools/agent-workflow/roles/coder.md',
    await readFile(new URL('../roles/coder.md', import.meta.url), 'utf8'),
  );
  const connection = await new FileTaskConnection(f.root).preview(
    'connection.json',
    f.card.locator,
    'task',
  );
  await f.file(f.card.locator, connection.after);
  await f.file(
    'planning.json',
    canonical({ schema_version: 1, task_id: 'task', council: f.council('planning') }),
  );
  const spec: RunSpec = {
    ...f.spec,
    identity: { task_id: 'task', card: await f.ref(f.card.locator) },
    host_id: 'local',
    session_id: 'owner',
    requested: { ...f.spec.requested, permissions: [...f.spec.requested.permissions, 'implement'] },
    route: { kind: 'substantial', accepted_plan: await f.ref('planning.json') },
  };
  const context = (turn_id: string, cwd = f.root): NativeRow => ({
    type: 'turn_context',
    payload: {
      turn_id,
      cwd,
      model: spec.requested.model,
      effort: spec.requested.effort,
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
    },
  });
  const rules = [await f.ref('AGENTS.md'), await f.ref('tools/agent-workflow/roles/coder.md')],
    procedures = spec.procedures.filter(({ id }) =>
      requiredProcedures('role', 'coder').includes(id),
    );
  const files = await Promise.all(
    [
      ...new Set([
        'source.txt',
        ...rules.map(({ locator }) => locator),
        ...procedures.map(({ locator }) => locator),
      ]),
    ].map(f.ref),
  );
  const briefCard = await f.ref(f.card.locator),
    briefAuthority = await f.ref('planning.json');
  const brief = (id: string): CoderBrief => ({
    id,
    project_id: 'project',
    task_id: 'task',
    parent_run_id: 'run',
    parent_session_id: 'owner',
    generation: 1,
    card: briefCard,
    authority: briefAuthority,
    source_root: f.root,
    copy_root: join(evidenceRoot, 'coder-workspaces', id),
    paths: ['source.txt'],
    files,
    rules,
    procedures,
    goal: 'Change source.txt inside the fixture copy',
    criterion: 'Only source.txt changes',
    checks: [],
    profile: { model: spec.requested.model, effort: spec.requested.effort },
  });
  const preparation = pin('preparation.json', {
    kind: 'comparison-h06-native-legacy-preparation/2',
    descriptor: 'connection.json',
    planningFile: 'planning.json',
    marker: 'preflight-load',
    spec,
    gates: taskChatGates(spec.criteria, [spec.criteria[0]!]),
  });
  const warm = pin('warm.json', brief('first')),
    cold = pin('cold.json', brief('second')),
    final = pin('final.json', brief('third'));
  const config = pin('config.json', { preparation, warm, cold, final });
  const loader = {
    path: realpathSync(resolve('node_modules/tsx/dist/loader.mjs')),
    sha256: digest(readFileSync(resolve('node_modules/tsx/dist/loader.mjs'))),
  };
  const runner = pin(
    'warm runner.mjs',
    '// Fixture primary launch identity; model runtime is not started.\n',
  );
  const request = {
    kind: 'comparison-h06-native/2' as const,
    binding: {
      operationId: 'task',
      variant: 'legacy' as const,
      workspaceRoot: f.root,
      node: { path: process.execPath, sha256: digest(readFileSync(process.execPath)) },
      timeoutMs: 2000,
    },
    evidenceRoot,
    chat: { threadId: 'controller', workspace: chat },
    budget: {
      maxElapsedMs: 300000,
      reserveMs: 120000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: 20000 },
    appServer: pin('app-server', 'Never spawned'),
    server: null,
    bootstrap: pin('bootstrap.json', {
      kind: 'comparison-h06-native-legacy-bootstrap/2',
      projectId: 'project',
      runId: 'run',
      actorId: 'owner',
      generation: 1,
      permissions: grant.permissions,
    }),
    runtime: [preparation, warm, cold, final, config, loader, runner],
  };
  const attempt = pin('attempt.json', request),
    proposal = planH06AutonomousGrant(attempt);
  const rootPath = join(sessionsRoot, 'rollout-controller.jsonl'),
    transcript = join(sessionsRoot, 'rollout-owner.jsonl');
  const rootRows: NativeRow[] = [
    session('controller', chat),
    event('task_started', { turn_id: 'root-turn' }),
    context('root-turn', chat),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: proposal.expectedGrantText }],
      },
    },
  ];
  const actorRows: NativeRow[] = [session('owner', f.root)];
  const flush = () => {
    writeFileSync(rootPath, rootRows.map(canonical).join('\n') + '\n');
    writeFileSync(transcript, actorRows.map(canonical).join('\n') + '\n');
  };
  flush();
  const source = {
    transcript: rootPath,
    turnId: 'root-turn',
    source: { locator: rootPath + '#L4', hash: digest(canonical(rootRows[3]) + '\n') },
  };
  const input: H06DelegatedInput = {
    kind: 'comparison-h06-delegated-legacy/1',
    attempt,
    source,
    budgetSource: { attempt, source },
    normalization: {
      kind: 'root-operator-normalization/1',
      decision: 'autonomous-legacy-warm-cold-completion',
    },
  };
  vi.stubEnv('CODEX_THREAD_ID', 'controller');
  const claim = consumeH06DelegatedAuthority(input),
    ledger = openH06DelegatedPhaseLedger(claim.receipt);
  vi.stubEnv('CODEX_THREAD_ID', 'owner');
  initializeStore(join(evidenceRoot, 'legacy-store'), grant.context);
  const store = new SqliteEvidenceStore(join(evidenceRoot, 'legacy-store'), grant, Date.now);
  unwrap(
    store.execute(
      signed({ type: 'claim', lease_until: Date.now() + 300000 }, 0, 0, 'preflight-owner'),
    ),
  );
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
  const persistence = {
    execute: async (value: Parameters<typeof store.execute>[0]) => store.execute(value),
  };
  const backup = (value: TechnicalState, operation: string) =>
    backupSupervision(persistence, store.root, evidenceRoot, grant, value, operation);
  const journal = new TaskWorkflowJournal(persistence, grant.context, 1, true, backup),
    runs = new TaskLocalRuns(persistence, grant.context, 1, true, backup);
  const chatJournal = new TaskChatContext(persistence, grant.context, 1);
  async function admit(stage: H06DelegatedStage) {
    const current = stage === 'load' ? null : await chatJournal.read(),
      history = ledger.inspect().phases;
    const phase = {
      stage,
      nonce: 'preflight-' + stage,
      rootThread: 'controller',
      actorThread: 'owner',
      requestHash: claim.requestHash,
      generation: 1,
      storeRevision: state().revision,
      controlRevision: current?.control?.revision ?? 0,
      requirementsRevision: current?.messages?.requirements_revision ?? 0,
      predecessor: history.at(-1)?.outcome ?? null,
    };
    const intent = ledger.admitPhase(phase),
      command = {
        kind: 'comparison-h06-delegated-command/1',
        nonce: phase.nonce,
        requestHash: claim.requestHash,
        action: h06DelegatedPhaseAction(stage),
        target: {
          claim: claim.receipt,
          intent,
          stage,
          generation: 1,
          storeRevision: phase.storeRevision,
          controlRevision: phase.controlRevision,
          requirementsRevision: phase.requirementsRevision,
        },
      };
    const prompt = 'Fixture delivery only\n' + canonical(command),
      turn = 'actor-' + stage,
      envelope =
        '<codex_delegation>\n  <source_thread_id>controller</source_thread_id>\n  <input>' +
        prompt +
        '</input>\n</codex_delegation>';
    rootRows.push(
      event('item_completed', {
        thread_id: 'controller',
        turn_id: 'root-turn',
        item: {
          type: 'McpToolCall',
          id: 'call-' + phase.nonce,
          server: 'codex_app',
          tool: 'send_message_to_thread',
          arguments: { threadId: 'owner', prompt },
          status: 'completed',
          result: { isError: false, content: [{ type: 'text', text: '{"threadId":"owner"}' }] },
        },
      }),
    );
    actorRows.push(
      event('task_started', { turn_id: turn }),
      context(turn),
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: 'delivery-' + phase.nonce,
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output: envelope,
          internal_chat_message_metadata_passthrough: { turn_id: turn },
        },
      },
      event('item_completed', {
        thread_id: 'owner',
        turn_id: turn,
        item: {
          type: 'FunctionCallOutput',
          id: 'delivery-' + phase.nonce,
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output: envelope,
        },
      }),
    );
    flush();
    const deliveryInput = {
      kind: 'comparison-h06-delegated-delivery/1',
      sessionsRoot,
      root: { threadId: 'controller', workspace: chat, turnId: 'root-turn', user: source.source },
      actor: { threadId: 'owner', workspace: f.root },
      command,
      prompt,
    };
    const delivery = pin(phase.nonce + '-delivery.json', planH06DelegatedDelivery(deliveryInput));
    return {
      claim: claim.receipt,
      phase: intent,
      delivery,
      input: preparation,
      descriptor: 'connection.json',
      turn,
      admitted: phase,
      deliveryInput,
    };
  }
  function settle(ticket: Awaited<ReturnType<typeof admit>>, result: H04Pin) {
    return ledger.settlePhase(
      pin(ticket.admitted.stage + '-outcome.json', {
        kind: 'h06-delegated-phase-outcome/1',
        claim: claim.receipt,
        intent: ticket.phase,
        stage: ticket.admitted.stage,
        status: 'confirmed',
        delivery: ticket.delivery,
        result,
      }),
    );
  }
  function load(turn: string, marker: string) {
    actorRows.push(
      event('item_completed', {
        thread_id: 'owner',
        turn_id: turn,
        item: {
          type: 'CommandExecution',
          id: marker,
          cwd: f.root,
          status: 'completed',
          exit_code: 0,
          aggregated_output: [...spec.rules, ...spec.procedures]
            .map(({ locator, hash }) =>
              canonical({
                chat_read: marker,
                locator,
                hash,
                content: readFileSync(join(f.root, locator), 'utf8'),
              }),
            )
            .join('\n'),
        },
      }),
    );
    flush();
  }
  const ticket = await admit('load');
  load(ticket.turn, 'preflight-load');
  const initialFailure = (
    await startH06NativeVariant(request.binding, evidenceRoot, async (failure) => failure)
  ).initialFailure;
  const prepared = await prepareH06DelegatedLegacy({ ...ticket, initialFailure }, () => {});
  const loadResult = pin('load-result.json', {
    kind: 'h06-delegated-load-result/1',
    claim: ticket.claim,
    phase: ticket.phase,
    delivery: ticket.delivery,
    prepared,
    qualification: false,
  });
  settle(ticket, loadResult);
  const packet = pin('load-packet.json', {
    claim: claim.receipt,
    phase: ticket.phase,
    config,
    initialFailure,
    deliveryInput: ticket.deliveryInput,
  });
  const argv = process.argv,
    execArgv = process.execArgv;
  process.argv = [process.execPath, runner.path, 'warm', packet.path];
  process.execArgv = ['--import', loader.path];
  cleanups.push(() => {
    process.argv = argv;
    process.execArgv = execArgv;
  });
  const quote = (value: string) =>
    /^[a-zA-Z0-9_./:=+-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
    .map(quote)
    .join(' ');
  actorRows.push(
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'own-warm',
        name: 'exec',
        input:
          'text(await tools.exec_command({cmd:' +
          JSON.stringify(command) +
          ',tty:true,yield_time_ms:1000}));',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'own-warm',
        output: [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: JSON.stringify({ session_id: 56810, output: '' }) },
        ],
      },
    },
    event('task_complete', { turn_id: ticket.turn }),
  );
  flush();
  const workspaces = new FileCoderWorkspaces(f.root, evidenceRoot, async (value, phase) => {
    const current = (await journal.read()).coders?.[value.id];
    requireContract(
      phase === null ? current === undefined : current?.status === phase,
      'preflight-coder-authority',
    );
  });
  return {
    f,
    root,
    evidenceRoot,
    store,
    claim,
    state,
    runs,
    journal,
    chatJournal,
    brief,
    pin,
    admit,
    settle,
    load,
    actorRows,
    flush,
    transcript,
    workspaces,
    loader,
    packet,
  };
}

/** Real adapters/process ownership; the single substituted boundary is model-facing RPC. */
async function preflightCoderRuntime(
  f: Awaited<ReturnType<typeof h06PreflightFixture>>,
  id: string,
  cleanups: PreflightCleanup,
  complete = false,
) {
  const processes = new NativeWriterProcesses();
  const runtime = spawn(
    process.execPath,
    [
      '-e',
      `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>process.send({pid:child.pid}));
    setInterval(()=>{},1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = once(runtime, 'exit');
  cleanups.push(async () => {
    if (runtime.exitCode === null && runtime.signalCode === null) {
      const tree = await processes.descendants([runtime.pid!]);
      if (tree.length > 0) await processes.terminate(tree);
    }
    await exited;
  });
  const [message] = (await once(runtime, 'message')) as [{ pid: number }];
  const tree = await processes.descendants([runtime.pid!]),
    identity = tree.find(({ pid }) => pid === runtime.pid)!;
  const child = tree.find(({ pid }) => pid === message.pid)!;
  requireContract(identity !== undefined && child !== undefined, 'preflight-child-missing');
  const directory = join(f.evidenceRoot, 'coders', id);
  await mkdir(directory, { recursive: true });
  const journalPath = join(directory, 'transport.jsonl'),
    transcript = join(directory, 'native.jsonl');
  const transport = new TransportJournal(journalPath, 'coder:' + id + ':create');
  const policy = f.pin(id + '-policy.json', {
    kind: 'fixture RPC only; real local process tree',
    runtime: identity,
  });
  const policyRef = { locator: policy.path, hash: policy.sha256 };
  const turns: Record<string, unknown>[] = [],
    contexts: NativeRow[] = [];
  const counts = {
    starts: 0,
    turns: 0,
    interrupts: 0,
    modelCalls: 0,
    temporalServices: 0,
    nativeServices: 0,
  };
  let serial = 0,
    response: Record<string, unknown>;
  const current = async (): Promise<CoderRun> => {
    const run = (await f.journal.read()).coders?.[id];
    requireContract(run !== undefined, 'preflight-coder-missing');
    return run;
  };
  const thread = () => ({ ...object(response.thread), turns: structuredClone(turns) });
  const rpc: AppServerRpc = {
    completed: async (_session, turn) => {
      turns.find(({ id }) => id === turn)!.status = 'completed';
    },
    request: async (method, params) => {
      const request = { id: ++serial, method, params };
      transport.write('send', request, JSON.stringify(request));
      const run = await current();
      let result: unknown;
      if (method === 'mcpServerStatus/list') result = { data: [], nextCursor: null };
      else if (method === 'thread/start') {
        counts.starts++;
        response = {
          thread: {
            id: 'fixture-' + id,
            projectId: null,
            parentThreadId: null,
            forkedFromId: null,
            agentRole: null,
            turns: [],
            path: transcript,
          },
          cwd: run.brief.copy_root,
          model: run.brief.profile.model,
          reasoningEffort: run.brief.profile.effort,
          approvalPolicy: 'never',
          sandbox: {
            type: 'workspaceWrite',
            networkAccess: false,
            writableRoots: [run.brief.copy_root],
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
        };
        result = structuredClone(response);
      } else if (method === 'thread/resume') result = { ...response, thread: thread() };
      else if (method === 'thread/loaded/list')
        result = { data: ['fixture-' + id], nextCursor: null };
      else if (method === 'thread/read') result = { thread: thread() };
      else if (method === 'thread/backgroundTerminals/list')
        result = {
          data: (await processes.alive([child])).map(({ pid }) => ({
            processId: 'physical-child-' + id,
            osPid: pid,
          })),
          nextCursor: null,
        };
      else if (method === 'thread/backgroundTerminals/terminate') {
        requireContract(
          (await processes.alive([child])).length === 0,
          'preflight-terminate-before-os-stop',
        );
        result = {};
      } else if (method === 'turn/interrupt') {
        // Detect the historical late-STOP order before an RPC can orphan descendants.
        requireContract(
          (await processes.alive([child])).length === 0,
          'preflight-interrupt-before-physical-stop',
        );
        counts.interrupts++;
        turns.find(({ id }) => id === params.turnId)!.status = 'interrupted';
        result = {};
      } else if (method === 'turn/start') {
        counts.turns++;
        const text = String(object((params.input as unknown[])[0]).text),
          delivery = JSON.parse(
            text.split('\n')[0]!.slice('Workflow delivery id: '.length),
          ) as string;
        const turnId = id + '-turn-' + counts.turns,
          implementation = delivery.endsWith(':implementation');
        const items: Record<string, unknown>[] = [
          { type: 'userMessage', content: [{ type: 'text', text }] },
        ];
        contexts.push({
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: run.brief.copy_root,
            model: run.brief.profile.model,
            effort: run.brief.profile.effort,
            approval_policy: 'never',
            sandbox_policy: {
              type: 'workspace-write',
              network_access: false,
              exclude_slash_tmp: true,
              exclude_tmpdir_env_var: true,
            },
            permission_profile: {
              type: 'managed',
              network: 'restricted',
              file_system: {
                type: 'restricted',
                entries: [
                  { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
                  { path: { type: 'path', path: run.brief.copy_root }, access: 'write' },
                ],
              },
            },
          },
        });
        if (delivery.endsWith(':load')) {
          const reads = await Promise.all(
            [...selectedProcedures(run.writer!.spec), ...run.brief.rules].map(
              async ({ locator }) => {
                const content = await readFile(join(run.brief.copy_root, locator), 'utf8');
                return canonical({ path: locator, sha256: digest(content), content });
              },
            ),
          );
          items.push({ type: 'commandExecution', exitCode: 0, aggregatedOutput: reads.join('\n') });
        }
        if (implementation) await writeFile(join(run.brief.copy_root, 'source.txt'), 'after:' + id);
        items.push({
          type: 'agentMessage',
          text: implementation
            ? JSON.stringify({
                summary: 'Fixture model response',
                errors: [],
                limitations: ['No real model or native service'],
              })
            : 'Fixture LOAD/profile response',
        });
        const turn = {
          id: turnId,
          status: implementation && !complete ? 'inProgress' : 'completed',
          items,
        };
        turns.push(turn);
        await writeFile(
          transcript,
          [session('fixture-' + id, run.brief.copy_root), ...contexts].map(canonical).join('\n') +
            '\n',
        );
        result = { turn };
      } else throw new Error('Unexpected fixture RPC: ' + method);
      const frame = { id: request.id, result };
      transport.write('recv', frame, JSON.stringify(frame));
      return result;
    },
  };
  const sessions = new AppServerCoderSessions(
    rpc,
    directory,
    journalPath,
    processes,
    (run) => f.workspaces.verifyCopy(run),
    policyRef,
    async () => {},
  );
  const deps: CoderDependencies = {
    journal: f.journal,
    runs: f.runs,
    workspaces: f.workspaces,
    sessions,
  };
  return { deps, sessions, counts, child, identity, processes, runtime, rpc, journalPath };
}

const cleanups: PreflightCleanup = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
const body = (pin: Parameters<typeof readH04Pin>[0]) =>
  object(JSON.parse(readH04Pin(pin).toString()));

it('preflights real Legacy /3 bootstrap, migration, retained warm recovery, cold host reopen and third Writer integration without a model', async () => {
  const f = await h06PreflightFixture(cleanups),
    before = f.state();
  expect(await f.journal.read()).toMatchObject({
    schema_version: 1,
    execution: { status: 'implementing' },
  });
  const first = await preflightCoderRuntime(f, 'first', cleanups);
  const reserved = await startCoder(f.brief('first'), first.deps);
  expect(reserved).toMatchObject({ status: 'reserved', session: null, copy: null });
  expect(first.counts.starts).toBe(0);
  const migrated = await f.journal.read();
  expect(migrated).toMatchObject({ schema_version: 2, coders: { first: { status: 'reserved' } } });
  expect(f.state()).toMatchObject({
    owner: before.owner,
    generation: before.generation,
    frozen: false,
    released: false,
  });
  const restoredRoot = join(f.root, 'restored-store');
  restoreStore(dirname(migrated.format_backup!.locator), restoredRoot, grant);
  const restored = new SqliteEvidenceStore(restoredRoot, grant, Date.now);
  expect(
    unwrap<TechnicalState>(
      restored.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    ),
  ).toEqual({ ...before, revision: before.revision + 1, frozen: true });
  expect(
    await new TaskWorkflowJournal(
      { execute: async (request) => restored.execute(request) },
      grant.context,
      1,
    ).read(),
  ).toMatchObject({ schema_version: 1, execution: { status: 'implementing' } });
  const firstRun = await launchCoder('first', first.deps);
  expect(firstRun.status).toBe('running');
  expect(await first.sessions.observeLiveWriter(firstRun)).toMatchObject({
    thread: 'fixture-first',
    turn: firstRun.turn,
  });
  expect(await first.processes.alive([first.child])).toEqual([first.child]);
  expect(await startCoder(f.brief('first'), first.deps)).toEqual(firstRun);
  expect(await launchCoder('first', first.deps)).toEqual(firstRun);
  await expect(startCoder(f.brief('overlap'), first.deps)).rejects.toThrow('coder-source-overlap');
  await expect(
    startCoder({ ...f.brief('protected'), paths: ['AGENTS.md'] }, first.deps),
  ).rejects.toThrow('coder-protected-scope');
  expect(first.counts).toMatchObject({ starts: 1, turns: 3 });
  expect(readFileSync(join(f.f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  expect(readFileSync(join(firstRun.brief.copy_root, 'source.txt'), 'utf8')).toBe('after:first');

  const pause = await f.admit('warm-pause'),
    pauseSource = { locator: pause.delivery.path, hash: pause.delivery.sha256 };
  const paused = await applyH06DelegatedLegacyControl(
    {
      ...pause,
      event: {
        type: 'PAUSE',
        id: pause.admitted.nonce,
        generation: 1,
        expected_revision: pause.admitted.controlRevision,
        thread_id: 'owner',
        source: pauseSource,
        reason: 'Fixture warm pause',
      },
    },
    f.store,
    { stopWriter: async () => ({ coder: firstRun, stopped: await first.sessions.stop(firstRun) }) },
  );
  f.settle(pause, paused.receipt);
  expect(first.counts.interrupts).toBe(1);
  expect(await first.processes.alive([first.child])).toEqual([]);
  expect(body(paused.receipt)).toMatchObject({
    control: { status: 'paused', revision: 1 },
    writer: { coder: { status: 'running' } },
  });
  const stopped = object(object(body(paused.receipt).writer).stopped) as {
    locator: string;
    hash: string;
  };
  const stopProof = body({ path: stopped.locator, sha256: stopped.hash });
  expect(stopProof).toMatchObject({
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
  });
  expect(stopProof.processes).toContainEqual(first.child);
  f.actorRows.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: pause.turn } });
  f.flush();
  const resume = await f.admit('warm-resume'),
    resumeSource = { locator: resume.delivery.path, hash: resume.delivery.sha256 };
  f.load(resume.turn, 'warm-resume-load');
  const host = new FileCurrentChatHost(f.f.root, f.transcript, {
    thread_id: 'owner',
    turn_id: resume.turn,
    host_id: 'local',
    workspace: f.f.root,
  });
  await expect(host.continuation('actor-load')).rejects.toThrow(
    'chat-continuation-operation-pending',
  );
  const resumed = await applyH06DelegatedLegacyControl(
    {
      ...resume,
      event: {
        type: 'RESUME',
        id: resume.admitted.nonce,
        expected_revision: 1,
        generation: 1,
        thread_id: 'owner',
        source: resumeSource,
        authorization: resumeSource,
        marker: 'warm-resume-load',
        stopped,
      },
    },
    f.store,
  );
  f.settle(resume, resumed.receipt);
  const warmResult = body(resumed.receipt);
  expect(warmResult).toMatchObject({
    control: { status: 'active', revision: 2, unreconciled_turns: [] },
  });
  expect(warmResult.retainedContinuations).toHaveLength(1);
  const retained = (warmResult.retainedContinuations as Parameters<typeof readH04Pin>[0][])[0]!;
  await expect(
    verifyH06RetainedWarmContinuation({ claim: f.claim.receipt, proof: retained }),
  ).resolves.toBeDefined();
  expect((await cancelCoder('first', first.deps)).status).toBe('cancelled');
  f.actorRows.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: resume.turn } });
  f.flush();

  const second = await preflightCoderRuntime(f, 'second', cleanups);
  await startCoder(f.brief('second'), second.deps);
  const secondRun = await launchCoder('second', second.deps),
    coldPause = await f.admit('cold-pause');
  const coldSource = { locator: coldPause.delivery.path, hash: coldPause.delivery.sha256 };
  const value = {
    ...coldPause,
    event: {
      type: 'PAUSE',
      id: coldPause.admitted.nonce,
      generation: 1,
      expected_revision: 2,
      thread_id: 'owner',
      source: coldSource,
      reason: 'Fixture cold host handoff',
    },
  };
  const packet = f.pin('cold-host-request.json', { value, storeRoot: f.store.root, grant });
  const child = spawn(
    process.execPath,
    [
      '--import',
      f.loader.path,
      '--input-type=module',
      '-e',
      `
    import { readFileSync } from 'node:fs';
    import { SqliteEvidenceStore } from ${JSON.stringify(new URL('../adapters/storage/sqliteEvidenceStore.ts', import.meta.url).href)};
    import { applyH06DelegatedLegacyControl } from ${JSON.stringify(new URL('./comparisonH06DelegatedLegacy.ts', import.meta.url).href)};
    const {value,storeRoot,grant}=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const store=new SqliteEvidenceStore(storeRoot,grant,Date.now);
    const result=await applyH06DelegatedLegacyControl(value,store,{stopWriter:async()=>{
      process.send({kind:'stop'});
      return await new Promise(resolve=>process.once('message',resolve));
    }});
    process.send({kind:'result',result});process.disconnect();
  `,
      packet.path,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, CODEX_THREAD_ID: 'owner' },
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const result = await new Promise<{ receipt: Parameters<typeof readH04Pin>[0] }>(
    (resolve, reject) => {
      child.on(
        'message',
        (message: { kind: string; result: { receipt: Parameters<typeof readH04Pin>[0] } }) => {
          if (message.kind === 'stop')
            void second.sessions
              .stop(secondRun)
              .then((proof) => child.send({ coder: secondRun, stopped: proof }))
              .catch(reject);
          if (message.kind === 'result') resolve(message.result);
        },
      );
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error('Cold fixture host failed: ' + stderr));
      });
    },
  );
  expect((await exited)[0], stderr).toBe(0);
  expect(() => process.kill(child.pid!, 0)).toThrow();
  f.settle(coldPause, result.receipt);
  expect(body(result.receipt)).toMatchObject({
    host: { pid: child.pid },
    control: { status: 'paused', revision: 3 },
  });
  expect(await second.processes.alive([second.child])).toEqual([]);
  f.actorRows.push({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: coldPause.turn },
  });
  f.flush();
  const coldResume = await f.admit('cold-resume'),
    coldResumeSource = { locator: coldResume.delivery.path, hash: coldResume.delivery.sha256 };
  f.load(coldResume.turn, 'cold-resume-load');
  const reopened = new SqliteEvidenceStore(f.store.root, grant, Date.now),
    coldStopped = object(object(body(result.receipt).writer).stopped) as {
      locator: string;
      hash: string;
    };
  const coldResumed = await applyH06DelegatedLegacyControl(
    {
      ...coldResume,
      event: {
        type: 'RESUME',
        id: coldResume.admitted.nonce,
        expected_revision: 3,
        generation: 1,
        thread_id: 'owner',
        source: coldResumeSource,
        authorization: coldResumeSource,
        marker: 'cold-resume-load',
        stopped: coldStopped,
      },
    },
    reopened,
  );
  f.settle(coldResume, coldResumed.receipt);
  expect(body(coldResumed.receipt)).toMatchObject({
    control: { status: 'active', revision: 4, unreconciled_turns: [] },
  });
  expect((await cancelCoder('second', second.deps)).status).toBe('cancelled');
  const third = await preflightCoderRuntime(f, 'third', cleanups, true);
  await startCoder(f.brief('third'), third.deps);
  const released = await runCoder('third', third.deps);
  expect(released.status).toBe('released');
  expect(await third.processes.alive([third.child])).toEqual([]);
  expect(readFileSync(join(f.f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  expect((await f.runs.read())!.coder_locks).toHaveLength(1);
  const integrated = await integrateCoder('third', third.deps);
  expect(integrated.status).toBe('integrated');
  expect(await integrateCoder('third', third.deps)).toEqual(integrated);
  expect(await runCoder('third', third.deps)).toEqual(integrated);
  expect(readFileSync(join(f.f.root, 'source.txt'), 'utf8')).toBe('after:third');
  expect((await f.runs.read())!.coder_locks).toEqual([]);
  expect((await f.journal.read()).execution!.coder_reservations).toEqual([]);
  for (const runtime of [first, second, third])
    expect(runtime.counts).toMatchObject({
      starts: 1,
      turns: 3,
      modelCalls: 0,
      temporalServices: 0,
      nativeServices: 0,
    });
  expect(f.state()).toMatchObject({
    owner: 'owner',
    generation: 1,
    frozen: false,
    released: false,
  });
  await expect(
    verifyH06RetainedWarmContinuation({ claim: f.claim.receipt, proof: retained }),
  ).resolves.toBeDefined();
  const transcript = readFileSync(f.transcript);
  writeFileSync(
    f.transcript,
    transcript.subarray(0, Number(object(body(retained).nativePrefix).bytes) - 1),
  );
  await expect(
    verifyH06RetainedWarmContinuation({ claim: f.claim.receipt, proof: retained }),
  ).rejects.toThrow();
  writeFileSync(f.transcript, transcript);
}, 60000);
