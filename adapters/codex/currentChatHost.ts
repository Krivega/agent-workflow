import { readFragmentFits } from '../../core/readFragments.js';
import { auditLaunchObservation } from './auditLaunchObservation.js';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { ChatAnchor, ChatObservation } from '../../core/currentChat.js';
import type { CurrentChatHost } from '../../ports/currentChatHost.js';
import type { InputRef, LocalRun, LoadReceipt } from '../../core/localRun.js';
import {
  actionProcedureLoading,
  confirmLoad,
  requireLoadedProcedures,
  selectedProcedures,
} from '../../core/localRun.js';
import { contentHash, projectText } from '../project/projectFiles.js';
import { nativeChatPermissions } from './nativeChatPermissions.js';
import { lateCommandSettlement } from './chatCommandSettlement.js';
import type { CompactContextPacket } from '../project/compactContext.js';
import { compactProof } from '../project/compactContext.js';
import { canonical } from '../storage/storeCodec.js';
import {
  comparisonDesktopVersion,
  comparisonDesktopHumanMessage,
  comparisonDesktopHistory,
  comparisonDesktopRequestRows,
  isComparisonDesktopUser,
  isComparisonDesktopActor,
  nativeDesktopCommandTurn,
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
} from '../../src/adapters/codex/nativeDesktopUser.js';
import { nativeWorkspaceMatches } from '../../src/adapters/codex/nativeWorkspace.js';

export function isSupportedChatClientVersion(version: unknown): version is string {
  return (
    version === '0.154.0' ||
    version === '0.162.0-alpha.17.2' ||
    version === '0.163.0-alpha.10.2' ||
    version === '0.163.0-alpha.11' ||
    version === '0.163.0-alpha.11.1' ||
    version === '0.163.0-alpha.11.2' ||
    version === '0.164.0-alpha.11.1' ||
    version === '0.165.0-alpha.1.2'
  );
}

export function isSupportedChatSession(
  session: Record<string, unknown>,
): session is Record<string, unknown> & { cli_version: string } {
  return isSupportedChatClientVersion(session.cli_version) || isNativeDesktopUser166(session);
}

export function chatPath(value: unknown): string {
  const text = textField(value);
  if (text.startsWith('file:')) return resolve(fileURLToPath(text));
  requireWorkflow(isAbsolute(text), 'chat-workspace-not-absolute');
  return resolve(text);
}
export interface RecordLine {
  record: Record<string, unknown>;
  ref: InputRef;
}

export function verifyChatContinuation(
  records: RecordLine[],
  thread: string,
  turn: string,
  workspace: string,
  boundary: InputRef,
): InputRef {
  const end = records.findIndex((entry) => entry.ref.locator === boundary.locator);
  const start = records.findIndex((entry) => {
    const payload = object(entry.record.payload);
    return (
      entry.record.type === 'event_msg' &&
      payload.type === 'task_started' &&
      payload.turn_id === turn
    );
  });
  requireWorkflow(
    start >= 0 && end > start && records[end]!.ref.hash === boundary.hash,
    'chat-continuation-history-incomplete',
  );
  const calls = new Set<string>();
  const items = new Set<string>();
  const cells = new Set<string>();
  const waits = new Map<string, string>();
  for (const entry of records.slice(start + 1, end)) {
    const payload = object(entry.record.payload);
    if (entry.record.type === 'response_item') {
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const id = textField(payload.call_id);
        requireWorkflow(!calls.has(id), 'chat-continuation-history-incomplete');
        calls.add(id);
        if (payload.name === 'wait')
          waits.set(
            id,
            textField(object(JSON.parse(textField(payload.arguments)) as unknown).cell_id),
          );
      }
      if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        // Native cross-chat delivery is an input without a matching local call.
        if (payload.call_id !== undefined) {
          const id = textField(payload.call_id);
          requireWorkflow(calls.delete(id), 'chat-continuation-history-incomplete');
          const output = Array.isArray(payload.output)
            ? object(payload.output[0]).text
            : payload.output;
          if (typeof output === 'string') {
            const running = /^Script running with cell ID (\S+)/u.exec(output);
            if (running !== null) cells.add(running[1]!);
            if (waits.has(id) && output.startsWith('Script completed'))
              cells.delete(waits.get(id)!);
          }
        } else
          requireWorkflow(
            payload.type === 'function_call_output' &&
              payload.namespace === 'codex_app' &&
              ['create_thread', 'send_message_to_thread'].includes(textField(payload.name)) &&
              object(payload.internal_chat_message_metadata_passthrough).turn_id === turn,
            'chat-continuation-history-incomplete',
          );
      }
    }
    if (
      entry.record.type !== 'event_msg' ||
      (payload.type !== 'item_started' && payload.type !== 'item_completed')
    )
      continue;
    requireWorkflow(
      payload.thread_id === thread && payload.turn_id === turn,
      'chat-continuation-item-unconfirmed',
    );
    const item = object(payload.item);
    if (payload.type === 'item_started') items.add(textField(item.id));
    else {
      if (item.id !== undefined) items.delete(textField(item.id));
      if (['CommandExecution', 'FileChange', 'McpToolCall'].includes(textField(item.type)))
        requireWorkflow(
          item.status === 'completed' || item.status === 'failed',
          'chat-continuation-operation-pending',
        );
    }
  }
  const settlement = lateCommandSettlement(records, start, end, thread, turn, workspace);
  for (const id of settlement.ids) items.delete(id);
  requireWorkflow(
    calls.size === 0 && items.size === 0 && cells.size === 0,
    'chat-continuation-operation-pending',
  );
  return settlement.source;
}
export class FileCurrentChatHost implements CurrentChatHost {
  compactContext?: (run: LocalRun, marker: string) => Promise<CompactContextPacket>;
  constructor(
    private readonly root: string,
    private readonly transcript: string,
    private readonly anchor: ChatAnchor,
    private readonly nativeParent: string | null = null,
    private readonly readOnlyRoleRoot = false,
    private readonly comparisonSource: boolean | { senderTurn: string } = false,
  ) {}
  private async records(): Promise<RecordLine[]> {
    const source = await readFile(this.transcript, 'utf8');
    requireWorkflow(source.endsWith('\n'), 'chat-transcript-partial');
    return source
      .slice(0, -1)
      .split('\n')
      .map((line, index) => ({
        record: object(JSON.parse(line) as unknown),
        ref: { locator: `${this.transcript}#L${index + 1}`, hash: contentHash(line + '\n') },
      }));
  }
  async compaction() {
    const records = await this.records();
    return records
      .slice()
      .reverse()
      .find(({ record }) => record.type === 'compacted')?.ref;
  }
  private async compactRead(run: LocalRun, marker: string) {
    requireWorkflow(this.compactContext !== undefined, 'chat-compact-state-unavailable');
    const packet = await this.compactContext(run, marker);
    for (const { source } of packet.procedures)
      requireWorkflow(
        contentHash(await projectText(this.root, source.locator)) === source.hash,
        'chat-compact-source-stale',
      );
    const records = await this.records();
    const observed = await this.observation(records);
    const latest = records
      .slice()
      .reverse()
      .find(({ record }) => record.type === 'compacted');
    const floor = Math.max(
      records.findIndex(
        ({ ref }) => ref.locator === packet.boundary.locator && ref.hash === packet.boundary.hash,
      ),
      records.findIndex(({ ref }) => ref.locator === observed.source.locator),
    );
    requireWorkflow(
      latest?.ref.locator === packet.boundary.locator && latest.ref.hash === packet.boundary.hash,
      'chat-compact-boundary-unconfirmed',
    );
    const stateHash = contentHash(canonical(packet.state));
    let read: InputRef | null = null;
    for (const { record, ref } of records.slice(floor + 1)) {
      if (record.type !== 'event_msg') continue;
      const payload = object(record.payload);
      if (payload.type !== 'item_completed') continue;
      const item = object(payload.item);
      if (item.type !== 'CommandExecution' || typeof item.aggregated_output !== 'string') continue;
      for (const line of item.aggregated_output.split('\n')) {
        if (!line.startsWith(`{"chat_compact":${JSON.stringify(marker)}`)) continue;
        const entry = object(JSON.parse(line));
        if (
          entry.action !== packet.action ||
          entry.payload_hash !== packet.payload_hash ||
          entry.state_hash !== stateHash
        )
          continue;
        requireWorkflow(
          payload.thread_id === observed.thread_id &&
            payload.turn_id === observed.turn_id &&
            chatPath(item.cwd) === observed.workspace &&
            item.exit_code === 0 &&
            item.status === 'completed',
          'chat-compact-native-read-invalid',
        );
        requireWorkflow(read === null, 'chat-compact-read-duplicate');
        requireWorkflow(
          entry.chat_compact === marker &&
            typeof entry.content === 'string' &&
            contentHash(entry.content) === entry.hash &&
            entry.content === canonical(packet),
          'chat-compact-context-stale',
        );
        read = ref;
      }
    }
    requireWorkflow(read !== null, 'chat-compact-read-unconfirmed');
    return { packet, read };
  }
  private async observation(
    records: RecordLine[],
  ): Promise<ChatObservation & { effective_read_only: boolean }> {
    const sessions = records.filter((r) => r.record.type === 'session_meta');
    const contexts = records.filter((r) => r.record.type === 'turn_context');
    requireWorkflow(sessions.length === 1 && contexts.length > 0, 'chat-context-missing');
    const session = object(sessions[0]!.record.payload);
    const context = contexts.at(-1)!;
    const turn = object(context.record.payload);
    if (this.readOnlyRoleRoot) {
      requireWorkflow(
        typeof session.source === 'string' &&
          ['cli', 'vscode', 'exec'].includes(session.source) &&
          session.thread_source !== 'subagent',
        'chat-independent-root-unconfirmed',
      );
    }
    if (this.nativeParent !== null) {
      const source = object(object(object(session.source).subagent).thread_spawn);
      requireWorkflow(
        session.thread_source === 'subagent' && source.parent_thread_id === this.nativeParent,
        'chat-native-parent-unconfirmed',
      );
    }
    const actor = typeof this.comparisonSource === 'object' ? this.comparisonSource : null;
    const comparisonDesktop =
      actor === null
        ? this.comparisonSource === true && isComparisonDesktopUser(session)
        : isComparisonDesktopActor(session);
    requireWorkflow(
      isSupportedChatSession(session) ||
        comparisonDesktop ||
        (this.readOnlyRoleRoot &&
          session.cli_version === '0.169.1' &&
          session.cwd === this.anchor.workspace &&
          session.originator === 'Codex Desktop'),
      'chat-client-unsupported',
    );
    if (comparisonDesktop)
      requireWorkflow(
        session.cwd === this.anchor.workspace &&
          turn.root_turn_id === (actor?.senderTurn ?? this.anchor.turn_id) &&
          nativeDesktopCommandTurn(
            comparisonDesktopHistory(records)
              .filter(({ record }) => record.type === 'turn_context')
              .map(({ record }) => object(record.payload)),
            this.anchor.turn_id,
            this.anchor.workspace,
          ),
        'chat-comparison-origin-unconfirmed',
      );
    requireWorkflow(
      session.id === this.anchor.thread_id &&
        session.session_id === (this.nativeParent ?? this.anchor.thread_id) &&
        turn.turn_id === this.anchor.turn_id &&
        this.anchor.host_id === 'local',
      'chat-identity-mismatch',
    );
    const workspace = await realpath(this.root);
    requireWorkflow(
      chatPath(turn.cwd) === workspace && chatPath(this.anchor.workspace) === workspace,
      'chat-workspace-mismatch',
    );
    const origin = chatPath(session.cwd);
    if (origin !== workspace) {
      requireWorkflow(
        this.root === workspace &&
          nativeWorkspaceMatches(
            { ...session, cwd: origin },
            [{ ...turn, cwd: chatPath(turn.cwd) }],
            this.anchor.turn_id,
            workspace,
          ),
        'chat-workspace-mismatch',
      );
    }
    return {
      ...this.anchor,
      workspace,
      client_version: textField(session.cli_version),
      model: textField(turn.model),
      effort: textField(turn.effort),
      approval_policy: textField(turn.approval_policy),
      sandbox_policy: textField(object(turn.sandbox_policy).type),
      permission_profile: textField(object(turn.permission_profile).type),
      effective_read_only: object(turn.sandbox_policy).type === 'read-only',
      network_access:
        object(turn.sandbox_policy).type === 'danger-full-access'
          ? true
          : typeof object(turn.sandbox_policy).network_access === 'boolean'
            ? (object(turn.sandbox_policy).network_access as boolean)
            : null,
      source: context.ref,
      ...(this.nativeParent === null && !this.readOnlyRoleRoot ? {} : nativeChatPermissions(turn)),
    };
  }
  async auditLaunch(operation: string) {
    const records = await this.records();
    await this.observation(records);
    return auditLaunchObservation(records, operation);
  }
  async reference(source: InputRef) {
    const records = await this.records();
    await this.observation(records);
    requireWorkflow(
      records.some((r) => r.ref.locator === source.locator && r.ref.hash === source.hash),
      'chat-source-unconfirmed',
    );
  }
  async message(source: InputRef, previousTurn?: string) {
    const records = await this.records();
    const observed = await this.observation(records);
    requireWorkflow(typeof this.comparisonSource !== 'object', 'chat-human-message-delegated');
    const sourceTurn = previousTurn ?? this.anchor.turn_id;
    requireWorkflow(
      (observed.client_version !== '0.166.0-alpha.6' &&
        observed.client_version !== comparisonDesktopVersion) ||
        !hasNativeDesktopInboundDelivery(
          records.map(({ record }) => record),
          sourceTurn,
        ),
      'chat-human-message-delegated',
    );
    let turn = '';
    if (previousTurn !== undefined) {
      const last = (
        observed.client_version === comparisonDesktopVersion
          ? comparisonDesktopRequestRows(records)
          : records
      )
        .filter(({ record }) => {
          const payload = object(record.payload);
          if (
            record.type !== 'response_item' ||
            payload.type !== 'message' ||
            payload.role !== 'user' ||
            !Array.isArray(payload.content)
          )
            return false;
          const text = payload.content
            .map((c) => object(c).text)
            .filter((t) => typeof t === 'string')
            .join('\n');
          return (
            text.trim() &&
            !text.startsWith('<external_codex_apps_open_page>') &&
            !text.startsWith('<skill>')
          );
        })
        .at(-1);
      requireWorkflow(
        last?.ref.locator === source.locator && last.ref.hash === source.hash,
        'chat-continuation-human-superseded',
      );
    }
    for (const entry of records) {
      const payload = object(entry.record.payload);
      if (entry.record.type === 'event_msg' && payload.type === 'task_started')
        turn = textField(payload.turn_id);
      if (entry.ref.locator !== source.locator || entry.ref.hash !== source.hash) continue;
      requireWorkflow(
        turn === sourceTurn &&
          entry.record.type === 'response_item' &&
          payload.type === 'message' &&
          payload.role === 'user' &&
          Array.isArray(payload.content) &&
          payload.content.some((c) => {
            const item = object(c);
            return (
              item.type === 'input_text' && typeof item.text === 'string' && item.text.length > 0
            );
          }),
        'chat-human-message-unconfirmed',
      );
      if (observed.client_version === comparisonDesktopVersion) {
        requireWorkflow(
          sourceTurn === this.anchor.turn_id &&
            payload.content.length === 1 &&
            comparisonDesktopHumanMessage(
              object(payload.internal_chat_message_metadata_passthrough),
              sourceTurn,
            ),
          'chat-comparison-human-unconfirmed',
        );
      }
      return { thread_id: this.anchor.thread_id, turn_id: turn };
    }
    throw new Error('chat-source-unconfirmed');
  }
  async observe() {
    return this.observation(await this.records());
  }
  async boundary(turn: string) {
    const records = await this.records();
    await this.observation(records);
    let current = '';
    let result: { kind: 'completed' | 'aborted' | 'compacted'; source: InputRef } | null = null;
    for (const entry of records) {
      const payload = object(entry.record.payload);
      if (
        entry.record.type === 'turn_context' ||
        (entry.record.type === 'event_msg' && payload.type === 'task_started')
      )
        current = textField(payload.turn_id);
      if (entry.record.type === 'compacted' && current === turn)
        result = { kind: 'compacted', source: entry.ref };
      if (
        entry.record.type === 'event_msg' &&
        payload.turn_id === turn &&
        ['task_complete', 'task_aborted', 'turn_aborted'].includes(String(payload.type))
      )
        result = {
          kind: payload.type === 'task_complete' ? 'completed' : 'aborted',
          source: entry.ref,
        };
    }
    requireWorkflow(result !== null, 'chat-boundary-unconfirmed');
    return result;
  }
  async continuation(turn: string) {
    requireWorkflow(turn !== this.anchor.turn_id, 'chat-continuation-turn-required');
    const boundary = await this.boundary(turn);
    requireWorkflow(boundary.kind !== 'compacted', 'chat-continuation-boundary-unconfirmed');
    const records = await this.records();
    await this.observation(records);
    return verifyChatContinuation(records, this.anchor.thread_id, turn, this.root, boundary.source);
  }
  async readSelection(run: LocalRun, marker: string, reuse = false) {
    textField(marker);
    const records = await this.records();
    const observed = await this.observation(records);
    requireWorkflow(
      run.spec.session_id === observed.thread_id &&
        run.spec.host_id === observed.host_id &&
        chatPath(run.spec.workspace) === observed.workspace &&
        run.spec.requested.model === observed.model &&
        run.spec.requested.effort === observed.effort,
      'chat-run-mismatch',
    );
    const expected = [...run.spec.procedures, ...run.spec.rules];
    const compacted = records.reduce(
      (index, r, i) => (r.record.type === 'compacted' ? i : index),
      -1,
    );
    const floor = Math.max(
      records.findIndex((r) => r.ref.locator === observed.source.locator),
      compacted,
    );
    let cached: InputRef[] = [];
    if (reuse && run.loaded !== null) {
      try {
        const value: unknown = JSON.parse(run.loaded.observed_read);
        if (Array.isArray(value)) cached = value as InputRef[];
      } catch {
        /* Legacy receipts require a fresh observed read. */
      }
    }
    const prior = (ref: InputRef) =>
      cached.some((entry) => entry?.locator === ref.locator && entry.hash === ref.hash);
    const selected = [
      ...records.slice(floor + 1),
      ...records.slice(compacted + 1, floor + 1).filter(({ ref }) => prior(ref)),
    ];
    const reads = new Map<string, string>();
    const fragments = new Map<string, string>();
    const receipts: InputRef[] = [];
    for (const { record, ref } of selected) {
      if (record.type !== 'event_msg') continue;
      const payload = object(record.payload);
      if (payload.type !== 'item_completed') continue;
      const item = object(payload.item);
      if (item.type !== 'CommandExecution' || typeof item.aggregated_output !== 'string') continue;
      const previous = prior(ref);
      const lines = item.aggregated_output
        .split('\n')
        .filter((line) =>
          line.startsWith(previous ? '{"chat_read":' : `{"chat_read":${JSON.stringify(marker)}`),
        );
      let entries: unknown[];
      try {
        entries = lines.map((line) => JSON.parse(line) as unknown);
      } catch {
        // An incomplete command proves no reads; a later complete LOAD can recover them.
        continue;
      }
      for (const value of entries) {
        const entry = object(value);
        requireWorkflow(entry.chat_read === marker || previous, 'chat-read-unconfirmed');
        requireWorkflow(
          payload.thread_id === observed.thread_id &&
            (payload.turn_id === observed.turn_id || previous) &&
            chatPath(item.cwd) === observed.workspace &&
            item.exit_code === 0 &&
            item.status === 'completed',
          'chat-read-unconfirmed',
        );
        const locator = textField(entry.locator),
          content = textField(entry.content);
        if (previous && reads.has(locator)) continue;
        requireWorkflow(
          expected.some((e) => e.locator === locator && e.hash === entry.hash) &&
            !reads.has(locator),
          'chat-read-stale-or-duplicate',
        );
        const source = await projectText(this.root, locator);
        requireWorkflow(contentHash(source) === entry.hash, 'chat-read-stale-or-duplicate');
        if (entry.offset !== undefined) {
          const priorContent = fragments.get(locator) ?? '';
          requireWorkflow(
            readFragmentFits(priorContent, content, entry.offset, entry.length) &&
              entry.length === source.length &&
              source.slice(priorContent.length, priorContent.length + content.length) === content,
            'chat-read-fragment-invalid',
          );
          const assembled = priorContent + content;
          fragments.set(locator, assembled);
          if (assembled.length === source.length) reads.set(locator, assembled);
        } else {
          requireWorkflow(contentHash(content) === entry.hash, 'chat-read-stale-or-duplicate');
          reads.set(locator, content);
        }
        receipts.push(ref);
      }
    }
    return { reads, fragments, receipts, observed };
  }
  async load(run: LocalRun, marker: string, reuse = false): Promise<LoadReceipt> {
    const { reads, receipts, observed } = await this.readSelection(run, marker, reuse);
    let compactFallback: string | undefined;
    if (run.spec.context_loading === 'fragments-v1' && (await this.compaction()) !== undefined) {
      try {
        const { packet, read } = await this.compactRead(run, marker);
        requireWorkflow(
          run.spec.rules.every((rule) => reads.has(rule.locator)),
          'chat-load-incomplete',
        );
        const compact = compactProof(packet);
        const receipt = {
          run_id: run.spec.run_id,
          session_id: observed.thread_id,
          procedures: compact.procedures,
          rules: run.spec.rules,
          observed_read: JSON.stringify([...receipts, read]),
          compact,
        };
        confirmLoad(run, receipt);
        requireLoadedProcedures({ ...run, loaded: receipt });
        return receipt;
      } catch (error) {
        compactFallback = error instanceof Error ? error.message : 'chat-compact-outcome-unknown';
      }
    }
    const procedures = actionProcedureLoading(run.spec)
      ? run.spec.procedures.filter((p) => reads.has(p.locator))
      : run.spec.procedures;
    const expected = [...procedures, ...run.spec.rules];
    requireWorkflow(
      expected.length > 0 &&
        expected.every((e) => reads.has(e.locator)) &&
        (compactFallback === undefined ||
          selectedProcedures(run.spec).every((procedure) => reads.has(procedure.locator))),
      compactFallback === undefined
        ? 'chat-load-incomplete'
        : `chat-compact-full-load-required:${compactFallback}`,
    );
    for (const procedure of procedures)
      requireWorkflow(
        reads
          .get(procedure.locator)!
          .includes(`Procedure: ${procedure.id}\nVersion: ${procedure.version}\n`),
        'chat-procedure-mismatch',
      );
    const receipt = {
      run_id: run.spec.run_id,
      session_id: observed.thread_id,
      procedures,
      rules: run.spec.rules,
      observed_read: JSON.stringify(receipts),
      ...(compactFallback === undefined ? {} : { compact_fallback: compactFallback }),
    };
    confirmLoad(run, receipt);
    requireLoadedProcedures({ ...run, loaded: receipt });
    return receipt;
  }
}
