import { copyValidationCheckout, sourceCheckouts } from './sourceCheckouts.mjs';
import './full-process-guard.test.mjs';
import './full-game-source.test.mjs';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
  realpathSync,
  existsSync,
  linkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inventory, checkSource } from '../../examples/temporal-consumers/full/inventories.mjs';
import {
  denialPolicy,
  parseFullRequest,
  runInstalledFullConsumers,
  gameCheckerVerifyCommand,
  consumerCheckCommands,
  installedFullConsumerPlan,
  mayRemoveInstalledFullRun,
} from './installed-full-consumers.mjs';
import {
  copyPinnedBinary,
  ownProcess,
  mayRemoveFullRun,
} from '../../examples/temporal-consumers/full/safety.mjs';
import {
  digest,
  fullRunPlan,
  injectGameDefect,
  validateCheckRequest,
  simulatedReadItems,
} from '../../examples/temporal-consumers/full/spec.mjs';

const gameSource = {
  root: '/source/game',
  snapshot: { path: '/inputs/game-source.json', sha256: 'c'.repeat(64), bytes: 100 },
};

test('plans three installations, two full game validations, no models and explicit recovery limits', () => {
  const plan = fullRunPlan();
  assert.equal(plan.offlineInstalls, 3);
  assert.equal(plan.sdkExecutions, 2);
  assert.equal(plan.bounds.gameValidateRuns, 2);
  assert.deepEqual(plan.game.validate, ['validate:brief']);
  assert.equal(plan.models, 0);
  assert.equal(plan.qualification, false);
  assert.ok(plan.pendingRecovery.includes('not qualified'));
});
test('the actual material and receipt gate retain every game and neutral project check', () => {
  const sdk = readFileSync(
    new URL('../../examples/temporal-consumers/full/sdk-run.mjs', import.meta.url),
    'utf8',
  );
  const materialStart = sdk.indexOf('const material = {');
  const materialEnd = sdk.indexOf('\nwriteFileSync(', materialStart);
  assert.ok(materialStart >= 0 && materialEnd > materialStart);
  const runner = readFileSync(new URL('./installed-full-consumers.mjs', import.meta.url), 'utf8');
  const receiptStart = runner.indexOf("const checkRoot = join(evidence, 'checks');");
  const receiptEnd = runner.indexOf('\n            entry.evidenceComplete =', receiptStart);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
  const receiptGate = runner.slice(receiptStart, receiptEnd);
  for (const [name, checks, receipts] of [
    ['game', ['validate'], 3],
    ['neutral', ['baseline', 'validate'], 5],
  ]) {
    const project = { checks };
    const owner = name + '.mjs';
    const material = runInNewContext(
      sdk.slice(materialStart, materialEnd) + '\nmaterial;',
      {
        project,
        configuration: { owner, links: ['consumer.mjs'] },
        preparation: { card: 'card.md' },
        workspace: '/inert',
        ref: (locator) => ({ locator, hash: digest(locator) }),
        store: { publish: (bytes) => ({ sha256: digest(bytes), bytes: bytes.length }) },
        readFileSync: (path) => {
          assert.equal(path, join('/inert', owner));
          return Buffer.from('before');
        },
        statSync: (path) => {
          assert.equal(path, join('/inert', owner));
          return { mode: 0o100644 };
        },
        join,
      },
      { timeout: 1000 },
    );
    assert.deepEqual(Array.from(material.checks), checks);
    assert.notEqual(material.checks, checks, 'material must own its check list');
    const commands = consumerCheckCommands(name, '/fixed/yarn', ['/source/game', '/source/tool']);
    const kinds =
      name === 'game'
        ? ['baseline', 'validate', 'validate']
        : ['baseline', 'baseline', 'validate', 'baseline', 'validate'];
    const records = kinds.map((kind, index) => ({
      code: 0,
      sourceError: null,
      stopped: true,
      timeout: false,
      kind,
      sha256: digest(index === 0 ? 'before' : 'after'),
      command: commands[kind],
    }));
    assert.equal(records.length, receipts);
    const verify = (records) =>
      runInNewContext(
        receiptGate,
        {
          assert,
          project,
          name,
          join,
          digest,
          JSON,
          evidence: '/inert/evidence',
          before: 'before',
          approved: 'after',
          checkerConfiguration: { consumer: { commands } },
          readdirSync: (path) =>
            path === '/inert/evidence/checks'
              ? records.map((_, index) => String(index + 1).padStart(3, '0')).reverse()
              : ['validation-fixture'],
          readFileSync: (path) => JSON.stringify(records[Number(path.split('/').at(-2)) - 1]),
          existsSync: () => true,
          statSync: () => ({ size: 1 }),
        },
        { timeout: 1000 },
      );
    verify(records);
    for (const mutate of [
      (rows) => rows.pop(),
      (rows) => rows.push(rows[0]),
      (rows) => {
        [rows[0], rows[1]] = [rows[1], rows[0]];
      },
      (rows) => {
        rows[1].kind = 'unknown';
      },
      (rows) => {
        rows[0].sha256 = digest('after');
      },
      (rows) => {
        rows[1].sha256 = digest('before');
      },
      (rows) => {
        rows[1].sha256 = digest('unapproved');
      },
      (rows) => {
        rows[1].command.executable = '/unapproved';
      },
      (rows) => {
        rows[1].command.args.push('--unapproved');
      },
      (rows) => {
        rows[1].code = 1;
      },
      (rows) => {
        rows[1].sourceError = 'source changed';
      },
      (rows) => {
        rows[1].stopped = false;
      },
      (rows) => {
        rows[1].timeout = true;
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(records));
      mutate(changed);
      assert.throws(() => verify(changed));
    }
  }
});
test('the actual execute boundary floors fractional budgets and refuses sub-millisecond/exhausted budgets', async () => {
  const nativeExec = childProcess.execFileSync;
  for (const [consumer, operationBudget] of [
    [undefined, 3570000],
    ['neutral', 570000],
  ])
    for (const remaining of [operationBudget - 219.919417, 0.75, 0, -0.25]) {
      const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-full-timeout-')));
      const archive = join(temporary, 'runtime.tgz');
      const binary = realpathSync('/usr/bin/true');
      writeFileSync(archive, 'pre-version boundary fixture; never installed');
      const request = {
        archive,
        archiveSha256: digest(readFileSync(archive)),
        schemaVersion: 2,
        ...(consumer === undefined ? { gameSource } : {}),
        evidence: join(temporary, 'evidence'),
        temporalBinary: binary,
        temporalBinarySha256: digest(readFileSync(binary)),
        ...(consumer === undefined ? {} : { consumer }),
      };
      const previousConsumerRoot = process.env.AGENT_WORKFLOW_CONSUMER_ROOT;
      process.env.AGENT_WORKFLOW_CONSUMER_ROOT = temporary;
      let clockCalls = 0;
      const calls = [];
      const clock = mock.method(performance, 'now', () =>
        ++clockCalls <= 2 ? 0 : operationBudget - remaining,
      );
      const executor = mock.method(childProcess, 'execFileSync', (...args) => {
        calls.push(args);
        return nativeExec('/usr/bin/true', [], args[2]);
      });
      syncBuiltinESMExports();
      try {
        if (process.platform !== 'darwin') {
          await assert.rejects(runInstalledFullConsumers(request), {
            code: 'ERR_ASSERTION',
            actual: process.platform,
            expected: 'darwin',
          });
          assert.equal(calls.length, 0);
          assert.equal(existsSync(request.evidence), false);
          continue;
        }
        await assert.rejects(runInstalledFullConsumers(request));
        const report = JSON.parse(readFileSync(join(request.evidence, 'report.json'), 'utf8'));
        assert.equal(report.actualInstalls, 0);
        assert.deepEqual(report.consumers, []);
        assert.deepEqual(report.stops, []);
        if (remaining >= 1) {
          assert.equal(calls.length, 1);
          assert.equal(calls[0][2].timeout, Math.floor(remaining));
          assert.match(report.error, /temporal version/u);
          assert.doesNotMatch(report.error, /ERR_OUT_OF_RANGE/u);
        } else {
          assert.equal(calls.length, 0, 'exhausted integer budget must never call native exec');
          assert.match(report.error, /setup deadline exceeded/u);
        }
        assert.equal(report.bounds.deadlineMinutes, consumer === 'neutral' ? 10 : 60);
        rmSync(report.temporaryRoot, { recursive: true });
      } finally {
        if (previousConsumerRoot === undefined) delete process.env.AGENT_WORKFLOW_CONSUMER_ROOT;
        else process.env.AGENT_WORKFLOW_CONSUMER_ROOT = previousConsumerRoot;
        executor.mock.restore();
        syncBuiltinESMExports();
        clock.mock.restore();
        rmSync(temporary, { recursive: true, force: true });
      }
    }
});
test('changes only the single controlled game defect and rejects a drifted fixture', () => {
  const source =
    'caseResults: results.flatMap((result) => result.caseResults),\nbattleResults: results.flatMap((result) => result.battleResults),';
  assert.equal(
    injectGameDefect(source),
    'caseResults: [],\nbattleResults: results.flatMap((result) => result.battleResults),',
  );
  assert.throws(() => injectGameDefect('changed'));
  assert.throws(() => injectGameDefect(source + source));
});
test('exhausted synchronous preparation and cancellation prevent every later child spawn', () => {
  const runner = readFileSync(new URL('./installed-full-consumers.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('  function tracked(');
  const end = runner.indexOf('  async function run(', start);
  assert.ok(start >= 0 && end > start);
  for (const [remaining, aborted] of [
    [100, false],
    [0.75, false],
    [0, false],
    [-1, false],
    [100, true],
  ]) {
    let spawns = 0;
    const control = { done: { then() {} } };
    const execute = () =>
      runInNewContext(
        runner.slice(start, end) + '\ntracked("/inert", [], {});',
        {
          assert,
          cancellation: {
            signal: {
              throwIfAborted() {
                if (aborted) throw new Error('cancelled');
              },
            },
          },
          operationDeadline: 1000,
          deadline: 1030,
          performance: { now: () => 1000 - remaining },
          spawn: () => {
            spawns++;
            return {};
          },
          ownProcess: () => control,
          owned: new Set(),
          report: { stops: [] },
        },
        { timeout: 1000 },
      );
    if (aborted || remaining < 1) {
      assert.throws(execute, aborted ? /cancelled/u : /deadline exceeded before spawn/u);
      assert.equal(spawns, 0);
    } else {
      assert.equal(execute(), control);
      assert.equal(spawns, 1);
    }
  }
});
test('verifies the installed consumer under source and network denial without building tool source', () => {
  const yarn = '/host/yarn.js';
  const command = gameCheckerVerifyCommand(['/source/integration', '/source/main'], yarn);
  assert.equal(command.executable, '/usr/bin/sandbox-exec');
  assert.deepEqual(command.args.slice(2), [yarn, 'agent-workflow:consumer:check']);
  assert.ok(command.args[1].includes('(deny network*)'));
  for (const path of ['/source/integration', '/source/main'])
    assert.ok(command.args[1].includes('(subpath ' + JSON.stringify(path) + ')'));
  assert.throws(() => gameCheckerVerifyCommand([], yarn));
  assert.throws(() => gameCheckerVerifyCommand(['/source'], 'relative'));
});
test('both projects keep exact checks behind the original-source read denial', () => {
  for (const name of ['game', 'neutral']) {
    const commands = consumerCheckCommands(name, '/fixed/yarn', ['/source/game', '/source/tool']);
    assert.deepEqual(Object.keys(commands), ['baseline', 'validate']);
    for (const [kind, command] of Object.entries(commands)) {
      assert.equal(command.executable, '/usr/bin/sandbox-exec');
      assert.equal(command.args[0], '-p');
      for (const root of ['/source/game', '/source/tool'])
        assert.ok(
          command.args[1].includes('(deny file-read* (subpath ' + JSON.stringify(root) + '))'),
        );
      assert.deepEqual(
        command.args.slice(2),
        name === 'game'
          ? ['/fixed/yarn', ...fullRunPlan().game[kind]]
          : [
              process.execPath,
              '--test',
              kind === 'baseline' ? 'baseline.test.mjs' : 'total.test.mjs',
            ],
      );
    }
  }
  assert.throws(() => consumerCheckCommands('unknown', '/fixed/yarn', ['/source']));
});

test('the trusted checker accepts exact approved bytes, never arbitrary commands or paths', () => {
  const configuration = { before: digest('before'), approved: digest('after') };
  const request = {
    kind: 'validate',
    sha256: digest('after'),
    bytes: Buffer.from('after').toString('base64'),
  };
  assert.equal(validateCheckRequest(request, configuration).toString(), 'after');
  assert.throws(() => validateCheckRequest({ ...request, path: '/outside' }, configuration));
  assert.throws(() => validateCheckRequest({ ...request, kind: 'shell' }, configuration));
  assert.throws(() =>
    validateCheckRequest(
      { ...request, bytes: Buffer.from('unapproved').toString('base64') },
      configuration,
    ),
  );
  assert.equal(
    validateCheckRequest({ ...request, kind: 'baseline' }, configuration).toString(),
    'after',
  );
  for (const kind of ['baseline', 'validate'])
    for (const content of ['before', 'after', 'unapproved']) {
      const candidate = {
        kind,
        sha256: digest(content),
        bytes: Buffer.from(content).toString('base64'),
      };
      if (content === 'after' || (kind === 'baseline' && content === 'before'))
        assert.equal(validateCheckRequest(candidate, configuration).toString(), content);
      else assert.throws(() => validateCheckRequest(candidate, configuration));
    }
  assert.throws(() =>
    validateCheckRequest({ ...request, bytes: request.bytes + '\n' }, configuration),
  );
});
test('keeps source denial and validates the exact unstarted run request', () => {
  const raw = {
    archive: '/tmp/runtime.tgz',
    archiveSha256: 'a'.repeat(64),
    schemaVersion: 2,
    gameSource,
    evidence: '/tmp/new-evidence',
    temporalBinary: '/tmp/temporal',
    temporalBinarySha256: 'b'.repeat(64),
  };
  assert.deepEqual(parseFullRequest(raw), raw);
  assert.throws(() => parseFullRequest({ ...raw, schemaVersion: 1 }));
  assert.throws(() => parseFullRequest({ ...raw, base: 'a'.repeat(40) }));
  const { schemaVersion, gameSource: removed, ...legacy } = raw;
  assert.throws(() =>
    parseFullRequest({ ...legacy, base: 'a79757f3d82c648ac8e0a8a459a5be3cd786d0a4' }),
  );
  assert.equal(schemaVersion, 2);
  assert.deepEqual(removed, gameSource);
  for (const pin of [
    null,
    {},
    { ...gameSource.snapshot, bytes: 0 },
    { ...gameSource.snapshot, path: 'relative' },
    { ...gameSource.snapshot, sha256: 'unknown' },
  ])
    assert.throws(() => parseFullRequest({ ...raw, gameSource: { ...gameSource, snapshot: pin } }));
  assert.throws(() => parseFullRequest({ ...raw, extra: true }));
  const policy = denialPolicy(['/source', '/checker/game']);
  assert.ok(policy.includes('(subpath "/source")'));
  assert.ok(policy.includes('(subpath "/checker/game")'));
  assert.ok(denialPolicy(['/source'], true).includes('(deny network*)'));
  assert.throws(() => denialPolicy(['relative']));
});
test('versioned full and neutral plans expose exact inputs without accepting the old request', () => {
  const full = {
    schemaVersion: 2,
    archive: '/tmp/runtime.tgz',
    archiveSha256: 'a'.repeat(64),
    gameSource,
    evidence: '/tmp/new-evidence',
    temporalBinary: '/tmp/temporal',
    temporalBinarySha256: 'b'.repeat(64),
  };
  const { gameSource: _game, ...common } = full;
  assert.deepEqual(_game, gameSource);
  const neutral = { ...common, consumer: 'neutral' };
  assert.deepEqual(parseFullRequest(full), full);
  assert.deepEqual(parseFullRequest(neutral), neutral);
  for (const consumer of ['game', 'full', '', null, undefined, false, ['neutral']])
    assert.throws(() => parseFullRequest({ ...common, consumer }));
  assert.throws(() => parseFullRequest({ ...neutral, gameSource }));
  assert.throws(() => parseFullRequest({ ...neutral, extra: true }));
  assert.throws(() => parseFullRequest(common));
  for (const key of ['archive', 'evidence', 'temporalBinary'])
    assert.throws(() => parseFullRequest({ ...full, [key]: '/tmp/../outside' }));
  assert.deepEqual(installedFullConsumerPlan(), fullRunPlan());
  assert.deepEqual(installedFullConsumerPlan(full), { ...fullRunPlan(), request: full });
  const plan = installedFullConsumerPlan(neutral);
  assert.equal(plan.scope, 'neutral-only');
  assert.equal(plan.partialScope, true);
  assert.deepEqual(plan.request, neutral);
  assert.deepEqual(plan.consumers, ['neutral']);
  assert.equal(plan.offlineInstalls, 1);
  assert.equal(plan.sdkExecutions, 1);
  assert.equal(plan.game, null);
  assert.equal(plan.bounds.gameValidateRuns, 0);
  assert.equal(plan.bounds.deadlineMinutes, 10);
  assert.equal(plan.models, 0);
  assert.equal(plan.qualification, false);
  assert.match(plan.services.temporal, /^one temporary /u);
  assert.match(plan.services.checker, /^one temporary /u);
});

test('the real plan CLI reads only request shape and creates no run or evidence', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-full-plan-')));
  try {
    const request = {
      schemaVersion: 2,
      archive: join(root, 'missing.tgz'),
      archiveSha256: 'a'.repeat(64),
      gameSource,
      evidence: join(root, 'must-not-exist'),
      temporalBinary: join(root, 'missing-binary'),
      temporalBinarySha256: 'b'.repeat(64),
    };
    const file = join(root, 'request.json');
    writeFileSync(file, JSON.stringify(request));
    const before = inventory(root);
    const plan = JSON.parse(
      childProcess.execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./installed-full-consumers.mjs', import.meta.url)), '--plan', file],
        { cwd: root, encoding: 'utf8', timeout: 10000 },
      ),
    );
    assert.deepEqual(plan.request, request);
    assert.equal(plan.offlineInstalls, 3);
    assert.equal(plan.sdkExecutions, 2);
    assert.equal(plan.qualification, false);
    assert.deepEqual(inventory(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrong binary pin, symlink and hardlink fail before the fake version executor can write its marker', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-full-pin-')));
  try {
    const binary = join(temporary, 'binary'),
      marker = join(temporary, 'executed'),
      copy = join(temporary, 'private-copy');
    const bytes = '#!/bin/sh\nprintf "temporal version 1.9.1"\n';
    writeFileSync(binary, bytes, { mode: 0o700 });
    const fakeVersion = () => writeFileSync(marker, 'version side effect');
    assert.throws(() => {
      copyPinnedBinary(binary, '0'.repeat(64), copy);
      fakeVersion();
    }, /binary hash mismatch/u);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(copy), false);
    symlinkSync(binary, join(temporary, 'link'));
    assert.throws(
      () => copyPinnedBinary(join(temporary, 'link'), digest(bytes), copy),
      /realpath/u,
    );
    linkSync(binary, join(temporary, 'hardlink'));
    assert.throws(() => copyPinnedBinary(binary, digest(bytes), copy), /single-link/u);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
function fakeOwned(exitCode, rows, listener = () => false) {
  let elapsed = 0;
  const child = Object.assign(new EventEmitter(), { pid: 911111, exitCode, signalCode: null });
  const signals = [];
  const control = ownProcess(child, {
    deadline: 100,
    stopMs: 20,
    now: () => elapsed,
    snapshot: () => rows(elapsed),
    listeners: listener,
    pause: async (ms) => {
      elapsed += Math.min(ms, 5);
    },
    signal: (pid, name) => signals.push([pid, name]),
  });
  return { child, control, signals, elapsed: () => elapsed };
}
test('process and listener observers floor remaining budgets and reject less than one millisecond', async () => {
  for (const boundary of ['process', 'listener']) {
    for (const remaining of [2500.75, 100.75, 0.75, 0, -0.25]) {
      let elapsed = 0;
      const calls = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 911111,
        exitCode: 0,
        signalCode: null,
      });
      const control = ownProcess(child, {
        deadline: boundary === 'process' ? remaining : 3000,
        now: () => elapsed,
        snapshot: (timeout) => {
          calls.push(['process', timeout]);
          if (boundary === 'listener') elapsed = 3000 - remaining;
          return [];
        },
        listeners: (_pids, _paths, timeout) => {
          calls.push(['listener', timeout]);
          return false;
        },
        signal: () => assert.fail('observer-only fixture must not signal'),
      });
      const receipt = await control.done;
      assert.equal(receipt.stopped, remaining >= 1);
      assert.ok(calls.every(([, timeout]) => Number.isInteger(timeout) && timeout > 0));
      if (remaining >= 1) {
        assert.equal(
          calls.find(([name]) => name === boundary)[1],
          Math.min(2000, Math.floor(remaining)),
        );
      } else {
        assert.equal(
          calls.some(([name]) => name === boundary),
          false,
        );
        assert.match(receipt.reason, /deadline/u);
      }
    }
  }
});
test('an unexited checker reaches its bounded unknown stop instead of waiting forever', async () => {
  const f = fakeOwned(null, () => [{ pid: 911111, ppid: 1, pgid: 911111, identity: 'owned' }]);
  const receipt = await f.control.stop();
  assert.equal(receipt.stopped, false);
  assert.match(receipt.reason, /deadline/u);
  assert.ok(f.elapsed() <= 100);
  assert.equal(f.child.exitCode, null);
  assert.deepEqual(receipt.groups, [911111]);
});
test('code zero waits for its late group and an open listener never counts as stop', async () => {
  const f = fakeOwned(0, (elapsed) =>
    elapsed < 10 ? [{ pid: 911112, ppid: 1, pgid: 911111, identity: 'late group' }] : [],
  );
  const receipt = await f.control.done;
  assert.equal(receipt.stopped, true);
  assert.ok(f.elapsed() >= 10);
  assert.deepEqual(f.signals[0], [-911111, 'SIGTERM']);
  const open = fakeOwned(
    0,
    () => [],
    () => true,
  );
  assert.equal((await open.control.done).stopped, false);
});
test('early failures, incomplete exports and unknown stops keep the working root', () => {
  const report = {
    status: 'passed',
    actualInstalls: 3,
    consumers: [
      { name: 'game', evidenceComplete: true },
      { name: 'neutral', evidenceComplete: true },
    ],
    stops: [{ stopped: true }],
    cleanupErrors: [],
  };
  assert.equal(mayRemoveFullRun(report), true);
  assert.equal(mayRemoveInstalledFullRun(report), true);
  for (const changed of [
    { status: 'failed' },
    { actualInstalls: 0 },
    { consumers: [] },
    { consumers: [{ name: 'game', evidenceComplete: false }, report.consumers[1]] },
    { stops: [{ stopped: false }] },
    { listenerStopUnknown: true },
    { cleanupErrors: ['export failed'] },
  ]) {
    assert.equal(mayRemoveFullRun({ ...report, ...changed }), false);
    assert.equal(mayRemoveInstalledFullRun({ ...report, ...changed }), false);
  }
});
test('neutral cleanup requires its exact partial scope, one install and complete evidence with every stop confirmed', () => {
  const report = {
    request: { consumer: 'neutral' },
    scope: 'neutral-only',
    partialScope: true,
    qualification: false,
    status: 'passed',
    actualInstalls: 1,
    consumers: [{ name: 'neutral', status: 'done', evidenceComplete: true }],
    stops: [{ stopped: true }],
    cleanupErrors: [],
  };
  assert.equal(mayRemoveInstalledFullRun(report), true);
  assert.equal(mayRemoveFullRun(report), false, 'partial proof must never qualify the full keeper');
  for (const changed of [
    { request: {} },
    { request: { consumer: 'game' } },
    { scope: 'full' },
    { partialScope: false },
    { qualification: true },
    { status: 'failed' },
    { status: 'preparing' },
    { actualInstalls: 0 },
    { actualInstalls: 3 },
    { consumers: [] },
    { consumers: [...report.consumers, ...report.consumers] },
    { consumers: [{ name: 'game', status: 'done', evidenceComplete: true }] },
    { consumers: [{ name: 'neutral', status: 'blocked', evidenceComplete: true }] },
    { consumers: [{ name: 'neutral', status: 'done', evidenceComplete: false }] },
    { stops: [] },
    { stops: [{ stopped: false }] },
    { stops: [{ stopped: true }, { stopped: undefined }] },
    { listenerStopUnknown: true },
    { cleanupErrors: ['export failed'] },
  ])
    assert.equal(mayRemoveInstalledFullRun({ ...report, ...changed }), false);
});
test('an exited leader with an unobserved reused PID stays unknown without signalling it', async () => {
  const f = fakeOwned(0, () => [
    { pid: 911111, ppid: 1, pgid: 911111, identity: 'unowned replacement' },
  ]);
  assert.equal((await f.control.done).stopped, false);
  assert.deepEqual(f.signals, []);
});
test('simulated LOAD preserves large escaped Unicode with bounded command fragments', () => {
  const content = 'А🙂"\\\n'.repeat(9000),
    ref = { path: '/copy/source.ts', sha256: digest(content) };
  const parts = simulatedReadItems(ref, content).map((item) => {
    assert.ok(Buffer.byteLength(item.aggregatedOutput) <= 24000);
    return JSON.parse(item.aggregatedOutput);
  });
  assert.equal(parts.map((part) => part.content).join(''), content);
  assert.ok(
    parts.every((part, index) => part.offset === index * 2000 && part.length === content.length),
  );
  assert.throws(() => simulatedReadItems({ ...ref, sha256: '0'.repeat(64) }, content));
  assert.equal(
    JSON.parse(simulatedReadItems({ ...ref, sha256: digest('') }, '')[0].aggregatedOutput).content,
    '',
  );
});
test('inventories do not follow links and source guards allow only the pinned owner overlay', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-full-inventory-')));
  try {
    const root = join(temporary, 'copy');
    mkdirSync(root);
    writeFileSync(join(root, 'owner'), 'before');
    writeFileSync(join(root, 'other'), 'unchanged');
    writeFileSync(join(temporary, 'outside'), 'must not be inventoried through the link');
    symlinkSync(join(temporary, 'outside'), join(root, 'link'));
    const entries = inventory(root);
    assert.deepEqual(
      entries.find((entry) => entry.path === 'link'),
      {
        path: 'link',
        mode: lstatSync(join(root, 'link')).mode & 0o777,
        kind: 'symlink',
        target: join(temporary, 'outside'),
      },
    );
    assert.equal(entries.filter((entry) => entry.kind === 'file').length, 2);
    const snapshot = { files: entries.filter((entry) => entry.kind === 'file') };
    checkSource(root, snapshot, 'owner', digest('before'));
    writeFileSync(join(root, 'owner'), 'after');
    checkSource(root, snapshot, 'owner', digest('after'));
    writeFileSync(join(root, 'other'), 'unapproved');
    assert.throws(() => checkSource(root, snapshot, 'owner', digest('after')));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('isolates both linked worktrees and their main checkouts, preserving the reviewed working files', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-checkouts-')));
  const git = (cwd, ...args) => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    const mains = ['game', 'tool'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'package.json'), '{}');
      writeFileSync(join(dir, '.gitignore'), 'tmp/\n');
      git(dir, 'add', '.');
      git(
        dir,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'initial',
      );
      git(dir, 'worktree', 'add', '-q', '--detach', dir + '-linked');
      return dir;
    });
    const trees = mains.map((dir) => dir + '-linked');
    assert.deepEqual(sourceCheckouts(trees).sort(), [...mains, ...trees].sort());
    const source = trees[1],
      copy = join(root, 'copy');
    writeFileSync(join(source, 'package.json'), '{"private":true}');
    writeFileSync(join(source, 'extra.mjs'), 'export {};');
    mkdirSync(join(source, 'tmp'));
    writeFileSync(join(source, 'tmp', 'state'), 'excluded');
    copyValidationCheckout(source, copy);
    assert.equal(readFileSync(join(copy, 'extra.mjs'), 'utf8'), 'export {};');
    assert.equal(readFileSync(join(copy, 'package.json'), 'utf8'), '{"private":true}');
    assert.equal(existsSync(join(copy, 'tmp')), false);
    assert.equal(git(copy, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
    assert.ok(lstatSync(join(copy, '.git')).isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
