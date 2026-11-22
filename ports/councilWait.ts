import type { InputRef } from '../core/localRun.js';

export interface CouncilWaitBinding {
  run_id: string;
  owner: string;
  generation: number;
  requirements_revision: number;
  control_revision: number;
  turn_id: string;
  source: InputRef;
}

export interface CouncilWaitGuard {
  capture(): Promise<CouncilWaitBinding>;
  verify(binding: CouncilWaitBinding): Promise<void>;
}
