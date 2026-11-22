import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { confirmNativeRead } from '../adapters/codex/nativeRead.js';
import { buildCompactContext, compactContextLine } from '../adapters/project/compactContext.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, parseConnection, requireWorkflow, textField } from '../core/connection.js';
import {
  confirmLoad,
  requireLoadedProcedures,
  selectedProcedures,
  startLocalRun,
} from '../core/localRun.js';
import type { InputRef, LocalRun, RunSpec } from '../core/localRun.js';
import type { LoadedConnection } from '../ports/projectConnection.js';
import {
  h01ReadJson,
  h01ReadPin,
  h01Record,
  type H01BackendAdapter,
} from './comparisonH01Contract.js';
import {
  h03ContextPath,
  h03Material,
  h03PreparedMetadata,
  h03Procedures,
  h03ProbeNames,
  h03Scenario,
  type H03CaseReport,
} from './comparisonH03Contract.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import { createH03State } from './comparisonH03State.js';

const readInstructions = (marker: string, refs: InputRef[]) =>
  `Только инструментом чтения прочитай полностью каждый файл. Для каждого выведи JSON {"chat_read":${JSON.stringify(marker)},"locator":"путь","hash":"SHA-256","content":"полный исходный текст"}. ` +
  'Для большого текста используй последовательные части content до 8000 UTF-16 единиц, offset и length полного текста. Не сокращай исходник. ' +
  JSON.stringify(refs);

/** Existing Legacy current-chat LOAD policy on one real native session, never a second controller. */
export function createH03LegacyAdapter(): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(
        ctx.criteria.value.id === 'H-03' && ctx.variant === 'baseline',
        'h03-legacy-context',
      );
      const evidence: InputRef[] = [],
        saved = (label: string, value: unknown) => {
          const ref = h01Record(ctx.roots.evidenceRoot, 'h03-legacy-' + label, value);
          evidence.push(ref);
          return ref;
        };
      const port = createH02NativeRpc(ctx, 'legacy-executor', { stage: 'execution' });
      const report: H03CaseReport = {
        kind: 'comparison-h03-case',
        scenario: 'H-03',
        opId: ctx.opId,
        engine: 'legacy',
        session: null,
        context: null,
        outcome: 'unknown',
        checks: Object.fromEntries(h03Scenario.checks.map((id) => [id, false])),
        blocking: [],
        initial: { load: null, state: null },
        compaction: { before: null, request: null, boundary: null, usage: [], receipt: null },
        probes: {},
        recovered: { load: null, state: null },
        retained: { failure: null, pending: null, before: null, after: null },
        stop: ctx.verifiedAuthorization,
        evidence,
        nativeAcceptance: false,
        qualification: false,
        partialScope: true,
      };
      let loaded: LoadedConnection | null = null,
        state: ReturnType<typeof createH03State> | null = null;
      let run: LocalRun | null = null;
      const working = async () => {
        if (report.context !== null) h01ReadPin(report.context);
        ctx.signal.throwIfAborted();
        await ctx.nativeObserver.verify();
        if (report.context !== null) h01ReadPin(report.context);
        ctx.signal.throwIfAborted();
      };
      try {
        await working();
        const descriptor = ctx.runtime.files.find(
          (ref) => ref.locator === join(ctx.runtime.root, 'project/workflow.json'),
        );
        requireWorkflow(descriptor !== undefined, 'h03-legacy-descriptor-unpinned');
        const project = parseConnection(h01ReadJson(descriptor));
        const procedures = h03Procedures.map((id) => {
          const procedure = project.procedures.find((row) => row.id === id);
          requireWorkflow(procedure !== undefined, 'h03-legacy-procedure-missing');
          const pin = ctx.runtime.files.find(
            (ref) => ref.locator === join(ctx.runtime.root, procedure.locator),
          );
          requireWorkflow(
            pin !== undefined && pin.hash === procedure.hash,
            'h03-legacy-procedure-unpinned',
          );
          return { ...procedure, content: h01ReadPin(pin).toString() };
        });
        const metadata = h03PreparedMetadata(
          h01ReadPin(ctx.rules).toString(),
          h01ReadPin(ctx.executor).toString(),
        );
        const prepared = {
          ...h03Material.files,
          ...metadata,
          ...Object.fromEntries(
            procedures.map((procedure) => [procedure.locator, procedure.content]),
          ),
        };
        await verifyComparisonMaterial(ctx.roots.workspaceRoot, prepared, []);
        await working();
        const rules = ['.h03/rules.md', '.h03/executor.md'].map((locator) => ({
          locator,
          content: metadata[locator]!,
          hash: digest(metadata[locator]!),
        }));
        loaded = { descriptor: project, revision: descriptor.hash, procedures, rules };
        const { checkNativeCase } = await import('./comparisonH01.js');
        const checked = await checkNativeCase(ctx, 'h03-initial-check');
        await working();
        requireWorkflow(checked.failed === true, 'h03-initial-failure-unconfirmed');
        evidence.push(checked.evidence);
        const sessions = new AppServerSessions(
          port.rpc,
          ctx.roots.workspaceRoot,
          'h03-' + digest(ctx.opId).slice(0, 16),
          ctx.roots.evidenceRoot,
          null,
          null,
        );
        const session = await sessions.create({
          model: ctx.profile.model,
          effort: ctx.profile.effort,
          reason: 'H03 isolated executor',
        });
        report.session = session.id;
        const inputs = new FileWorkflowInputs(ctx.roots.workspaceRoot, ctx.roots.evidenceRoot),
          assignment = await inputs.ref('.h03/task.md');
        await working();
        let spec: RunSpec = {
          project_id: 'h03-' + digest(ctx.opId).slice(0, 16),
          identity: { assignment_id: ctx.opId },
          assignment,
          product: false,
          run_id: ctx.opId,
          session_id: session.id,
          host_id: 'local',
          workspace: ctx.roots.workspaceRoot,
          parent_run_id: null,
          coordinator: false,
          role: null,
          fork_turns: 'none',
          scope: ['evidence/'],
          outcome: h03Material.instructions,
          criteria: [...h03Scenario.checks],
          writer: ctx.identity.owner,
          requested: {
            model: ctx.profile.model,
            effort: ctx.profile.effort,
            permissions: ['read'],
          },
          effective: {
            model: ctx.profile.model,
            effort: ctx.profile.effort,
            permissions: ['read'],
          },
          sources: [assignment],
          procedures: procedures.map(({ content: _content, ...procedure }) => procedure),
          rules: rules.map(({ content: _content, ...rule }) => rule),
          procedure_loading: 'by-action',
          context_loading: 'fragments-v1',
          route: { kind: 'nonproduct' },
        };
        run = startLocalRun(spec, 1);
        state = createH03State(ctx, run, checked.evidence);
        report.context = state.context;
        evidence.push(state.context);
        run = state.initialRun;
        spec = run.spec;
        loaded.rules.push({
          locator: h03ContextPath,
          hash: state.context.hash,
          content: h01ReadPin(state.context).toString(),
        });
        report.retained.failure = state.failure;
        report.retained.pending = state.pending;
        report.retained.before = state.snapshot();
        report.initial.state = report.retained.before;
        evidence.push(state.failure, state.pending, report.retained.before);
        const initial = report.initial.state;
        const firstMarker = 'h03-initial';
        const first = await sessions.send(
          session,
          readInstructions(firstMarker, [...selectedProcedures(spec), ...spec.rules]) +
            '\n' +
            `Прочитай также текущий checkpoint ${JSON.stringify(initial)}. Выведи отдельную JSON строку {"path":${JSON.stringify(initial.locator)},"sha256":${JSON.stringify(initial.hash)},"content":"полные байты checkpoint"}. ` +
            'Большой checkpoint читай частями aw-native-read-parts/1 с path, sha256, content до 8000 UTF-16 единиц, offset и length полного текста. В checkpoint открытый F-01 и незавершённая операция: сохрани их. Не запускай и не завершай эту операцию, не меняй права. После чтения верни промежуточный ответ; сжатие выполнит среда.',
          ctx.opId + ':initial',
        );
        await port.rpc.completed(session.id, first, ctx.signal, working);
        await working();
        const primary = object(
          object(
            await port.rpc.request('thread/read', { threadId: session.id, includeTurns: true }),
          ).thread,
        );
        requireWorkflow(Array.isArray(primary.turns), 'h03-native-history-missing');
        const firstTurn = primary.turns.map(object).find((turn) => turn.id === first);
        requireWorkflow(firstTurn !== undefined, 'h03-initial-turn-missing');
        confirmNativeRead(firstTurn, [initial]);
        const transcript = textField(primary.path);
        const hostAt = (turn: string) => {
          const anchor = {
            thread_id: session.id,
            turn_id: turn,
            host_id: 'local' as const,
            workspace: ctx.roots.workspaceRoot,
          };
          return {
            host: new FileCurrentChatHost(ctx.roots.workspaceRoot, transcript, anchor),
            config: { root: ctx.roots.workspaceRoot, transcript, anchor },
          };
        };
        const firstHost = hostAt(first),
          receipt = await firstHost.host.load(run, firstMarker);
        confirmLoad(run, receipt);
        report.initial.load = saved('initial-load', {
          kind: 'comparison-h03-native-load',
          session: session.id,
          turn: first,
          marker: firstMarker,
          run,
          receipt,
          host: firstHost.config,
          packet: null,
          state: initial,
        });
        run = await state.load(receipt, await firstHost.host.observe());
        await working();
        requireWorkflow(port.compact !== undefined, 'h03-native-compaction-unsupported');
        const boundary = await port.compact(firstHost.host);
        await working();
        requireWorkflow(port.compactionEvidence != null, 'h03-native-compaction-proof-missing');
        const compacted = object(h01ReadJson(port.compactionEvidence));
        report.compaction = {
          before: compacted.before as InputRef,
          request: compacted.request as InputRef,
          boundary,
          usage: compacted.usage as InputRef[],
          receipt: port.compactionEvidence,
        };
        evidence.push(port.compactionEvidence);
        report.checks['real-compaction'] =
          compacted.session === session.id && report.compaction.usage.length > 0;
        const current = await state.journal.read();
        const basePacket = (
          marker: string,
          action = 'continue-chat',
          additional: Parameters<typeof selectedProcedures>[1] = [],
        ) =>
          buildCompactContext(
            run!,
            marker,
            action,
            ctx.requestHash,
            boundary,
            current,
            state!.state(),
            state!.effects(),
            loaded!,
            additional,
            Date.now(),
          );
        const probes = h03ProbeNames.map((probe) => {
          const marker = 'h03-' + probe,
            expected = basePacket(
              marker,
              probe === 'new-action' ? 'execution-chat' : 'continue-chat',
              probe === 'new-action' ? ['implementation'] : [],
            );
          const packet = structuredClone(probe === 'new-action' ? basePacket(marker) : expected);
          if (probe === 'missing-rule') {
            const procedure = packet.procedures.find((row) => row.source.id === 'evidence')!;
            requireWorkflow(
              procedure.rules.some((rule) => rule.id === 'evidence.03'),
              'h03-mandatory-rule-unavailable',
            );
            procedure.rules = procedure.rules.filter((rule) => rule.id !== 'evidence.03');
          }
          if (probe === 'stale-source') packet.procedures[0]!.source.hash = digest('stale-source');
          if (probe === 'wrong-role') packet.role = 'auditor';
          const view = saved('probe-input', {
            kind: 'comparison-h03-probe-input',
            probe,
            packet,
            line: JSON.stringify(compactContextLine(packet)),
          });
          return { probe, marker, expected, packet, view };
        });
        const probeTurn = await sessions.send(
          session,
          'После настоящего сжатия это новый ход того же сеанса. Не выполняй продуктовых действий. ' +
            probes
              .map(
                ({ marker, view }) =>
                  readInstructions(marker, spec.rules) +
                  `\nПрочитай ${JSON.stringify(view)} и выведи поле line как готовую текстовую строку без дополнительных кавычек и без пересериализации инструментом чтения. Это отдельный отрицательный вход, не исправляй его. Не читай целые процедуры на этом этапе.`,
              )
              .join('\n'),
          ctx.opId + ':probes',
        );
        await port.rpc.completed(session.id, probeTurn, ctx.signal, working);
        await working();
        const probeHost = hostAt(probeTurn);
        for (const probe of probes) {
          const basis = saved('probe-basis', {
            kind: 'comparison-h03-probe-basis',
            probe: probe.probe,
            run,
            marker: probe.marker,
            host: probeHost.config,
            expected: probe.expected,
            packet: probe.packet,
            input: probe.view,
          });
          probeHost.host.compactContext = async () => probe.expected;
          let error: string | null = null;
          try {
            await probeHost.host.load(run, probe.marker);
          } catch (caught) {
            error = caught instanceof Error ? caught.message : null;
          }
          await working();
          const expectedError =
            'chat-compact-full-load-required:' +
            (probe.probe === 'new-action'
              ? 'chat-compact-read-unconfirmed'
              : 'chat-compact-context-stale');
          const refused = error === expectedError;
          const observed = saved('probe-refused', {
            kind: 'comparison-h03-load-refused',
            probe: probe.probe,
            basis,
            error,
          });
          report.probes[probe.probe] = {
            basis,
            observed,
            error: error ?? 'h03-owner-error-unknown',
            refused,
          };
        }
        report.checks['invalid-context-refused'] = h03ProbeNames.every(
          (name) => report.probes[name]?.refused === true,
        );
        const recoveryMarker = 'h03-recovery';
        const recoveryPacket = basePacket(recoveryMarker, 'execution-chat', ['implementation']);
        const recoveryTurn = await sessions.send(
          session,
          'Выполни полный LOAD по Р1 в этом новом ходе того же сеанса. ' +
            readInstructions(recoveryMarker, [...spec.procedures, ...spec.rules]) +
            '\nНе печатай chat_compact: это полное восстановление из источников. Сохрани исходные F-01 и pending; не запускай неизвестную операцию, не меняй её состояние и не создавай новый сеанс.',
          ctx.opId + ':recovery',
        );
        await port.rpc.completed(session.id, recoveryTurn, ctx.signal, working);
        await working();
        const recoveryHost = hostAt(recoveryTurn);
        recoveryHost.host.compactContext = async () => recoveryPacket;
        const recovered = await recoveryHost.host.load(run, recoveryMarker);
        confirmLoad(run, recovered);
        requireLoadedProcedures({ ...run, loaded: recovered }, ['implementation']);
        report.recovered.load = saved('recovered-load', {
          kind: 'comparison-h03-native-load',
          session: session.id,
          turn: recoveryTurn,
          marker: recoveryMarker,
          run,
          receipt: recovered,
          host: recoveryHost.config,
          packet: recoveryPacket,
        });
        run = await state.load(recovered, await recoveryHost.host.observe());
        report.recovered.state = state.snapshot();
        report.retained.after = report.recovered.state;
        evidence.push(report.recovered.state);
        const before = object(h01ReadJson(report.retained.before)),
          after = object(h01ReadJson(report.retained.after));
        report.checks['fresh-observed-read'] =
          first !== recoveryTurn && receipt.observed_read !== recovered.observed_read;
        report.checks['mandatory-rules'] = canonical(recovered.rules) === canonical(spec.rules);
        report.checks['full-load-recovery'] =
          recovered.compact === undefined &&
          recovered.compact_fallback === 'chat-compact-read-unconfirmed' &&
          recovered.procedures.length === h03Procedures.length;
        report.checks['pending-preserved'] =
          canonical(before.effects) === canonical(after.effects) &&
          canonical(before.failure) === canonical(after.failure) &&
          state.effects().some((effect) => effect.outcome === 'pending');
        await working();
        report.outcome = Object.values(report.checks).every(Boolean) ? 'accepted' : 'failed';
        if (report.outcome === 'accepted') {
          mkdirSync(join(ctx.roots.workspaceRoot, 'evidence'), { recursive: true, mode: 0o700 });
          writeFileSync(
            join(ctx.roots.workspaceRoot, 'evidence/manifest.json'),
            canonical({
              sources: [...evidence, report.recovered.load!, report.recovered.state!],
              initial_failure: 'F-01',
            }) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
        }
      } catch (error) {
        if (error instanceof Error && /^[a-z][a-z0-9:-]*$/u.test(error.message))
          report.blocking.push(error.message);
        report.blocking.push('h03-legacy-incomplete');
        if (
          port.evidence.some((ref) => {
            const proof = object(h01ReadJson(ref));
            return (
              proof.kind === 'comparison-native-compaction-refused' &&
              object(proof.response).code === -32601
            );
          })
        )
          report.outcome = 'not-run';
      } finally {
        report.stop = await port.stop();
        evidence.push(report.stop, ...port.evidence);
      }
      let contextKnown = true;
      try {
        if (report.context !== null) h01ReadPin(report.context);
      } catch {
        contextKnown = false;
        report.blocking.push('h03-context-changed');
      }
      if (
        !contextKnown ||
        ctx.signal.aborted ||
        object(h01ReadJson(report.stop)).confirmed !== true ||
        ctx.nativeObserver.accounting().unknown
      )
        report.outcome = 'unknown';
      for (const [check, passed] of Object.entries(report.checks))
        if (!passed) report.blocking.push(check);
      const caseReport = saved('case', report);
      const projection = saved('projection', {
        kind: 'comparison-h03-native-projection',
        scenario: 'H-03',
        opId: ctx.opId,
        engine: 'legacy',
        caseReport,
      });
      return {
        outcome:
          report.outcome === 'accepted'
            ? 'completed'
            : report.outcome === 'failed'
              ? 'failed'
              : 'unknown',
        evidence,
        stop: report.stop,
        projection,
        nativeAcceptance: report.recovered.load,
      };
    },
  };
}
