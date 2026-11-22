import type { InputRef } from './localRun.js';

export interface ChatAnchor {
  thread_id: string;
  turn_id: string;
  workspace: string;
  host_id: 'local';
}
export interface ChatObservation extends ChatAnchor {
  client_version: string;
  model: string;
  effort: string;
  approval_policy: string;
  sandbox_policy: string;
  permission_profile: string;
  network_access: boolean | null;
  source: InputRef;
}
