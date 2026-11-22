import { createMachine, getInitialSnapshot, transition } from 'xstate';
import type { InputRef } from './localRun.js';
import type { Procedure } from './connection.js';
import { requireWorkflow, textField } from './connection.js';

export interface TaskConnectionPlan {
  schema_version: 1;
  tool_version: 'aw-local/1';
  runtime_package_version?: string;
  project_id: string;
  task_id: string;
  card: string;
  descriptor: InputRef;
  procedures: Procedure[];
  rules: InputRef[];
  before: string;
  after: string;
  from_version: null | 1 | 2;
  to_version: 2;
}
export type ConnectionPhase = 'prepared' | 'enabled' | 'disabled' | 'rolled-back';
export type ConnectionAction = 'ENABLE' | 'DISABLE' | 'ROLLBACK';
const machine = createMachine({
  id: 'task-connection',
  initial: 'prepared',
  states: {
    prepared: { on: { ENABLE: 'enabled', ROLLBACK: 'rolled-back' } },
    enabled: { on: { DISABLE: 'disabled' } },
    disabled: { on: { ENABLE: 'enabled', ROLLBACK: 'rolled-back' } },
    'rolled-back': { type: 'final' },
  },
});
export function connectionTransition(
  phase: ConnectionPhase,
  action: ConnectionAction,
): ConnectionPhase {
  const initial = getInitialSnapshot(machine),
    snapshot = machine.resolveState({ value: phase, context: initial.context });
  const [next] = transition(machine, snapshot, { type: action });
  requireWorkflow(next.value !== phase, 'invalid-connection-transition');
  return next.value as ConnectionPhase;
}
export function validateConnectionPlan(plan: TaskConnectionPlan) {
  requireWorkflow(
    plan.schema_version === 1 &&
      plan.tool_version === 'aw-local/1' &&
      plan.to_version === 2 &&
      [null, 1, 2].includes(plan.from_version),
    'unsupported-task-connection',
  );
  textField(plan.project_id);
  textField(plan.task_id);
  textField(plan.before);
  textField(plan.after);
}
