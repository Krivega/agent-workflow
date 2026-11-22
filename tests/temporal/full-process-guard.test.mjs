import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';
import test from 'node:test';
import { ownProcess } from '../../examples/temporal-consumers/full/safety.mjs';

const ROOT = 911111,
  CHILD = 911112,
  OTHER = 922222;
const rootRow = { pid: ROOT, ppid: 1, pgid: ROOT, identity: 'root-owned' };
const childRow = { pid: CHILD, ppid: ROOT, pgid: ROOT, identity: 'first-child' };
const kernelRow = { pid: 2, ppid: 0, pgid: 0, identity: 'Tue Nov 10 00:00:00 2026' };
function trace(frames, options = {}) {
  let index = 0,
    elapsed = 0;
  const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: null, signalCode: null });
  const signals = [],
    queries = [];
  const guard = ownProcess(child, {
    deadline: 100,
    stopMs: 20,
    now: () => elapsed,
    snapshot: () => {
      const frame = frames[Math.min(index, frames.length - 1)];
      if (frame instanceof Error) throw frame;
      child.exitCode = frame.exited ? 0 : null;
      return frame.rows;
    },
    listeners: (pids, paths, timeout) => {
      queries.push({ pids, paths, timeout });
      return options.listener?.(pids, paths) ?? false;
    },
    listenerPaths: options.listenerPaths ?? [],
    signal: (pid, name) => signals.push([pid, name]),
    pause: async () => {
      elapsed += 5;
      index++;
    },
  });
  return { child, guard, signals, queries };
}

async function timedStop(options = {}) {
  let elapsed = 0,
    termAt = null,
    exited = false;
  const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: null, signalCode: null });
  const signals = [];
  const guard = ownProcess(child, {
    deadline: options.deadline ?? 10000,
    stopMs: 8000,
    ...(options.termGraceMs === undefined ? {} : { termGraceMs: options.termGraceMs }),
    now: () => elapsed,
    snapshot: () =>
      exited
        ? []
        : [
            rootRow,
            ...(options.lateChild && termAt !== null && elapsed - termAt >= 1000
              ? [{ ...childRow, pgid: CHILD }]
              : []),
          ],
    listeners: () => false,
    signal: (target, name) => {
      signals.push({ target, name, atMs: elapsed });
      if (name === 'SIGTERM') termAt = elapsed;
      if (name === 'SIGKILL') {
        exited = true;
        child.signalCode = name;
      }
    },
    pause: async (milliseconds) => {
      elapsed += milliseconds;
      if (termAt !== null && elapsed - termAt >= (options.exitAfterTermMs ?? Infinity)) {
        exited = true;
        child.exitCode = 0;
      }
    },
  });
  const receipt = await guard.stop();
  return { receipt, signals, elapsed };
}

test('default TERM grace still forces a delayed exit at the existing 1000ms boundary', async () => {
  const f = await timedStop({ exitAfterTermMs: 1500 });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.equal(f.receipt.killed, true);
  assert.equal(f.receipt.signal, 'SIGKILL');
  assert.deepEqual(f.signals, [
    { target: -ROOT, name: 'SIGTERM', atMs: 50 },
    { target: -ROOT, name: 'SIGKILL', atMs: 1050 },
  ]);
});

test('a cooperative window delays automatic TERM and bounds KILL and observation by the original deadline', async () => {
  let elapsed = 0;
  const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: null, signalCode: null });
  const signals = [];
  const receipt = await ownProcess(child, {
    deadline: 10000,
    stopMs: 8000,
    automaticStopAt: 9500,
    now: () => elapsed,
    snapshot: () => (child.signalCode === null ? [rootRow] : []),
    listeners: () => false,
    signal: (_target, name) => {
      signals.push([name, elapsed]);
      if (name === 'SIGKILL') child.signalCode = name;
    },
    pause: async (ms) => {
      elapsed += ms;
    },
  }).done;
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.equal(receipt.signal, 'SIGKILL');
  assert.deepEqual(signals, [
    ['SIGTERM', 9500],
    ['SIGKILL', 9750],
  ]);
  assert.ok(elapsed < 10000);
});

for (const automaticStopAt of [1999, 10000, Infinity, NaN])
  test(`refuses an unsafe automatic stop boundary: ${automaticStopAt}`, async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: ROOT,
      exitCode: null,
      signalCode: null,
    });
    const receipt = await ownProcess(child, {
      deadline: 10000,
      stopMs: 8000,
      automaticStopAt,
      snapshot: () => assert.fail('invalid bounds must not observe or signal'),
    }).done;
    assert.equal(receipt.stopped, false);
    assert.match(receipt.reason, /invalid automatic stop boundary/u);
  });

test('explicit TERM grace permits an owned exit after 1000ms without forced termination', async () => {
  const f = await timedStop({ termGraceMs: 3000, exitAfterTermMs: 1500 });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.equal(f.receipt.code, 0);
  assert.equal(f.receipt.killed, false);
  assert.equal(f.receipt.deadlineReached, false);
  assert.equal(f.elapsed, 1550);
  assert.deepEqual(f.signals, [{ target: -ROOT, name: 'SIGTERM', atMs: 50 }]);
});

test('explicit TERM grace remains bounded and forces owned cleanup when TERM is ignored', async () => {
  const f = await timedStop({ termGraceMs: 3000 });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.equal(f.receipt.killed, true);
  assert.equal(f.receipt.signal, 'SIGKILL');
  assert.deepEqual(f.signals, [
    { target: -ROOT, name: 'SIGTERM', atMs: 50 },
    { target: -ROOT, name: 'SIGKILL', atMs: 3050 },
  ]);
});

test('short hard deadline clamps explicit grace and retains half the interval for forced cleanup', async () => {
  const f = await timedStop({ termGraceMs: 3000, deadline: 500 });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.equal(f.receipt.killed, true);
  assert.equal(f.receipt.deadlineReached, true);
  assert.deepEqual(f.signals, [
    { target: -ROOT, name: 'SIGTERM', atMs: 0 },
    { target: -ROOT, name: 'SIGKILL', atMs: 250 },
  ]);
  assert.ok(f.elapsed < 500);
});

test('explicit grace cannot exceed half the stop budget', async () => {
  const f = await timedStop({ termGraceMs: 20000 });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.equal(f.receipt.killed, true);
  assert.equal(f.signals[1].atMs, f.signals[0].atMs + 4000);
});

test('a late owned child and process group do not move the original kill deadline', async () => {
  const f = await timedStop({ termGraceMs: 3000, lateChild: true });
  assert.equal(f.receipt.stopped, true, f.receipt.reason);
  assert.deepEqual(f.signals, [
    { target: -ROOT, name: 'SIGTERM', atMs: 50 },
    { target: -ROOT, name: 'SIGKILL', atMs: 3050 },
    { target: -CHILD, name: 'SIGKILL', atMs: 3050 },
  ]);
  assert.ok(f.receipt.identities.some((row) => row.pid === CHILD && row.pgid === CHILD));
});

for (const termGraceMs of [0, -1, 1.5, NaN, Infinity, '1000', null]) {
  test(`unsafe explicit TERM grace ${String(termGraceMs)} refuses without signaling`, async () => {
    const f = await timedStop({ termGraceMs });
    assert.equal(f.receipt.stopped, false);
    assert.match(f.receipt.reason, /TERM grace/u);
    assert.deepEqual(f.signals, []);
  });
}

test('retires an absent owned PID before foreign reuse without TCP attribution or signaling', async () => {
  const foreign = { pid: CHILD, ppid: 1, pgid: OTHER, identity: 'foreign-reuse' };
  const f = trace(
    [
      { rows: [rootRow, childRow] },
      { rows: [rootRow] },
      { rows: [rootRow, foreign] },
      { rows: [foreign], exited: true },
    ],
    { listener: (pids) => pids.includes(CHILD) },
  );
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.deepEqual(f.signals, []);
  assert.ok(f.queries.every((query) => !query.pids.includes(CHILD) && !query.pids.includes(ROOT)));
  assert.deepEqual(receipt.identities, [rootRow, childRow]);
  assert.deepEqual(receipt.pids, [ROOT, CHILD]);
  assert.ok(receipt.retired.some((row) => row.pid === CHILD && row.identity === childRow.identity));
  assert.ok(!receipt.identities.some((row) => row.identity === foreign.identity));
});

test('retains both owned PID epochs when a new descendant reuses an observed absent PID', async () => {
  const second = { ...childRow, identity: 'second-owned-child' };
  const f = trace([
    { rows: [rootRow, childRow] },
    { rows: [rootRow] },
    { rows: [rootRow, second] },
    { rows: [], exited: true },
  ]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.deepEqual(receipt.identities, [rootRow, childRow, second]);
  assert.deepEqual(receipt.pids, [ROOT, CHILD]);
  assert.deepEqual(
    receipt.retired.filter((row) => row.pid === CHILD).map((row) => row.identity),
    [childRow.identity, second.identity],
  );
});

test('retires an empty owned PGID before a foreign group reuses it', async () => {
  const group = { pid: OTHER, ppid: ROOT, pgid: OTHER, identity: 'owned-group' };
  const foreign = { pid: OTHER + 1, ppid: 1, pgid: OTHER, identity: 'foreign-group' };
  const f = trace([
    { rows: [rootRow, group] },
    { rows: [rootRow] },
    { rows: [rootRow, foreign] },
    { rows: [foreign], exited: true },
  ]);
  const receipt = await f.guard.done;
  assert.ok(
    !f.signals.some(([target]) => target === -OTHER || target === foreign.pid),
    'foreign reused group must not receive a signal',
  );
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.deepEqual(receipt.groups, [ROOT, OTHER]);
  assert.ok(receipt.retiredGroups.some((row) => row.pgid === OTHER));
  assert.ok(!receipt.identities.some((row) => row.pid === foreign.pid));
});

test('keeps separate owned epochs even when a reused PID has the same coarse start text', async () => {
  const f = trace([
    { rows: [rootRow, childRow] },
    { rows: [rootRow] },
    { rows: [rootRow, { ...childRow }] },
    { rows: [], exited: true },
  ]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.deepEqual(receipt.identities, [rootRow, childRow, childRow]);
  assert.equal(receipt.retired.filter((row) => row.pid === CHILD).length, 2);
});

test('a retired leader is not an unconditional ownership seed for its foreign replacement', async () => {
  const late = { pid: CHILD, ppid: 1, pgid: ROOT, identity: 'remaining-owned-group' };
  const foreign = { ...rootRow, ppid: 1, pgid: OTHER, identity: 'foreign-leader-reuse' };
  const f = trace([
    { rows: [rootRow, late] },
    { rows: [late], exited: true },
    { rows: [foreign], exited: true },
  ]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.ok(!receipt.identities.some((row) => row.identity === foreign.identity));
  assert.ok(!f.signals.some(([target]) => target === ROOT || target === -OTHER));
});

test('PID reuse without an intervening complete absence remains UNKNOWN', async () => {
  const f = trace([
    { rows: [rootRow, childRow] },
    { rows: [rootRow, { ...childRow, identity: 'unobserved-replacement' }] },
  ]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, false);
  assert.match(receipt.reason, /owned PID identity changed/u);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(receipt.retired ?? [], []);
});

test('an observer error does not retire identities or grant a known stop', async () => {
  const f = trace([{ rows: [rootRow, childRow] }, new Error('PS observation denied')]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, false);
  assert.match(receipt.reason, /PS observation denied/u);
  assert.deepEqual(receipt.identities, [rootRow, childRow]);
  assert.deepEqual(receipt.retired ?? [], []);
  assert.deepEqual(f.signals, []);
});

test('stops only its owned group when a complete snapshot includes a foreign zero PGID', async () => {
  const f = trace([
    { rows: [rootRow, kernelRow] },
    { rows: [rootRow, kernelRow] },
    { rows: [kernelRow], exited: true },
  ]);
  const receipt = await f.guard.stop();
  assert.equal(receipt.stopped, true, receipt.reason);
  assert.deepEqual(receipt.identities, [rootRow]);
  assert.deepEqual(receipt.pids, [ROOT]);
  assert.deepEqual(receipt.groups, [ROOT]);
  assert.deepEqual(f.signals, [[-ROOT, 'SIGTERM']]);
  assert.ok(f.signals.every(([target]) => target !== 0 && target !== kernelRow.pid));
});

for (const [name, frames] of [
  ['leader', [{ rows: [{ ...rootRow, pgid: 0 }] }]],
  [
    'new descendant after leader exit',
    [{ rows: [rootRow] }, { rows: [{ ...childRow, pgid: 0 }], exited: true }],
  ],
  [
    'previously owned descendant after leader exit',
    [{ rows: [rootRow, childRow] }, { rows: [{ ...childRow, pgid: 0 }], exited: true }],
  ],
  [
    'new transitive descendant before a missing identity is retired',
    [
      { rows: [rootRow, childRow] },
      {
        rows: [
          { pid: OTHER + 1, ppid: OTHER, pgid: 0, identity: 'owned-grandchild' },
          { pid: OTHER, ppid: ROOT, pgid: OTHER, identity: 'new-owned-parent' },
          rootRow,
        ],
      },
    ],
  ],
]) {
  test(`an owned zero-PGID ${name} remains UNKNOWN before retirement or drain`, async () => {
    const f = trace(frames);
    const receipt = await f.guard.done;
    assert.equal(receipt.stopped, false);
    assert.match(receipt.reason, /process snapshot/u);
    assert.deepEqual(receipt.retired, []);
    assert.deepEqual(receipt.retiredGroups, []);
    assert.ok(receipt.identities.every((row) => row.pgid > 0));
    assert.deepEqual(f.signals, []);
    assert.deepEqual(f.queries, []);
  });
}

for (const [name, rows] of [
  ['not-array', null],
  ['null-row', [rootRow, null]],
  ['duplicate-PID', [rootRow, rootRow]],
  ['zero-PID', [rootRow, { ...childRow, pid: 0 }]],
  ['negative-PID', [rootRow, { ...childRow, pid: -1 }]],
  ['infinite-PID', [rootRow, { ...childRow, pid: Infinity }]],
  ['NaN-PID', [rootRow, { ...childRow, pid: NaN }]],
  ['fractional-PID', [rootRow, { ...childRow, pid: 1.5 }]],
  ['string-PID', [rootRow, { ...childRow, pid: '911112' }]],
  ['zero-PGID', [rootRow, { ...childRow, pgid: 0 }]],
  ['negative-PGID', [rootRow, { ...childRow, pgid: -1 }]],
  ['infinite-PGID', [rootRow, { ...childRow, pgid: Infinity }]],
  ['NaN-PGID', [rootRow, { ...childRow, pgid: NaN }]],
  ['fractional-PGID', [rootRow, { ...childRow, pgid: 1.5 }]],
  ['string-PGID', [rootRow, { ...childRow, pgid: '911111' }]],
  ['negative-PPID', [rootRow, { ...childRow, ppid: -1 }]],
  ['NaN-PPID', [rootRow, { ...childRow, ppid: NaN }]],
  ['empty-identity', [rootRow, { ...childRow, identity: '' }]],
  ['blank-identity', [rootRow, { ...childRow, identity: ' ' }]],
]) {
  test(`a ${name} snapshot remains UNKNOWN before any retirement`, async () => {
    const f = trace([{ rows: [rootRow, childRow] }, { rows }, { rows: [], exited: true }]);
    const receipt = await f.guard.done;
    assert.equal(receipt.stopped, false);
    assert.match(receipt.reason, /process snapshot/u);
    assert.deepEqual(receipt.retired ?? [], []);
    assert.deepEqual(f.signals, []);
  });
}

test('unobserved exited leader reuse remains UNKNOWN', async () => {
  const f = trace([{ rows: [{ ...rootRow, identity: 'foreign-unobserved' }], exited: true }]);
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, false);
  assert.match(receipt.reason, /exited PID appeared before/u);
  assert.deepEqual(f.signals, []);
});

test('retirement does not turn an owned-path listener into a successful stop', async () => {
  const f = trace([{ rows: [rootRow] }, { rows: [], exited: true }], {
    listenerPaths: ['/owned/task.sqlite'],
    listener: () => true,
  });
  const receipt = await f.guard.done;
  assert.equal(receipt.stopped, false);
  assert.match(receipt.reason, /deadline/u);
  assert.ok(f.queries.length > 1);
  assert.ok(f.queries.every((query) => query.pids.length === 0));
  assert.ok(f.queries.every((query) => query.paths[0] === '/owned/task.sqlite'));
});

for (const [name, output] of [
  ['empty', '  '],
  ['self-missing', `${OTHER} 0 ${OTHER} foreign-system-row\n`],
]) {
  test(`default ps rejects ${name} output without running a real observer`, async (t) => {
    const stub = t.mock.method(childProcess, 'execFileSync', () => output);
    syncBuiltinESMExports();
    try {
      const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: 0, signalCode: null });
      const receipt = await ownProcess(child, {
        deadline: 100,
        now: () => 0,
        listeners: () => false,
        signal: () => assert.fail('an incomplete observation must not signal'),
      }).done;
      assert.equal(receipt.stopped, false);
      assert.match(receipt.reason, /process snapshot/u);
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('default TCP observation skips retired PID queries and still checks owned paths', async (t) => {
  const queries = [];
  const stub = t.mock.method(childProcess, 'spawnSync', (_file, args) => {
    queries.push(args);
    return { status: 1, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  try {
    let index = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: ROOT,
      exitCode: null,
      signalCode: null,
    });
    const receipt = await ownProcess(child, {
      deadline: 100,
      stopMs: 20,
      now: () => index * 5,
      snapshot: () => (index === 0 ? [rootRow] : []),
      pause: async () => {
        index++;
        child.exitCode = 0;
      },
      listenerPaths: ['/owned/task.sqlite'],
      signal: () => assert.fail('no live owned identities'),
    }).done;
    assert.equal(receipt.stopped, true, receipt.reason);
    assert.deepEqual(queries, [['-nP', '-t', '/owned/task.sqlite']]);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

test('default complete ps accepts the observer self row and a system PPID zero', async (t) => {
  const stub = t.mock.method(
    childProcess,
    'execFileSync',
    () => `${process.pid} 0 ${process.pid} observer-self\n`,
  );
  syncBuiltinESMExports();
  try {
    const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: 0, signalCode: null });
    const receipt = await ownProcess(child, {
      deadline: 100,
      now: () => 0,
      listeners: () => false,
      signal: () => assert.fail('no owned process remains'),
    }).done;
    assert.equal(receipt.stopped, true, receipt.reason);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

test('default complete ps accepts a foreign kernel row with PGID zero', async (t) => {
  const stub = t.mock.method(
    childProcess,
    'execFileSync',
    () =>
      `${process.pid} 0 ${process.pid} observer-self\n${kernelRow.pid} ${kernelRow.ppid} ${kernelRow.pgid} ${kernelRow.identity}\n`,
  );
  syncBuiltinESMExports();
  try {
    const child = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: 0, signalCode: null });
    const receipt = await ownProcess(child, {
      deadline: 100,
      now: () => 0,
      listeners: () => false,
      signal: () => assert.fail('a foreign kernel process must not receive a signal'),
    }).done;
    assert.equal(receipt.stopped, true, receipt.reason);
    assert.deepEqual(receipt.identities, []);
    assert.deepEqual(receipt.retired, []);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});
