import type { AuditReservation } from '../core/supervision.js';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { withChatRoles } from '../cli/chatRoles.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { CouncilReviewRequest } from '../core/council.js';
import type { AgentSession } from '../core/dataRoute.js';
const calls = vi.hoisted(() => ({
  inspect: vi.fn(),
  poll: vi.fn(),
  verifyReview: vi.fn(),
  initialize: vi.fn(),
  close: vi.fn(),
  peer: vi.fn(),
  parent: vi.fn(),
  launch: vi.fn(),
  terminal: vi.fn(),
  refusal: vi.fn(),
}));
vi.mock('../adapters/codex/currentChatHost.js', () => ({
  FileCurrentChatHost: class {
    observe = calls.parent;
    auditLaunch = calls.launch;
  },
}));
vi.mock('../adapters/codex/chatPeer.js', () => ({ inspectChatPeer: calls.peer }));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    initialize = calls.initialize;
    close = calls.close;
  },
}));
vi.mock('../adapters/codex/appServerSessions.js', () => ({
  AppServerSessions: class {
    inspect = calls.inspect;
    observeAuditTerminal = calls.terminal;
    observeAuditRefusal = calls.refusal;
    poll = calls.poll;
    verifyReview = calls.verifyReview;
  },
}));
let external: string;
beforeEach(async () => {
  external = await realpath(await mkdtemp(resolve(tmpdir(), 'chat-roles-')));
  calls.inspect.mockReset();
  calls.poll.mockReset();
  calls.verifyReview.mockReset();
  calls.initialize.mockReset();
  calls.close.mockReset();
  calls.peer.mockReset();
  calls.parent.mockReset();
});
afterEach(async () => {
  await rm(external, { recursive: true, force: true });
});
const host = {
  message: async () => ({ thread_id: 'principal', turn_id: 'turn' }),
} satisfies Pick<CurrentChatHost, 'message'>;
function request() {
  return {
    root: '/project',
    evidence_root: external,
    roles: {
      authority: { locator: 'human', hash: 'hash' },
      sessions: ['role'],
      args: [],
      binary: '/observed-client',
      project_id: 'native-project',
    },
  };
}
it('limits inspection/polling to allowed independent IDs, maps project identity and always closes its own transport', async () => {
  calls.peer.mockResolvedValue({
    id: 'role',
    project_id: 'project',
    native_project_id: 'native-project',
  });
  calls.poll.mockResolvedValue({ status: 'running' });
  const result = await withChatRoles(request(), 'principal', 'project', host, async (sessions) => {
    const observed = await sessions.inspect('role');
    expect(observed).toMatchObject({ project_id: 'project', native_project_id: 'native-project' });
    await expect(sessions.inspect('principal')).rejects.toThrow('chat-role-outside-authority');
    const review = { schema_version: 1 } as CouncilReviewRequest;
    const evidence = { locator: 'proof', hash: 'hash' };
    await sessions.verifyReview(observed as AgentSession, review, 'turn', evidence);
    expect(calls.verifyReview).toHaveBeenCalledWith(observed, review, 'turn', evidence);
    await expect(
      sessions.verifyReview(
        { ...observed, id: 'principal' } as AgentSession,
        review,
        'turn',
        evidence,
      ),
    ).rejects.toThrow('chat-role-outside-authority');
    return sessions.poll(observed as AgentSession, 'turn');
  });
  expect(result).toEqual({ status: 'running' });
  expect(calls.close).toHaveBeenCalledOnce();
  expect(calls.peer).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'role', external, {
    parent: 'principal',
    project: 'project',
  });
  expect(calls.inspect).not.toHaveBeenCalled();
  calls.peer.mockResolvedValue({ id: 'role', read_only: false });
  expect(
    await withChatRoles(request(), 'principal', 'project', host, (s) => s.inspect('role'), true),
  ).toMatchObject({ read_only: false });
  expect(calls.peer).toHaveBeenCalledTimes(2);
  calls.peer.mockResolvedValue(null);
  expect(
    await withChatRoles(request(), 'principal', 'project', host, (sessions) =>
      sessions.inspect('role'),
    ),
  ).toBeNull();
});
it('refuses missing authority, principal aliases and an invalid transport, and preserves initialization failure', async () => {
  const r = request();
  await expect(
    withChatRoles(
      { ...r, roles: { ...r.roles, sessions: ['principal'] } },
      'principal',
      'project',
      host,
      async () => null,
    ),
  ).rejects.toThrow('chat-role-authority-required');
  await expect(
    withChatRoles(
      { ...r, roles: { ...r.roles, args: [1] } },
      'principal',
      'project',
      host,
      async () => null,
    ),
  ).rejects.toThrow('chat-role-transport-invalid');
  calls.initialize.mockRejectedValue(new Error('native unavailable'));
  await expect(withChatRoles(r, 'principal', 'project', host, async () => null)).rejects.toThrow(
    'native unavailable',
  );
  expect(calls.close).toHaveBeenCalledOnce();
});

it('observes an explicitly bound read-only audit parent without changing the council parent route', async () => {
  const r = request();
  const audit = {
    ...r,
    event: { type: 'SUPERVISE', action: { kind: 'audit' } },
    roles: {
      ...r.roles,
      audit_parent: 'aux-parent',
      peer_observations: { 'aux-parent': { root: '/project', transcript: '/primary', anchor: {} } },
    },
  };
  calls.parent.mockResolvedValue({
    thread_id: 'aux-parent',
    workspace: '/project',
    effective_read_only: true,
    network_access: false,
  });
  calls.peer.mockResolvedValue({ id: 'role', agent_role: 'auditor' });
  expect(
    await withChatRoles(audit, 'principal', 'project', host, (s) => s.inspect('role')),
  ).toHaveProperty('agent_role', 'auditor');
  expect(calls.peer).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    'role',
    external,
    { parent: 'aux-parent', project: 'project' },
  );
  for (const event of [
    { type: 'SUPERVISE' },
    { type: 'SUPERVISE', action: { kind: 'arbitrate' } },
    { type: 'REVIEW' },
  ]) {
    await withChatRoles({ ...audit, event }, 'principal', 'project', host, (s) =>
      s.inspect('role'),
    );
    expect(calls.peer).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'role',
      external,
      { parent: 'principal', project: 'project' },
    );
  }
  expect(calls.inspect).not.toHaveBeenCalled();
  for (const parent of ['principal', 'role']) {
    await expect(
      withChatRoles(
        { ...audit, roles: { ...audit.roles, audit_parent: parent } },
        'principal',
        'project',
        host,
        (s) => s.inspect('role'),
      ),
    ).rejects.toThrow('chat-audit-parent-forbidden');
  }
  for (const patch of [
    { thread_id: 'other' },
    { workspace: '/other' },
    { effective_read_only: false },
    { network_access: true },
    { network_access: null },
  ]) {
    calls.parent.mockResolvedValue({
      thread_id: 'aux-parent',
      workspace: '/project',
      effective_read_only: true,
      network_access: false,
      ...patch,
    });
    await expect(
      withChatRoles(audit, 'principal', 'project', host, (s) => s.inspect('role')),
    ).rejects.toThrow('chat-audit-parent-profile-unconfirmed');
  }
});

it('selects the independent council observer explicitly without resuming or changing other role routes', async () => {
  calls.peer.mockResolvedValue({ id: 'role', parent_id: null, native_child: false });
  await withChatRoles(request(), 'principal', 'project', host, (s) => s.inspect('role'), 'council');
  expect(calls.peer).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    'role',
    external,
    undefined,
    'project',
  );
  expect(calls.inspect).not.toHaveBeenCalled();
});

it('observes no-session refusal and native terminal attempts through the original read-only parent', async () => {
  const proof = { locator: 'native-receipt', hash: 'hash' };
  const reservation = {
    id: 'audit',
    operation: 'attempt',
    parent: 'aux-parent',
  } as AuditReservation;
  const r = request();
  const audit = {
    ...r,
    event: { type: 'SUPERVISE', action: { kind: 'settle-audit' } },
    roles: {
      ...r.roles,
      audit_parent: 'aux-parent',
      peer_observations: { 'aux-parent': { root: '/project', transcript: '/primary', anchor: {} } },
    },
  };
  calls.parent.mockResolvedValue({
    thread_id: 'aux-parent',
    workspace: '/project',
    effective_read_only: true,
    network_access: false,
  });
  const observe = (input = audit) =>
    withChatRoles(input, 'principal', 'project', host, (sessions) =>
      sessions.observeAuditAttempt!(reservation),
    );
  await withChatRoles(audit, 'principal', 'project', host, (sessions) =>
    sessions.confirmAuditParent!('aux-parent'),
  );
  await expect(
    withChatRoles(audit, 'principal', 'project', host, (sessions) =>
      sessions.confirmAuditParent!('other'),
    ),
  ).rejects.toThrow('audit-parent-unconfirmed');
  await withChatRoles(
    {
      ...audit,
      event: { type: 'SUPERVISE', action: { kind: 'launch-audit' } },
      roles: { ...audit.roles, sessions: [] },
    },
    'principal',
    'project',
    host,
    (sessions) => sessions.confirmAuditParent!('aux-parent'),
  );
  calls.launch.mockResolvedValue({ outcome: 'unknown' });
  expect(await observe()).toEqual({ outcome: 'unknown' });
  calls.launch.mockResolvedValue({ outcome: 'not-started', receipt: proof });
  calls.refusal.mockResolvedValue({
    outcome: 'not-started',
    operation: 'attempt',
    session: null,
    receipt: proof,
  });
  expect(await observe({ ...audit, roles: { ...audit.roles, sessions: [] } })).toMatchObject({
    outcome: 'not-started',
    session: null,
  });
  calls.launch.mockResolvedValue({
    outcome: 'created',
    session: 'role',
    turn_not_started: false,
    deliveries: ['card.md'],
    receipt: proof,
  });
  calls.peer.mockResolvedValue(null);
  expect(await observe()).toEqual({ outcome: 'unknown' });
  calls.peer.mockResolvedValue({ id: 'role' });
  calls.terminal.mockResolvedValue({ outcome: 'terminal', turn: 'old-turn' });
  expect(await observe()).toMatchObject({ outcome: 'terminal' });
  await expect(
    withChatRoles(r, 'principal', 'project', host, (sessions) =>
      sessions.observeAuditAttempt!(reservation),
    ),
  ).rejects.toThrow('audit-attempt-observer-required');
  await expect(
    withChatRoles(audit, 'principal', 'project', host, (sessions) =>
      sessions.observeAuditAttempt!({ ...reservation, operation: null }),
    ),
  ).rejects.toThrow('audit-attempt-observer-required');
});
