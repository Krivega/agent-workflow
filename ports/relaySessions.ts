import type { RelaySeed } from '../core/relay.js';
import type { AgentSession } from '../core/dataRoute.js';
export interface RelaySessions {
  create(seed: RelaySeed): Promise<AgentSession>;
}
