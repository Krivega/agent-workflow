import { expect, it } from 'vitest';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';

type Row = { type: string; payload: Record<string, unknown> };
const workspace = '/fixture/root-workspace';
function start(turn: string, retry = false): Row {
  return {
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turn,
      ...(retry
        ? {
            turn_attribution: {
              turn_id: turn,
              turn_trigger: 'capacity_retry_manual',
              parent_turn_id: null,
              initiating_agent_path: null,
              root_turn_id: turn,
            },
          }
        : {}),
    },
  };
}
function context(turn: string): Row {
  return {
    type: 'turn_context',
    payload: {
      turn_id: turn,
      root_turn_id: turn,
      cwd: workspace,
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
      model: 'fixture-model',
      effort: 'high',
    },
  };
}
function overloaded(turn: string): Row {
  return {
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      root_turn_id: turn,
      turn_id: turn,
      last_agent_message: null,
      error: {
        message: 'Selected model is at capacity. Please try a different model.',
        codex_error_info: 'server_overloaded',
      },
      started_at: 1000,
      completed_at: 2000,
      duration_ms: 1000000,
      time_to_first_token_ms: 2000,
    },
  };
}
function inbound(turn: string): Row {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      namespace: 'codex_app',
      name: 'send_message_to_thread',
      internal_chat_message_metadata_passthrough: { turn_id: turn },
    },
  };
}
function fixture() {
  const rows = [
    start('decision'),
    context('decision'),
    overloaded('decision'),
    start('retry', true),
    context('retry'),
  ];
  return {
    rows,
    previous: rows[2]!.payload,
    attribution: rows[3]!.payload.turn_attribution as Record<string, unknown>,
  };
}
const verify = (rows: Row[], source = 'decision', target = 'retry') =>
  verifyH06OperatorContinuation(rows, source, target, workspace);

it('retains a decision over the observed native capacity shape without modifying its journal', () => {
  const f = fixture(),
    before = structuredClone(f.rows);
  expect(verify(f.rows)).toBe(true);
  expect(f.rows).toEqual(before);
});

it('allows multiple consecutive verified capacity retries and ordinary root model changes', () => {
  const f = fixture();
  f.rows[4]!.payload.model = 'different-operator-model';
  f.rows[4]!.payload.effort = 'medium';
  f.rows.push(overloaded('retry'), start('retry-again', true), context('retry-again'));
  expect(verify(f.rows, 'decision', 'retry-again')).toBe(true);
});

it('checks an unchanged source turn without granting continuation past its terminal', () => {
  const rows = [start('decision'), context('decision'), overloaded('decision')];
  expect(verify(rows, 'decision', 'decision')).toBe(true);
  // The active-target check belongs to the authority caller, independently of chain verification.
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'missing source',
    ({ rows }) => {
      rows.splice(0, 1);
    },
  ],
  [
    'missing target',
    ({ rows }) => {
      rows.splice(3, 2);
    },
  ],
  [
    'duplicate start',
    ({ rows }) => {
      rows.push(start('decision'));
    },
  ],
  [
    'duplicate context',
    ({ rows }) => {
      rows.push(context('retry'));
    },
  ],
  [
    'missing context',
    ({ rows }) => {
      rows.pop();
    },
  ],
  [
    'different workspace',
    ({ rows }) => {
      rows[4]!.payload.cwd = '/other';
    },
  ],
  [
    'context preceding start',
    ({ rows }) => {
      [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    },
  ],
  [
    'context outside its turn',
    ({ rows }) => {
      const value = rows.splice(1, 1)[0]!;
      rows.push(value);
    },
  ],
  [
    'context after completion',
    ({ rows }) => {
      [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    },
  ],
  [
    'approval scope',
    ({ rows }) => {
      rows[4]!.payload.approval_policy = 'on-request';
    },
  ],
  [
    'execution scope',
    ({ rows }) => {
      rows[4]!.payload.sandbox_policy = { type: 'workspace-write' };
    },
  ],
  [
    'permission scope',
    ({ rows }) => {
      rows[4]!.payload.permission_profile = { type: 'restricted' };
    },
  ],
  [
    'delegated source',
    ({ rows }) => {
      rows.push(inbound('decision'));
    },
  ],
  [
    'delegated retry',
    ({ rows }) => {
      rows.push(inbound('retry'));
    },
  ],
  [
    'missing terminal',
    ({ rows }) => {
      rows.splice(2, 1);
    },
  ],
  [
    'duplicate terminal',
    ({ rows }) => {
      rows.splice(2, 0, overloaded('decision'));
    },
  ],
  [
    'terminal after next start',
    ({ rows }) => {
      const value = rows.splice(2, 1)[0]!;
      rows.push(value);
    },
  ],
  [
    'successful terminal',
    ({ previous }) => {
      previous.error = null;
    },
  ],
  [
    'other error',
    ({ previous }) => {
      previous.error = { codex_error_info: 'network_error' };
    },
  ],
  [
    'nonempty result',
    ({ previous }) => {
      previous.last_agent_message = 'Completed';
    },
  ],
  [
    'different terminal turn',
    ({ previous }) => {
      previous.turn_id = 'other';
    },
  ],
  [
    'different terminal root',
    ({ previous }) => {
      previous.root_turn_id = 'other';
    },
  ],
  [
    'aborted terminal',
    ({ previous }) => {
      previous.type = 'task_aborted';
    },
  ],
  [
    'missing attribution',
    ({ rows }) => {
      delete rows[3]!.payload.turn_attribution;
    },
  ],
  [
    'ordinary new turn',
    ({ attribution }) => {
      attribution.turn_trigger = 'user';
    },
  ],
  [
    'different attributed turn',
    ({ attribution }) => {
      attribution.turn_id = 'other';
    },
  ],
  [
    'different attributed root',
    ({ attribution }) => {
      attribution.root_turn_id = 'other';
    },
  ],
  [
    'parented retry',
    ({ attribution }) => {
      attribution.parent_turn_id = 'parent';
    },
  ],
  [
    'missing parent marker',
    ({ attribution }) => {
      delete attribution.parent_turn_id;
    },
  ],
  [
    'agent initiated retry',
    ({ attribution }) => {
      attribution.initiating_agent_path = '/root/worker';
    },
  ],
  [
    'malformed native payload',
    ({ rows }) => {
      rows.push({ type: 'event_msg', payload: null as unknown as Record<string, unknown> });
    },
  ],
];
it.each(mutations)('rejects %s', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(verify(f.rows)).toBe(false);
});

it('rejects a reversed source and target', () => {
  expect(verify(fixture().rows, 'retry', 'decision')).toBe(false);
});

it('does not skip an intervening ordinary turn even when its final retry metadata is valid', () => {
  const f = fixture();
  f.rows.splice(3, 0, start('ordinary'), context('ordinary'), overloaded('ordinary'));
  expect(verify(f.rows)).toBe(false);
});

it('does not accept another turn terminal as the source capacity failure', () => {
  const f = fixture();
  f.rows.splice(2, 1, overloaded('another-turn'));
  expect(verify(f.rows)).toBe(false);
});
