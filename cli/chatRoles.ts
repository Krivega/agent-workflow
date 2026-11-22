import { object, requireWorkflow, textField } from '../core/connection.js';
import type { CouncilSessions } from '../ports/agentSessions.js';
import type { InputRef } from '../core/localRun.js';
import { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { inspectChatPeer } from '../adapters/codex/chatPeer.js';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import type { ChatAnchor } from '../core/currentChat.js';

export async function withChatRoles<T>(
  request: Record<string, unknown>,
  principal: string,
  project: string,
  host: Pick<CurrentChatHost, 'message'>,
  action: (sessions: CouncilSessions) => Promise<T>,
  peers: boolean | 'council' = false,
): Promise<T> {
  const roles = object(request.roles);
  const event = request.event as { type?: string; action?: { kind?: string } } | undefined;
  const settling = event?.type === 'SUPERVISE' && event.action?.kind === 'settle-audit';
  const launching = event?.type === 'SUPERVISE' && event.action?.kind === 'launch-audit';
  requireWorkflow(
    (await host.message(roles.authority as InputRef)).thread_id === principal,
    'chat-role-authority-required',
  );
  requireWorkflow(
    Array.isArray(roles.sessions) &&
      (roles.sessions.length > 0 || settling || launching) &&
      roles.sessions.every((id) => typeof id === 'string' && id !== principal),
    'chat-role-authority-required',
  );
  requireWorkflow(
    Array.isArray(roles.args) && roles.args.every((s) => typeof s === 'string'),
    'chat-role-transport-invalid',
  );
  let parent = principal;
  let auditHost: FileCurrentChatHost | null = null;
  if (event?.type === 'SUPERVISE' && (event.action?.kind === 'audit' || settling || launching)) {
    parent = textField(roles.audit_parent);
    requireWorkflow(
      parent !== principal && !(roles.sessions as string[]).includes(parent),
      'chat-audit-parent-forbidden',
    );
    const source = object(object(roles.peer_observations)[parent]);
    auditHost = new FileCurrentChatHost(
      textField(source.root),
      textField(source.transcript),
      source.anchor as ChatAnchor,
      null,
      true,
    );
    const observed = await auditHost.observe();
    requireWorkflow(
      observed.thread_id === parent &&
        observed.workspace === request.root &&
        observed.effective_read_only &&
        observed.network_access === false,
      'chat-audit-parent-profile-unconfirmed',
    );
  }
  const evidence = textField(request.evidence_root);
  safeDirectory(evidence);
  const rpc = new StdioAppServer(
    textField(roles.binary),
    roles.args,
    textField(request.root),
    resolve(evidence, `role-observation-${randomUUID()}.jsonl`),
  );
  try {
    await rpc.initialize();
    const native = new AppServerSessions(rpc, textField(request.root), project, evidence);
    const allowed = (id: string) =>
      requireWorkflow(
        (roles.sessions as string[]).includes(id) && id !== principal,
        'chat-role-outside-authority',
      );
    const sessions: CouncilSessions = {
      confirmAuditParent: async (id) => {
        requireWorkflow(auditHost !== null && id === parent, 'audit-parent-unconfirmed');
      },
      observeAuditAttempt: async (reservation) => {
        requireWorkflow(
          auditHost !== null && reservation.operation !== null && reservation.parent === parent,
          'audit-attempt-observer-required',
        );
        const launch = await auditHost.auditLaunch(reservation.operation);
        if (launch.outcome === 'unknown') return launch;
        if (launch.outcome === 'not-started')
          return native.observeAuditRefusal(reservation.operation, launch.receipt);
        allowed(launch.session);
        const session = await inspectChatPeer(rpc, roles, launch.session, evidence, {
          parent,
          project,
        });
        if (session === null) return { outcome: 'unknown' };
        return native.observeAuditTerminal(
          reservation.operation,
          session,
          launch.receipt,
          launch.turn_not_started,
          launch.deliveries,
          launch.delivery_turns,
        );
      },
      inspect: async (id) => {
        allowed(id);
        if (peers === true) return inspectChatPeer(rpc, roles, id, evidence);
        if (peers === 'council')
          return inspectChatPeer(rpc, roles, id, evidence, undefined, project);
        return inspectChatPeer(rpc, roles, id, evidence, { parent, project });
      },
      poll: async (session, turn) => {
        allowed(session.id);
        return native.poll(session, turn);
      },
      verifyReview: async (session, binding, turn, answer) => {
        allowed(session.id);
        return native.verifyReview(session, binding, turn, answer);
      },
    };
    return await action(sessions);
  } finally {
    rpc.close();
  }
}
