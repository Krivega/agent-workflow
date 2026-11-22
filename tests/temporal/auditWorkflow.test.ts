import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { auditFixture } from './auditFixture.js';
import { AuditWorkflow } from '../../src/workflows/audit.js';
import { startAudit } from '../../src/client/audit.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
const sdk = vi.hoisted(() => ({
  registerAuditor: vi.fn(),
  launchAuditor: vi.fn(),
  observeAuditorLoad: vi.fn(),
  prepareAuditQuestion: vi.fn(),
  answerAuditor: vi.fn(),
  observeAuditAnswer: vi.fn(),
  finishAudit: vi.fn(),
  stopAuditor: vi.fn(),
  sleep: vi.fn(),
  condition: vi.fn(),
  cancelled: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (s: string) => new Error(s) },
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  defineQuery: (s: string) => s,
  defineSignal: (s: string) => s,
  condition: sdk.condition,
  sleep: sdk.sleep,
  isCancellation: () => sdk.cancelled,
  setHandler: (name: string, handler: (...args: unknown[]) => unknown) =>
    sdk.handlers.set(name, handler),
  proxyActivities: () => sdk,
  workflowInfo: () => ({ taskQueue: 'audit' }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
  sdk.cancelled = false;
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = auditFixture(),
    s = await f.setup();
  sdk.registerAuditor.mockResolvedValue(s.permit);
  sdk.launchAuditor.mockResolvedValue({
    parent: { id: 'parent', creation: f.proof },
    child: 'child',
    path: '/root/auditor',
    parentTurn: 'load',
  });
  sdk.observeAuditorLoad.mockResolvedValue(f.proof);
  sdk.prepareAuditQuestion.mockResolvedValue(f.proof);
  sdk.answerAuditor.mockResolvedValue('answer');
  sdk.observeAuditAnswer.mockResolvedValue(f.proof);
  sdk.finishAudit.mockResolvedValue({
    manifest: f.proof,
    report: { coverage: 'partial', direction: null },
  });
  sdk.stopAuditor.mockResolvedValue(f.proof);
  return { ...f, ...s };
}
describe('durable auditor coordinator', () => {
  it('bounds missing primary turn observations without a second launch', async () => {
    const f = await fixture();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(20 * 60_000);
    expect(await AuditWorkflow(f.input)).toMatchObject({
      status: 'blocked',
      error: 'Error: audit-observation-timeout',
    });
    expect(sdk.stopAuditor).toHaveBeenCalled();
    expect(sdk.observeAuditorLoad).not.toHaveBeenCalled();
    expect(sdk.launchAuditor).toHaveBeenCalledTimes(1);
  });
  it('waits for technical LOAD and answer through Temporal timers and stops before returning the audit', async () => {
    const f = await fixture();
    sdk.observeAuditorLoad.mockResolvedValueOnce(null);
    sdk.observeAuditAnswer.mockResolvedValueOnce(null);
    expect(await AuditWorkflow(f.input)).toMatchObject({
      status: 'audited',
      report: { coverage: 'partial' },
      stop: f.proof,
    });
    expect(sdk.sleep).toHaveBeenCalledTimes(2);
    expect(sdk.handlers.get('auditInput')!()).toEqual(f.input);
    expect(sdk.handlers.get('auditStatus')!()).toHaveProperty('phase', 'audited');
    expect(sdk.stopAuditor.mock.invocationCallOrder[0]).toBeGreaterThan(
      sdk.finishAudit.mock.invocationCallOrder[0]!,
    );
  });
  it.each(['register', 'launch', 'load', 'question', 'answer', 'observe', 'finish', 'stop'])(
    'keeps failed or cancelled work fenced before exit: %s',
    async (step) => {
      const f = await fixture();
      const failure = new Error('failure', { cause: new Error('primary failure') });
      ({
        register: sdk.registerAuditor,
        launch: sdk.launchAuditor,
        load: sdk.observeAuditorLoad,
        question: sdk.prepareAuditQuestion,
        answer: sdk.answerAuditor,
        observe: sdk.observeAuditAnswer,
        finish: sdk.finishAudit,
        stop: sdk.stopAuditor,
      })[step]!.mockRejectedValueOnce(failure);
      sdk.cancelled = step === 'answer';
      expect(await AuditWorkflow(f.input)).toMatchObject({
        status: sdk.cancelled ? 'cancelled' : 'blocked',
        error: 'Error: primary failure',
        stop: f.proof,
      });
      expect(sdk.stopAuditor).toHaveBeenLastCalledWith(
        f.input,
        step === 'register' ? null : f.permit,
      );
    },
  );
  it('keeps stop-unknown pending until an explicit reconcile, without another native launch', async () => {
    const f = await fixture();
    sdk.launchAuditor.mockRejectedValueOnce('lost');
    sdk.stopAuditor.mockRejectedValueOnce('offline');
    sdk.condition.mockImplementationOnce(async (ready: () => boolean) => {
      expect(ready()).toBe(false);
      expect(sdk.handlers.get('auditStatus')!()).toHaveProperty('phase', 'stop-unknown');
      sdk.handlers.get('auditReconcile')!();
      expect(ready()).toBe(true);
    });
    expect(await AuditWorkflow(f.input)).toMatchObject({
      status: 'blocked',
      error: 'lost',
      stopFailure: 'offline',
    });
    expect(sdk.launchAuditor).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed input before scheduling work and starts idempotently only for the same pinned input', async () => {
    const f = await fixture();
    await expect(AuditWorkflow({ ...f.input, schemaVersion: 2 } as never)).rejects.toThrow();
    expect(sdk.registerAuditor).not.toHaveBeenCalled();
    const handle = { query: vi.fn(async () => f.input) },
      start = vi.fn(async () => handle),
      client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startAudit(client, f.input, 'audit')).toBe(handle);
    expect(start.mock.calls[0]).toMatchObject([
      'AuditWorkflow',
      {
        taskQueue: 'audit',
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      },
    ]);
    handle.query.mockResolvedValue({ ...f.input, auditId: 'other' });
    await expect(startAudit(client, f.input, 'audit')).rejects.toThrow('audit-start-conflict');
  });
});
