import { workflowFixture } from './workflowFixtures.js';
import { startLocalRun } from '../core/localRun.js';
import { createChatMessages } from '../core/chatMessages.js';
import { createChatControl } from '../core/chatControl.js';
import type { ChatContext } from '../ports/chatContext.js';
import type { TechnicalState, EffectRecord } from '../core/evidence.js';
import { buildCompactContext } from '../adapters/project/compactContext.js';

export async function compactFixture() {
  const f = await workflowFixture();
  const run = startLocalRun(
    { ...f.executor.spec, procedure_loading: 'by-action', context_loading: 'fragments-v1' },
    1,
  );
  const observed = {
    thread_id: run.spec.session_id,
    turn_id: 'turn',
    workspace: f.root,
    host_id: 'local' as const,
    model: run.spec.requested.model,
    effort: run.spec.requested.effort,
    approval_policy: 'never',
    sandbox_policy: 'danger-full-access',
    permission_profile: 'disabled',
    network_access: true,
    client_version: '0.163.0-alpha.11.2',
    source: f.proof,
  };
  const context: ChatContext = {
    run,
    messages: createChatMessages('task', run.spec.session_id, 1, run.spec.assignment),
    control: createChatControl(observed, 1),
    workflow: { schema_version: 1, revision: 0, execution: null, readings: {} },
    coordination_bound: false,
  };
  const ownership: TechnicalState = {
    revision: 1,
    generation: 1,
    owner: run.spec.session_id,
    lease_until: 100_000,
    frozen: false,
    released: false,
    checkpoint: {},
  };
  const effects: EffectRecord[] = [];
  const build = () =>
    buildCompactContext(
      run,
      'marker',
      'continue-chat',
      'a'.repeat(64),
      f.proof,
      context,
      ownership,
      effects,
      f.loaded,
      [],
      1000,
    );
  return { ...f, run, context, ownership, effects, build };
}
