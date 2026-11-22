import type { InputRef } from '../core/localRun.js';

export interface UserCommandTarget {
  project_id: string;
  task_id: string;
  run_id: string;
  thread_id: string;
  generation: number;
  control_revision: number;
  requirements_revision: number;
}
export interface UserCommands {
  verify(source: InputRef, target: UserCommandTarget): Promise<void>;
}
