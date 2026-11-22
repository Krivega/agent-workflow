import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlFixture } from './controlFixture.js';
import {
  readerExecution,
  parseReaderExecution,
  supportedReaderClient,
} from '../../src/policy/readerExecution.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerActivities } from '../../src/activities/reader.js';

describe('immutable execution configuration', () => {
  it('accepts only the explicitly supported reader clients, without prefix or stable-version fallback', () => {
    for (const version of ['0.154.0', '0.165.0-alpha.1.2', '0.169.1'])
      expect(supportedReaderClient(version)).toBe(true);
    for (const version of [
      '',
      '0.165.0',
      '0.165.0-alpha.1.3',
      '0.154.1',
      '0.169.0',
      '0.169.2',
      'other',
    ])
      expect(supportedReaderClient(version)).toBe(false);
  });
  it('copies the accepted profile and pins it before preparation or model creation', async () => {
    const f = controlFixture(),
      accepted = readerExecution(f.profile);
    expect(f.gate.execution(f.input, f.permit)).toEqual(accepted);
    f.profile.model = 'changed-model';
    expect(f.gate.execution(f.input, f.permit)).toEqual(accepted);
    f.gate.boundary.assert(f.input, f.epoch);
    const activity = readerActivities(
      f.registration,
      f.rpc,
      f.profile,
      join(f.root, 'effects'),
      f.gate.boundary,
    );
    const prepared = await activity.prepareProject(f.input.preparation);
    await expect(activity.createReader(f.input, prepared, f.epoch)).rejects.toThrow(
      'reader-execution-changed',
    );
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it.each([{ model: 'other' }, { clientVersion: '0.165.0-alpha.1.2' }])(
    'rejects a changed Worker profile but preserves fencing and stop under the original profile: %j',
    async (change) => {
      const f = controlFixture();
      await f.gate.boundary.dispatch(
        f.input,
        f.epoch,
        'create',
        'thread/start',
        {},
        async () => f.response,
      );
      f.response.thread.turns.push({ id: 'active', status: 'inProgress' });
      const changed = readerBoundary(
        f.boundaryRoot,
        f.store,
        f.workspace,
        readerExecution({ ...f.profile, ...change }),
      );
      expect(() => changed.install(f.input)).toThrow('reader-execution-changed');
      expect(() => changed.boundary.assert(f.input, f.epoch)).toThrow('reader-execution-changed');
      f.gate.advance(f.input, f.permit, f.command(), f.proof);
      await f.controls.stopReader(f.input, f.permit, 1);
      expect(() => changed.advance(f.input, f.permit, f.command('resume', 1, 1), f.proof)).toThrow(
        'reader-execution-changed',
      );
      expect(changed.freeze(f.input, f.permit)).toBe(2);
      expect((await f.controls.stopReader(f.input, f.permit, 2)).status).toBe('stopped');
    },
  );
  it('checks permit schema and target/workspace bindings rather than trusting a replacement artifact', () => {
    const f = controlFixture(),
      folder = join(f.boundaryRoot, readdirSync(f.boundaryRoot)[0]!),
      file = join(folder, 'permission.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const proof = JSON.parse(f.store.read(f.permit).toString()) as Record<string, unknown>;
    for (const change of [
      { schemaVersion: 1 },
      { kind: 'other' },
      { target: {} },
      { workspace: {} },
      { id: 0 },
    ]) {
      const permit = f.save({ ...proof, ...change });
      writeFileSync(file, JSON.stringify({ ...state, permit }));
      expect(() => f.gate.execution(f.input, permit)).toThrow('reader-permit-binding-invalid');
    }
  });
  it('rejects unsupported configuration revisions and malformed profiles', () => {
    const f = controlFixture(),
      accepted = readerExecution(f.profile);
    for (const change of [
      { schemaVersion: 2 },
      { policyVersion: 2 },
      { profile: {} },
      { profile: { ...f.profile, model: '' } },
      { extra: 1 },
    ])
      expect(() => parseReaderExecution({ ...accepted, ...change })).toThrow();
  });
});
