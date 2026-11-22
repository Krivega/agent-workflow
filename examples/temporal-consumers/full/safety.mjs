import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { digest } from './spec.mjs';

export function verifyPinnedBinary(path, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/u);
  assert.equal(realpathSync(path), resolve(path), 'binary realpath changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.nlink === 1 && stat.mode & 0o100,
      'regular single-link executable required',
    );
    const bytes = readFileSync(fd),
      after = lstatSync(path);
    assert.ok(
      after.isFile() && after.nlink === 1 && after.dev === stat.dev && after.ino === stat.ino,
      'binary identity changed',
    );
    assert.equal(digest(bytes), expected, 'binary hash mismatch');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function copyPinnedBinary(path, expected, destination) {
  writeFileSync(destination, verifyPinnedBinary(path, expected), { flag: 'wx', mode: 0o700 });
  verifyPinnedBinary(destination, expected);
  return destination;
}
function processes(timeout) {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout,
  });
  assert.ok(output.trim(), 'process snapshot is empty');
  const rows = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, pgid, identity] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u) ?? [];
      assert.ok(identity, 'process identity unavailable');
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), identity };
    });
  assert.ok(
    rows.some((row) => row.pid === process.pid),
    'process snapshot is missing self',
  );
  return rows;
}
function listening(pids, paths, timeout) {
  for (const args of [
    ...(pids.length ? [['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN']] : []),
    ...paths.map((path) => ['-nP', '-t', path]),
  ]) {
    const result = spawnSync('/usr/sbin/lsof', args, { encoding: 'utf8', timeout });
    if (result.error || ![0, 1].includes(result.status))
      throw new Error('listener observation unknown');
    if (result.status === 0 && result.stdout.trim()) return true;
    if (result.stderr.trim() && !/No such file or directory/u.test(result.stderr))
      throw new Error('listener observation unknown: ' + result.stderr);
  }
  return false;
}

// Both the outer runner and trusted checker retain unknown process handles until explicit review.
export function ownProcess(child, options) {
  const {
    deadline,
    listenerPaths = [],
    now = () => performance.now(),
    snapshot = processes,
    listeners = listening,
    signal = (pid, name) => process.kill(pid, name),
    pause = (ms) => setTimeout(ms),
    stopMs = 10000,
    automaticStopAt = deadline - stopMs,
    termGraceMs,
  } = options;
  const known = [],
    active = new Map(),
    groups = new Set(child.pid ? [child.pid] : []),
    groupHistory = new Set(groups),
    retired = [],
    retiredGroups = [];
  let requested = false,
    stopAt = deadline,
    killAt = null,
    killed = false,
    spawnError = null,
    deadlineReached = false,
    leaderObserved = false,
    leaderRetired = false,
    observation = 0;
  child.once('error', (error) => {
    spawnError = String(error);
  });
  const requestStop = () => {
    requested = true;
    stopAt = Math.min(stopAt, now() + stopMs, deadline);
  };
  const done = (async () => {
    let reason = null;
    try {
      assert.ok(
        termGraceMs === undefined || (Number.isSafeInteger(termGraceMs) && termGraceMs > 0),
        'TERM grace must be a positive safe integer',
      );
      assert.ok(
        Number.isFinite(automaticStopAt) &&
          automaticStopAt >= deadline - stopMs &&
          automaticStopAt < deadline,
        'invalid automatic stop boundary',
      );
      for (;;) {
        if (spawnError) throw new Error(spawnError);
        const remaining = Math.floor(stopAt - now());
        if (remaining <= 0) {
          reason = 'process stop deadline exceeded';
          break;
        }
        const rows = snapshot(Math.min(2000, remaining));
        assert.ok(Array.isArray(rows), 'process snapshot must be a complete array');
        const seen = new Set();
        for (const row of rows) {
          assert.ok(
            row &&
              Number.isSafeInteger(row.pid) &&
              row.pid > 0 &&
              Number.isSafeInteger(row.ppid) &&
              row.ppid >= 0 &&
              Number.isSafeInteger(row.pgid) &&
              row.pgid >= 0 &&
              typeof row.identity === 'string' &&
              row.identity.trim(),
            'process snapshot contains an invalid identity',
          );
          assert.ok(!seen.has(row.pid), 'process snapshot contains a duplicate PID');
          seen.add(row.pid);
        }
        assert.ok(
          !(
            (child.exitCode !== null || child.signalCode !== null) &&
            !leaderObserved &&
            rows.some((row) => row.pid === child.pid)
          ),
          'exited PID appeared before its owned identity was observed',
        );
        for (const row of rows) {
          const prior = active.get(row.pid);
          if (prior) assert.equal(row.identity, prior.identity, 'owned PID identity changed');
        }
        // Validate possible owned descendants before absence can retire their parents.
        const potentiallyOwned = new Set(active.keys());
        if (!leaderRetired && child.pid) potentiallyOwned.add(child.pid);
        let expanded;
        do {
          expanded = false;
          for (const row of rows)
            if (
              potentiallyOwned.has(row.pid) ||
              groups.has(row.pgid) ||
              potentiallyOwned.has(row.ppid)
            ) {
              assert.ok(row.pgid > 0, 'owned process snapshot contains an invalid process group');
              if (!potentiallyOwned.has(row.pid)) {
                potentiallyOwned.add(row.pid);
                expanded = true;
              }
            }
        } while (expanded);
        observation++;
        for (const [pid, prior] of active)
          if (!seen.has(pid)) {
            active.delete(pid);
            retired.push({ ...prior, observation, atMs: now() });
            if (pid === child.pid) leaderRetired = true;
          }
        for (const pgid of groups)
          if (!rows.some((row) => row.pgid === pgid)) {
            groups.delete(pgid);
            retiredGroups.push({ pgid, observation, atMs: now() });
          }
        for (const row of rows) if (active.has(row.pid)) active.set(row.pid, row);
        let changed;
        do {
          changed = false;
          for (const row of rows)
            if (
              (!leaderRetired && row.pid === child.pid) ||
              groups.has(row.pgid) ||
              active.has(row.ppid)
            ) {
              if (!active.has(row.pid)) {
                active.set(row.pid, row);
                known.push({ ...row });
                if (row.pid === child.pid) leaderObserved = true;
                changed = true;
              }
            }
        } while (changed);
        for (const row of active.values())
          if (active.has(row.pgid)) {
            groups.add(row.pgid);
            groupHistory.add(row.pgid);
          }
        const members = rows.filter((row) => active.has(row.pid) || groups.has(row.pgid));
        const exited = child.exitCode !== null || child.signalCode !== null;
        if (exited && members.length === 0) {
          assert.ok(child.pid, 'owned PID unavailable');
          const pids = [...new Set([child.pid, ...[...known.values()].map((row) => row.pid)])];
          const listenerTimeout = Math.floor(Math.min(2000, stopAt - now()));
          assert.ok(listenerTimeout > 0, 'process stop deadline exceeded');
          if (!listeners([], listenerPaths, listenerTimeout))
            return {
              stopped: true,
              code: child.exitCode,
              signal: child.signalCode,
              pids,
              identities: [...known.values()],
              groups: [...groupHistory],
              retired,
              retiredGroups,
              killed,
              deadlineReached,
            };
        }
        if (exited || now() >= automaticStopAt) {
          if (!exited) deadlineReached = true;
          requestStop();
        }
        if (requested) {
          const kill = killAt !== null && now() >= killAt;
          if (killAt === null || (kill && !killed)) {
            const name = kill ? 'SIGKILL' : 'SIGTERM';
            const selfGroup = rows.find((row) => row.pid === process.pid)?.pgid;
            const targets = new Set(
              members.map((row) => (groups.has(row.pgid) ? -row.pgid : row.pid)),
            );
            for (const target of targets) {
              assert.ok(
                Number.isSafeInteger(target) && target !== 0,
                'refuse invalid signal target',
              );
              assert.notEqual(target, process.pid, 'refuse own process');
              assert.notEqual(target, -selfGroup, 'refuse own process group');
              try {
                signal(target, name);
              } catch (error) {
                if (error.code !== 'ESRCH') throw error;
              }
            }
            if (kill) killed = true;
            else {
              const termAt = now();
              killAt =
                termAt +
                (termGraceMs === undefined
                  ? Math.min(1000, stopMs / 2, Math.max(0, (stopAt - termAt) / 2))
                  : Math.min(termGraceMs, stopMs / 2, Math.max(0, (stopAt - termAt) / 2)));
            }
          }
        }
        await pause(Math.min(50, Math.max(1, stopAt - now())));
      }
    } catch (error) {
      reason = String(error);
    }
    return {
      stopped: false,
      code: child.exitCode,
      signal: child.signalCode,
      pids: [...new Set([...known.values()].map((row) => row.pid))],
      identities: [...known.values()],
      groups: [...groupHistory],
      retired,
      retiredGroups,
      reason,
      deadlineReached,
    };
  })();
  return {
    child,
    done,
    stop() {
      requestStop();
      return done;
    },
  };
}

export function mayRemoveFullRun(report) {
  return (
    report.status === 'passed' &&
    report.actualInstalls === 3 &&
    report.consumers.length === 2 &&
    new Set(report.consumers.map((item) => item.name)).size === 2 &&
    report.consumers.every((item) => ['game', 'neutral'].includes(item.name)) &&
    report.consumers.every((item) => item.evidenceComplete === true) &&
    report.stops.length > 0 &&
    report.stops.every((item) => item.stopped === true) &&
    report.cleanupErrors.length === 0 &&
    report.listenerStopUnknown !== true
  );
}
