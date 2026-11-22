import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export function parseSdkProcessTable(output, self) {
  assert.ok(typeof output === 'string' && output.trim(), 'empty process observation');
  assert.ok(Number.isSafeInteger(self) && self > 1, 'invalid SDK self PID');
  const seen = new Set();
  const rows = output
    .trim()
    .split('\n')
    .map((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+([RSDITtZUXW][A-Za-z0-9+<>=/?-]*)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?:[1-9]|[12]\d|3[01])\s+(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4})\s*$/u.exec(
          line,
        );
      assert.ok(match, 'malformed process observation');
      const pid = Number(match[1]),
        parent = Number(match[2]);
      assert.ok(
        Number.isSafeInteger(pid) && Number.isSafeInteger(parent),
        'invalid process PID/parent',
      );
      assert.ok(!seen.has(pid), 'duplicate process PID');
      seen.add(pid);
      return { pid, parent, state: match[3], started: match[4].replace(/\s+/gu, ' ') };
    });
  assert.ok(seen.has(self), 'SDK self PID missing from process table');
  return rows;
}

export function sdkProcessGuard(
  self,
  observe = () =>
    execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    }),
) {
  const captured = new Map(),
    observations = [],
    unknown = [];
  let selfIdentity = null,
    stopped = false;
  function table() {
    const rows = parseSdkProcessTable(observe(), self),
      current = rows.find((row) => row.pid === self);
    if (selfIdentity)
      assert.equal(current.started, selfIdentity.started, 'SDK self identity changed');
    else selfIdentity = current;
    return rows;
  }
  function checked(stage, run) {
    try {
      run(table());
    } catch (error) {
      unknown.push({ stage, error: String(error) });
    }
    return unknown.length === 0;
  }
  function identityCurrent(rows, expected) {
    const actual = rows.find((row) => row.pid === expected.pid);
    if (actual)
      assert.equal(actual.started, expected.started, 'captured PID reused: ' + expected.pid);
    return actual;
  }
  return {
    capture(stage) {
      stopped = false;
      return checked(stage, (rows) => {
        for (const expected of captured.values()) identityCurrent(rows, expected);
        const children = new Map();
        for (const row of rows) {
          if (!children.has(row.parent)) children.set(row.parent, []);
          children.get(row.parent).push(row);
        }
        const queue = [self],
          visited = new Set(queue),
          descendants = [];
        for (let index = 0; index < queue.length; index++)
          for (const row of children.get(queue[index]) ?? []) {
            if (visited.has(row.pid)) continue;
            visited.add(row.pid);
            queue.push(row.pid);
            captured.set(row.pid, row);
            descendants.push(row);
          }
        observations.push({ stage, self: selfIdentity, descendants });
      });
    },
    assertStopped() {
      const okay = checked('after-SDK-teardown', (rows) => {
        const present = [];
        for (const expected of captured.values()) {
          const actual = identityCurrent(rows, expected);
          if (actual)
            present.push({ expected, actual, reparented: actual.parent !== expected.parent });
        }
        observations.push({ stage: 'after-SDK-teardown', present });
        assert.equal(
          present.length,
          0,
          'captured descendant still present after SDK teardown: ' + JSON.stringify(present),
        );
      });
      stopped = okay;
      return okay;
    },
    proof() {
      return {
        self: selfIdentity ?? { pid: self },
        captured: [...captured.values()],
        observations,
        unknown: [...unknown],
        stopped,
      };
    },
  };
}

export function sdkProcessGuardSelfTest() {
  const stamp = 'Thu Oct 29 12:00:00 2026';
  const own = `100 1 S ${stamp}`;
  const child = `200 100 S+ ${stamp}`;
  const grandchild = `300 200 R ${stamp}`;
  const fake = (values) =>
    sdkProcessGuard(100, () => {
      const value = values.shift();
      if (value instanceof Error) throw value;
      assert.notEqual(value, undefined, 'fake observation exhausted');
      return value;
    });
  assert.deepEqual(parseSdkProcessTable(own + '\n' + child, 100)[1], {
    pid: 200,
    parent: 100,
    state: 'S+',
    started: stamp,
  });
  for (const value of [
    '',
    'PID PPID STAT STARTED',
    child,
    own + '\n' + own,
    '100 -1 S ' + stamp,
    '100 1 invalid ' + stamp,
    '100 1 S not-a-start-time',
  ])
    assert.throws(() => parseSdkProcessTable(value, 100));
  const gone = fake([own + '\n' + child, own + '\n' + child + '\n' + grandchild, own]);
  assert.equal(gone.capture('after-env-acquire'), true);
  assert.equal(gone.capture('before-SDK-teardown'), true);
  assert.deepEqual(
    gone.proof().captured.map((row) => row.pid),
    [200, 300],
  );
  assert.equal(gone.assertStopped(), true);
  const live = fake([own + '\n' + child, own + '\n' + child, own]);
  live.capture('after-env-acquire');
  assert.equal(live.assertStopped(), false);
  assert.equal(live.assertStopped(), false, 'a later absence must not erase sticky unknown');
  const reparented = fake([own + '\n' + child, own + '\n' + child.replace('200 100', '200 1')]);
  reparented.capture('after-env-acquire');
  assert.equal(reparented.assertStopped(), false);
  assert.equal(reparented.proof().observations.at(-1).present[0].reparented, true);
  const reused = fake([own + '\n' + child, own + '\n' + child.replace('12:00:00', '12:00:01')]);
  reused.capture('after-env-acquire');
  assert.equal(reused.assertStopped(), false);
  assert.match(reused.proof().unknown[0].error, /PID reused/u);
  const reusedBefore = fake([
    own + '\n' + child,
    own + '\n' + child.replace('12:00:00', '12:00:01'),
    own,
  ]);
  reusedBefore.capture('after-env-acquire');
  assert.equal(reusedBefore.capture('before-SDK-teardown'), false);
  assert.equal(reusedBefore.assertStopped(), false);
  const failed = fake([new Error('observer failed'), own]);
  assert.equal(failed.capture('after-env-acquire'), false);
  assert.equal(failed.assertStopped(), false);
  const missingSelf = fake([child, own]);
  assert.equal(missingSelf.capture('after-env-acquire'), false);
  assert.equal(missingSelf.assertStopped(), false);
  return {
    status: 'PASS',
    scope: 'pure PS parser/captured identity guard',
    realObservers: 0,
    cases: 8,
  };
}
