import { join } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';
import { digest } from '../../src/adapters/artifacts/files.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { NativeConnection, WorkerOptions } from '@temporalio/worker';
import type {
  ControlledReaderActivities,
  ReaderControlActivities,
} from '../../src/contracts/readerControl.js';
import type { ReviewActivities, ReviewInput } from '../../src/contracts/review.js';
import { createReaderHost } from '../../src/worker/readerHost.js';
import { readerKey } from '../../src/policy/readerControl.js';
import { requireScoped } from '../../src/policy/review.js';
import { correctionFixture } from './correctionFixture.js';
import { throughIntegration, runReview } from './localTaskRun.js';
const sdk = vi.hoisted(() => ({
  create: vi.fn<(_options: WorkerOptions) => Promise<ReturnType<typeof fakeWorker>>>(),
}));
vi.mock('@temporalio/worker', () => ({ Worker: { create: sdk.create } }));
vi.mock('@temporalio/activity', () => ({ Context: { current: () => ({ heartbeat() {} }) } }));
function fakeWorker() {
  let stop!: () => void;
  const ended = new Promise<void>((done) => {
    stop = done;
  });
  return { run: () => ended, shutdown: () => stop() };
}
beforeEach(() => {
  vi.resetAllMocks();
  sdk.create.mockImplementation(async () => fakeWorker());
});
afterEach(() => vi.restoreAllMocks());
describe('correction adviser ownership', { timeout: 30000 }, () => {
  it('retires the old grant, resumes the same adviser and leaves the unchanged role idle', async () => {
    const f = correctionFixture(),
      input = f.correctionInput,
      a = f.service.activities;
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning),
      first = await throughIntegration(f, input, approved.manifest);
    const requests = vi.spyOn(f.rpc, 'request');
    const host = await createReaderHost(
      {} as NativeConnection,
      'q',
      'w',
      [{ registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host }],
      f.profile,
      join(f.root, 'host'),
      16,
    );
    const controls = sdk.create.mock.calls.at(-2)![0].activities as ReaderControlActivities;
    const models = sdk.create.mock.calls.at(-1)![0].activities as ControlledReaderActivities &
      ReviewActivities;
    const assignments: {
      input: ReturnType<typeof requireScoped>;
      permit: { sha256: string; bytes: number };
    }[] = [];
    async function review(packet: ReviewInput) {
      const plan = await models.prepareReviewPlan(packet),
        answers = [];
      for (const row of plan.decisions) {
        if (row.action !== 'review') {
          answers.push({ roleId: row.roleId, answer: row.answer });
          continue;
        }
        const actor = requireScoped(row.input),
          permit = await controls.registerReader(actor, readerKey(actor)),
          epoch = { permit, revision: 0, attempt: 0 };
        assignments.push({ input: actor, permit });
        const prepared = await models.prepareControlledReader(actor, epoch),
          session =
            assignments.length === 3
              ? await (async () => {
                  const concurrent = await Promise.allSettled([
                    models.createReader(actor, prepared, epoch),
                    models.createReader(actor, prepared, epoch),
                  ]);
                  const success = concurrent.find((result) => result.status === 'fulfilled')!;
                  expect(
                    String(concurrent.find((result) => result.status === 'rejected')?.reason),
                  ).toContain('reader-retarget-busy');
                  if (success.status !== 'fulfilled') throw new Error('missing resumed session');
                  const folder = join(
                    f.root,
                    'host',
                    digest(f.registration.project.projectId),
                    'effects',
                  );
                  for (const file of readdirSync(folder).filter((name) =>
                    name.endsWith('.receipt'),
                  ))
                    unlinkSync(join(folder, file));
                  expect(await models.createReader(actor, prepared, epoch)).toEqual(success.value);
                  return success.value;
                })()
              : await models.createReader(actor, prepared, epoch),
          load = await models.loadReader(actor, prepared, session, epoch),
          answer = await models.answerReader(actor, prepared, session, load, epoch);
        answers.push({ roleId: row.roleId, answer });
      }
      return {
        ...(await models.finishReview({
          schemaVersion: 1,
          input: packet,
          plan: plan.manifest,
          answers,
        })),
        plan,
      };
    }
    await host.runUntil(async () => {
      const failed = await review(first.packet);
      expect(failed.complete).toBe(false);
      const next = await a.prepareLocalCorrection(
          input,
          first.snapshot,
          first.packet,
          failed.manifest,
        ),
        second = await throughIntegration(f, input, undefined, next),
        before = f.state.starts,
        accepted = await review(second.packet);
      expect(accepted.complete).toBe(true);
      expect(f.state.starts - before).toBe(2);
      expect(f.state.readers).toBe(4);
      expect(accepted.plan.decisions.map((row) => [row.roleId, row.action])).toEqual([
        ['reviewer', 'review'],
        ['tester', 'reuse'],
      ]);
      const old = assignments[0]!,
        current = assignments[2]!;
      const calls = requests.mock.calls.length;
      const revision = await controls.freezeReader(old.input, old.permit);
      expect((await controls.stopReader(old.input, old.permit, revision)).status).toBe('stopped');
      expect(requests.mock.calls).toHaveLength(calls);
      await expect(controls.stopReader(old.input, old.permit, revision + 1)).rejects.toThrow(
        'reader-retired-binding',
      );
      const conflict = await models.prepareReviewPlan({
          ...second.packet,
          reviewId: 'conflicting-owner',
        }),
        actor = requireScoped(conflict.decisions[0]!.input),
        permit = await controls.registerReader(actor, readerKey(actor)),
        conflictEpoch = { permit, revision: 0, attempt: 0 };
      await expect(
        models.createReader(
          actor,
          await models.prepareControlledReader(actor, conflictEpoch),
          conflictEpoch,
        ),
      ).rejects.toThrow('reader-retarget-owner-conflict');
      const epoch = { permit: old.permit, revision: 0, attempt: 0 };
      await expect(
        models.createReader(
          old.input,
          await models.prepareControlledReader(current.input, {
            permit: current.permit,
            revision: 0,
            attempt: 0,
          }),
          epoch,
        ),
      ).rejects.toThrow('reader-permit-revoked');
      const legacy = await models.prepareReviewPlan({
          ...second.packet,
          reviewId: 'legacy-fresh',
          request: f.save(f.correctionRequest),
        }),
        fresh = requireScoped(legacy.decisions[0]!.input),
        freshPermit = await controls.registerReader(fresh, readerKey(fresh)),
        freshEpoch = { permit: freshPermit, revision: 0, attempt: 0 };
      const freshSession = await models.createReader(
        fresh,
        await models.prepareControlledReader(fresh, freshEpoch),
        freshEpoch,
      );
      expect(
        (f.read(accepted.manifest).reports as { answer: { sha256: string; bytes: number } }[]).map(
          (row) => f.read(row.answer).session,
        ),
      ).not.toContain(freshSession.id);
      expect((await a.finishLocalTask(input, next, second.packet, accepted.manifest)).status).toBe(
        'done',
      );
    });
  });
});
