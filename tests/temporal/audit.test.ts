import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { auditFixture } from './auditFixture.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as files from '../../src/adapters/artifacts/files.js';
import { auditWorkflowKey } from '../../src/policy/audit.js';
import {
  auditChildTurn,
  nativeAuditChild,
  nativeAuditCalls,
  nativeAuditRecords,
  checkAuditorProfile,
  confirmAuditorSession,
  confirmAuditDelivery,
} from '../../src/adapters/codex/nativeAudit.js';
afterEach(() => vi.restoreAllMocks());
async function loaded() {
  const f = auditFixture(),
    s = await f.setup(),
    a = f.service.activities;
  const session = await a.launchAuditor(s.input, s.epoch),
    load = await a.observeAuditorLoad(s.input, session, s.epoch);
  expect(load).not.toBeNull();
  return { ...f, ...s, session, load: load!, a };
}
async function answered() {
  const f = await loaded(),
    question = await f.a.prepareAuditQuestion(f.input, f.session, f.load, f.epoch);
  const parentTurn = await f.a.answerAuditor(f.input, f.session, question, f.epoch);
  const answer = await f.a.observeAuditAnswer(
    f.input,
    f.session,
    f.load,
    question,
    parentTurn,
    f.epoch,
  );
  expect(answer).not.toBeNull();
  return { ...f, question, parentTurn, answer: answer! };
}
describe('native auditor boundary', () => {
  describe('verification after the auditor stopped', () => {
    async function stoppedAudit() {
      const f = await answered();
      const completed = await f.a.finishAudit(
        f.input,
        f.session,
        f.load,
        f.question,
        f.parentTurn,
        f.answer,
        f.epoch,
      );

      const stop = await f.service.controls.stopAuditor(f.input, f.permit);
      return {
        f,
        result: completed.manifest,
        stop,
        parentTurns: structuredClone(f.parent.turns),
        childTurns: structuredClone(f.child.turns),
        records: structuredClone(f.records),
      };
    }
    let baseline: Awaited<ReturnType<typeof stoppedAudit>>;
    beforeAll(async () => {
      baseline = await stoppedAudit();
    });
    beforeEach(() => {
      const { f } = baseline;
      f.parent.turns = structuredClone(baseline.parentTurns);
      f.child.turns = structuredClone(baseline.childTurns);
      Object.assign(f.records, structuredClone(baseline.records));
      f.writeRecords();
    });
    it.each([
      'valid',
      'result-kind',
      'acceptance',
      'result-input',
      'stop-kind',
      'stop-confirmed',
      'stop-input',
      'creation-kind',
      'creation-input',
      'pending',
      'changed-answer',
      'changed-report',
      'spawn-name',
      'spawn-role',
      'spawn-fork',
      'spawn-message',
      'started',
      'started-old-model',
      'stop-observations',
      'stop-child',
      'parent-status',
      'parent-receipt',
      'parent-confirmed',
      'parent-target',
    ])(
      'rechecks the native primary result after stopping without starting another model: %s',
      async (defect) => {
        const { f } = baseline;
        let { result, stop } = baseline;
        const body = f.read(result),
          stopped = f.read(stop);
        if (defect === 'result-kind') body.kind = 'foreign';
        if (defect === 'acceptance') body.acceptance = true;
        if (defect === 'result-input') body.input = {};
        if (defect.startsWith('result-') || defect === 'acceptance') result = f.save(body);
        if (defect === 'stop-kind') stopped.kind = 'foreign';
        if (defect === 'stop-confirmed') stopped.confirmed = false;
        if (defect === 'stop-input') stopped.input = {};
        if (defect.startsWith('creation-')) {
          const session = structuredClone(f.session),
            creation = f.read(session.parent.creation);
          if (defect === 'creation-kind') creation.kind = 'foreign';
          else creation.input = {};
          session.parent.creation = f.save(creation);
          body.session = session;
          result = f.save(body);
        }
        if (defect === 'pending') f.turns(f.child)[1]!.status = 'inProgress';
        if (defect === 'changed-answer') {
          const item = (f.turns(f.child)[1]!.items as Record<string, unknown>[]).find(
            (i) => i.type === 'agentMessage',
          )!;
          const report = JSON.parse(String(item.text)) as Record<string, unknown>;
          report.reasons = ['Другой исходный ответ'];
          item.text = JSON.stringify(report);
        }
        if (defect === 'changed-report') {
          body.report = {};
          result = f.save(body);
        }
        if (defect.startsWith('spawn-')) {
          const call = f.records.parent![1]!.payload as { arguments: string },
            args = JSON.parse(call.arguments) as Record<string, unknown>;
          if (defect === 'spawn-name') args.task_name = 'other';
          if (defect === 'spawn-role') args.agent_type = 'default';
          if (defect === 'spawn-fork') args.fork_turns = 'all';
          if (defect === 'spawn-message') args.message = null;
          call.arguments = JSON.stringify(args);
          f.writeRecords();
        }
        if (defect === 'started-old-model')
          (f.turns(f.parent)[0]!.items as Record<string, unknown>[])[1]!.model = 'gpt-6.1-sol';
        if (defect === 'started')
          (f.turns(f.parent)[0]!.items as Record<string, unknown>[])[1]!.reasoningEffort = 'medium';
        if (defect === 'stop-observations') stopped.observations = [];
        if (defect === 'stop-child') {
          const observations = stopped.observations as { sha256: string; bytes: number }[];
          stopped.observations = observations.map((ref) =>
            f.save({ ...f.read(ref), child: 'foreign' }),
          );
        }
        if (defect.startsWith('parent-')) {
          const parentStop = stopped.parentStop as Record<string, unknown>;
          const receipt = f.read(parentStop.receipt as { sha256: string; bytes: number });
          if (defect === 'parent-status') parentStop.status = 'unknown';
          if (defect === 'parent-receipt') receipt.kind = 'foreign';
          if (defect === 'parent-confirmed') receipt.confirmed = false;
          if (defect === 'parent-target') receipt.target = {};
          parentStop.receipt = f.save(receipt);
        }
        if (defect.startsWith('stop-') || defect.startsWith('parent-')) stop = f.save(stopped);
        const verify = f.a.verifyAuditResult(f.input, result, stop);
        if (defect === 'valid')
          expect(await verify).toMatchObject({
            report: { coverage: 'complete', direction: 'continue' },
          });
        else await expect(verify).rejects.toThrow();
        expect(f.state.starts).toBe(4);
      },
    );
  });
  it('keeps the test transport strict about unknown operations, direct child input and parent interruption', async () => {
    const f = await loaded();
    await expect(f.rpc.request('unknown', {})).rejects.toThrow('unexpected-rpc:unknown');
    await expect(f.rpc.request('turn/start', { threadId: 'child' })).rejects.toThrow(
      'direct-child-input-forbidden',
    );
    await f.rpc.request('turn/interrupt', { threadId: 'parent', turnId: f.session.parentTurn });
    expect(f.turns(f.parent)[0]!.status).toBe('interrupted');
    expect(f.state.starts).toBe(2);
  });
  it.each(['refs', 'prepared', 'status'])(
    'rechecks the exact preparation and mandatory LOAD set instead of trusting a supplied preflight: %s',
    async (defect) => {
      const f = auditFixture(),
        s = await f.setup(),
        before = f.read(s.input.preflight);
      if (defect === 'refs') before.refs = [];
      const prepared = before.prepared as Record<string, unknown>;
      if (defect === 'prepared') prepared.manifest = f.save({ kind: 'preparation', inputs: [] });
      if (defect === 'status') prepared.status = 'unknown';
      const input = { ...s.input, auditId: 'forged-' + defect, preflight: f.save(before) };
      await expect(f.service.activities.registerAuditor(input)).rejects.toThrow(
        defect === 'refs' ? 'auditor-input-changed' : 'auditor-preparation-changed',
      );
      expect(f.state.starts).toBe(0);
    },
  );
  it.each([
    'custom-tool',
    'unsupported-send',
    'pending-spawn',
    'pending-delivery',
    'lost-turn',
    'delegation',
  ])('never releases ownership with unresolved native work: %s', async (defect) => {
    const f = await loaded(),
      primary = f.rpc.request.getMockImplementation()!;
    if (defect === 'custom-tool')
      f.records.parent!.push({ type: 'response_item', payload: { type: 'custom_tool_call' } });
    if (defect === 'unsupported-send')
      (f.records.parent![1]!.payload as { name: string }).name = 'send_message';
    if (defect === 'pending-spawn') (f.turns(f.parent)[0]!.items as unknown[]).splice(1, 1);
    if (defect === 'pending-delivery') f.records.child!.pop();
    if (defect === 'delegation')
      (f.turns(f.child)[0]!.items as unknown[]).push({ type: 'subAgentActivity', kind: 'started' });
    f.writeRecords();
    let reads = 0;
    if (defect === 'lost-turn')
      f.rpc.request.mockImplementation(async (m, p) => {
        if (m === 'thread/read' && p.threadId === 'child' && ++reads === 2)
          return { thread: { ...f.child, turns: [] } };
        return primary(m, p);
      });
    await expect(f.service.controls.stopAuditor(f.input, f.permit)).rejects.toThrow();
  });
  it('reads one final report after optional commentary and rejects duplicate finals', async () => {
    const f = await answered(),
      turn = f.turns(f.child)[1]!;
    (turn.items as unknown[]).unshift({
      type: 'agentMessage',
      phase: 'commentary',
      text: 'Читаю карточку',
    });
    const answer = (await f.a.observeAuditAnswer(
      f.input,
      f.session,
      f.load,
      f.question,
      f.parentTurn,
      f.epoch,
    ))!;
    expect(f.read(answer).report).toHaveProperty('direction', 'continue');
    (turn.items as unknown[]).push({ type: 'agentMessage', phase: 'final_answer', text: '{}' });
    await expect(
      f.a.observeAuditAnswer(f.input, f.session, f.load, f.question, f.parentTurn, f.epoch),
    ).rejects.toThrow('auditor-report-required');
  });
  it('binds native encrypted delivery by the original child and parent turn without claiming decrypted plaintext', async () => {
    const f = await loaded(),
      call = f.records.parent![1]!.payload as { arguments: string };
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    call.arguments = JSON.stringify({ ...args, message: 'opaque-load' });
    f.records.child!.push({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        recipient: f.session.path,
        internal_chat_message_metadata_passthrough: { turn_id: 'child-load' },
        content: [
          { type: 'input_text', text: 'Native delivery header' },
          { type: 'encrypted_content', encrypted_content: 'opaque-load' },
        ],
      },
    });
    f.writeRecords();
    const load = (await f.a.observeAuditorLoad(f.input, f.session, f.epoch))!;
    expect(f.read(load).delivery).toBe('attributed-encrypted');
    const q = await f.a.prepareAuditQuestion(f.input, f.session, load, f.epoch),
      turn = await f.a.answerAuditor(f.input, f.session, q, f.epoch);
    const followup = f.records.parent![3]!.payload as { arguments: string },
      delivery = JSON.parse(followup.arguments) as Record<string, unknown>;
    followup.arguments = JSON.stringify({ ...delivery, message: 'opaque-card' });
    f.records.child!.push({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        recipient: f.session.path,
        internal_chat_message_metadata_passthrough: { turn_id: 'child-answer' },
        content: [{ type: 'encrypted_content', encrypted_content: 'opaque-card' }],
      },
    });
    f.writeRecords();
    const answer = (await f.a.observeAuditAnswer(f.input, f.session, load, q, turn, f.epoch))!;
    expect(f.read(answer).delivery).toBe('attributed-encrypted');
    expect(
      (await f.a.finishAudit(f.input, f.session, load, q, turn, answer, f.epoch)).report.direction,
    ).toBe('continue');
    expect(f.state.starts).toBe(4);
  });
  it.each(['missing', 'foreign', 'cipher'])(
    'rejects an unbound encrypted message: %s',
    async (defect) => {
      const f = await loaded();
      if (defect !== 'missing')
        f.records.child!.push({
          type: 'response_item',
          payload: {
            type: 'agent_message',
            author: defect === 'foreign' ? '/foreign' : '/root',
            recipient: f.session.path,
            internal_chat_message_metadata_passthrough: { turn_id: 'child-load' },
            content: [
              {
                type: 'encrypted_content',
                encrypted_content: defect === 'cipher' ? 'other' : 'opaque',
              },
            ],
          },
        });
      f.writeRecords();
      expect(() =>
        confirmAuditDelivery(f.child, f.session.parentTurn, f.session.path, 'opaque', 'expected'),
      ).toThrow('auditor-delivery-unconfirmed');
    },
  );
  it('waits for a scheduled child turn but preserves a terminal provider refusal', async () => {
    const f = await loaded(),
      before = f.child.turns;
    f.child.turns = [];
    expect(await f.a.observeAuditorLoad(f.input, f.session, f.epoch)).toBeNull();
    f.child.turns = before;
    f.turns(f.child)[0]!.status = 'failed';
    await expect(f.a.observeAuditorLoad(f.input, f.session, f.epoch)).rejects.toThrow(
      'auditor-load-not-completed',
    );
    f.turns(f.child)[0]!.status = 'completed';
    const q = await f.a.prepareAuditQuestion(f.input, f.session, f.load, f.epoch),
      turn = await f.a.answerAuditor(f.input, f.session, q, f.epoch);
    f.turns(f.child).pop();
    expect(await f.a.observeAuditAnswer(f.input, f.session, f.load, q, turn, f.epoch)).toBeNull();
  });
  it.each(['recovered', 'missing-parent', 'missing-send'])(
    'never repeats a model send after a lost journal receipt: %s',
    async (defect) => {
      const f = await loaded();
      const effects = join(f.directory, 'effects');
      for (const name of readdirSync(effects).filter((n) => n.endsWith('.receipt')))
        rmSync(join(effects, name));
      if (defect === 'missing-parent') {
        for (const folder of readdirSync(join(f.root, 'audit-permissions'))) {
          const home = join(f.root, 'audit-permissions', folder);
          for (const name of readdirSync(home).filter((n) => n.endsWith('.response')))
            rmSync(join(home, name));
        }
      }
      if (defect === 'missing-send') f.parent.turns = [];
      if (defect === 'recovered')
        expect(await f.a.launchAuditor(f.input, f.epoch)).toEqual(f.session);
      else
        await expect(f.a.launchAuditor(f.input, f.epoch)).rejects.toThrow('effect-outcome-unknown');
      expect(f.state.starts).toBe(2);
    },
  );
  it('propagates an inaccessible registration journal rather than declaring not-started', async () => {
    const f = auditFixture(),
      s = await f.setup();
    const primary = files.readPrivateFile;
    vi.spyOn(files, 'readPrivateFile').mockImplementation((path) => {
      if (path.endsWith('/registering.json'))
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return primary(path);
    });
    await expect(f.service.controls.stopAuditor(s.input, null)).rejects.toThrow(
      'permission denied',
    );
  });
  it('binds the native role, independent LOAD, sole card delivery and original report; stops parent and child without acceptance', async () => {
    const f = await answered();
    const result = await f.a.finishAudit(
      f.input,
      f.session,
      f.load,
      f.question,
      f.parentTurn,
      f.answer,
      f.epoch,
    );
    expect(f.read(result.manifest)).toMatchObject({ kind: 'audit-result', acceptance: false });
    expect(result.report.direction).toBe('continue');
    expect(Object.keys(result.report).sort()).toEqual(['coverage', 'direction']);
    expect(f.read(result.manifest).report).toHaveProperty('reasons');
    expect(f.state.starts).toBe(4);
    expect(f.consume).toHaveBeenCalledTimes(4);
    expect(f.rpc.request.mock.calls.find(([m]) => m === 'thread/start')![1]).toMatchObject({
      config: { web_search: 'disabled' },
    });
    expect(
      f.rpc.request.mock.calls.filter(([m, p]) => m === 'turn/start' && p.threadId === 'child'),
    ).toHaveLength(0);
    expect(nativeAuditCalls(f.parent).map((v) => v.name)).toEqual(['spawn_agent', 'followup_task']);
    expect(f.read(await f.service.controls.stopAuditor(f.input, f.permit))).toMatchObject({
      kind: 'auditor-stopped',
      confirmed: true,
    });
    await f.service.stopAll();
    await expect(f.a.answerAuditor(f.input, f.session, f.question, f.epoch)).rejects.toThrow(
      'reader-permit-revoked',
    );
  });
  it('reuses a journalled launch and send without another child or model credit', async () => {
    const f = await loaded();
    expect(await f.a.launchAuditor(f.input, f.epoch)).toEqual(f.session);
    expect(f.state.starts).toBe(2);
    const q = await f.a.prepareAuditQuestion(f.input, f.session, f.load, f.epoch);
    const turn = await f.a.answerAuditor(f.input, f.session, q, f.epoch);
    expect(await f.a.answerAuditor(f.input, f.session, q, f.epoch)).toBe(turn);
    expect(f.state.starts).toBe(4);
    await f.service.stopAll();
  });
  it('leaves pending LOAD/answer to durable Workflow polling and interrupts a busy child on stop', async () => {
    const f = auditFixture(),
      s = await f.setup();
    f.state.loadPending = true;
    const session = await f.service.activities.launchAuditor(s.input, s.epoch);
    expect(await f.service.activities.observeAuditorLoad(s.input, session, s.epoch)).toBeNull();
    f.turns(f.child)[0]!.status = 'completed';
    const load = (await f.service.activities.observeAuditorLoad(s.input, session, s.epoch))!;
    const q = await f.service.activities.prepareAuditQuestion(s.input, session, load, s.epoch);
    f.state.answerPending = true;
    const turn = await f.service.activities.answerAuditor(s.input, session, q, s.epoch);
    expect(
      await f.service.activities.observeAuditAnswer(s.input, session, load, q, turn, s.epoch),
    ).toBeNull();
    await f.service.controls.stopAuditor(s.input, s.permit);
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'child',
      turnId: 'child-answer',
    });
  });
  it('fences a late registration after cancellation before any model start', async () => {
    const f = auditFixture();
    const input = {
      schemaVersion: 1 as const,
      preparation: f.card.preparation,
      auditId: 'early',
      card: f.save(f.card),
      preflight: await f.service.activities.preflightAuditor(f.card.preparation),
    };
    expect(f.read(await f.service.controls.stopAuditor(input, null)).kind).toBe(
      'auditor-not-started',
    );
    await expect(f.service.activities.registerAuditor(input)).rejects.toThrow(
      'auditor-already-stopping',
    );
    expect(f.state.starts).toBe(0);
  });
  it('recovers a lost registration reply from a pinned permit and blocks a missing registration journal', async () => {
    const f = auditFixture(),
      s = await f.setup();
    expect(f.read(await f.make().controls.stopAuditor(s.input, null)).kind).toBe('auditor-stopped');
    const g = auditFixture(),
      t = await g.setup();
    const home = join(g.directory, digest(auditWorkflowKey(t.input)));
    rmSync(join(home, 'permit.json'));
    await expect(g.make().controls.stopAuditor(t.input, null)).rejects.toThrow('ENOENT');
  });
  it.each(['role', 'profile', 'source', 'preflight', 'card', 'nontext', 'input', 'models'])(
    'rejects a changed or unqualified audit input before model work: %s',
    async (defect) => {
      const f = auditFixture(),
        s = await f.setup();
      let input = s.input;
      if (defect === 'role') f.registration.project.roles.pop();
      if (defect === 'profile')
        writeFileSync(f.profilePath, readFileSync(f.profilePath, 'utf8') + '\n# changed\n');
      if (defect === 'source') writeFileSync(join(f.workspace, 'RULES.md'), 'changed');
      if (defect === 'preflight')
        input = { ...input, preflight: f.save({ ...f.read(input.preflight), profile: {} }) };
      if (defect === 'card')
        input = {
          ...input,
          card: f.save({ ...f.card, preparation: { ...input.preparation, revision: 2 } }),
        };
      if (defect === 'nontext') {
        const bytes = Buffer.from([255]),
          ref = { path: 'RULES.md', sha256: digest(bytes), bytes: 1 };
        writeFileSync(join(f.workspace, ref.path), bytes);
        input = {
          ...input,
          auditId: 'binary',
          card: f.save({ ...f.card, sources: [f.card.goal, ref] }),
        };
        input.preflight = await f.service.activities.preflightAuditor(input.preparation);
      }
      if (defect === 'input')
        input = { ...input, card: f.save({ ...f.card, nextAction: 'other' }) };
      if (defect === 'models') f.rpc.request.mockResolvedValueOnce({ data: [] });
      await expect(f.service.activities.launchAuditor(input, s.epoch)).rejects.toThrow();
      expect(f.state.starts).toBe(0);
    },
  );
  it('validates every declared evidence length before deduplicating a repeated trigger', async () => {
    const f = auditFixture();
    const original = await f.setup();
    const input = {
      ...original.input,
      auditId: 'duplicate-evidence',
      card: f.save({
        ...f.card,
        completed: [{ ...f.proof, bytes: f.proof.bytes + 1 }],
        trigger: { kind: 'doubt', evidence: f.proof },
      }),
    };
    await expect(f.setup(input)).rejects.toThrow();
    expect(f.state.starts).toBe(0);
  });
  it('pins no-progress/doubt evidence and rejects a foreign question or LOAD', async () => {
    const f = await loaded();
    await expect(f.a.prepareAuditQuestion(f.input, f.session, f.proof, f.epoch)).rejects.toThrow(
      'auditor-load-binding',
    );
    await expect(f.a.answerAuditor(f.input, f.session, f.proof, f.epoch)).rejects.toThrow(
      'auditor-question-binding',
    );
    const g = auditFixture(),
      s = await g.setup();
    const input = {
      ...s.input,
      auditId: 'doubt',
      card: g.save({ ...g.card, trigger: { kind: 'doubt', evidence: g.proof } }),
    };
    const permit = await g.service.activities.registerAuditor(input),
      epoch = { permit, revision: 0, attempt: 0 };
    const session = await g.service.activities.launchAuditor(input, epoch),
      load = (await g.service.activities.observeAuditorLoad(input, session, epoch))!;
    const question = g.read(
      await g.service.activities.prepareAuditQuestion(input, session, load, epoch),
    );
    expect(question.evidence).toHaveLength(1);
    expect(new Set(question.allowedSources as string[]).size).toBe(
      (question.allowedSources as string[]).length,
    );
    expect(question.facts).toMatchObject({
      completed: [g.proof],
      trigger: { kind: 'doubt', evidence: g.proof },
    });
  });
  it.each([
    'missing-load',
    'wrong-child',
    'wrong-model',
    'delegation',
    'compaction',
    'delivery',
    'extra-call',
    'changed-answer',
  ])('holds a report on primary evidence failure: %s', async (defect) => {
    const f = await answered(),
      turn = f.turns(f.child)[1]!;
    if (defect === 'missing-load') (turn.items as unknown[]).shift();
    if (defect === 'wrong-child') f.child.parentThreadId = 'other';
    if (defect === 'wrong-model') f.native.reasoningEffort = 'medium';
    if (defect === 'delegation') (turn.items as unknown[]).push({ type: 'subAgentActivity' });
    if (defect === 'compaction') (turn.items as unknown[]).push({ type: 'contextCompaction' });
    if (defect === 'delivery') {
      const call = f.records.parent!.filter((r) => r.type === 'response_item')[2]!.payload as {
        arguments: string;
      };
      call.arguments = JSON.stringify({
        target: f.session.path,
        message: f.store.path(f.question) + ' extra',
      });
      f.writeRecords();
    }
    if (defect === 'extra-call') f.records.parent!.push(...f.records.parent!.slice(1, 3));
    f.writeRecords();
    await expect(
      f.a.finishAudit(
        f.input,
        f.session,
        f.load,
        f.question,
        f.parentTurn,
        defect === 'changed-answer' ? f.proof : f.answer,
        f.epoch,
      ),
    ).rejects.toThrow();
  });
  it.each(['unknown', 'active', 'read-error', 'foreign-parent', 'parent-unknown'])(
    'does not confirm an unproved stop: %s',
    async (defect) => {
      const f = await loaded(),
        primary = f.rpc.request.getMockImplementation()!;
      if (defect === 'unknown') f.turns(f.child)[0]!.status = ['completed'];
      if (defect === 'active') f.turns(f.child)[0]!.status = 'inProgress';
      if (defect === 'foreign-parent') f.child.parentThreadId = 'other';
      if (defect === 'parent-unknown') {
        const key = readdirSync(join(f.root, 'audit-permissions')).find((k) =>
          readdirSync(join(f.root, 'audit-permissions', k)).some((n) => n.endsWith('.response')),
        )!;
        const path = join(f.root, 'audit-permissions', key);
        for (const n of readdirSync(path).filter((n) => n.endsWith('.response')))
          rmSync(join(path, n));
      }
      f.rpc.request.mockImplementation(async (m, p) => {
        if (m === 'thread/read' && p.threadId === 'child' && defect === 'read-error')
          throw new Error('offline');
        if (m === 'turn/interrupt' && defect === 'active') return {};
        return primary(m, p);
      });
      await expect(f.service.controls.stopAuditor(f.input, f.permit)).rejects.toThrow();
    },
  );
  it('propagates immutable binding and storage failures without retrying model work', async () => {
    const f = auditFixture(),
      s = await f.setup();
    const spy = vi.spyOn(files, 'publishFile').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await expect(f.service.activities.registerAuditor(s.input)).rejects.toThrow('disk full');
    spy.mockRestore();
    const home = join(f.directory, digest(auditWorkflowKey(s.input)));
    mkdirSync(join(home, 'unused'));
    expect(f.state.starts).toBe(0);
  });
});

describe('first-party native audit evidence', () => {
  it.each(['role', 'model', 'effort', 'feature', 'extra', 'empty', 'encoding', 'toml'])(
    'rejects unsafe role configuration: %s',
    (defect) => {
      const f = auditFixture();
      let value = readFileSync(f.profilePath, 'utf8');
      if (defect === 'role') value = value.replace('name = "auditor"', 'name = "reader"');
      if (defect === 'model') value = value.replace('gpt-6.2-sol', 'gpt-6.1-sol');
      if (defect === 'effort') value = value.replace('"xhigh"', '"medium"');
      if (defect === 'feature') value = value.replace('apps = false', 'apps = true');
      if (defect === 'extra') value += '\n[agents]\nenabled=true\n';
      if (defect === 'empty') value = value.replace(/description = ".*"/u, 'description = ""');
      if (defect === 'toml') value = 'broken=[';
      expect(() =>
        checkAuditorProfile(defect === 'encoding' ? Buffer.from([255]) : Buffer.from(value)),
      ).toThrow();
    },
  );
  it.each([
    'partial',
    'meta',
    'missing-output',
    'args',
    'spawn',
    'path',
    'activity',
    'attribution',
    'turn',
  ])('rejects malformed native history: %s', async (defect) => {
    const f = await loaded(),
      parent = f.parent;
    if (defect === 'partial') writeFileSync(String(parent.path), 'partial');
    if (defect === 'meta') {
      (f.records.parent![0]!.payload as { cli_version: string }).cli_version = 'other';
      f.writeRecords();
    }
    if (defect === 'missing-output') {
      f.records.parent!.pop();
      f.writeRecords();
    }
    if (defect === 'args') {
      (f.records.parent![1]!.payload as { arguments: unknown }).arguments = null;
      f.writeRecords();
    }
    if (defect === 'spawn') {
      (f.records.parent![1]!.payload as { arguments: string }).arguments = '{}';
      f.writeRecords();
    }
    if (defect === 'path')
      (f.turns(parent)[0]!.items as Record<string, unknown>[])[1]!.agentPath = '/wrong';
    if (defect === 'activity')
      (f.turns(parent)[0]!.items as Record<string, unknown>[])[1]!.reasoningEffort = 'medium';
    if (defect === 'attribution') {
      f.records.child!.pop();
      f.writeRecords();
    }
    if (defect === 'turn') f.child.turns = [];
    const check =
      defect === 'attribution' || defect === 'turn'
        ? () => auditChildTurn(f.child, f.session.parentTurn)
        : ['path', 'activity', 'spawn'].includes(defect)
          ? () => nativeAuditChild(parent, f.session.path.split('/').at(-1)!)
          : () => nativeAuditRecords(parent).length && nativeAuditCalls(parent);
    expect(check).toThrow();
  });
  it('checks every native session field without trusting role text', async () => {
    const f = await loaded();
    for (const mutate of [
      () => {
        f.native.sandbox.networkAccess = true;
      },
      () => {
        f.native.thread.canAcceptDirectInput = true;
      },
      () => {
        f.native.thread.projectId = 'other';
      },
    ]) {
      const old = structuredClone(f.native);
      mutate();
      expect(() => confirmAuditorSession(f.native, 'parent', 'child', f.workspace)).toThrow();
      Object.assign(f.native, old);
    }
  });
});

it('loads the native auditor registration and both qualification procedures from this checkout', () => {
  const profile = readFileSync(new URL('../../.codex/agents/auditor.toml', import.meta.url));
  checkAuditorProfile(profile);
  for (const name of ['audit', 'evidence']) {
    const locator = 'procedures/' + name + '.md';
    expect(profile.toString()).toContain(locator);
    expect(readFileSync(new URL('../../' + locator, import.meta.url), 'utf8')).toContain(
      'Procedure: ' + name,
    );
  }
});
