import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mechanicalTaskFixture } from './mechanicalTaskFixture.js';
import { acceptance, throughIntegration, runReview } from './localTaskRun.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import {
  parseMechanicalMaterial,
  parseMechanicalAdmission,
} from '../../src/policy/mechanicalTask.js';
import { parseLocalTask, localTaskKey } from '../../src/policy/localTask.js';
import type { TaskSnapshot } from '../../src/contracts/localTask.js';
import * as admission from '../../src/activities/mechanicalTask.js';
import * as localAdmission from '../../src/activities/localAdmission.js';
import * as mechanical from '../../src/adapters/project/mechanicalTask.js';
import { localTaskFixture } from './localTaskFixture.js';
afterEach(() => vi.restoreAllMocks());
describe('complete mechanical M1', { timeout: 15000 }, () => {
  it.each(['create', 'delete'] as const)(
    'carries an accepted %s through actual checks and independent completion',
    async (operation) => {
      const f = await mechanicalTaskFixture(operation),
        run = await throughIntegration(f, f.mechanicalInput),
        verdict = await acceptance(f, run);
      expect(verdict.complete).toBe(true);
      expect(
        (await run.a.finishLocalTask(f.mechanicalInput, run.snapshot, run.packet, verdict.manifest))
          .status,
      ).toBe('done');
      if (operation === 'create')
        expect(f.files.version(f.workspace, 'created.cjs')!.mode).toBe(0o600);
      else expect(f.files.version(f.workspace, 'obsolete.txt')).toBeNull();
      expect(f.state.creates).toBe(0);
    },
  );
  it('applies multiple accepted files and preserves preexisting versioned acceptance evidence', async () => {
    const f = await mechanicalTaskFixture('multiple');
    const extra = f.save({ kind: 'accepted-criterion', text: 'exact approved bytes only' });
    f.mechanicalInput.admission.acceptance = f.save({
      ...f.read(f.mechanicalInput.admission.acceptance),
      schemaVersion: 2,
      evidence: [extra],
      expectedFiles: [],
    });
    const run = await throughIntegration(f, f.mechanicalInput);
    const request = f.read(run.packet.request);
    expect(request.evidence).toEqual(expect.arrayContaining([extra]));
    expect(readFileSync(join(f.workspace, 'extra.txt'), 'utf8')).toBe('new');
    const verdict = await acceptance(f, run);
    expect(
      (await run.a.finishLocalTask(f.mechanicalInput, run.snapshot, run.packet, verdict.manifest))
        .status,
    ).toBe('done');
    expect(f.state.creates).toBe(0);
  });
  it('stops between mechanical copy writes without integrating a partial result', async () => {
    const f = await mechanicalTaskFixture('multiple'),
      input = f.mechanicalInput,
      s = await f.service.activities.prepareLocalTask(input),
      original = mechanical.applyMechanicalTask;
    let stopped: Promise<unknown> = Promise.resolve();
    vi.spyOn(mechanical, 'applyMechanicalTask').mockImplementation(async (body, files, gate) => {
      const replace = files.replace;
      let count = 0;
      files.replace = (...args) => {
        replace(...args);
        if (++count === 1)
          queueMicrotask(() => {
            stopped = f.service.controls.stopLocalTask(input);
          });
      };
      return original(body, files, gate);
    });
    await expect(f.service.activities.writeLocalTask(input, s)).rejects.toThrow();
    await stopped;
    expect(f.files.version(f.workspace, 'owner.cjs')!.content).toEqual(
      f.material.files[0]!.before!.content,
    );
    expect(f.state.creates).toBe(0);
    expect(f.state.starts).toBe(2);
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).not.toContain('DONE');
  });
  it.each(['basis', 'rules', 'acceptance', 'mode'] as const)(
    'rejects %s changed after admission before copying',
    async (target) => {
      const f = await mechanicalTaskFixture(),
        original = admission.prepareMechanicalTask;
      vi.spyOn(admission, 'prepareMechanicalTask').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (target === 'basis') writeFileSync(join(f.workspace, 'approved/owner.cjs'), 'late');
        if (target === 'rules') writeFileSync(join(f.workspace, 'RULES.md'), 'late');
        if (target === 'acceptance') writeFileSync(join(f.workspace, 'material.json'), 'late');
        if (target === 'mode') {
          const { chmodSync } = await import('node:fs');
          chmodSync(join(f.workspace, 'owner.cjs'), 0o600);
        }
        return result;
      });
      await expect(f.service.activities.prepareLocalTask(f.mechanicalInput)).rejects.toThrow(
        'task-admission-input-changed',
      );
      expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
      await f.service.controls.stopLocalTask(f.mechanicalInput);
    },
  );
  it('also protects the qualified B1 against a post-admission input substitution', async () => {
    const f = localTaskFixture(),
      factory = localAdmission.localAdmissionActivities;
    vi.spyOn(localAdmission, 'localAdmissionActivities').mockImplementation((registration) => {
      const actor = factory(registration);
      return {
        async prepareLocalAdmission(input) {
          const result = await actor.prepareLocalAdmission(input);
          writeFileSync(join(f.workspace, 'RULES.md'), 'changed after admission');
          return result;
        },
      };
    });
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'task-admission-input-changed',
    );
    expect(f.state.starts).toBe(0);
    await f.service.controls.stopLocalTask(f.input);
  });
  it('revokes copy permission while planning revalidation is pending', async () => {
    const f = await mechanicalTaskFixture(),
      original = admission.prepareMechanicalTask;
    vi.spyOn(admission, 'prepareMechanicalTask').mockImplementation(async (...args) => {
      const result = await original(...args);
      await f.service.controls.stopLocalTask(f.mechanicalInput);
      return result;
    });
    await expect(f.service.activities.prepareLocalTask(f.mechanicalInput)).rejects.toThrow();
    expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
    expect(f.state.creates).toBe(0);
  });
  it.each(['material', 'source'] as const)(
    'requires planning to have actually loaded the %s',
    async (missing) => {
      const f = await mechanicalTaskFixture(),
        request = f.read(f.planningInput.request),
        paths = request.sharedPaths as string[];
      request.sharedPaths = paths.filter(
        (path) => path !== (missing === 'material' ? 'material.json' : 'approved/owner.cjs'),
      );
      const partial = await runReview(f, {
        ...f.planningInput,
        reviewId: 'incomplete-proof',
        request: f.save(request),
      });
      expect(partial.complete).toBe(true);
      f.mechanicalInput.admission.accepted = partial.manifest;
      const starts = f.state.starts;
      await expect(f.service.activities.prepareLocalTask(f.mechanicalInput)).rejects.toThrow(
        missing === 'material'
          ? 'mechanical-planning-material-missing'
          : 'mechanical-planning-inputs-incomplete',
      );
      expect(f.state.starts).toBe(starts);
      await f.service.controls.stopLocalTask(f.mechanicalInput);
    },
  );
  it('rejects a real planning FAIL even if the saved summary is forged complete', async () => {
    const f = await mechanicalTaskFixture();
    f.state.verdict = 'FAIL';
    const failed = await runReview(f, { ...f.planningInput, reviewId: 'failed-planning' });
    expect(failed.complete).toBe(false);
    f.mechanicalInput.admission.accepted = f.save({ ...f.read(failed.manifest), complete: true });
    await expect(f.service.activities.prepareLocalTask(f.mechanicalInput)).rejects.toThrow(
      'mechanical-planning-not-passed',
    );
    await f.service.controls.stopLocalTask(f.mechanicalInput);
  });
  it('applies exactly accepted bytes, runs actual checks and obtains independent acceptance without a model writer', async () => {
    const f = await mechanicalTaskFixture();
    f.host.createRuntime = () => {
      throw new Error('M1 must not create a writer');
    };
    const run = await throughIntegration(f, f.mechanicalInput);
    expect(run.writer.session).toBeNull();
    expect(f.state.starts).toBe(2);
    expect(f.state.creates).toBe(0);
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toBe(
      readFileSync(join(f.workspace, 'approved/owner.cjs'), 'utf8'),
    );
    const verdict = await acceptance(f, run);
    expect(verdict.complete).toBe(true);
    expect(
      (await run.a.finishLocalTask(f.mechanicalInput, run.snapshot, run.packet, verdict.manifest))
        .status,
    ).toBe('done');
    expect(f.state.starts).toBe(4);
    expect(f.state.readers).toBe(2);
    expect(await f.service.controls.stopLocalTask(f.mechanicalInput)).toBeDefined();
  });
  it.each([
    'material',
    'source',
    'before',
    'accepted',
    'scope',
    'revision',
    'reports',
    'acceptance',
    'checks',
    'canonical',
  ])('rejects %s before dependent work', async (defect) => {
    const f = await mechanicalTaskFixture(),
      input = f.mechanicalInput,
      before = f.state.starts;
    if (defect === 'material') writeFileSync(join(f.workspace, 'material.json'), '{}');
    if (defect === 'source') writeFileSync(join(f.workspace, 'approved/owner.cjs'), 'changed');
    if (defect === 'before') writeFileSync(join(f.workspace, 'owner.cjs'), 'foreign');
    if (defect === 'accepted') input.admission.accepted = f.save({ complete: true });
    if (['scope', 'revision', 'reports', 'canonical'].includes(defect)) {
      const record = f.read(input.admission.accepted);
      if (defect === 'scope')
        record.input = {
          ...f.planningInput,
          request: f.save({ ...f.review, phase: 'planning', scope: 'other' }),
        };
      if (defect === 'revision')
        record.input = {
          ...f.planningInput,
          preparation: { ...f.planningInput.preparation, revision: 2 },
        };
      if (defect === 'reports') record.reports = [];
      if (defect === 'canonical') record.extra = 'forged result';
      input.admission.accepted = f.save(record);
    }
    if (defect === 'acceptance')
      input.admission.acceptance = f.save({ ...f.review, phase: 'planning' });
    if (defect === 'checks') {
      f.material.checks = ['smoke'];
      const bytes = Buffer.from(JSON.stringify(f.material));
      writeFileSync(join(f.workspace, 'material.json'), bytes);
      input.admission.plan.sha256 = digest(bytes);
    }
    await expect(f.service.activities.prepareLocalTask(input)).rejects.toThrow();
    expect(f.state.starts).toBe(before);
    expect(f.state.creates).toBe(0);
    await f.service.controls.stopLocalTask(input);
  });
  it('rejects any deviation from the accepted delta after application', async () => {
    const f = await mechanicalTaskFixture(),
      a = f.service.activities,
      input = f.mechanicalInput,
      s = await a.prepareLocalTask(input),
      w = await a.writeLocalTask(input, s),
      body = f.read(s) as unknown as TaskSnapshot;
    writeFileSync(join(body.copy.root, 'owner.cjs'), 'unaccepted');
    await expect(a.checkLocalTask(input, s, 'candidate', w, null)).rejects.toThrow(
      'mechanical-stop-unconfirmed',
    );
  });
  it('checks versioned mechanical input and rejects semantic changes, unknown links and malformed targets', async () => {
    const f = await mechanicalTaskFixture();
    expect(parseLocalTask(f.mechanicalInput)).toEqual(f.mechanicalInput);
    expect(localTaskKey(f.mechanicalInput)).toBe('aw/task/neutral/one');
    for (const patch of [
      { schemaVersion: 2 },
      { semanticDelta: true },
      { linksComplete: false },
      { files: [] },
      { checks: [] },
      { files: [...f.material.files, ...f.material.files] },
      { files: [{ ...f.material.files[0], path: '../outside' }] },
      { files: [{ path: 'owner.cjs', before: null, after: null }] },
      {
        files: [
          {
            ...f.material.files[0],
            after: { source: { locator: 'approved/owner.cjs', hash: 'bad' }, mode: 0o644 },
          },
        ],
      },
      {
        files: [{ ...f.material.files[0], after: { ...f.material.files[0]!.after, mode: 0o4000 } }],
      },
    ])
      expect(() => parseMechanicalMaterial({ ...f.material, ...patch })).toThrow();
    expect(() =>
      parseMechanicalAdmission({ ...f.mechanicalInput.admission, schemaVersion: 1 }),
    ).toThrow();
  });
});
