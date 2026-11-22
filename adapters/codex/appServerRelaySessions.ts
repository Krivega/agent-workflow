import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { RelaySessions } from '../../ports/relaySessions.js';
import type { RelaySeed } from '../../core/relay.js';
import type { AgentSession } from '../../core/dataRoute.js';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { AppServerRpc } from './appServerTransport.js';

export class AppServerRelaySessions implements RelaySessions {
  constructor(
    private readonly rpc: AppServerRpc,
    private readonly evidenceRoot: string,
  ) {}
  async create(seed: RelaySeed): Promise<AgentSession> {
    const profile = seed.predecessor.spec.requested;
    const readOnly = !profile.permissions.includes('implement');
    const raw = object(
      await this.rpc.request('thread/start', {
        projectId: seed.native_project_id,
        cwd: seed.predecessor.spec.workspace,
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: 'never',
        ephemeral: false,
        allowProviderModelFallback: false,
        model: profile.model,
        config: {
          model_reasoning_effort: profile.effort,
          'sandbox_workspace_write.network_access': false,
        },
      }),
    );
    const thread = object(raw.thread),
      sandbox = object(raw.sandbox);
    const id = textField(thread.id);
    requireWorkflow(
      /^[a-zA-Z0-9_-]+$/u.test(id) && Array.isArray(thread.turns),
      'invalid-relay-session',
    );
    const bytes = JSON.stringify({ session: raw }, null, 2) + '\n';
    const hash = createHash('sha256').update(bytes).digest('hex');
    const locator = resolve(this.evidenceRoot, `created-${id}-${hash}.json`);
    await writeFile(locator, bytes, { flag: 'wx' });
    return {
      id,
      project_id: textField(thread.projectId),
      workspace: textField(raw.cwd),
      model: textField(raw.model),
      effort: textField(raw.reasoningEffort),
      read_only: sandbox.type === 'readOnly',
      network: sandbox.networkAccess !== false,
      initial_turns: thread.turns.length,
      forked_from: thread.forkedFromId === null ? null : textField(thread.forkedFromId),
      receipt: { locator, hash },
    };
  }
}
