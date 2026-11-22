import type { AuditAttemptObservation } from '../../core/progressAudit.js';
import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { AgentSession, DataAnswer, DataQuery, SessionProfile } from '../../core/dataRoute.js';
import type { InputRef } from '../../core/localRun.js';
import type { AgentSessions } from '../../ports/agentSessions.js';
import { contentHash } from '../project/projectFiles.js';
import type { AppServerRpc } from './appServerTransport.js';
import { confirmNativeRead } from './nativeRead.js';
import type { CouncilSender } from './councilDelegation.js';
import { verifyNativeReview } from './appServerCouncil.js';
import { observeAuditRefusal, observeAuditTerminal } from './appServerAuditAttempts.js';
import type { CouncilReviewRequest } from '../../core/council.js';
import { sameRefs } from '../../core/council.js';
import { projectText } from '../project/projectFiles.js';
import { decodeChatArtifact, encodeProofArtifact } from '../storage/sharedArtifacts.js';
import { readPrivateFile } from '../storage/storeFiles.js';

export class AppServerSessions implements AgentSessions {
  constructor(
    private readonly rpc: AppServerRpc,
    private readonly root: string,
    private readonly project: string,
    private readonly evidenceRoot: string,
    private readonly nativeParent: string | null = null,
    private readonly nativeProject: string | null = project,
    private readonly retainedEvidenceRoot: string = evidenceRoot,
  ) {}
  private async receipt(name: string, value: unknown): Promise<InputRef> {
    requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(name), 'unsafe-receipt-name');
    const text = encodeProofArtifact(this.evidenceRoot, value);
    const path = resolve(this.evidenceRoot, `${name}.json`);
    // Content-addressing preserves the original observation across later reads.
    const hash = contentHash(text);
    const locator = `${path}.${hash}`;
    await writeFile(locator, text, { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
      requireWorkflow(
        (error as { code: string }).code === 'EEXIST' &&
          readPrivateFile(locator).toString('utf8') === text,
        'receipt-write-failed',
      );
    });
    return { locator, hash };
  }
  private async session(raw: unknown, fresh: boolean): Promise<AgentSession> {
    const response = object(raw);
    const thread = object(response.thread);
    const policy = object(response.sandbox);
    const id = textField(thread.id);
    let project = thread.projectId;
    let parent: Record<string, unknown> | null = null;
    if (
      project === null &&
      thread.agentRole === 'auditor' &&
      typeof thread.parentThreadId === 'string'
    ) {
      parent = object(
        object(
          await this.rpc.request('thread/read', {
            threadId: thread.parentThreadId,
            includeTurns: false,
          }),
        ).thread,
      );
      requireWorkflow(
        parent.id === thread.parentThreadId && parent.cwd === this.root,
        'wrong-native-parent',
      );
      project = parent.projectId;
    }
    requireWorkflow(
      project === this.nativeProject && response.cwd === this.root,
      'wrong-session-project',
    );
    requireWorkflow(Array.isArray(thread.turns), 'session-history-unknown');
    return {
      id,
      agent_role: typeof thread.agentRole === 'string' ? thread.agentRole : null,
      native_project_id: thread.projectId === null ? null : textField(thread.projectId),
      parent_id: parent === null ? null : textField(parent.id),
      model: textField(response.model),
      effort: textField(response.reasoningEffort),
      workspace: this.root,
      project_id: this.project,
      read_only: policy.type === 'readOnly',
      network: policy.networkAccess !== false,
      forked_from: thread.forkedFromId === null ? null : textField(thread.forkedFromId),
      initial_turns: fresh ? thread.turns.length : -1,
      receipt: await this.receipt(id, {
        operation: fresh ? 'thread/start' : 'thread/resume',
        session: raw,
        parent,
      }),
    };
  }
  async create(profile: SessionProfile) {
    const response = await this.rpc.request('thread/start', {
      projectId: this.nativeProject,
      cwd: this.root,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: false,
      allowProviderModelFallback: false,
      model: profile.model,
      config: { model_reasoning_effort: profile.effort },
    });
    return this.session(response, true);
  }
  async inspect(id: string) {
    if (this.nativeParent !== null) {
      const child = object(
        object(await this.rpc.request('thread/read', { threadId: id, includeTurns: false })).thread,
      );
      requireWorkflow(
        child.id === id &&
          child.agentRole === 'auditor' &&
          child.parentThreadId === this.nativeParent,
        'wrong-native-child',
      );
      const parent = await this.rpc.request('thread/resume', {
        threadId: this.nativeParent,
        cwd: this.root,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        excludeTurns: true,
      });
      const restored = await this.session(parent, false);
      requireWorkflow(restored.id === this.nativeParent, 'wrong-native-parent');
    }
    let response: unknown;
    try {
      response = await this.rpc.request('thread/resume', {
        threadId: id,
        cwd: this.root,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        excludeTurns: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('app-server-error:') &&
        error.message.includes(`no rollout found for thread id ${id}`)
      )
        return null;
      throw error;
    }
    const session = await this.session(response, false);
    requireWorkflow(session.id === id, 'wrong-resumed-session');
    return session;
  }
  private async startTurn(session: AgentSession, brief: string) {
    const response = object(
      await this.rpc.request('turn/start', {
        threadId: session.id,
        input: [{ type: 'text', text: brief }],
        environments: [
          { environmentId: 'local', cwd: this.root, runtimeWorkspaceRoots: [this.root] },
        ],
      }),
    );
    return textField(object(response.turn).id);
  }
  async send(session: AgentSession, brief: string, requestId: string) {
    return this.startTurn(session, `Workflow delivery id: ${JSON.stringify(requestId)}\n${brief}`);
  }
  async recoverSend(session: AgentSession, requestId: string) {
    const response = object(
      await this.rpc.request('thread/read', { threadId: session.id, includeTurns: true }),
    );
    const thread = object(response.thread);
    requireWorkflow(thread.id === session.id && Array.isArray(thread.turns), 'wrong-thread-read');
    const marker = `Workflow delivery id: ${JSON.stringify(requestId)}\n`;
    const matching = thread.turns.map(object).filter((turn) => {
      requireWorkflow(Array.isArray(turn.items), 'turn-history-incomplete');
      return turn.items
        .map(object)
        .some(
          (item) =>
            item.type === 'userMessage' &&
            Array.isArray(item.content) &&
            item.content
              .map(object)
              .some(
                (part) =>
                  part.type === 'text' &&
                  typeof part.text === 'string' &&
                  part.text.startsWith(marker),
              ),
        );
    });
    // An absent/multiple match is unknown, not permission to repeat turn/start.
    return matching.length === 1 ? textField(matching[0]!.id) : null;
  }
  private async turn(session: AgentSession, turnId: string) {
    const response = object(
      await this.rpc.request('thread/read', { threadId: session.id, includeTurns: true }),
    );
    const thread = object(response.thread);
    requireWorkflow(thread.id === session.id && Array.isArray(thread.turns), 'wrong-thread-read');
    const turn = thread.turns.map(object).find((t) => t.id === turnId);
    requireWorkflow(turn !== undefined, 'turn-not-found');
    return turn;
  }
  async observeAuditRefusal(
    operation: string,
    primary: InputRef,
  ): Promise<AuditAttemptObservation> {
    return observeAuditRefusal(operation, primary, (name, value) => this.receipt(name, value));
  }
  async observeAuditTerminal(
    operation: string,
    session: AgentSession,
    launch: InputRef,
    turnNotStarted: boolean,
    deliveries: string[],
    deliveryTurns?: string[],
  ): Promise<AuditAttemptObservation> {
    return observeAuditTerminal(
      this.rpc,
      operation,
      session,
      launch,
      turnNotStarted,
      deliveries,
      deliveryTurns,
      (name, value) => this.receipt(name, value),
    );
  }
  async load(session: AgentSession, query: DataQuery) {
    const refs = [...query.procedures, ...query.rules].map(({ locator, hash }) => ({
      locator,
      hash,
    }));
    const prompt = `Только чтение; без сети, записи, помощников и внешней истории. До работы прочитай полностью перечисленные файлы. Для каждого выведи отдельную строку JSON {"path":"...","sha256":"...","content":"полный исходный текст"} инструментом чтения. Пути и хеши: ${JSON.stringify(refs)}. Для крупного источника используй принятый формат частей: {"format":"aw-native-read-parts/1","path":"...","sha256":"SHA-256 всего исходника","content":"точный фрагмент","offset":0,"length":полная длина}. Смещения и длина — кодовые единицы UTF-16 (Node.js string.length), первая часть offset=0, следующие непрерывны. Один content не длиннее 8000 единиц; полная сериализованная JSON-строка с переводом строки не больше 24000 UTF-8-байт: уменьшай часть при необходимости. Вывод каждой команды тоже должен помещаться в этот бюджет; не объединяй большие части в одну команду. Не сокращай текст, не смешивай форматы одного файла. Пустой файл читай полной строкой. Обрезку вывода или неизвестный формат считай отказом: не повторяй ту же большую строку. Затем верни краткое подтверждение правил. Саму задачу пока не выполняй.`;
    const turnId = await this.startTurn(session, prompt);
    await this.rpc.completed(session.id, turnId);
    return this.observeLoad(session, query, turnId);
  }
  async observeLoad(session: AgentSession, query: DataQuery, turnId: string) {
    const refs = [...query.procedures, ...query.rules].map(({ locator, hash }) => ({
      locator,
      hash,
    }));
    const turn = await this.turn(session, turnId);
    confirmNativeRead(turn, refs);
    return this.receipt(`load-${session.id}-${turnId}`, {
      session: session.id,
      turn: turnId,
      refs,
      observation: turn,
      ...(session.initial_turns === 0 ? { creation: session.receipt } : {}),
    });
  }
  async reuseLoad(session: AgentSession, query: DataQuery, proof: InputRef) {
    const source = await projectText(this.evidenceRoot, relative(this.evidenceRoot, proof.locator));
    requireWorkflow(contentHash(source) === proof.hash, 'native-load-receipt-changed');
    const saved = object(decodeChatArtifact(this.evidenceRoot, source));
    const refs = [...query.procedures, ...query.rules].map(({ locator, hash }) => ({
      locator,
      hash,
    }));
    requireWorkflow(
      saved.session === session.id &&
        Array.isArray(saved.refs) &&
        sameRefs(saved.refs as InputRef[], refs),
      'native-load-receipt-mismatch',
    );
    const thread = object(
      object(await this.rpc.request('thread/read', { threadId: session.id, includeTurns: true }))
        .thread,
    );
    requireWorkflow(thread.id === session.id && Array.isArray(thread.turns), 'wrong-thread-read');
    const turns = thread.turns.map(object);
    requireWorkflow(
      new Set(turns.map((turn) => textField(turn.id))).size === turns.length,
      'ambiguous-review-turns',
    );
    const index = turns.findIndex((turn) => turn.id === saved.turn);
    requireWorkflow(index >= 0, 'native-load-turn-missing');
    requireWorkflow(
      turns
        .slice(index)
        .every(
          (turn) =>
            Array.isArray(turn.items) &&
            ['completed', 'failed', 'interrupted'].includes(String(turn.status)),
        ),
      'native-load-history-unconfirmed',
    );
    confirmNativeRead(turns[index]!, refs);
    if (
      turns
        .slice(index)
        .some((turn) =>
          (turn.items as unknown[]).some(
            (item: unknown) => object(item).type === 'contextCompaction',
          ),
        )
    )
      return null;
    return proof;
  }
  async verifyReview(
    session: AgentSession,
    request: CouncilReviewRequest,
    turn: string,
    answer: InputRef,
    sender?: CouncilSender,
  ) {
    return verifyNativeReview(
      this.rpc,
      this.evidenceRoot,
      session,
      request,
      turn,
      answer,
      (name, value) => this.receipt(name, value),
      sender,
      this.retainedEvidenceRoot,
    );
  }
  async poll(session: AgentSession, turnId: string): ReturnType<AgentSessions['poll']> {
    const turn = await this.turn(session, turnId);
    if (turn.status === 'inProgress') return { status: 'running' };
    requireWorkflow(turn.status === 'completed' && Array.isArray(turn.items), 'data-turn-failed');
    const messages = turn.items.map(object).filter((item) => item.type === 'agentMessage');
    const last = messages.at(-1);
    requireWorkflow(last !== undefined && typeof last.text === 'string', 'data-answer-missing');
    const answer = object(JSON.parse(last.text) as unknown);
    requireWorkflow(
      ['PASS', 'FAIL', 'NOT RUN'].includes(String(answer.outcome)) &&
        ['complete', 'partial'].includes(String(answer.coverage)) &&
        Array.isArray(answer.scope) &&
        Array.isArray(answer.sources) &&
        Array.isArray(answer.limitations) &&
        typeof answer.content === 'string' &&
        (answer.continuation === null || typeof answer.continuation === 'string'),
      'invalid-data-answer',
    );
    return {
      status: 'completed',
      answer: {
        ...answer,
        evidence: await this.receipt(`answer-${session.id}-${turnId}`, turn),
      } as unknown as DataAnswer,
    };
  }
}
