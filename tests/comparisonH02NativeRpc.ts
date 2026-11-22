import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { StdioAppServer, type AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { AppServerWriters, ownedRuntimeProcesses } from '../adapters/codex/appServerWriters.js';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { writerScopeHash } from '../adapters/project/writerScope.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import { comparisonCompaction } from '../adapters/codex/comparisonCompaction.js';
import type { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { verifyNativeCompactionBarrier } from './comparisonH01Guard.js';
import { readComparisonUsage } from '../adapters/codex/comparisonUsage.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import {
  h01ReadJson,
  h01ReadPin,
  h01RawFile,
  h01Record,
  comparisonKind,
  type H01AttemptContext,
  type H01ModelStart,
} from './comparisonH01Contract.js';

export interface H02NativeRpcOptions {
  stage?: 'execution';
  startForTurn?(params: Record<string, unknown>): Promise<H01ModelStart>;
  observe?(message: Record<string, unknown>): void;
  resume?: InputRef;
}
export interface H02NativeRpc {
  rpc: AppServerRpc;
  compact?(host: Pick<FileCurrentChatHost, 'compaction'>): Promise<InputRef>;
  readonly compactionEvidence?: InputRef | null;
  stop(): Promise<InputRef>;
  detachForRecovery?(): Promise<InputRef>;
  evidence: InputRef[];
}

/** One owned native transport and at most one fresh reader; no automatic retry or grant. */
export function createH02NativeRpc(
  ctx: H01AttemptContext,
  label: string,
  options: H02NativeRpcOptions = {},
): H02NativeRpc {
  requireWorkflow(
    ((ctx.criteria.value.id === 'H-02' && options.stage === undefined) ||
      ((ctx.criteria.value.id === 'H-03' ||
        ctx.criteria.value.id === 'H-04' ||
        ctx.criteria.value.id === 'H-05') &&
        options.stage === 'execution')) &&
      /^[A-Za-z0-9_-]{1,96}$/u.test(label),
    'h02-native-rpc-context',
  );
  const scenario = ctx.criteria.value.id,
    stage = scenario === 'H-02' ? 'council' : 'execution';
  const workspace = ctx.roots.workspaceRoot,
    evidenceRoot = ctx.roots.evidenceRoot,
    directory = join(evidenceRoot, 'native-rpc-' + label);
  const profile = structuredClone(ctx.profile),
    binary = structuredClone(ctx.binary),
    disabled = [...(ctx.disabledMcpServers ?? [])];
  const observer = ctx.nativeObserver,
    processes = new NativeWriterProcesses(),
    evidence: InputRef[] = [];
  const deadline = ctx.deadlineNs,
    workDeadline = ctx.workDeadlineNs;
  const binding = canonical({
    opId: ctx.opId,
    requestHash: ctx.requestHash,
    roots: ctx.roots,
    profile,
    binary,
    control: observer.controlRef,
    deadline,
    workDeadline,
    disabled,
    scenario,
    stage,
  });
  const record = (kind: string, value: unknown) => {
    const ref = h01Record(
      evidenceRoot,
      scenario.replace('-', '').toLowerCase() + '-' + label + '-' + kind,
      value,
    );
    evidence.push(ref);
    return ref;
  };
  const recovery = options.resume === undefined ? null : object(h01ReadJson(options.resume));
  const retiredProcesses: ProcessIdentity[] = [];
  const recoveryCheck = () => {
    requireWorkflow(
      scenario === 'H-05' && recovery !== null && options.resume !== undefined,
      'h05-recovery-scenario',
    );
    h01ReadPin(options.resume);
    requireWorkflow(
      recovery.kind === 'comparison-h05-recovery-binding' &&
        recovery.opId === ctx.opId &&
        recovery.requestHash === ctx.requestHash &&
        recovery.binding === binding,
      'h05-recovery-binding',
    );
    const stopped = object(h01ReadJson(recovery.stop as InputRef));
    requireWorkflow(
      stopped.kind === 'comparison-h05-stop' &&
        stopped.opId === ctx.opId &&
        stopped.confirmed === true &&
        stopped.readersStopped === true &&
        stopped.transportClosed === true &&
        canonical(stopped.sessions) === canonical([recovery.session]) &&
        canonical(stopped.remainingProcesses) === canonical([]),
      'h05-recovery-stop',
    );
    const processStops = (stopped.evidence as InputRef[])
      .map((ref) => object(h01ReadJson(ref)))
      .filter((value) => value.kind === 'h02-native-process-stop');
    requireWorkflow(
      processStops.length === 1 &&
        processStops[0]!.confirmed === true &&
        Array.isArray(processStops[0]!.processes) &&
        processStops[0]!.processes.length > 0,
      'h05-recovery-process-stop',
    );
    retiredProcesses.splice(
      0,
      retiredProcesses.length,
      ...(processStops[0]!.processes as ProcessIdentity[]),
    );
    const savedPrefix = object(recovery.prefix),
      bytes = h01RawFile(textField(recovery.transcript));
    requireWorkflow(
      bytes.length === savedPrefix.bytes && digest(bytes) === savedPrefix.hash,
      'h05-recovery-prefix',
    );
    requireWorkflow(
      observer.assertRecoveryParticipant !== undefined,
      'h05-recovery-guard-required',
    );
    observer.assertRecoveryParticipant(
      textField(recovery.session),
      recovery.creation as InputRef,
      textField(recovery.transcript),
    );
  };
  if (recovery !== null) recoveryCheck();
  let raw: StdioAppServer | undefined,
    initial: ProcessIdentity | undefined,
    creation: InputRef | undefined,
    session: string | undefined,
    transcript: string | undefined,
    models: unknown;
  let knownPath: InputRef | undefined, knownTurn: string | undefined;
  let resumed = recovery === null;
  if (recovery !== null) {
    session = textField(recovery.session);
    creation = recovery.creation as InputRef;
    transcript = textField(recovery.transcript);
    knownPath =
      recovery.pathObservation === null ? undefined : (recovery.pathObservation as InputRef);
    knownTurn = textField(recovery.turn);
    evidence.push(options.resume!, recovery.stop as InputRef);
  }
  let ready: Promise<void> | undefined,
    stopping = false,
    invalid = false,
    ordinal = 0,
    stopPromise: Promise<InputRef> | undefined,
    compactPromise: Promise<InputRef> | undefined,
    compactionEvidence: InputRef | null = null;
  const remaining = (work: boolean) =>
    Math.floor(Number(BigInt(work ? workDeadline : deadline) - process.hrtime.bigint()) / 1e6);
  const working = () => {
    ctx.signal.throwIfAborted();
    requireWorkflow(!stopping && !invalid && remaining(true) > 0, 'h02-native-rpc-frozen');
    requireWorkflow(
      binding ===
        canonical({
          opId: ctx.opId,
          requestHash: ctx.requestHash,
          roots: ctx.roots,
          profile: ctx.profile,
          binary: ctx.binary,
          control: observer.controlRef,
          deadline: ctx.deadlineNs,
          workDeadline: ctx.workDeadlineNs,
          disabled: ctx.disabledMcpServers ?? [],
          scenario: ctx.criteria.value.id,
          stage,
        }),
      'h02-native-rpc-binding-changed',
    );
  };
  const bounded = <T>(work: Promise<T>, active: boolean): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('h02-native-rpc-deadline')),
        Math.max(1, remaining(active)),
      );
      abort = () => reject(new Error('h02-native-rpc-cancelled'));
      if (active) ctx.signal.addEventListener('abort', abort, { once: true });
    });
    return Promise.race([work, interruption]).finally(() => {
      clearTimeout(timeout);
      if (active) ctx.signal.removeEventListener('abort', abort);
    });
  };
  const ensure = () =>
    (ready ??= (async () => {
      working();
      await bounded(observer.verify(), true);
      working();
      h01ReadPin(binary);
      working();
      if (recovery !== null) {
        recoveryCheck();
        requireWorkflow(
          (await bounded(processes.alive(retiredProcesses), true)).length === 0,
          'h05-recovery-process-live',
        );
        working();
        recoveryCheck();
      }
      mkdirSync(directory, { mode: 0o700 });
      const sourceArguments = [
        binary.locator,
        [
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.multi_agent=false',
          '-c',
          'web_search="disabled"',
          ...disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
          'app-server',
          '--stdio',
        ] as string[],
        workspace,
        join(directory, 'transport.jsonl'),
        ctx.opId + '-' + label,
      ] as const;
      raw =
        scenario === 'H-05'
          ? new StdioAppServer(...sourceArguments, join(directory, 'primary.jsonl'))
          : new StdioAppServer(...sourceArguments);
      if (options.observe) raw.observe((message) => options.observe!(structuredClone(message)));
      requireWorkflow(typeof raw.pid === 'number' && raw.pid > 1, 'h02-native-rpc-pid-unknown');
      const observed = await bounded(processes.descendants([raw.pid]), true);
      initial = observed.find((item) => item.pid === raw!.pid && item.parent === process.pid);
      requireWorkflow(initial !== undefined, 'h02-native-rpc-process-unconfirmed');
      record('process', { kind: 'h02-native-rpc-process', label, initial });
      working();
      await bounded(raw.initialize(), true);
      working();
      models = await bounded(raw.request('model/list', {}), true);
      working();
      const data = object(models).data;
      requireWorkflow(
        Array.isArray(data) &&
          data
            .map(object)
            .some(
              (model) =>
                model.model === profile.model &&
                Array.isArray(model.supportedReasoningEfforts) &&
                model.supportedReasoningEfforts
                  .map(object)
                  .some((effort) => effort.reasoningEffort === profile.effort),
            ),
        'h02-native-rpc-model-unavailable',
      );
      record('models', { kind: 'h02-native-model-probe', profile, response: models });
      assertCoderCapabilities(
        await bounded(
          raw.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
          true,
        ),
        disabled,
      );
      working();
    })());
  const capability = async () => {
    working();
    const response = await bounded(
      raw!.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
      true,
    );
    working();
    assertCoderCapabilities(response, disabled);
    observer.registerCapabilities({
      session: session!,
      disabled,
      evidence: record('capabilities', { kind: 'h01-native-capabilities', session, response }),
    });
  };
  const participant = (thread: Record<string, unknown>, pathObservation?: InputRef) => {
    if (typeof thread.path === 'string') {
      if (pathObservation !== undefined) knownPath = pathObservation;
      transcript = thread.path;
      observer.registerParticipant({
        session: session!,
        transcript: thread.path,
        run: ctx.opId,
        stage,
        creation: creation!,
        ...(knownPath === undefined ? {} : { pathObservation: knownPath }),
      });
    }
  };
  const request: AppServerRpc['request'] = async (method, params) => {
    try {
      requireWorkflow(
        recovery === null || ['thread/resume', 'thread/read'].includes(method),
        'h05-recovery-read-only',
      );
      requireWorkflow(resumed || method === 'thread/resume', 'h05-recovery-resume-required');
      requireWorkflow(
        scenario !== 'H-05' || method !== 'turn/start' || knownTurn === undefined,
        'h05-one-native-turn',
      );
      const cleanup = [
        'thread/read',
        'thread/loaded/list',
        'thread/backgroundTerminals/list',
        'thread/backgroundTerminals/terminate',
        'turn/interrupt',
      ].includes(method);
      requireWorkflow(
        cleanup ||
          [
            'thread/start',
            'thread/resume',
            'turn/start',
            'thread/name/set',
            'model/list',
            'mcpServerStatus/list',
          ].includes(method),
        'h02-native-rpc-method',
      );
      const check = () =>
        cleanup ? requireWorkflow(remaining(false) > 0, 'h02-native-rpc-deadline') : working();
      check();
      if (raw === undefined) {
        working();
        await ensure();
      } else
        await bounded(
          ready!.catch(() => {}),
          !cleanup,
        );
      check();
      const before = canonical(params);
      if (method === 'model/list') return structuredClone(models);
      if (method !== 'thread/start' && method !== 'mcpServerStatus/list')
        requireWorkflow(
          session !== undefined && (method === 'thread/loaded/list' || params.threadId === session),
          'h02-native-rpc-session',
        );
      let payload = structuredClone(params),
        start: H01ModelStart | undefined;
      if (method === 'thread/start' || method === 'thread/resume') {
        requireWorkflow(
          (method !== 'thread/start' || session === undefined) &&
            params.cwd === workspace &&
            params.sandbox === 'read-only' &&
            params.approvalPolicy === 'never' &&
            (params.model === undefined || params.model === profile.model),
          'h02-native-rpc-profile',
        );
        const config = object(params.config);
        requireWorkflow(config.model_reasoning_effort === profile.effort, 'h02-native-rpc-profile');
        payload = {
          ...payload,
          runtimeWorkspaceRoots: [workspace],
          selectedCapabilityRoots: [],
          multiAgentMode: 'explicitRequestOnly',
          allowProviderModelFallback: false,
          config: {
            ...config,
            features: { apps: false, plugins: false, multi_agent: false },
            web_search: 'disabled',
            sandbox_read_only: { network_access: false },
            shell_environment_policy: {
              inherit: 'none',
              include_only: ['PATH', 'LANG', 'LC_ALL'],
              set: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: workspace },
            },
          },
        };
        await bounded(observer.verify(), true);
        working();
      }
      if (method === 'turn/start') {
        requireWorkflow(
          (params.model === undefined || params.model === profile.model) &&
            (params.effort === undefined || params.effort === profile.effort),
          'h02-native-rpc-profile',
        );
        await capability();
        start =
          options.startForTurn === undefined
            ? {
                origin: 'legacy',
                stage,
                session: session!,
                key: digest(canonical([ctx.opId, label, ++ordinal, params])),
                hash: digest(canonical(params)),
              }
            : await bounded(options.startForTurn(payload), true);
        working();
        requireWorkflow(
          start.session === session &&
            start.stage === stage &&
            start.origin === (options.startForTurn === undefined ? 'legacy' : 'temporal-host') &&
            start.hash ===
              (start.origin === 'legacy'
                ? digest(canonical(params))
                : digest(JSON.stringify(params))),
          'h02-native-rpc-credit-binding',
        );
        await bounded(observer.beforeModelStart(start), true);
        working();
      }
      requireWorkflow(
        canonical(params) === before && (method !== 'turn/start' || canonical(payload) === before),
        'h02-native-rpc-request-changed',
      );
      check();
      const response = await bounded(raw!.request(method, payload), !cleanup);
      if (method === 'thread/loaded/list') {
        const loaded = object(response);
        requireWorkflow(
          Array.isArray(loaded.data) &&
            loaded.data.every((id) => id === session) &&
            (loaded.nextCursor === undefined || loaded.nextCursor === null),
          'h02-native-rpc-loaded-unknown',
        );
      }
      if (['thread/start', 'thread/resume', 'thread/read', 'turn/start'].includes(method)) {
        const proof = record('dispatch', {
          kind: 'h01-native-dispatch',
          method,
          params: payload,
          response,
          ...(start === undefined ? {} : { start }),
        });
        if (method === 'turn/start') {
          knownTurn = textField(object(object(response).turn).id);
          observer.confirmModelStart({
            key: start!.key,
            session: session!,
            turn: knownTurn,
            evidence: proof,
          });
        } else {
          const value = object(response),
            thread = object(value.thread),
            id = textField(thread.id);
          requireWorkflow(
            (session === undefined || session === id) &&
              thread.cwd === workspace &&
              thread.projectId === null &&
              thread.parentThreadId === null &&
              thread.forkedFromId === null,
            'h02-native-rpc-identity',
          );
          if (method === 'thread/start') {
            session = id;
            creation = proof;
            observer.registerCreation({ session, run: ctx.opId, stage, creation });
          }
          if (method === 'thread/start' || method === 'thread/resume') {
            requireWorkflow(
              value.model === profile.model &&
                value.reasoningEffort === profile.effort &&
                value.cwd === workspace &&
                value.approvalPolicy === 'never' &&
                object(value.sandbox).type === 'readOnly' &&
                object(value.sandbox).networkAccess === false,
              'h02-native-rpc-effective-profile',
            );
            if (method === 'thread/start')
              requireWorkflow(
                Array.isArray(thread.turns) && thread.turns.length === 0,
                'h02-native-rpc-history-not-empty',
              );
            await capability();
            if (method === 'thread/resume') resumed = true;
          }
          participant(thread, method === 'thread/read' ? proof : undefined);
        }
      }
      check();
      return response;
    } catch (error) {
      invalid = true;
      record('failure', { kind: 'h02-native-rpc-unknown', method });
      throw error;
    }
  };
  const rpc: AppServerRpc = {
    request,
    async completed(id, turn, signal, verify) {
      try {
        working();
        await ensure();
        requireWorkflow(session === id, 'h02-native-rpc-session');
        const combined = signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, signal]);
        await bounded(
          raw!.completed(id, turn, combined, async () => {
            await observer.verify();
            await verify?.();
            working();
          }),
          true,
        );
        working();
      } catch (error) {
        invalid = true;
        record('wait-failure', { kind: 'h02-native-wait-unknown', session: id, turn });
        throw error;
      }
    },
  };
  const compact = (host: Pick<FileCurrentChatHost, 'compaction'>): Promise<InputRef> =>
    (compactPromise ??= (async () => {
      try {
        working();
        requireWorkflow(
          scenario === 'H-03' &&
            stage === 'execution' &&
            session !== undefined &&
            transcript !== undefined &&
            observer.confirmCompaction !== undefined,
          'h03-native-compaction-context',
        );
        await capability();
        const text = readPrivateFile(transcript).toString();
        requireWorkflow(text.endsWith('\n') && text.length > 1, 'h03-native-transcript-partial');
        const lines = text.slice(0, -1).split('\n');
        const before: InputRef = {
          locator: transcript + '#L' + String(lines.length),
          hash: digest(lines.at(-1)! + '\n'),
        };
        verifyNativeCompactionBarrier({ session, transcript, run: ctx.opId, stage }, before);
        const params = { threadId: session },
          start: H01ModelStart = {
            origin: 'legacy',
            method: 'thread/compact/start',
            before,
            stage,
            session,
            key: digest(
              canonical([ctx.opId, label, ++ordinal, 'thread/compact/start', params, before]),
            ),
            hash: digest(canonical(params)),
          };
        await bounded(observer.beforeModelStart(start), true);
        working();
        const intent = record('compaction-dispatch', {
          kind: 'comparison-native-compaction-dispatch',
          method: 'thread/compact/start',
          scenario,
          opId: ctx.opId,
          start,
          params,
          before,
        });
        let sent = false;
        const boundary = await bounded(
          comparisonCompaction(
            {
              observe: (listener) => raw!.observe(listener),
              request: async (method, value) => {
                working();
                requireWorkflow(
                  !sent &&
                    method === 'thread/compact/start' &&
                    canonical(value) === canonical(params),
                  'h03-native-compaction-dispatch',
                );
                sent = true;
                try {
                  return await raw!.request(method, value);
                } catch (error) {
                  if (error instanceof Error && error.message.startsWith('app-server-error:')) {
                    const response = object(
                      JSON.parse(error.message.slice('app-server-error:'.length)),
                    );
                    record('compaction-refused', {
                      kind: 'comparison-native-compaction-refused',
                      request: intent,
                      response,
                    });
                  }
                  throw error;
                }
              },
            },
            host,
            session,
            async () => {
              working();
              await observer.verify();
              working();
            },
          ),
          true,
        );
        working();
        requireWorkflow(sent, 'h03-native-compaction-unsent');
        requireWorkflow(
          observer.confirmCompaction !== undefined,
          'h03-native-compaction-unsupported',
        );
        const prefix = transcript + '#L';
        const prior = new Set(
          readComparisonUsage(
            { session, transcript, run: ctx.opId, stage, through: before },
            true,
          ).map((receipt) => receipt.id),
        );
        let unsubscribe!: () => void;
        let poll: ReturnType<typeof setInterval> | undefined;
        const observed = await bounded(
          new Promise<{ through: InputRef; usage: InputRef[] }>((resolve, reject) => {
            let busy = false;
            const check = async () => {
              if (busy) return;
              busy = true;
              try {
                working();
                await observer.verify();
                working();
                const bytes = readPrivateFile(transcript!).toString();
                if (!bytes.endsWith('\n')) return;
                const current = bytes.slice(0, -1).split('\n');
                const through = {
                  locator: prefix + String(current.length),
                  hash: digest(current.at(-1)! + '\n'),
                };
                const receipts = readComparisonUsage(
                  { session: session!, transcript: transcript!, run: ctx.opId, stage, through },
                  true,
                );
                const fresh = receipts.filter(
                  (receipt) =>
                    receipt.source.locator.startsWith(prefix) &&
                    Number(receipt.source.locator.slice(prefix.length)) > lines.length &&
                    !prior.has(receipt.id),
                );
                const valid =
                  fresh.length > 0 &&
                  fresh.every((receipt) => {
                    const offset = Number(receipt.source.locator.slice(prefix.length)) - 1;
                    return (
                      object(JSON.parse(current[offset]!)).type === 'token_usage_record' &&
                      receipt.responses === 1 &&
                      [receipt.input_uncached, receipt.input_cached, receipt.output].every(
                        (value) => value !== null,
                      )
                    );
                  });
                if (valid) resolve({ through, usage: fresh.map((receipt) => receipt.source) });
              } catch (error) {
                reject(error);
              } finally {
                busy = false;
              }
            };
            unsubscribe = raw!.observe(() => {
              void check();
            });
            poll = setInterval(() => {
              void check();
            }, 100);
            void check();
          }),
          true,
        ).finally(() => {
          unsubscribe();
          clearInterval(poll);
        });
        working();
        const { through, usage } = observed;
        observer.confirmCompaction({
          key: start.key,
          session,
          before,
          boundary,
          evidence: intent,
          through,
        });
        compactionEvidence = record('compaction', {
          kind: 'comparison-native-compaction',
          scenario,
          opId: ctx.opId,
          session,
          before,
          request: intent,
          boundary,
          through,
          usage,
        });
        return boundary;
      } catch (error) {
        invalid = true;
        record('compaction-unknown', {
          kind: 'comparison-native-compaction-unknown',
          scenario,
          opId: ctx.opId,
        });
        throw error;
      }
    })());
  const finishStop = (seal: boolean) =>
    (stopPromise ??= (async () => {
      stopping = true;
      let confirmed = false,
        readersStopped = false,
        transportClosed = false,
        reason = 'h02-native-stop-unknown';
      const remainingProcesses: ProcessIdentity[] = [];
      try {
        if (ready !== undefined)
          await bounded(
            ready.catch(() => {}),
            false,
          );
        if (raw !== undefined) {
          requireWorkflow(initial !== undefined, 'h02-native-stop-process-unconfirmed');
          if (session !== undefined) {
            const policy = record('policy', {
              kind: 'h02-native-owned-rpc',
              opId: ctx.opId,
              label,
              runtime: initial,
              workspace,
            });
            const scope = await bounded(
              ownedRuntimeProcesses(raw, processes, initial, session, policy),
              false,
            );
            const terminals = object(
              await bounded(
                raw.request('thread/backgroundTerminals/list', { threadId: session, limit: 100 }),
                false,
              ),
            );
            requireWorkflow(
              Array.isArray(terminals.data) &&
                terminals.data.length === 0 &&
                (terminals.nextCursor === undefined || terminals.nextCursor === null),
              'h02-native-stop-unexpected-terminal',
            );
            const current = object(
              object(
                await bounded(
                  raw.request('thread/read', { threadId: session, includeTurns: true }),
                  false,
                ),
              ).thread,
            );
            requireWorkflow(
              current.id === session && Array.isArray(current.turns),
              'h02-native-stop-history',
            );
            const active = current.turns.map(object).filter((turn) => turn.status === 'inProgress');
            requireWorkflow(active.length <= 1, 'h02-native-stop-active-unknown');
            const proof = await bounded(
              new AppServerWriters(raw, scope.processes).stop(
                {
                  thread: session,
                  turn: active.length === 0 ? null : textField(active[0]!.id),
                  terminals: [],
                  markers: [policy.locator],
                  tree: dirname(workspace),
                  runtime: scope.runtime,
                  complete: true,
                },
                join(directory, 'writers-stopped.json'),
              ),
              false,
            );
            h01ReadPin(proof);
            evidence.push(proof);
            const primary = object(h01ReadJson(proof));
            requireWorkflow(
              primary.kind === 'writers-stopped' &&
                primary.active_turn === false &&
                primary.remaining_terminals === 0 &&
                primary.remaining_processes === 0 &&
                primary.before_hash === primary.after_hash &&
                primary.after_hash ===
                  (await writerScopeHash([policy.locator], dirname(workspace))),
              'h02-native-stop-primary',
            );
          }
        }
        confirmed = true;
      } catch {
        reason = 'h02-native-reader-stop-unknown';
      } finally {
        readersStopped = confirmed;
        if (raw !== undefined) {
          try {
            requireWorkflow(initial !== undefined, 'h02-native-stop-process-unconfirmed');
            const owned = await bounded(processes.descendants([initial.pid]), false);
            requireWorkflow(
              owned.some((item) => canonical(item) === canonical(initial)),
              'h02-native-stop-identity-changed',
            );
            const killed = await bounded(processes.terminate(owned), false);
            for (
              let attempts = 0;
              attempts < 40 && (await bounded(processes.alive(killed), false)).length > 0;
              attempts++
            )
              await bounded(processes.wait(25), false);
            remainingProcesses.push(...(await bounded(processes.alive(killed), false)));
            requireWorkflow(remainingProcesses.length === 0, 'h02-native-stop-survivor');
            record('process-stop', {
              kind: 'h02-native-process-stop',
              initial,
              processes: killed,
              confirmed: true,
            });
            transportClosed = true;
          } catch {
            confirmed = false;
            reason = 'h02-native-process-stop-unknown';
          }
          raw.close();
        } else transportClosed = true;
      }
      confirmed = readersStopped && transportClosed;
      const proof = record('stop', {
        kind: comparisonKind(scenario, 'stop'),
        executionVersion: 2,
        opId: ctx.opId,
        confirmed,
        readersStopped,
        transportClosed,
        sessions: session === undefined ? [] : [session],
        remainingProcesses,
        evidence: [...evidence],
        ...(confirmed ? {} : { reason }),
      });
      if (seal && confirmed && session !== undefined) {
        try {
          observer.completeParticipant(session, {
            outcome: invalid || ctx.signal.aborted ? 'unknown' : 'completed',
            stop: proof,
            evidence: [...evidence],
          });
        } catch {
          record('usage-unknown', { kind: 'h02-native-accounting-unknown', session });
        }
      }
      return proof;
    })());
  const stop = () => finishStop(true);
  const detachForRecovery = async () => {
    working();
    requireWorkflow(
      scenario === 'H-05' &&
        recovery === null &&
        session !== undefined &&
        creation !== undefined &&
        transcript !== undefined &&
        knownTurn !== undefined &&
        stopPromise === undefined,
      'h05-detach-context',
    );
    requireWorkflow(
      observer.assertRecoveryParticipant !== undefined,
      'h05-recovery-guard-required',
    );
    observer.assertRecoveryParticipant(session, creation, transcript);
    const stopped = await finishStop(false),
      physical = object(h01ReadJson(stopped));
    requireWorkflow(
      physical.confirmed === true &&
        physical.readersStopped === true &&
        physical.transportClosed === true,
      'h05-detach-unconfirmed',
    );
    const prefix = h01RawFile(transcript);
    requireWorkflow(prefix.toString('utf8').endsWith('\n'), 'h05-detach-prefix');
    return record('detached', {
      kind: 'comparison-h05-recovery-binding',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      binding,
      session,
      creation,
      pathObservation: knownPath ?? null,
      transcript,
      turn: knownTurn,
      stop: stopped,
      prefix: { bytes: prefix.length, hash: digest(prefix) },
    });
  };
  return {
    rpc,
    compact,
    get compactionEvidence() {
      return compactionEvidence;
    },
    stop,
    detachForRecovery,
    evidence,
  };
}
