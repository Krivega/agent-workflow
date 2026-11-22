import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { refuseUnroutedBackendConsumer } from '../src/adapters/project/taskBackend.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import materialsSource from '../comparison/materials.json' with { type: 'json' };
import { object, requireWorkflow, textField, localLocator } from '../core/connection.js';
import {
  comparisonReport,
  comparisonSchedule,
  parseComparisonSuite,
  parseComparisonMaterials,
} from '../core/comparison.js';
import type { ComparisonResult, ComparisonRun } from '../core/comparison.js';
import {
  comparisonDuration,
  type ComparisonInstant,
  type ComparisonTiming,
} from '../core/comparison.js';
import type { InputRef } from '../core/localRun.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { InputManifest } from '../core/evidence.js';
import { compareInputs } from '../core/evidence.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { sameValue } from '../core/equality.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { readPrivateFile, safeDirectory } from '../adapters/storage/storeFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { withChatWriter } from '../adapters/storage/chatWriter.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { comparisonSession } from '../adapters/codex/comparisonSession.js';
import { readComparisonUsage, sealComparisonUsage } from '../adapters/codex/comparisonUsage.js';
import type {
  ComparisonParticipant,
  NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import {
  comparisonToolRoot,
  engineDirectories,
  freezeComparisonSnapshot,
  materializeComparisonSnapshot,
  verifyComparisonClient,
  verifyComparisonMaterial,
  verifyComparisonSnapshot,
} from '../adapters/project/comparisonInputs.js';

const runnerRoot = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const instant = (): ComparisonInstant => ({
  wall_ms: Date.now(),
  monotonic_ms: performance.now(),
  clock_id: `${process.pid}:${performance.timeOrigin}`,
});
const suite = parseComparisonSuite(suiteSource);
const materials = parseComparisonMaterials(materialsSource, suite);
interface Series {
  schema_version: 1;
  runner_version: 1;
  series_id: string;
  suite_hash: string;
  materials_hash: string;
  sources: { baseline: InputRef; candidate: InputRef };
  profile: {
    model: string;
    effort: string;
    binary: string;
    binary_hash: string;
    modules: string;
    lock_hash: string;
    node: string;
    executor_sandbox: 'danger-full-access';
    reviewer_sandbox: 'read-only';
    runner_hash: string;
  };
  runner: { root: string; inputs: InputManifest };
  schedule: ComparisonRun[];
  participants: (ComparisonParticipant & { complete: boolean })[];
  receipts: NativeComparisonReceipt[];
  results: ComparisonResult[];
  pending: {
    run: string;
    attempt: number;
    operation: string;
    stage: 'preparation' | 'execution' | 'council';
    error: string | null;
    started?: ComparisonInstant;
  } | null;
  preparation_timing: ComparisonTiming;
  started_at: number;
  elapsed_ms: number;
}

function pinned(ref: InputRef) {
  requireWorkflow(
    isAbsolute(ref.locator) && digest(readPrivateFile(ref.locator)) === ref.hash,
    'comparison-source-changed',
  );
}
function report(series: Series) {
  return {
    ...comparisonReport(suite, series.schedule, series.receipts, series.results, series.elapsed_ms),
    preparation_timing: series.preparation_timing,
    preparation_ms: comparisonDuration(
      series.preparation_timing.start,
      series.preparation_timing.end,
    ),
    pending: series.pending,
  };
}
export async function prepareComparisonSeries(request: Record<string, unknown>) {
  const started = instant();
  const startedAt = started.wall_ms;
  requireWorkflow(request.schema_version === 1, 'unsupported-comparison-request');
  const root = textField(request.state_root);
  safeDirectory(dirname(root));
  const variants = object(request.variants),
    profile = object(request.profile);
  for (const source of [
    runnerRoot,
    ...['baseline', 'candidate'].map((variant) => textField(object(variants[variant]).root)),
  ])
    requireWorkflow(
      root !== source && !root.startsWith(source + '/') && !source.startsWith(root + '/'),
      'comparison-state-overlaps-source',
    );
  await mkdir(root, { mode: 0o700 });
  const sources = {} as Series['sources'];
  for (const variant of ['baseline', 'candidate'] as const) {
    const input = object(variants[variant]);
    sources[variant] = await freezeComparisonSnapshot(
      textField(input.root),
      input.revision === null ? null : textField(input.revision),
      root,
    );
  }
  const binary = await realpath(textField(request.binary));
  const modules = await realpath(textField(request.modules));
  const runnerInputs = await new FileWorkflowInputs(runnerRoot).capture(
    { files: ['package.json', 'yarn.lock'], directories: engineDirectories },
    'comparison runner',
  );
  const runtime = {
    model: textField(profile.model),
    effort: textField(profile.effort),
    binary,
    binary_hash: digest(readPrivateFile(binary)),
    modules,
    lock_hash: digest(readPrivateFile(resolve(dirname(modules), 'yarn.lock'))),
    node: process.version,
    executor_sandbox: 'danger-full-access' as const,
    reviewer_sandbox: 'read-only' as const,
    runner_hash: digest(canonical(runnerInputs)),
  };
  for (const variant of ['baseline', 'candidate'] as const) {
    const workspace = resolve(root, `preflight-${variant}`);
    await materializeComparisonSnapshot(sources[variant], workspace, modules);
    await verifyComparisonClient(workspace, binary);
  }
  const series: Series = {
    schema_version: 1,
    runner_version: 1,
    series_id: textField(request.series_id),
    suite_hash: digest(canonical(suite)),
    materials_hash: digest(canonical(materialsSource)),
    sources,
    profile: runtime,
    runner: { root: runnerRoot, inputs: runnerInputs },
    schedule: comparisonSchedule(
      suite,
      Object.fromEntries(
        materials.map((material) => [
          material.id,
          { material_hash: digest(canonical(material)), profile_hash: digest(canonical(runtime)) },
        ]),
      ),
    ),
    participants: [],
    receipts: [],
    results: [],
    pending: null,
    preparation_timing: { start: started, end: instant() },
    started_at: startedAt,
    elapsed_ms: Date.now() - startedAt,
  };
  saveManaged(resolve(root, 'series.json'), series, false);
  return { status: 'prepared', series: resolve(root, 'series.json'), ...report(series) };
}

export async function runComparisonSeries(request: Record<string, unknown>) {
  requireWorkflow(
    request.schema_version === 1 && request.live === true,
    'comparison-live-authorization-required',
  );
  const path = textField(request.series);
  refuseUnroutedBackendConsumer(runnerRoot);
  refuseUnroutedBackendConsumer(textField(object(request.authorization).root));
  const root = safeDirectory(dirname(path));
  return withChatWriter(resolve(root, 'series'), async () => {
    const series = readManaged<Series>(path);
    requireWorkflow(
      series !== null &&
        series.schema_version === 1 &&
        series.runner_version === 1 &&
        series.suite_hash === digest(canonical(suite)) &&
        series.materials_hash === digest(canonical(materialsSource)),
      'comparison-series-incompatible',
    );
    requireWorkflow(
      series.runner.root === runnerRoot &&
        digest(canonical(series.runner.inputs)) === series.profile.runner_hash &&
        compareInputs(
          series.runner.inputs,
          await new FileWorkflowInputs(series.runner.root).current(series.runner.inputs),
        ) === 'applicable',
      'comparison-runner-changed',
    );
    const authorization = object(request.authorization);
    const host = new FileCurrentChatHost(
      textField(authorization.root),
      textField(authorization.transcript),
      authorization.anchor as ChatAnchor,
    );
    const observed = await host.observe();
    requireWorkflow(
      observed.thread_id === process.env.CODEX_THREAD_ID &&
        observed.model === series.profile.model &&
        observed.effort === series.profile.effort &&
        observed.sandbox_policy === 'danger-full-access' &&
        observed.approval_policy === 'never' &&
        observed.permission_profile === 'disabled' &&
        observed.network_access === true &&
        authorization.series_id === series.series_id &&
        authorization.sources_hash === digest(canonical(series.sources)),
      'comparison-authorization-binding-mismatch',
    );
    const verifyAuthority = async () => {
      requireWorkflow(
        sameValue(await host.observe(), observed),
        'comparison-authorization-changed',
      );
      await host.message(authorization.source as InputRef, observed.turn_id);
    };
    await verifyAuthority();
    const qualification = request.qualification as InputRef;
    pinned(qualification);
    const accepted = object(JSON.parse(readPrivateFile(qualification.locator).toString('utf8')));
    requireWorkflow(
      accepted.schema_version === 1 &&
        accepted.kind === 'native-workflow-comparison' &&
        accepted.profile_hash === digest(canonical(series.profile)) &&
        accepted.sources_hash === digest(canonical(series.sources)) &&
        sameValue(
          accepted.scenarios,
          suite.scenarios.map((scenario) => scenario.id),
        ) &&
        Array.isArray(accepted.evidence) &&
        accepted.evidence.length > 0,
      'comparison-native-qualification-required',
    );
    (accepted.evidence as InputRef[]).forEach(pinned);
    const save = () => {
      const elapsed = Date.now() - series.started_at;
      requireWorkflow(elapsed >= series.elapsed_ms, 'comparison-series-clock-regressed');
      series.elapsed_ms = elapsed;
      saveManaged(path, series, false);
    };
    const collect = (terminal: boolean) => {
      series.receipts = series.participants.flatMap((participant) => {
        return readComparisonUsage(participant, !terminal && !participant.complete);
      });
      save();
    };
    const verify = async () => {
      await verifyAuthority();
      for (const ref of Object.values(series.sources)) pinned(ref);
      requireWorkflow(
        digest(readPrivateFile(series.profile.binary)) === series.profile.binary_hash &&
          process.version === series.profile.node &&
          digest(readPrivateFile(resolve(dirname(series.profile.modules), 'yarn.lock'))) ===
            series.profile.lock_hash,
        'comparison-runtime-changed',
      );
      collect(false);
      const budget = comparisonReport(
        suite,
        series.schedule,
        series.receipts,
        series.results,
        series.elapsed_ms,
      );
      requireWorkflow(
        series.preparation_timing !== undefined &&
          comparisonDuration(series.preparation_timing.start, series.preparation_timing.end) !==
            null,
        'comparison-preparation-timing-unknown',
      );
      requireWorkflow(
        budget.timings.runs.every((run) => run.attempts.length === 0 || run.observed_ms !== null),
        'comparison-timing-unknown',
      );
      requireWorkflow(budget.stop === null, `comparison-series-stopped:${budget.stop}`);
    };
    await verify();
    const latest = new Map(series.results.map((result) => [result.run, result]));
    const retry = request.retry === undefined ? null : textField(request.retry);
    if (retry !== null)
      requireWorkflow(
        ['failed', 'harness-error'].includes(String(latest.get(retry)?.outcome)),
        'comparison-retry-not-allowed',
      );
    const runs =
      retry === null
        ? series.schedule.filter((run) => !latest.has(run.id))
        : series.schedule.filter((run) => run.id === retry);
    for (const run of runs) {
      const material = materials.find((material) => material.id === run.scenario)!;
      requireWorkflow(
        run.material_hash === digest(canonical(material)) &&
          run.profile_hash === digest(canonical(series.profile)),
        'comparison-inputs-changed',
      );
      const attempt = (latest.get(run.id)?.attempt ?? 0) + 1;
      const operation = digest(canonical([series.series_id, run.id, attempt]));
      requireWorkflow(
        series.pending === null || series.pending.operation === operation,
        'comparison-pending-operation-mismatch',
      );
      const workspace = resolve(root, `work-${operation}`),
        caseRoot = resolve(workspace, 'case'),
        stateRoot = resolve(workspace, 'state');
      try {
        if (series.pending === null || series.pending.stage === 'preparation') {
          await verify();
          series.pending ??= {
            run: run.id,
            attempt,
            operation,
            stage: 'preparation',
            error: null,
            started: instant(),
          };
          save();
          await materializeComparisonSnapshot(
            series.sources[run.variant],
            workspace,
            series.profile.modules,
          );
          await verifyComparisonClient(workspace, series.profile.binary);
          await mkdir(caseRoot, { recursive: true, mode: 0o700 });
          safeDirectory(caseRoot);
          await mkdir(stateRoot, { recursive: true, mode: 0o700 });
          safeDirectory(stateRoot);
          for (const [locator, content] of Object.entries(material.files)) {
            localLocator(locator);
            const path = resolve(caseRoot, locator);
            try {
              await writeFile(path, content, { flag: 'wx', mode: 0o600 });
            } catch (error) {
              if ((error as { code?: string }).code !== 'EEXIST') throw error;
              requireWorkflow(
                readPrivateFile(path).toString('utf8') === content,
                'comparison-material-changed',
              );
            }
          }
          series.pending = { ...series.pending, stage: 'execution' };
          save();
        }
        const register = (participant: ComparisonParticipant) => {
          const previous = series.participants.find(
            (entry) => entry.session === participant.session,
          );
          requireWorkflow(
            previous === undefined ||
              sameValue(
                { ...previous, complete: undefined, through: undefined, stage: participant.stage },
                { ...participant, complete: undefined, through: undefined },
              ),
            'comparison-participant-conflict',
          );
          if (previous === undefined) series.participants.push({ ...participant, complete: false });
          save();
        };
        const actor = async (stage: 'execution' | 'council', brief: string) => {
          series.pending!.stage = stage;
          save();
          const result = await comparisonSession(
            {
              binary: series.profile.binary,
              directory: resolve(root, `${operation}-${stage}`),
              workspace: caseRoot,
              state_root: stateRoot,
              operation: `${operation}:${stage}`,
              profile: series.profile,
              read_only: stage === 'council',
              brief,
              run: run.id,
              stage,
            },
            register,
            verify,
          );
          for (const participant of series.participants)
            if (
              participant.run === run.id &&
              (participant.stage === stage || participant.stage === 'helper')
            )
              Object.assign(participant, sealComparisonUsage(participant), { complete: true });
          collect(true);
          return result;
        };
        const commit = (result: ComparisonResult) => {
          if (series.pending?.started !== undefined)
            result.timing = { start: series.pending.started, end: instant() };
          comparisonReport(
            suite,
            series.schedule,
            series.receipts,
            [...series.results, result],
            series.elapsed_ms,
          );
          series.results.push(result);
          series.pending = null;
          save();
        };
        const rejected = (
          outcome: 'failed' | 'harness-error',
          evidence: string[],
        ): ComparisonResult => ({
          run: run.id,
          attempt,
          outcome,
          checks: Object.fromEntries(
            suite.scenarios
              .find((scenario) => scenario.id === run.scenario)!
              .checks.map((check) => [check, false]),
          ),
          evidence,
        });
        const assignment =
          `${suite.scenarios.find((scenario) => scenario.id === run.scenario)!.task}\n${material.instructions}\n` +
          `Область записи: ${caseRoot}; внешний Store и материалы процесса: ${stateRoot}. Версия agent-workflow для этого выполнения: ${comparisonToolRoot(workspace)}.\n` +
          `Критерии: ${JSON.stringify(suite.scenarios.find((scenario) => scenario.id === run.scenario)!.checks)}.\n` +
          'Сохраняй первичные доказательства в evidence/. Чужие файлы, правила и checks.mjs не меняй. Не читай задания, решения и результаты других выполнений. Недоступное оставляй NOT RUN. Верни JSON с summary и limitations.';
        const implemented = await actor('execution', assignment);
        if (implemented.status !== 'completed') {
          commit(rejected('failed', [implemented.source.locator]));
          continue;
        }
        const validation = await verifyComparisonMaterial(
          caseRoot,
          material.files,
          material.mutable,
        )
          .then(() => verifyComparisonSnapshot(series.sources[run.variant], workspace))
          .then(() => exec(process.execPath, ['checks.mjs'], { cwd: caseRoot }))
          .then(
            (result) => ({ exit_code: 0, stdout: result.stdout, stderr: result.stderr }),
            (error: unknown) => ({
              exit_code: 1,
              error: error instanceof Error ? error.message : 'unknown',
            }),
          );
        const check = resolve(root, `check-${operation}.json`);
        saveManaged(check, validation, false);
        await verify();
        const reviewed = await actor(
          'council',
          `Проведи независимую приёмку.\n${assignment}\n` +
            `Первичный ответ исполнителя: ${implemented.source.locator}; проверка: ${check}.\n` +
            'Проверь источники каждого критерия; наличие manifest и локальный double не подтверждают native сценарий. Не исправляй файлы. ' +
            'Верни только JSON: {"outcome":"accepted" или "failed","checks":{каждый критерий:boolean},"limitations":[...]}. Неподтверждённый критерий — false.',
        );
        await verify();
        await verifyComparisonSnapshot(series.sources[run.variant], workspace);
        if (reviewed.status !== 'completed') {
          commit(
            rejected('harness-error', [implemented.source.locator, reviewed.source.locator, check]),
          );
          continue;
        }
        let result: ComparisonResult;
        try {
          const answer = object(JSON.parse(reviewed.text));
          requireWorkflow(
            ['accepted', 'failed'].includes(String(answer.outcome)),
            'comparison-review-invalid',
          );
          result = {
            run: run.id,
            attempt,
            outcome:
              validation.exit_code === 0 ? (answer.outcome as 'accepted' | 'failed') : 'failed',
            checks: object(answer.checks) as Record<string, boolean>,
            evidence: [implemented.source.locator, reviewed.source.locator, check],
          };
          comparisonReport(
            suite,
            series.schedule,
            series.receipts,
            [...series.results, result],
            series.elapsed_ms,
          );
        } catch {
          result = rejected('harness-error', [
            implemented.source.locator,
            reviewed.source.locator,
            check,
          ]);
        }
        commit(result);
      } catch (error) {
        if (series.pending !== null) {
          series.pending.error =
            error instanceof Error ? error.message : 'comparison-operation-outcome-unknown';
          save();
        }
        throw error;
      }
    }
    collect(true);
    return { series: path, ...report(series) };
  });
}
