import { afterEach, beforeEach, expect, it } from 'vitest';
import { coderFixture } from './coderFixtures.js';
import { reserveCoder } from '../core/coder.js';
import { briefChatResult } from '../cli/chatOutput.js';
import { object } from '../core/connection.js';
let f: Awaited<ReturnType<typeof coderFixture>>;
beforeEach(async () => {
  f = await coderFixture();
});
afterEach(async () => {
  await f.dispose();
});
it('shows source ownership and the action required for a candidate, a failure, cancellation and unknown stop', async () => {
  const brief = await f.brief(),
    run = reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []),
    request = { evidence_root: f.db.parent, storage: { root: f.db.root } };
  expect(briefChatResult('coder-chat', run, request)).toMatchObject({
    id: 'one',
    scope: brief.paths,
    status: 'reserved',
    session: null,
  });
  const session = await f.session(run),
    result = {
      outcome: 'PASS' as const,
      evidence: f.proof,
      checks: [],
      errors: [],
      limitations: [],
    };
  for (const status of [
    'released',
    'integrating',
    'integrated',
    'cancelled',
    'stopping',
  ] as const) {
    const view = briefChatResult(
      'coder-chat',
      { ...run, status, session, result, stopped: f.proof },
      request,
    );
    expect(view).toMatchObject({ status, session: session.id });
  }
  const failed = briefChatResult(
    'coder-chat',
    {
      ...run,
      status: 'released',
      result: { ...result, outcome: 'FAIL', errors: ['observed failure'] },
    },
    request,
  );
  expect(failed).toMatchObject({ reason: 'observed failure' });
  const status = {
    local: f.executor,
    execution: { status: 'implementing', blockers: [] },
    coders: [{ id: 'one', status: 'stopping' }],
    control: null,
    ownership: {},
    resume_required: false,
    coordination: null,
  };
  expect(briefChatResult('status-chat', status, request)).toMatchObject({
    coders: [{ id: 'one', status: 'stopping' }],
  });
});

it('reports the confirmed refusal and original pending operations with their recovery receipts', async () => {
  const brief = await f.brief(),
    run = reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []),
    request = { evidence_root: f.db.parent, storage: { root: f.db.root } },
    receipt = await f.artifact('not-started', {
      kind: 'coder-not-started',
      reason: 'coder-bootstrap-unconfirmed',
    });
  const refused = object(
    briefChatResult('coder-chat', { ...run, status: 'not-started', receipt }, request),
  );
  expect(refused).toMatchObject({
    reason: 'coder-bootstrap-unconfirmed',
    receipt,
  });
  expect(refused.next_action).toContain('завершено');
  for (const status of ['creating', 'sending'] as const) {
    const delivery = 'coder:one:implementation';
    const pending = object(briefChatResult('coder-chat', { ...run, status, delivery }, request));
    expect(pending).toMatchObject({
      operation: status === 'creating' ? 'coder:one:create' : delivery,
    });
    expect(pending.next_action).toContain('прежнего ID');
  }
});
it('refuses a missing or changed terminal refusal receipt', async () => {
  const brief = await f.brief(),
    run = reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []),
    request = { evidence_root: f.db.parent, storage: { root: f.db.root } };
  expect(() => briefChatResult('coder-chat', { ...run, status: 'not-started' }, request)).toThrow(
    'coder-refusal-unconfirmed',
  );
  const receipt = await f.artifact('refused', { reason: 'confirmed refusal' });
  expect(() =>
    briefChatResult(
      'coder-chat',
      { ...run, status: 'not-started', receipt: { ...receipt, hash: '0'.repeat(64) } },
      request,
    ),
  ).toThrow('coder-refusal-unconfirmed');
});
