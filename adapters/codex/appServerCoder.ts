import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { selectedProcedures } from '../../core/localRun.js';
import type { InputRef, LoadReceipt } from '../../core/localRun.js';
import type { DataQuery } from '../../core/dataRoute.js';
import type { CoderResult, CoderRun, CoderSession } from '../../core/coder.js';
import type { CoderSessions } from '../../ports/coder.js';
import type { ProcessIdentity, WriterProcesses } from '../../ports/writerProcesses.js';
import type { AppServerRpc } from './appServerTransport.js';
import { AppServerSessions } from './appServerSessions.js';
import { AppServerWriters, ownedRuntimeProcesses } from './appServerWriters.js';
import { nativeCreationProof, readDeliveryReceipt } from './transportJournal.js';
import { coderCreationRefusal, refuseCoderCreation } from './coderCreation.js';
import { assertCoderCapabilities } from './coderCapabilities.js';
import { canonical, digest } from '../storage/storeCodec.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';
import { writerScopeHash } from '../project/writerScope.js';

export class AppServerCoderSessions implements CoderSessions {
  private owned: CoderSession | null = null;
  private readonly bindings: InputRef[] = [];
  private profileObservation: InputRef | null = null;
  private readonly started = new Set<string>();
  constructor(
    private readonly rpc: AppServerRpc,
    private readonly directory: string,
    private readonly journal: string,
    private readonly processes: WriterProcesses,
    private readonly unchanged: (run: CoderRun) => Promise<void>,
    private readonly policy: InputRef,
    private readonly beforeTurn: (run: CoderRun) => Promise<void>,
  ) {}
  private async proof(name: string, value: unknown): Promise<InputRef> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    safeDirectory(this.directory);
    const bytes = canonical(value) + '\n',
      hash = digest(bytes),
      locator = resolve(this.directory, `${name}-${hash}.json`);
    try {
      await writeFile(locator, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      requireWorkflow(
        (error as { code?: string }).code === 'EEXIST' &&
          readPrivateFile(locator).toString('utf8') === bytes,
        'coder-native-proof-conflict',
      );
    }
    return { locator, hash };
  }
  private async noMcp(threadId?: string) {
    const status = object(
      await this.rpc.request('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );
    const bytes = readPrivateFile(this.policy.locator);
    requireWorkflow(digest(bytes) === this.policy.hash, 'coder-policy-changed');
    const policy = object(JSON.parse(bytes.toString('utf8')) as unknown);
    const disabled = policy.disabled_mcp_servers ?? [];
    requireWorkflow(
      Array.isArray(disabled) && disabled.every((name) => typeof name === 'string'),
      'coder-policy-unconfirmed',
    );
    try {
      assertCoderCapabilities(status, disabled as string[]);
    } catch (error) {
      await this.proof('capabilities-rejected', {
        kind: 'coder-capabilities-rejected',
        thread: threadId ?? null,
        policy: this.policy,
        status,
      });
      throw error;
    }
    return status;
  }
  private session(
    run: CoderRun,
    raw: unknown,
    receipt: InputRef,
    policy: InputRef,
    expectedTurns: unknown[] = [],
  ): CoderSession {
    const response = object(raw),
      thread = object(response.thread),
      sandbox = object(response.sandbox);
    requireWorkflow(
      thread.projectId === null &&
        thread.parentThreadId === null &&
        thread.forkedFromId === null &&
        Array.isArray(thread.turns) &&
        sameValue(thread.turns, expectedTurns) &&
        response.cwd === run.brief.copy_root &&
        response.model === run.brief.profile.model &&
        response.reasoningEffort === run.brief.profile.effort &&
        response.approvalPolicy === 'never' &&
        sandbox.type === 'workspaceWrite' &&
        sandbox.networkAccess === false &&
        sandbox.excludeSlashTmp === true &&
        sandbox.excludeTmpdirEnvVar === true &&
        Array.isArray(sandbox.writableRoots) &&
        sandbox.writableRoots.every((path) => path === run.brief.copy_root),
      'coder-native-profile-unconfirmed',
    );
    const id = textField(thread.id);
    requireWorkflow(id !== run.brief.parent_session_id, 'coder-native-parent-forbidden');
    return {
      policy,
      id,
      model: run.brief.profile.model,
      effort: run.brief.profile.effort,
      project_id: run.brief.project_id,
      workspace: run.brief.copy_root,
      native_project_id: null,
      parent_id: null,
      native_child: false,
      agent_role: thread.agentRole === undefined ? null : (thread.agentRole as string | null),
      read_only: false,
      network: false,
      sandbox: 'workspace-write',
      approval: 'never',
      write_roots: [run.brief.copy_root],
      exclude_slash_tmp: true,
      exclude_tmpdir: true,
      forked_from: null,
      initial_turns: 0,
      receipt,
    };
  }
  private config(run: CoderRun) {
    return {
      model_reasoning_effort: run.brief.profile.effort,
      features: { apps: false, plugins: false, multi_agent: false },
      web_search: 'disabled',
      sandbox_workspace_write: {
        writable_roots: [run.brief.copy_root],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      shell_environment_policy: {
        inherit: 'none',
        include_only: ['PATH', 'LANG', 'LC_ALL'],
        set: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: run.brief.copy_root },
      },
    };
  }
  async create(run: CoderRun) {
    const refused = coderCreationRefusal(this.directory, this.journal, run);
    if (refused !== null) return refused;
    requireWorkflow(
      nativeCreationProof(this.journal, `coder:${run.brief.id}:create`) === null,
      'native-creation-already-attempted',
    );
    try {
      await this.noMcp();
      const context =
        canonical({
          operation: `coder:${run.brief.id}:create`,
          policy: this.policy,
          brief: run.brief,
        }) + '\n';
      const path = resolve(this.directory, 'creation-policy.json');
      if (existsSync(path))
        requireWorkflow(
          readPrivateFile(path).toString('utf8') === context,
          'coder-creation-policy-conflict',
        );
      else await writeFile(path, context, { flag: 'wx', mode: 0o600 });
      await this.beforeTurn(run);
    } catch (error) {
      return refuseCoderCreation(
        this.directory,
        this.journal,
        run,
        error instanceof Error ? error.message : 'unknown',
      );
    }
    const response = await this.rpc.request('thread/start', {
      projectId: null,
      cwd: run.brief.copy_root,
      runtimeWorkspaceRoots: [run.brief.copy_root],
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      selectedCapabilityRoots: [],
      ephemeral: false,
      allowProviderModelFallback: false,
      model: run.brief.profile.model,
      multiAgentMode: 'explicitRequestOnly',
      config: this.config(run),
    });
    const proof = nativeCreationProof(this.journal, `coder:${run.brief.id}:create`);
    requireWorkflow(
      proof?.response !== null &&
        proof?.response !== undefined &&
        proof.source !== null &&
        sameValue(object(proof.response).result, response),
      'coder-native-creation-unconfirmed',
    );
    this.owned = this.session(run, response, proof.source, this.policy);
    return { outcome: 'created' as const, session: this.owned };
  }
  async recoverCreate(run: CoderRun) {
    const refused = coderCreationRefusal(this.directory, this.journal, run);
    if (refused !== null) return refused;
    const proof = nativeCreationProof(this.journal, `coder:${run.brief.id}:create`);
    if (
      proof?.response === null ||
      proof?.response === undefined ||
      proof.source === null ||
      proof.response.result === undefined
    )
      return null;
    const context = object(
      JSON.parse(
        readPrivateFile(resolve(this.directory, 'creation-policy.json')).toString('utf8'),
      ) as unknown,
    );
    requireWorkflow(
      context.operation === `coder:${run.brief.id}:create` && sameValue(context.brief, run.brief),
      'coder-creation-policy-conflict',
    );
    const policy = object(context.policy) as unknown as InputRef;
    requireWorkflow(
      digest(readPrivateFile(policy.locator)) === policy.hash,
      'coder-creation-policy-conflict',
    );
    return {
      outcome: 'created' as const,
      session: this.session(run, proof.response.result, proof.source, policy),
    };
  }
  private native(run: CoderRun) {
    return new AppServerSessions(
      this.rpc,
      run.brief.copy_root,
      run.brief.project_id,
      this.directory,
      null,
      null,
    );
  }
  private query(run: CoderRun): DataQuery {
    requireWorkflow(run.writer !== null, 'coder-writer-missing');
    return {
      kind: 'unknown-source',
      question: 'LOAD coder',
      scope: run.brief.paths,
      sources: run.brief.files,
      criterion: run.brief.criterion,
      format: 'native LOAD',
      rules: run.brief.rules,
      procedures: selectedProcedures(run.writer.spec),
      entrypoints: run.brief.files.map((file) => file.locator),
    };
  }
  private async thread(run: CoderRun) {
    requireWorkflow(run.session !== null, 'coder-session-missing');
    const thread = object(
      object(
        await this.rpc.request('thread/read', { threadId: run.session.id, includeTurns: true }),
      ).thread,
    );
    requireWorkflow(
      thread.id === run.session.id && Array.isArray(thread.turns),
      'coder-native-thread-mismatch',
    );
    return thread;
  }
  private async turn(run: CoderRun, id: string) {
    const thread = await this.thread(run);
    const turn = (thread.turns as unknown[]).map(object).find((turn) => turn.id === id);
    requireWorkflow(turn !== undefined && Array.isArray(turn.items), 'coder-native-turn-missing');
    return turn;
  }
  private async wait(run: CoderRun, id: string) {
    if (this.started.has(id)) await this.rpc.completed(run.session!.id, id);
    let turn = await this.turn(run, id);
    if (turn.status === 'inProgress') {
      await this.rpc.completed(run.session!.id, id);
      turn = await this.turn(run, id);
    }
    requireWorkflow(
      ['completed', 'failed', 'interrupted'].includes(String(turn.status)),
      'coder-native-turn-not-terminal',
    );
    return turn;
  }
  private async idleThread(run: CoderRun) {
    requireWorkflow(
      run.session !== null &&
        run.writer?.loaded === null &&
        ['load', 'implementation'].every(
          (kind) =>
            readDeliveryReceipt(this.journal, run.session!.id, `coder:${run.brief.id}:${kind}`) ===
            null,
        ),
      'coder-writer-runtime-unbound',
    );
    const thread = await this.thread(run),
      turns = (thread.turns as unknown[]).map(object);
    const profile = readDeliveryReceipt(
      this.journal,
      run.session.id,
      `coder:${run.brief.id}:profile`,
    );
    requireWorkflow(
      turns.length === 0
        ? profile === null
        : turns.length === 1 &&
            profile?.outcome === 'accepted' &&
            ['completed', 'failed', 'interrupted'].includes(String(turns[0]!.status)) &&
            Array.isArray(turns[0]!.items) &&
            (turns[0]!.items as unknown[])
              .map(object)
              .every((item) =>
                ['userMessage', 'agentMessage', 'reasoning'].includes(String(item.type)),
              ) &&
            (await this.native(run).recoverSend(run.session, `coder:${run.brief.id}:profile`)) ===
              turns[0]!.id,
      'coder-writer-runtime-unbound',
    );
    await this.unchanged(run);
    return thread;
  }
  private async reconcileIdleStop(run: CoderRun) {
    const path = resolve(this.directory, 'unconfirmed-stop.json');
    if (!existsSync(path)) return;
    requireWorkflow(run.session !== null, 'coder-session-missing');
    const unknown = { locator: path, hash: digest(readPrivateFile(path)) };
    const recovered = resolve(this.directory, 'idle-stop-recovery.json');
    if (existsSync(recovered)) {
      const proof = object(JSON.parse(readPrivateFile(recovered).toString('utf8')) as unknown);
      requireWorkflow(
        proof.kind === 'coder-idle-stop-recovery' &&
          proof.session === run.session.id &&
          sameValue(proof.unknown, unknown) &&
          sameValue(proof.creation, run.session.receipt) &&
          Array.isArray(object(proof.thread).turns),
        'coder-stop-scope-unconfirmed',
      );
      return;
    }
    let thread: Record<string, unknown>;
    try {
      thread = await this.idleThread(run);
    } catch {
      throw new Error('coder-stop-scope-unconfirmed');
    }
    const creation = nativeCreationProof(this.journal, `coder:${run.brief.id}:create`);
    requireWorkflow(
      creation?.source !== null &&
        creation?.source !== undefined &&
        sameValue(creation.source, run.session.receipt),
      'coder-native-creation-unconfirmed',
    );
    await writeFile(
      recovered,
      canonical({
        kind: 'coder-idle-stop-recovery',
        session: run.session.id,
        unknown,
        creation: run.session.receipt,
        thread,
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  }
  private async bound(run: CoderRun) {
    await this.reconcileIdleStop(run);
    let loaded = object(await this.rpc.request('thread/loaded/list', { limit: 100 }));
    if (
      run.session !== null &&
      Array.isArray(loaded.data) &&
      !loaded.data.includes(run.session.id)
    ) {
      const thread = await this.idleThread(run);
      await this.unchanged(run);
      await this.beforeTurn(run);
      const creation = nativeCreationProof(this.journal, `coder:${run.brief.id}:create`);
      requireWorkflow(
        creation?.source !== null &&
          creation?.source !== undefined &&
          sameValue(creation.source, run.session.receipt),
        'coder-native-creation-unconfirmed',
      );
      const response = await this.rpc.request('thread/resume', {
        threadId: run.session.id,
        cwd: run.brief.copy_root,
        runtimeWorkspaceRoots: [run.brief.copy_root],
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        model: run.brief.profile.model,
        excludeTurns: false,
        config: this.config(run),
      });
      const restored = this.session(
        run,
        response,
        run.session.receipt,
        run.session.policy,
        thread.turns as unknown[],
      );
      requireWorkflow(restored.id === run.session.id, 'coder-native-thread-mismatch');
      this.owned = restored;
      this.bindings.push(
        await this.proof('idle-resume', {
          kind: 'coder-idle-resume',
          creation: run.session.receipt,
          policy: this.policy,
          response,
        }),
      );
      loaded = object(await this.rpc.request('thread/loaded/list', { limit: 100 }));
    }
    requireWorkflow(
      run.session !== null &&
        Array.isArray(loaded.data) &&
        loaded.data.includes(run.session.id) &&
        (loaded.nextCursor === null || loaded.nextCursor === undefined),
      'coder-writer-runtime-unbound',
    );
    await this.noMcp(run.session!.id);
  }
  private async delivery(run: CoderRun, id: string, prompt: string): Promise<string> {
    requireWorkflow(run.session !== null, 'coder-session-missing');
    const native = this.native(run),
      turn =
        readDeliveryReceipt(this.journal, run.session.id, id) === null
          ? null
          : await native.recoverSend(run.session, id);
    if (turn !== null) return turn;
    requireWorkflow(
      readDeliveryReceipt(this.journal, run.session.id, id) === null,
      'coder-send-outcome-unknown',
    );
    await this.bound(run);
    await this.beforeTurn(run);
    const response = object(
      await this.rpc.request('turn/start', {
        threadId: run.session.id,
        input: [{ type: 'text', text: `Workflow delivery id: ${JSON.stringify(id)}\n${prompt}` }],
        model: run.brief.profile.model,
        effort: run.brief.profile.effort,
        approvalPolicy: 'never',
        multiAgentMode: 'explicitRequestOnly',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [run.brief.copy_root],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        environments: [
          {
            environmentId: 'local',
            cwd: run.brief.copy_root,
            runtimeWorkspaceRoots: [run.brief.copy_root],
          },
        ],
      }),
    );
    const created = textField(object(response.turn).id);
    this.started.add(created);
    return created;
  }
  private async profile(run: CoderRun, turnId: string): Promise<InputRef> {
    const thread = await this.thread(run),
      path = textField(thread.path);
    requireWorkflow(isAbsolute(path), 'coder-native-transcript-unknown');
    const bytes = await readFile(path, 'utf8');
    requireWorkflow(bytes.endsWith('\n'), 'coder-native-transcript-partial');
    const lines = bytes.slice(0, -1).split('\n');
    const records = lines.map((line, index) => ({
      record: object(JSON.parse(line) as unknown),
      ref: { locator: `${path}#L${index + 1}`, hash: digest(line + '\n') },
    }));
    const sessions = records.filter((entry) => entry.record.type === 'session_meta');
    requireWorkflow(sessions.length === 1, 'coder-native-identity-unknown');
    const session = object(sessions[0]!.record.payload);
    requireWorkflow(
      session.id === run.session!.id &&
        session.session_id === run.session!.id &&
        session.cwd === run.brief.copy_root &&
        session.thread_source !== 'subagent',
      'coder-native-identity-mismatch',
    );
    const contexts = records.filter((entry) => entry.record.type === 'turn_context');
    const start = contexts.findIndex((entry) => object(entry.record.payload).turn_id === turnId);
    const observation = await this.proof('effective-profile', {
      kind: 'coder-profile',
      session: run.session!.id,
      creation: run.session!.receipt,
      contexts,
      expected_turn: turnId,
      operation: run.brief.id,
      bindings: this.bindings,
      policy: this.policy,
    });
    this.profileObservation = observation;
    requireWorkflow(start >= 0, 'coder-native-context-missing');
    for (const entry of contexts.slice(start)) {
      const context = object(entry.record.payload),
        sandbox = object(context.sandbox_policy),
        profile = object(context.permission_profile);
      const filesystem = object(profile.file_system);
      requireWorkflow(
        context.cwd === run.brief.copy_root &&
          context.model === run.brief.profile.model &&
          context.effort === run.brief.profile.effort &&
          context.approval_policy === 'never' &&
          sandbox.type === 'workspace-write' &&
          sandbox.network_access === false &&
          sandbox.exclude_slash_tmp === true &&
          sandbox.exclude_tmpdir_env_var === true &&
          profile.type === 'managed' &&
          profile.network === 'restricted' &&
          filesystem.type === 'restricted' &&
          Array.isArray(filesystem.entries),
        'coder-native-profile-unconfirmed',
      );
      const writes = filesystem.entries.map(object).filter((entry) => entry.access !== 'read');
      requireWorkflow(
        writes.length > 0 &&
          writes.every(
            (entry) =>
              entry.access === 'write' &&
              sameValue(entry.path, { type: 'path', path: run.brief.copy_root }),
          ),
        'coder-native-write-roots-unconfirmed',
      );
    }
    await this.noMcp(run.session!.id);
    return observation;
  }
  async load(run: CoderRun, _fresh: boolean): Promise<LoadReceipt> {
    requireWorkflow(run.session !== null && run.writer !== null, 'coder-session-missing');
    const probe = await this.delivery(
      run,
      `coder:${run.brief.id}:profile`,
      'Проверка профиля перед LOAD. Не выполняй поручение, не вызывай инструменты, не меняй файлы и не запускай помощников. Ответь только: профиль ожидает проверки хостом.',
    );
    requireWorkflow(
      (await this.wait(run, probe)).status === 'completed',
      'coder-profile-probe-failed',
    );
    const profile = await this.profile(run, probe);
    await this.unchanged(run);
    const procedures = selectedProcedures(run.writer.spec),
      refs = [...procedures, ...run.brief.rules].map(({ locator, hash }) => ({ locator, hash }));
    const prompt = `Формальный LOAD, только чтение. Поручение пока не выполняй. Для каждого перечисленного файла выведи инструментом полную отдельную строку JSON {"path":"...","sha256":"...","content":"полный текст"}; обрезанный вывод не подтверждает чтение. Источники внутри текущей копии: ${JSON.stringify(refs)}. Затем кратко подтверди чтение.`;
    const turn = await this.delivery(run, `coder:${run.brief.id}:load`, prompt);
    await this.wait(run, turn);
    await this.profile(run, turn);
    const query = this.query(run);
    const native = await this.native(run).observeLoad(run.session, query, turn);
    return {
      run_id: run.writer.spec.run_id,
      session_id: run.session.id,
      procedures,
      rules: run.brief.rules,
      observed_read: native.locator,
      native,
      origin: await this.proof('coder-origin', {
        creation: run.session.receipt,
        profile,
        load: native,
      }),
    };
  }
  async send(run: CoderRun, _fresh: boolean): Promise<string> {
    requireWorkflow(run.writer?.status === 'ready' && run.delivery !== null, 'coder-not-ready');
    const profileTurn = await this.native(run).recoverSend(
      run.session!,
      `coder:${run.brief.id}:load`,
    );
    requireWorkflow(profileTurn !== null, 'coder-load-turn-unknown');
    await this.profile(run, profileTurn);
    requireWorkflow(
      run.writer.loaded?.native !== undefined &&
        (await this.native(run).reuseLoad(
          run.session!,
          this.query(run),
          run.writer.loaded.native,
        )) !== null,
      'coder-load-stale-or-compacted',
    );
    return this.delivery(
      run,
      run.delivery,
      `Ты ограниченный coder, не самостоятельный координатор. Ты не один в проекте: сохраняй чужие изменения и учитывай их. Владение только путями ${JSON.stringify(run.brief.paths)} внутри ${run.brief.copy_root}. Основное дерево ${run.brief.source_root}, карточка, Store родителя, конфигурация, секреты и внешние сервисы недоступны для записи. Не делегируй, не принимай свою работу и не публикуй. До этого хост проверил LOAD и исходные байты. Копия подготовлена без Git; исходные версии и владение проверяет родитель. Цель: ${run.brief.goal}. Критерий: ${run.brief.criterion}. Источники: ${JSON.stringify(run.brief.files)}. Разрешённые проверки: ${JSON.stringify(run.brief.checks)}. Верни только JSON {"summary":"фактический результат","errors":[],"limitations":[]}. Фактические команды и diff проверит родитель. При ошибке укажи её; самоприёмка запрещена.`,
    );
  }
  async result(run: CoderRun): Promise<CoderResult> {
    requireWorkflow(run.turn !== null, 'coder-turn-missing');
    const turn = await this.wait(run, run.turn);
    const messages = (turn.items as unknown[])
      .map(object)
      .filter((item) => item.type === 'agentMessage');
    let result: Record<string, unknown>;
    try {
      result = object(JSON.parse(textField(messages.at(-1)?.text)));
      textField(result.summary);
    } catch {
      result = {
        summary: 'Native result is not structured',
        errors: ['coder-result-invalid'],
        limitations: [],
      };
    }
    const errors =
      Array.isArray(result.errors) &&
      result.errors.every((value) => typeof value === 'string' && value.trim().length > 0)
        ? (result.errors as string[])
        : ['coder-errors-unknown'];
    const limitationsKnown =
      Array.isArray(result.limitations) &&
      result.limitations.every((value) => typeof value === 'string' && value.trim().length > 0);
    const limitations = limitationsKnown
      ? (result.limitations as string[])
      : ['coder-limitations-unknown'];
    if (!limitationsKnown) errors.push('coder-limitations-unknown');
    if (turn.status !== 'completed') errors.push(`native-turn:${String(turn.status)}`);
    try {
      const loaded = await this.native(run).recoverSend(run.session!, `coder:${run.brief.id}:load`);
      requireWorkflow(loaded !== null, 'coder-load-turn-unknown');
      await this.profile(run, loaded);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'coder-profile-unknown');
    }
    const load = run.writer?.loaded?.native;
    if (
      load === undefined ||
      (await this.native(run).reuseLoad(run.session!, this.query(run), load)) === null
    )
      errors.push('coder-load-stale-or-compacted');
    const evidence = await this.proof('result', {
      session: run.session!.id,
      turn,
      profile: this.profileObservation,
      errors,
    });
    const checks: CoderResult['checks'] = [];
    for (const raw of turn.items as unknown[]) {
      const item = object(raw);
      if (item.type !== 'commandExecution' || !run.brief.checks.includes(String(item.command)))
        continue;
      const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
      checks.push({
        command: textField(item.command),
        exit_code: exit,
        evidence: await this.proof('check', item),
      });
    }
    return {
      outcome:
        errors.length === 0 && checks.every((check) => check.exit_code === 0) ? 'PASS' : 'FAIL',
      evidence,
      checks,
      errors,
      limitations,
    };
  }
  private async processScope(run: CoderRun) {
    const bytes = readPrivateFile(this.policy.locator);
    requireWorkflow(digest(bytes) === this.policy.hash, 'coder-policy-changed');
    const policy = object(JSON.parse(bytes.toString('utf8')) as unknown);
    requireWorkflow(policy.runtime !== undefined, 'writer-process-binding-missing');
    const runtime = object(policy.runtime);
    requireWorkflow(
      Number.isSafeInteger(runtime.pid) &&
        typeof runtime.parent === 'number' &&
        typeof runtime.started === 'string' &&
        runtime.started.length > 0,
      'writer-process-binding-missing',
    );
    const root = runtime as unknown as ProcessIdentity;
    return ownedRuntimeProcesses(this.rpc, this.processes, root, run.session!.id, this.policy);
  }
  async observeLiveWriter(run: CoderRun) {
    const { session, turn } = run;
    const deliveryId = `coder:${run.brief.id}:implementation`;
    requireWorkflow(
      session !== null &&
        run.copy !== null &&
        run.status === 'running' &&
        turn !== null &&
        run.delivery === deliveryId,
      'coder-live-writer-unbound',
    );
    const delivery = readDeliveryReceipt(this.journal, session.id, deliveryId);
    requireWorkflow(
      delivery?.outcome === 'accepted' &&
        delivery.attempts === 1 &&
        delivery.responses === 1 &&
        (await this.native(run).recoverSend(session, deliveryId)) === turn,
      'coder-live-delivery-unconfirmed',
    );
    const scope = await this.processScope(run);
    const processes = await scope.processes.descendants([]);
    const loaded = object(await this.rpc.request('thread/loaded/list', { limit: 100 }));
    requireWorkflow(
      sameValue(loaded.data, [session.id]) &&
        (loaded.nextCursor === null || loaded.nextCursor === undefined),
      'coder-live-writer-unbound',
    );
    const thread = await this.thread(run);
    const active = (thread.turns as unknown[])
      .map(object)
      .filter((entry) => entry.status === 'inProgress');
    requireWorkflow(active.length === 1 && active[0]!.id === turn, 'coder-live-turn-unconfirmed');
    return {
      thread: session.id,
      turn,
      delivery,
      native: { active: { id: active[0]!.id, status: active[0]!.status }, loaded },
      runtime: scope.runtime,
      processes,
    };
  }
  async stop(run: CoderRun): Promise<InputRef> {
    requireWorkflow(run.session !== null && run.copy !== null, 'coder-session-missing');
    const thread = await this.thread(run),
      turns = (thread.turns as unknown[]).map(object);
    const known: string[] = [];
    for (const delivery of ['profile', 'load', 'implementation']) {
      const turn = await this.native(run).recoverSend(
        run.session,
        `coder:${run.brief.id}:${delivery}`,
      );
      requireWorkflow(
        turn !== null ||
          readDeliveryReceipt(this.journal, run.session.id, `coder:${run.brief.id}:${delivery}`) ===
            null,
        'coder-send-outcome-unknown',
      );
      if (turn !== null) known.push(turn);
    }
    requireWorkflow(
      new Set(known).size === turns.length &&
        turns.every((turn) => known.includes(String(turn.id))),
      'coder-native-turns-unknown',
    );
    await this.reconcileIdleStop(run);
    const scope = await this.processScope(run);
    const path = resolve(this.directory, `stopped-${digest(canonical(known.slice().sort()))}.json`);
    if (existsSync(path)) {
      const bytes = readPrivateFile(path),
        proof = object(JSON.parse(bytes.toString('utf8'))),
        owned = object(proof.owned),
        previous = object(object(owned.runtime).process);
      requireWorkflow(
        Number.isSafeInteger(previous.pid) &&
          typeof previous.parent === 'number' &&
          typeof previous.started === 'string' &&
          (sameValue(previous, scope.runtime.process) ||
            (await this.processes.alive([previous as unknown as ProcessIdentity])).length === 0),
        'coder-stop-receipt-unconfirmed',
      );
      requireWorkflow(
        proof.kind === 'writers-stopped' &&
          proof.thread === run.session.id &&
          proof.active_turn === false &&
          proof.remaining_terminals === 0 &&
          proof.remaining_processes === 0 &&
          proof.before_hash === proof.after_hash &&
          owned.tree === run.brief.copy_root &&
          owned.complete === true &&
          sameValue(owned.markers, [run.copy.evidence.locator, run.session.receipt.locator]) &&
          Array.isArray(owned.markers) &&
          (await writerScopeHash(owned.markers as string[], run.brief.copy_root)) ===
            proof.after_hash &&
          Array.isArray(proof.processes) &&
          (await scope.processes.alive(proof.processes as ProcessIdentity[])).length === 0,
        'coder-stop-receipt-unconfirmed',
      );
      const loaded = object(await this.rpc.request('thread/loaded/list', { limit: 100 }));
      requireWorkflow(
        Array.isArray(loaded.data) &&
          (loaded.nextCursor === null || loaded.nextCursor === undefined),
        'coder-writer-runtime-unbound',
      );
      let noTerminals = !loaded.data.includes(run.session.id);
      if (!noTerminals) {
        const current = object(
          await this.rpc.request('thread/backgroundTerminals/list', {
            threadId: run.session.id,
            limit: 100,
          }),
        );
        noTerminals =
          Array.isArray(current.data) &&
          current.data.length === 0 &&
          (current.nextCursor === null || current.nextCursor === undefined);
      }
      requireWorkflow(
        turns.every((turn) =>
          ['completed', 'failed', 'interrupted'].includes(String(turn.status)),
        ) && noTerminals,
        'coder-writers-still-active',
      );
      return { locator: path, hash: digest(bytes) };
    }
    await this.bound(run);
    const active = turns.filter((turn) => turn.status === 'inProgress');
    requireWorkflow(active.length <= 1, 'coder-turns-unknown');
    const turn = active[0]?.id ?? run.turn ?? turns.at(-1)?.id ?? null;
    requireWorkflow(turn === null || typeof turn === 'string', 'coder-turns-unknown');
    const raw = object(
      await this.rpc.request('thread/backgroundTerminals/list', {
        threadId: run.session.id,
        limit: 100,
      }),
    );
    requireWorkflow(
      Array.isArray(raw.data) && (raw.nextCursor === null || raw.nextCursor === undefined),
      'coder-terminals-incomplete',
    );
    const terminals = raw.data.map(object).map((item) => ({
      process: textField(item.processId),
      pid: item.osPid === null ? null : Number(item.osPid),
    }));
    const bindings = [];
    if (terminals.some((terminal) => terminal.pid === null)) {
      const writers = await scope.processes.descendants([]);
      requireWorkflow(writers.length > 0, 'writer-process-binding-missing');
      for (const terminal of terminals.filter((entry) => entry.pid === null)) {
        const evidence = await this.proof('process-binding', {
          kind: 'process-binding',
          thread: run.session.id,
          terminal: terminal.process,
          scope_complete: true,
          processes: writers,
          runtime: scope.runtime.process,
          policy: this.policy,
          inventory: raw,
        });
        bindings.push({ terminal: terminal.process, processes: writers, evidence });
      }
    }
    return new AppServerWriters(this.rpc, scope.processes).stop(
      {
        thread: run.session.id,
        turn,
        terminals,
        bindings,
        runtime: scope.runtime,
        markers: [run.copy.evidence.locator, run.session.receipt.locator],
        tree: run.brief.copy_root,
        complete: true,
      },
      path,
    );
  }
  async stopOwned(run: CoderRun): Promise<void> {
    if (this.owned === null || run.copy === null) return;
    const bound = { ...run, session: this.owned };
    try {
      await this.stop(bound);
    } catch (error) {
      const receipt = await this.proof('stop-unknown', {
        kind: 'coder-stop-unknown',
        session: this.owned.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      const path = resolve(this.directory, 'unconfirmed-stop.json');
      if (!existsSync(path))
        await writeFile(path, canonical({ session: this.owned.id, receipt }), {
          flag: 'wx',
          mode: 0o600,
        });
    }
  }
}
