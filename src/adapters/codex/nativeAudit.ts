import { parse as parseToml } from 'smol-toml';
import { exactFields, object, requireContract, text } from '../../contracts/project.js';
import { readPrivateFile } from '../artifacts/files.js';

export const auditorProfile = {
  model: 'gpt-6.2-sol',
  effort: 'xhigh',
  clientVersion: '0.171.0-alpha.13',
};
export const auditParentProfile = { ...auditorProfile, effort: 'medium' };

export function checkAuditorProfile(bytes: Buffer): void {
  requireContract(Buffer.from(bytes.toString('utf8')).equals(bytes), 'auditor-profile-encoding');
  const profile = object(parseToml(bytes.toString('utf8')));
  exactFields(profile, [
    'name',
    'description',
    'model',
    'model_reasoning_effort',
    'developer_instructions',
    'features',
  ]);
  requireContract(
    profile.name === 'auditor' &&
      profile.model === auditorProfile.model &&
      profile.model_reasoning_effort === auditorProfile.effort,
    'auditor-profile-mismatch',
  );
  text(profile.description);
  requireContract(
    typeof profile.developer_instructions === 'string' &&
      profile.developer_instructions.trim().length > 0,
    'auditor-instructions-missing',
  );
  const features = object(profile.features);
  exactFields(features, ['apps', 'plugins', 'memories', 'request_permissions_tool']);
  requireContract(
    Object.values(features).every((v) => v === false),
    'auditor-capabilities-unconfirmed',
  );
}
export function nativeAuditRecords(thread: Record<string, unknown>): Record<string, unknown>[] {
  const bytes = readPrivateFile(text(thread.path)).toString('utf8');
  requireContract(bytes.endsWith('\n'), 'auditor-history-partial');
  const records = bytes
    .slice(0, -1)
    .split('\n')
    .map((line) => object(JSON.parse(line) as unknown));
  const meta = records.filter((r) => r.type === 'session_meta');
  requireContract(
    meta.length === 1 &&
      object(meta[0]!.payload).id === thread.id &&
      object(meta[0]!.payload).cli_version === auditorProfile.clientVersion,
    'auditor-history-identity',
  );
  return records;
}
export function nativeAuditCalls(thread: Record<string, unknown>) {
  const records = nativeAuditRecords(thread);
  requireContract(
    !records.some(
      (r) => r.type === 'response_item' && object(r.payload).type === 'custom_tool_call',
    ),
    'auditor-parent-extra-tool',
  );
  return records
    .filter((r) => r.type === 'response_item' && object(r.payload).type === 'function_call')
    .map((r) => {
      const p = object(r.payload),
        id = text(p.call_id),
        turn = text(object(p.internal_chat_message_metadata_passthrough).turn_id);
      const outputs = records.filter(
        (v) =>
          v.type === 'response_item' &&
          object(v.payload).type === 'function_call_output' &&
          object(v.payload).call_id === id,
      );
      requireContract(outputs.length === 1, 'auditor-parent-tool-outcome-unknown');
      requireContract(typeof p.arguments === 'string', 'auditor-parent-arguments');
      return { name: text(p.name), id, turn, args: object(JSON.parse(p.arguments) as unknown) };
    });
}
export function nativeAuditChild(parent: Record<string, unknown>, operation: string) {
  requireContract(Array.isArray(parent.turns), 'auditor-parent-history');
  const calls = nativeAuditCalls(parent);
  requireContract(
    calls.length === 1 && ['spawn_agent', 'collaboration.spawn_agent'].includes(calls[0]!.name),
    'auditor-parent-single-spawn',
  );
  const call = calls[0]!;
  exactFields(call.args, ['task_name', 'agent_type', 'fork_turns', 'message']);
  requireContract(
    call.args.task_name === operation &&
      call.args.agent_type === 'auditor' &&
      call.args.fork_turns === 'none' &&
      typeof call.args.message === 'string',
    'auditor-spawn-binding',
  );
  const turns = parent.turns.map(object),
    turn = turns.find((t) => t.id === call.turn);
  requireContract(
    turn !== undefined && turn.status === 'completed' && Array.isArray(turn.items),
    'auditor-parent-not-completed',
  );
  const started = turn.items
    .map(object)
    .filter((i) => i.type === 'subAgentActivity' && i.kind === 'started');
  requireContract(
    started.length === 1 &&
      started[0]!.id === call.id &&
      started[0]!.model === auditorProfile.model &&
      started[0]!.reasoningEffort === auditorProfile.effort,
    'auditor-spawn-unconfirmed',
  );
  const activity = started[0]!;
  requireContract(activity.agentPath === '/root/' + operation, 'auditor-path-mismatch');
  return {
    id: text(activity.agentThreadId),
    path: text(activity.agentPath),
    parentTurn: call.turn,
    message: call.args.message,
  };
}
export function confirmAuditDelivery(
  thread: Record<string, unknown>,
  parentTurn: string,
  path: string,
  actual: string,
  expected: string,
): 'text' | 'attributed-encrypted' {
  const turn = auditChildTurn(thread, parentTurn);
  if (actual === expected) return 'text';
  const messages = nativeAuditRecords(thread).filter(
    (r) =>
      r.type === 'response_item' &&
      object(r.payload).type === 'agent_message' &&
      object(object(r.payload).internal_chat_message_metadata_passthrough).turn_id === turn.id,
  );
  requireContract(messages.length === 1, 'auditor-delivery-unconfirmed');
  const message = object(messages[0]!.payload);
  requireContract(
    message.author === '/root' && message.recipient === path && Array.isArray(message.content),
    'auditor-delivery-unconfirmed',
  );
  const encrypted = message.content.map(object).filter((c) => c.type === 'encrypted_content');
  requireContract(
    encrypted.length === 1 && encrypted[0]!.encrypted_content === actual,
    'auditor-delivery-unconfirmed',
  );
  return 'attributed-encrypted';
}
export function confirmAuditorSession(
  raw: unknown,
  parent: string,
  child: string,
  workspace: string,
) {
  const response = object(raw),
    thread = object(response.thread),
    sandbox = object(response.sandbox);
  requireContract(
    response.cwd === workspace &&
      response.model === auditorProfile.model &&
      response.reasoningEffort === auditorProfile.effort &&
      response.approvalPolicy === 'never' &&
      sandbox.type === 'readOnly' &&
      sandbox.networkAccess === false &&
      thread.id === child &&
      thread.cwd === workspace &&
      thread.agentRole === 'auditor' &&
      thread.parentThreadId === parent &&
      thread.forkedFromId === null &&
      thread.projectId === null &&
      thread.canAcceptDirectInput === false,
    'auditor-native-profile-unconfirmed',
  );
  return thread;
}
export function auditChildTurn(thread: Record<string, unknown>, parentTurn: string) {
  const records = nativeAuditRecords(thread);
  const starts = records.filter(
    (r) =>
      r.type === 'event_msg' &&
      object(r.payload).type === 'task_started' &&
      object(object(r.payload).turn_attribution).parent_turn_id === parentTurn,
  );
  requireContract(
    starts.length === 1 && Array.isArray(thread.turns),
    'auditor-delivery-unconfirmed',
  );
  const id = text(object(starts[0]!.payload).turn_id),
    turns = thread.turns.map(object).filter((t) => t.id === id);
  requireContract(turns.length === 1, 'auditor-turn-unconfirmed');
  return turns[0]!;
}
