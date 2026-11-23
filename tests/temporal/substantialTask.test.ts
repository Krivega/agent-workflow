import { basename, join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { localTaskFixture } from './localTaskFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import {
  parseSubstantialPlan,
  parseSubstantialAdmission,
} from '../../src/policy/substantialTask.js';
import { validateLocalPlan } from '../../src/policy/localPlanning.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { readerReportSchema, readerReport } from '../../src/adapters/codex/readerMessages.js';
import { requireScoped, parseReviewSnapshot, reviewChanges } from '../../src/policy/review.js';
import { reviewActivities } from '../../src/activities/review.js';
import * as substantial from '../../src/activities/substantialTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { prepareTaskStartAdmission } from '../../src/adapters/project/taskStartAdmission.js';
import { buildPreparedTaskPreview } from '../../src/client/taskStartPreview.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import type { SubstantialCriterionCheck } from '../../src/contracts/substantialTask.js';
afterEach(() => vi.restoreAllMocks());

function startFixture() {
  const f = substantialTaskFixture();
  const input: HumanManagedTaskInput = {
    ...f.substantialInput,
    schemaVersion: 12,
    startAdmission: f.proof,
    continuation: { attempt: 0, previous: null },
  };
  return { ...f, input };
}

const firstCriterion = 'K1: Сохраняются одинаковые квитанции';
const humanCriterion = 'K2: Владелец подтверждает результат';
const writerCriterion = 'K3: Обновить объяснение';
const excludedCriterion = 'Проверка отсутствующего режима';
const expectedCommand: SubstantialCriterionCheck = {
  criterion: 'K1',
  stage: 'candidate',
  command: 'validate',
  evidence: 'Журнал validate',
  success: 'Квитанции содержат один ID',
};
const expectedReview: SubstantialCriterionCheck = {
  criterion: firstCriterion,
  stage: 'acceptance',
  roleId: 'reviewer',
  subject: 'Сверить идентификаторы в квитанциях',
  evidence: 'Отчёт приёмки',
  success: 'Ревьюер подтвердил совпадение',
};

async function previewFixture() {
  const f = startFixture();
  const preparation = f.input.admission.preparation;
  const card = `# Поручение\n\n## Критерии приёмки\n\n${[
    firstCriterion,
    humanCriterion,
    writerCriterion,
    excludedCriterion,
  ]
    .map((criterion) => `- [ ] ${criterion}`)
    .join('\n')}\n`;
  writeFileSync(join(f.workspace, preparation.card), card);
  f.proposal.requirement.hash = digest(card);
  f.proposal.criterion = writerCriterion;
  function setChecks(checks?: SubstantialCriterionCheck[]) {
    if (checks === undefined) delete f.proposal.criterion_checks;
    else f.proposal.criterion_checks = checks;
    const plan = JSON.stringify(f.proposal);
    writeFileSync(join(f.workspace, f.input.admission.plan.path), plan);
    f.input.admission.plan.sha256 = digest(plan);
  }
  setChecks([expectedCommand, expectedReview]);
  const principal = {
    owner: f.registration.owner,
    threadId: 'preview-thread',
    turnId: 'preview-turn',
    source: { locator: 'private-preview-message', hash: f.proof.sha256 },
    proof: f.proof,
  };
  const startAuthority = { issue: async () => principal, verify: async () => {} };
  const admitted = await prepareTaskStartAdmission(f.registration, startAuthority, {
    preparation,
    previous: null,
    human: [humanCriterion],
    inapplicable: [{ criterion: excludedCriterion, reason: 'Режим отключён' }],
  });
  f.input.startAdmission = admitted.ref;
  return {
    ...f,
    admitted,
    startAuthority,
    setChecks,
    preview: () => buildPreparedTaskPreview(f.registration, f.input, admitted),
  };
}

describe('prepared task preview', () => {
  it('shows the declared checks, human gate and writer scope with only the unassigned criterion called out', async () => {
    const f = await previewFixture();
    const other = await previewFixture();
    const retained = readdirSync(f.registration.artifactRoot).sort();
    const rpc = vi.spyOn(f.rpc, 'request');
    const preview = f.preview();
    const { summary } = preview;
    expect(f.preview()).toEqual(preview);
    expect(other.preview().summary).toMatchObject({
      projectId: summary.projectId,
      workspaceRoot: other.workspace,
    });
    expect(other.workspace).not.toBe(summary.workspaceRoot);
    expect(summary).toMatchObject({
      gaps: {
        withoutReviewerCount: 1,
        withoutReviewer: [{ id: 'K3', text: writerCriterion }],
        incompleteChecks: [],
      },
      card: f.input.admission.preparation.card,
      workspaceRoot: f.workspace,
      stages: {
        planning: { roles: [{ roleId: 'reviewer' }, { roleId: 'tester' }] },
        baseline: {
          commands: [{ id: 'smoke', args: f.registration.commands.smoke.args }],
          criteria: [],
        },
        writing: { paths: f.proposal.paths, profile: f.input.executor.path, criteria: ['K3'] },
        candidate: {
          commands: [
            { id: 'smoke' },
            { id: 'validate', args: f.registration.commands.validate.args },
          ],
          criteria: ['K1'],
        },
        integrated: { commands: [{ id: 'smoke' }, { id: 'validate' }], criteria: [] },
        acceptance: { roles: [{ roleId: 'reviewer' }, { roleId: 'tester' }], criteria: ['K1'] },
        human: { criteria: ['K2'] },
      },
      criteria: [
        {
          id: 'K1',
          checks: [
            {
              participant: 'Хост',
              commandId: 'validate',
              evidence: expectedCommand.evidence,
              success: expectedCommand.success,
            },
            {
              participant: 'reviewer',
              subject: 'Сверить идентификаторы в квитанциях',
              evidence: expectedReview.evidence,
              success: expectedReview.success,
            },
          ],
        },
        { id: 'K2', checks: [{ stage: 'human', participant: 'Владелец задачи' }] },
        { id: 'K3', checks: [] },
        { id: excludedCriterion, applicable: false, reason: 'Режим отключён' },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('private-preview-message');
    expect(JSON.stringify(summary)).not.toContain(f.registration.artifactRoot);
    expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(retained);
    expect(rpc).not.toHaveBeenCalled();
    f.setChecks([expectedCommand, expectedReview, { ...expectedCommand, criterion: 'K3' }]);
    expect(f.preview().summary.gaps.withoutReviewerCount).toBe(0);
    f.setChecks();
    expect(f.preview().summary.gaps.withoutReviewerCount).toBe(2);
  });

  it.each([
    ['evidence', 'Доказательство не указано'],
    ['success', 'Условие успеха не задано'],
  ] as const)(
    'reports missing %s while retaining the other evidence fields',
    async (field, missing) => {
      const f = await previewFixture();
      const check = { ...expectedCommand };
      delete check[field];
      f.setChecks([check, expectedReview]);
      const { summary } = f.preview();
      expect(summary.gaps.incompleteChecks).toEqual([
        {
          id: 'K1',
          text: firstCriterion,
          stage: 'candidate',
          participant: 'Хост',
          missing: [missing],
        },
      ]);
      expect(summary.criteria[0]!.checks[0]).toMatchObject({
        evidence: check.evidence ?? null,
        success: check.success ?? null,
      });
    },
  );

  it.each([
    {
      checks: [{ ...expectedCommand, stage: 'writing' }],
      error: 'substantial-criterion-check-stage',
    },
    { checks: {}, error: 'substantial-criterion-checks' },
    {
      checks: [{ ...expectedCommand, stage: 'baseline' }],
      error: 'substantial-criterion-command-unassigned',
    },
    {
      checks: [{ ...expectedReview, roleId: 'foreign' }],
      error: 'substantial-criterion-review-unassigned',
    },
    {
      checks: [{ ...expectedCommand, criterion: 'missing' }],
      error: 'substantial-criterion-check-target',
    },
  ])('refuses an invalid criterion binding ($error)', async ({ checks, error }) => {
    const f = await previewFixture();
    f.setChecks(checks as SubstantialCriterionCheck[]);
    expect(f.preview).toThrow(error);
  });

  it('changes the fingerprint for changed inputs and commands, and verifies the retained card and registration', async () => {
    const f = await previewFixture();
    const original = f.preview();
    const role = join(f.workspace, 'reviewer.md');
    writeFileSync(role, 'New role instructions');
    const updated = f.preview();
    expect(updated.fingerprint).not.toBe(original.fingerprint);
    expect(updated.summary).toEqual(original.summary);
    f.registration.commands.smoke.args.push('new flag');
    expect(f.preview().fingerprint).not.toBe(updated.fingerprint);
    expect(() =>
      buildPreparedTaskPreview({ ...f.registration, owner: 'foreign' }, f.input, f.admitted),
    ).toThrow('preparation-grant-mismatch');
    expect(() =>
      buildPreparedTaskPreview(f.registration, { ...f.input, startAdmission: f.proof }, f.admitted),
    ).toThrow('task-start-card-changed');
    expect(() =>
      buildPreparedTaskPreview(f.registration, f.input, {
        ...f.admitted,
        admission: { ...f.admitted.admission, card: { ...f.admitted.admission.card, ...f.proof } },
      }),
    ).toThrow('task-start-card-changed');
  });

  it.each([false, true])(
    'matches previewed commands and write conditions to retained Activity evidence (baseline failure %s)',
    async (baselineFails) => {
      const f = await previewFixture();
      if (baselineFails) f.registration.commands.smoke.args[1] = 'missing.cjs';
      const { stages, effects } = f.preview().summary;
      const { preparation } = f.input.admission;
      declareBackendFixture(f.workspace);
      const home = taskBackendHome(f.workspace);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'backend-policy.json'),
        JSON.stringify({
          schemaVersion: 2,
          newTasks: 'temporal',
          startAdmission: 'task-start-admission/1',
        }),
      );
      await reserveTaskBackend(
        f.workspace,
        {
          schemaVersion: 2,
          projectId: preparation.project.projectId,
          taskId: preparation.taskId,
          backend: 'temporal',
          cardName: basename(preparation.card),
          origin: f.admitted.admission.card.sha256,
          startAdmission: f.admitted.ref,
        },
        { registration: f.registration, authority: f.startAuthority, preparation },
      );
      const service = localTaskActivities(
        f.registration,
        {
          ...f.host,
          authority: f.authority,
          startAdmissionAuthority: f.startAuthority,
        },
        f.rpc,
        f.profile,
        () => {},
      );
      await service.executionControls.prepareTaskExecution(f.input);
      const planning = await service.activities.prepareSubstantialPlanning(f.input);
      const reviewed = await runReview(f, planning);
      expect(reviewed.complete).toBe(true);
      const snapshot = await service.activities.prepareLocalTask(f.input, reviewed.manifest);
      const baseline = await service.activities.checkLocalTask(
        f.input,
        snapshot,
        'baseline',
        null,
        null,
      );
      const observed = (manifest: ArtifactRef) =>
        (f.read(manifest).outcomes as { name: string; proof: ArtifactRef }[]).map(
          ({ name, proof }) => ({
            id: name,
            ...(f.read(proof).command as Omit<(typeof stages.baseline.commands)[number], 'id'>),
          }),
        );
      expect(observed(baseline.manifest)).toEqual(stages.baseline.commands);
      const source = join(f.workspace, 'owner.cjs');
      expect(effects.worker.join(' ')).toContain('При её успехе запускает модель исполнителя');
      expect(readFileSync(source, 'utf8')).not.toContain('trim()');
      if (baselineFails) {
        expect(baseline.status).toBe('FAIL');
        expect(f.state.creates).toBe(0);
      } else {
        expect(baseline.status).toBe('PASS');
        const run = await throughIntegration(
          { ...f, service },
          f.input,
          reviewed.manifest,
          snapshot,
        );
        expect(observed(run.candidate.manifest)).toEqual(stages.candidate.commands);
        expect(observed(run.checked.manifest)).toEqual(stages.integrated.commands);
        expect(readFileSync(source, 'utf8')).toContain('trim()');
        expect((await acceptance(f, run)).complete).toBe(true);
      }
      await service.controls.stopLocalTask(f.input);
    },
    15_000,
  );
});

describe('read-only substantial start checks', () => {
  it('accepts a complete start and an explicitly declared future acceptance file without writing', () => {
    const f = startFixture();
    const { input, registration, workspace } = f;
    const original = readdirSync(registration.artifactRoot).sort();
    const rpc = vi.spyOn(f.rpc, 'request');
    substantial.checkSubstantialStartInputs(registration, input);
    expect(readdirSync(registration.artifactRoot).sort()).toEqual(original);
    f.proposal.paths.push('generated.cjs');
    const bytes = Buffer.from(JSON.stringify(f.proposal));
    writeFileSync(join(workspace, 'plan.json'), bytes);
    input.admission.plan.sha256 = digest(bytes);
    const pinned = readFileSync(join(workspace, 'accepted.md'));
    input.admission.acceptance = f.save({
      ...f.request,
      schemaVersion: 2,
      evidence: [f.proof],
      sharedPaths: [...f.request.sharedPaths, 'generated.cjs'],
      expectedFiles: [
        { path: 'accepted.md', sha256: digest(pinned), bytes: pinned.length },
        { path: 'generated.cjs', ...f.proof },
      ],
      roles: [
        f.request.roles[0]!,
        { ...f.request.roles[1]!, applies: false, history: { complete: true, answers: [] } },
      ],
    });
    const before = readdirSync(registration.artifactRoot).sort();
    substantial.checkSubstantialStartInputs(registration, input);
    expect(readdirSync(registration.artifactRoot).sort()).toEqual(before);
    expect(existsSync(join(workspace, 'generated.cjs'))).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a declared planning input absent from the candidate snapshot without writing', () => {
    const f = startFixture();
    f.input.admission.planning = f.save({
      ...f.request,
      phase: 'planning',
      sharedPaths: [...f.request.sharedPaths, 'missing.cjs'],
    });
    const before = readdirSync(f.registration.artifactRoot).sort();
    expect(() => substantial.checkSubstantialStartInputs(f.registration, f.input)).toThrow(
      'substantial-planning-inputs-incomplete',
    );
    expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(before);
  });

  it('rejects an acceptance path absent from the source and the plan without writing', () => {
    const f = startFixture();
    f.input.admission.acceptance = f.save({
      ...f.request,
      sharedPaths: [...f.request.sharedPaths, 'missing.cjs'],
    });
    const before = readdirSync(f.registration.artifactRoot).sort();
    expect(() => substantial.checkSubstantialStartInputs(f.registration, f.input)).toThrow(
      'substantial-acceptance-input-missing',
    );
    expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(before);
  });

  it.each(['executable', 'timeout'])(
    'rejects a broken registered check %s before writing',
    (defect) => {
      const f = startFixture();
      if (defect === 'executable')
        f.registration.commands.smoke.executable = join(f.root, 'missing-check');
      else Object.assign(f.registration.commands.validate, { timeoutMs: 1200001 });
      const before = readdirSync(f.registration.artifactRoot).sort();
      const rpc = vi.spyOn(f.rpc, 'request');
      expect(() => substantial.checkSubstantialStartInputs(f.registration, f.input)).toThrow(
        defect === 'executable' ? 'ENOENT' : 'task-check-timeout-invalid',
      );
      expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(before);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('rejects stale immutable acceptance pins, missing history, and correction templates without writing', () => {
    const f = startFixture();
    const { input, registration } = f;
    const base = { ...f.request, schemaVersion: 2, evidence: [], expectedFiles: [] };
    const missing = { sha256: 'e'.repeat(64), bytes: 10 };
    const verify = (request: unknown, reason: string) => {
      input.admission.acceptance = f.save(request);
      const before = readdirSync(registration.artifactRoot).sort();
      expect(() => substantial.checkSubstantialStartInputs(registration, input)).toThrow(reason);
      expect(readdirSync(registration.artifactRoot).sort()).toEqual(before);
    };
    verify(
      { ...base, expectedFiles: [{ path: 'accepted.md', ...f.proof }] },
      'substantial-acceptance-expected-input-changed',
    );
    verify(
      {
        ...base,
        roles: [
          { ...f.request.roles[0]!, history: { complete: true, answers: [missing] } },
          f.request.roles[1]!,
        ],
      },
      'ENOENT',
    );
    verify(
      {
        ...base,
        schemaVersion: 4,
        roleEvidence: f.request.roles.map(({ roleId }) => ({
          roleId,
          evidence: [],
          openFindings: [],
        })),
      },
      'substantial-start-review-schema',
    );
  });
});

describe('complete ordinary substantial', { timeout: 15000 }, () => {
  it('runs two independent planning and accepting roles around the shared real writer/check/integration path', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput,
      a = f.service.activities;
    const schemas: Record<string, unknown>[] = [];
    const request = f.rpc.request;
    vi.spyOn(f.rpc, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start' && params.outputSchema)
        schemas.push(params.outputSchema as Record<string, unknown>);
      return request(method, params);
    });
    const planning = await a.prepareSubstantialPlanning(input);
    expect(await a.prepareSubstantialPlanning(input)).toEqual(planning);
    expect(f.state.starts).toBe(0);
    const approved = await runReview(f, planning);
    expect(approved.complete).toBe(true);
    expect(f.state.readers).toBe(2);
    expect(f.state.creates).toBe(0);
    const run = await throughIntegration(f, input, approved.manifest);
    const verdict = await acceptance(f, run);
    expect(verdict.complete).toBe(true);
    expect(
      (await a.finishLocalTask(input, run.snapshot, run.packet, verdict.manifest)).status,
    ).toBe('done');
    expect(f.state.readers).toBe(4);
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(11);
    expect(schemas).toHaveLength(4);
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toContain('trim()');
  });
  it.each([
    'plan',
    'source',
    'consumer',
    'missing-profile',
    'executor',
    'checks',
    'roles',
    'applicability',
    'scope',
    'coverage',
    'acceptance-file',
    'private',
  ])('rejects %s before any planning or writer model', async (defect) => {
    const f = substantialTaskFixture(),
      input = f.substantialInput;
    if (defect === 'plan') writeFileSync(join(f.workspace, 'plan.json'), '{}');
    if (defect === 'source') writeFileSync(join(f.workspace, 'proposal.md'), 'changed');
    if (defect === 'consumer') writeFileSync(join(f.workspace, 'consumer.cjs'), 'changed');
    if (defect === 'missing-profile') {
      input.admission.preparation.project.roles[0]!.profile = 'missing.md';
      f.service = f.makeService();
    }
    if (defect === 'executor') writeFileSync(join(f.workspace, 'executor.md'), 'changed');
    if (defect === 'checks' || defect === 'private') {
      if (defect === 'checks') f.proposal.checks = ['smoke'];
      else f.proposal.paths = ['.env'];
      const bytes = Buffer.from(JSON.stringify(f.proposal));
      writeFileSync(join(f.workspace, 'plan.json'), bytes);
      input.admission.plan.sha256 = digest(bytes);
    }
    if (['roles', 'applicability', 'scope', 'coverage'].includes(defect)) {
      const request = { ...f.request, phase: 'planning' };
      if (defect === 'roles') request.roles = request.roles.slice(0, 1);
      if (defect === 'applicability') request.roles[0]!.applies = null;
      if (defect === 'scope') request.scope = 'other';
      if (defect === 'coverage')
        request.sharedPaths = request.sharedPaths.filter((p) => p !== 'proposal.md');
      input.admission.planning = f.save(request);
    }
    if (defect === 'acceptance-file')
      input.admission.acceptance = f.save({
        ...f.request,
        sharedPaths: [...f.request.sharedPaths, 'missing.cjs'],
      });
    await expect(f.service.activities.prepareSubstantialPlanning(input)).rejects.toThrow(
      defect === 'missing-profile' ? 'missing.md' : undefined,
    );
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
    await f.service.controls.stopLocalTask(input);
  });
  it.each(['source', 'mode', 'forged', 'wrong-target', 'failed', 'missing-proof'])(
    'rejects %s after planning with zero dependent writer starts',
    async (defect) => {
      const f = substantialTaskFixture(),
        input = f.substantialInput,
        a = f.service.activities;
      const planning = await a.prepareSubstantialPlanning(input);
      if (defect === 'failed') f.state.verdict = 'FAIL';
      const approved = await runReview(f, planning);
      let ref = approved.manifest;
      if (defect === 'source') writeFileSync(join(f.workspace, 'proposal.md'), 'late');
      if (defect === 'mode') chmodSync(join(f.workspace, 'owner.cjs'), 0o600);
      if (defect === 'forged' || defect === 'failed')
        ref = f.save({ ...f.read(ref), complete: true, extra: 'forged' });
      if (defect === 'wrong-target') {
        const other = await runReview(f, { ...planning, reviewId: 'foreign' });
        ref = other.manifest;
      }
      const starts = f.state.starts;
      await expect(
        a.prepareLocalTask(input, defect === 'missing-proof' ? undefined : ref),
      ).rejects.toThrow();
      expect(f.state.creates).toBe(0);
      expect(f.state.starts).toBe(starts);
      expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
      await f.service.controls.stopLocalTask(input);
    },
  );
  it('rejects forged final acceptance and retains the primary reports', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput,
      a = f.service.activities;
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning),
      run = await throughIntegration(f, input, approved.manifest),
      verdict = await acceptance(f, run);
    await expect(
      a.finishLocalTask(
        input,
        run.snapshot,
        run.packet,
        f.save({ ...f.read(verdict.manifest), extra: 'forged' }),
      ),
    ).rejects.toThrow('task-acceptance-not-passed');
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).not.toContain('DONE');
    await f.service.controls.stopLocalTask(input);
  });
  it('supports a declared new file and explicit N/A while preserving versioned planning and acceptance evidence', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput,
      a = f.service.activities;
    f.proposal.paths.push('generated.cjs');
    const bytes = Buffer.from(JSON.stringify(f.proposal));
    writeFileSync(join(f.workspace, 'plan.json'), bytes);
    input.admission.plan.sha256 = digest(bytes);
    const extra = f.save({ kind: 'proposal-evidence', text: 'new file is explicitly in scope' });
    const current = f.proposal.basis[0]!;
    const expected = {
      path: current.locator,
      sha256: current.hash,
      bytes: readFileSync(join(f.workspace, current.locator)).length,
    };
    input.admission.planning = f.save({
      ...f.request,
      phase: 'planning',
      schemaVersion: 2,
      evidence: [extra],
      expectedFiles: [expected],
    });
    input.admission.acceptance = f.save({
      ...f.request,
      schemaVersion: 2,
      evidence: [extra],
      expectedFiles: [expected],
      roles: [
        { ...f.request.roles[0]!, paths: ['owner.cjs', 'generated.cjs'] },
        { ...f.request.roles[1]!, applies: false, paths: [] },
      ],
    });
    const runtime = f.createRuntime;
    f.host.createRuntime = (root) => {
      const rpc = runtime(root);
      return {
        ...rpc,
        async request(method, params) {
          const response = await rpc.request(method, params);
          if (
            method === 'turn/start' &&
            (params.input as { text: string }[])[0]!.text.includes('Выполни локальный план')
          )
            writeFileSync(join(root, 'generated.cjs'), 'module.exports = 7;\n');
          return response;
        },
      };
    };
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning),
      run = await throughIntegration(f, input, approved.manifest),
      verdict = await acceptance(f, run);
    expect(
      (await a.finishLocalTask(input, run.snapshot, run.packet, verdict.manifest)).status,
    ).toBe('done');
    expect(readFileSync(join(f.workspace, 'generated.cjs'), 'utf8')).toBe('module.exports = 7;\n');
    expect(f.state.readers).toBe(3);
    expect(f.state.starts).toBe(9);
  });
  it('rejects stale expected planning files before a model and stale acceptance expectations before its reviewers', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput,
      a = f.service.activities;
    input.admission.planning = f.save({
      ...f.request,
      phase: 'planning',
      schemaVersion: 2,
      evidence: [],
      expectedFiles: [{ path: 'owner.cjs', ...f.proof }],
    });
    await expect(a.prepareSubstantialPlanning(input)).rejects.toThrow(
      'substantial-planning-input-changed',
    );
    expect(f.state.starts).toBe(0);
    await f.service.controls.stopLocalTask(input);
    const g = substantialTaskFixture(),
      other = g.substantialInput,
      actor = g.service.activities;
    other.admission.acceptance = g.save({
      ...g.request,
      schemaVersion: 2,
      evidence: [],
      expectedFiles: [{ path: 'owner.cjs', ...g.proof }],
    });
    const planning = await actor.prepareSubstantialPlanning(other),
      approved = await runReview(g, planning);
    await expect(throughIntegration(g, other, approved.manifest)).rejects.toThrow(
      'task-acceptance-expected-input-changed',
    );
    expect(g.state.readers).toBe(2);
    expect(g.state.creates).toBe(1);
    await g.service.controls.stopLocalTask(other);
  });
  it('rejects a file mode changed after planning admission and before the copy is created', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput,
      a = f.service.activities;
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning),
      original = substantial.admitSubstantialTask;
    vi.spyOn(substantial, 'admitSubstantialTask').mockImplementation(async (...args) => {
      const result = await original(...args);
      chmodSync(join(f.workspace, 'owner.cjs'), 0o600);
      return result;
    });
    await expect(a.prepareLocalTask(input, approved.manifest)).rejects.toThrow(
      'task-admission-input-changed',
    );
    expect(f.state.creates).toBe(0);
    expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
    await f.service.controls.stopLocalTask(input);
  });
  it('rejects a non-substantial preflight and prevents copying when cancellation revokes the grant', async () => {
    const f = localTaskFixture();
    await expect(f.service.activities.prepareSubstantialPlanning(f.input)).rejects.toThrow(
      'substantial-input-required',
    );
    const g = substantialTaskFixture(),
      input = g.substantialInput,
      a = g.service.activities;
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(g, planning);
    await g.service.controls.stopLocalTask(input);
    await expect(a.prepareLocalTask(input, approved.manifest)).rejects.toThrow();
    expect(g.state.creates).toBe(0);
    expect(existsSync(join(g.registration.artifactRoot, 'copies'))).toBe(false);
  });
  it('constrains report binding at generation and still rejects a corrupted primary hash', async () => {
    const f = substantialTaskFixture(),
      input = f.substantialInput;
    const planning = await f.service.activities.prepareSubstantialPlanning(input);
    const rows = await reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(
      planning,
    );
    const actor = requireScoped(rows.decisions[0]!.input),
      snapshot = parseReviewSnapshot(f.read(actor.review), actor);
    expect(snapshot.schemaVersion).toBe(3);
    const schema = readerReportSchema(actor, snapshot);
    expect(schema.properties.review.properties.sha256.enum).toEqual([actor.review.sha256]);
    expect(schema.properties.review.properties.bytes.enum).toEqual([actor.review.bytes]);
    expect(schema.additionalProperties).toBe(false);
    expect(reviewChanges({ ...snapshot, schemaVersion: 2, evidence: [] }, snapshot)).toContain(
      'report-format-changed',
    );
    expect(() =>
      readerReport(
        {
          items: [
            {
              type: 'agentMessage',
              text: JSON.stringify({
                schemaVersion: 1,
                roleId: actor.roleId,
                phase: snapshot.phase,
                scope: snapshot.scope,
                review: { ...actor.review, sha256: actor.review.sha256 + '0' },
                verdict: 'PASS',
                coverage: 'complete',
                findings: [],
                limitations: [],
              }),
            },
          ],
        },
        actor,
        snapshot,
      ),
    ).toThrow('reader-control-proof-invalid');
    expect(f.state.starts).toBe(0);
    await f.service.controls.stopLocalTask(input);
  });
  it('keeps positive risks out of B1 and checks the separate versioned substantial contract', () => {
    const f = substantialTaskFixture();
    expect(parseLocalTask(f.substantialInput)).toEqual(f.substantialInput);
    expect(() => validateLocalPlan(f.proposal)).toThrow();
    for (const patch of [
      { schema_version: 1 },
      { risks: {} },
      { risks: { ...f.proposal.risks, new_behavior: null } },
      { risks: { ...f.proposal.risks, unknown_consumers: true } },
      { risks: { ...f.plan.risks } },
      { extra: true },
      { basis: [{ locator: '../private', hash: 'bad' }] },
    ])
      expect(() => parseSubstantialPlan({ ...f.proposal, ...patch })).toThrow();
    expect(() =>
      parseSubstantialAdmission({ ...f.substantialInput.admission, schemaVersion: 1 }),
    ).toThrow();
    const local = localTaskFixture();
    expect(() => parseLocalTask({ ...local.input, schemaVersion: 3 })).toThrow();
  });
});
