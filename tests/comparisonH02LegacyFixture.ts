import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { readPrivateFile, safeDirectory } from '../adapters/storage/storeFiles.js';
import type { Connection, CouncilConfiguration } from '../core/connection.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { CouncilReviewRequest, ReviewAnswer } from '../core/council.js';
import type { DataAnswer } from '../core/dataRoute.js';
import type { InputRef, RunSpec } from '../core/localRun.js';
import type { H02Counts } from './comparisonH02Contract.js';
import { checkH02Material, h02Material } from './comparisonH02Contract.js';
import type { H02LegacyContext, H02LegacyRpcTurn } from './comparisonH02Legacy.js';

/** Deterministic local protocol fixture. No native process, service, model or authority. */
export async function createH02LegacyFixture(
  root: string,
  signal?: AbortSignal,
): Promise<H02LegacyContext> {
  signal?.throwIfAborted();
  requireWorkflow(isAbsolute(root) && resolve(root) === root, 'h02-legacy-fixture-root');
  safeDirectory(dirname(root));
  mkdirSync(root, { mode: 0o700 });
  const workspaceRoot = join(root, 'workspace'),
    evidenceRoot = join(root, 'evidence');
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(evidenceRoot, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(h02Material.files))
    writeFileSync(join(workspaceRoot, name), bytes, { mode: 0o600 });
  const put = (name: string, bytes: string) => {
    mkdirSync(dirname(join(workspaceRoot, name)), { recursive: true });
    writeFileSync(join(workspaceRoot, name), bytes, { mode: 0o600 });
    return { locator: name, hash: digest(bytes) };
  };
  const rule = put(
    'RULES.md',
    'H02 local fixture: preserve all immutable files and primary FAIL history. No native execution.\n',
  );
  const assignment = put('assignment.md', h02Material.instructions);
  const configuration: CouncilConfiguration = {
    catalog: 'roles/README.md',
    profiles: Object.fromEntries(
      ['pricing', 'logging', 'storage'].map((role) => [role, 'roles/' + role + '.md']),
    ),
  };
  put(
    configuration.catalog,
    'H02 subject roles: pricing, logging, storage. Local protocol fixture only.\n',
  );
  for (const [role, path] of Object.entries(configuration.profiles))
    put(
      path,
      'Inspect only ' +
        role +
        '.json. Preserve primary FAIL and exact sources. Fixture, not native.\n',
    );
  const connection = JSON.parse(
    readFileSync(new URL('../project/workflow.json', import.meta.url), 'utf8'),
  ) as Connection;
  const procedures = connection.procedures
    .filter((p) =>
      ['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council'].includes(p.id),
    )
    .map((procedure) => {
      const source = readFileSync(new URL('../' + procedure.locator, import.meta.url), 'utf8');
      return { ...procedure, ...put(procedure.locator, source) };
    });
  const spec: RunSpec = {
    project_id: 'h02-local',
    identity: { assignment_id: 'h02-local' },
    assignment,
    product: false,
    run_id: 'h02-local',
    session_id: 'h02-local-controller',
    host_id: 'local',
    workspace: realpathSync(workspaceRoot),
    parent_run_id: null,
    coordinator: false,
    role: null,
    fork_turns: 'none',
    scope: ['pricing.json'],
    outcome: 'H02 technical policy integration',
    criteria: ['H02 fixed comparison checks'],
    writer: 'h02-local-controller',
    requested: { model: 'deterministic-local-rpc', effort: 'fixture', permissions: ['read'] },
    effective: { model: 'deterministic-local-rpc', effort: 'fixture', permissions: ['read'] },
    sources: [assignment, rule],
    procedures,
    rules: [rule],
    route: { kind: 'nonproduct' },
  };
  type Thread = {
    id: string;
    cwd: string;
    projectId: null;
    parentThreadId: null;
    forkedFromId: null;
    name: string | null;
    turns: Record<string, unknown>[];
  };
  const threads = new Map<string, Thread>(),
    observed: H02LegacyRpcTurn[] = [],
    counts: H02Counts = { threadStarts: 0, turnStarts: 0 };
  let closed = false;
  const log = join(evidenceRoot, 'local-rpc.jsonl');
  const record = (value: unknown) =>
    appendFileSync(log, JSON.stringify(value) + '\n', { mode: 0o600 });
  record({ kind: 'h02-fixed-local-rpc', native: false, modelCalls: 0 });
  const response = (thread: Thread) => ({
    cwd: workspaceRoot,
    model: spec.requested.model,
    reasoningEffort: spec.requested.effort,
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: structuredClone(thread),
  });
  const current = (id: unknown) => {
    const thread = threads.get(textField(id));
    requireWorkflow(thread !== undefined, 'h02-local-thread-unknown');
    return thread;
  };
  const rpc: AppServerRpc = {
    async request(method, params) {
      signal?.throwIfAborted();
      requireWorkflow(!closed, 'h02-local-rpc-closed');
      record({ method, params });
      let result: unknown;
      if (method === 'thread/start') {
        const id = 'h02-local-reader-' + String(++counts.threadStarts),
          thread: Thread = {
            id,
            cwd: workspaceRoot,
            projectId: null,
            parentThreadId: null,
            forkedFromId: null,
            name: null,
            turns: [],
          };
        threads.set(id, thread);
        result = response(thread);
      } else if (method === 'thread/name/set') {
        current(params.threadId).name = textField(params.name);
        result = {};
      } else if (method === 'thread/resume') result = response(current(params.threadId));
      else if (method === 'thread/read')
        result = { thread: structuredClone(current(params.threadId)) };
      else if (method === 'turn/start') {
        const thread = current(params.threadId),
          text = textField(object((params.input as unknown[])[0]).text),
          id = 'h02-local-turn-' + String(++counts.turnStarts);
        const marker = 'Пути и хеши: ',
          offset = text.indexOf(marker);
        let items: unknown[], kind: H02LegacyRpcTurn['kind'];
        if (offset >= 0) {
          kind = 'load';
          const refs = JSON.parse(
            text.slice(offset + marker.length, text.indexOf('. Для крупного', offset)),
          ) as InputRef[];
          items = refs.map((ref) => {
            const path = resolve(workspaceRoot, ref.locator);
            requireWorkflow(
              path.startsWith(workspaceRoot + sep),
              'h02-local-read-outside-workspace',
            );
            const content = readPrivateFile(path).toString();
            requireWorkflow(digest(content) === ref.hash, 'h02-local-read-changed');
            return {
              type: 'commandExecution',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput:
                JSON.stringify({ path: ref.locator, sha256: ref.hash, content }) + '\n',
            };
          });
        } else {
          kind = 'review';
          const brief = 'Council review request file: ',
            start = text.indexOf(brief);
          requireWorkflow(start >= 0, 'h02-local-review-request');
          const view = object(
            JSON.parse(text.slice(start + brief.length, text.indexOf('\n', start))),
          );
          const requestFile = object(view.request_file) as unknown as InputRef;
          requireWorkflow(
            requestFile.locator.startsWith(evidenceRoot + sep),
            'h02-local-request-outside-evidence',
          );
          const source = readPrivateFile(requestFile.locator).toString();
          requireWorkflow(digest(source) === requestFile.hash, 'h02-local-request-changed');
          const request = decodeChatArtifact(evidenceRoot, source) as CouncilReviewRequest;
          requireWorkflow(
            ['pricing', 'logging', 'storage'].includes(request.role),
            'h02-local-role',
          );
          const passed =
            request.role === 'pricing'
              ? await checkH02Material(workspaceRoot)
              : request.role === 'logging'
                ? object(JSON.parse(readFileSync(join(workspaceRoot, 'logging.json'), 'utf8')))
                    .level === 'info'
                : object(JSON.parse(readFileSync(join(workspaceRoot, 'storage.json'), 'utf8')))
                    .version === 1;
          const report: Omit<ReviewAnswer, 'target' | 'evidence'> & {
            target_ref: InputRef;
            evidence: InputRef;
          } = {
            verdict: passed ? 'PASS' : 'FAIL',
            scope: request.target.scope,
            target_ref: requestFile,
            coverage: 'complete',
            sources: request.requirements,
            limitations: ['Deterministic local RPC fixture; not a native review.'],
            findings: passed
              ? []
              : [
                  {
                    id: 'pricing-rate',
                    scope: request.target.scope,
                    condition: 'pricing.rate must equal 7',
                    reason: 'The real immutable H02 checker rejected pricing.',
                    blocking: true,
                    sources: request.requirements,
                  },
                ],
            evidence: { locator: 'local-fixture-answer-not-native', hash: '0'.repeat(64) },
          };
          const answer: Omit<DataAnswer, 'evidence'> = {
            outcome: report.verdict as 'PASS' | 'FAIL',
            scope: [request.target.scope],
            sources: request.requirements,
            coverage: 'complete',
            content: JSON.stringify(report),
            continuation: null,
            limitations: ['Fixed local RPC; native usage unknown.'],
          };
          items = [{ type: 'agentMessage', text: JSON.stringify(answer) }];
        }
        thread.turns.push({
          id,
          status: 'completed',
          items: [{ type: 'userMessage', content: [{ type: 'text', text }] }, ...items],
        });
        observed.push({
          role: textField(thread.name).replace(/^Советник: /u, ''),
          session: thread.id,
          turn: id,
          kind,
        });
        result = { turn: { id } };
      } else throw new Error('h02-local-rpc-method');
      record({ method, result });
      return result;
    },
    async completed(thread, turn, waitSignal) {
      signal?.throwIfAborted();
      waitSignal?.throwIfAborted();
      requireWorkflow(
        current(thread).turns.some((item) => item.id === turn && item.status === 'completed'),
        'h02-local-turn-unconfirmed',
      );
    },
  };
  const sessions = new AppServerSessions(
    rpc,
    workspaceRoot,
    spec.project_id,
    evidenceRoot,
    null,
    null,
  );
  return {
    workspaceRoot,
    evidenceRoot,
    spec,
    configuration,
    rpc,
    inputs: new FileWorkflowInputs(workspaceRoot, evidenceRoot),
    nativeSessions: {
      create: (profile) => sessions.create(profile),
      load: (session, query) => sessions.load(session, query),
      send: (session, brief, id) => sessions.send(session, brief, id),
      recoverSend: (session, id) => sessions.recoverSend(session, id),
      poll: (session, id) => sessions.poll(session, id),
      verifyReview: (session, request, turn, answer) =>
        sessions.verifyReview(session, request, turn, answer),
      async inspect(id) {
        const session = await sessions.inspect(id);
        requireWorkflow(session !== null, 'h02-local-session-missing');
        const thread = current(id);
        return {
          ...session,
          native_child: false,
          name: thread.name,
          observed_turn: textField(thread.turns.at(-1)!.id),
        };
      },
    },
    counts: () => ({ ...counts }),
    observations: () => structuredClone(observed),
    async stop() {
      const readersStopped = [...threads.values()].every((thread) =>
        thread.turns.every((turn) => turn.status === 'completed'),
      );
      closed = true;
      record({ kind: 'h02-local-rpc-close', readersStopped, transportClosed: true, native: false });
      return {
        readersStopped,
        transportClosed: true,
        evidence: [{ locator: log, hash: digest(readPrivateFile(log)) }],
      };
    },
    ...(signal === undefined ? {} : { signal }),
  };
}
