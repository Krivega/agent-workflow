import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import { sourceCheckouts } from './sourceCheckouts.mjs';
import {
  snapshotGameSource,
  readGameSource,
  copyGameSource,
  gameSourceRoots,
} from './full-game-source.mjs';
import { bindGameRuntime, readGameSnapshotInput } from './full-game-release.mjs';
import { consumerLock, checkPackageFiles } from './pinned-consumers.mjs';
import {
  digest,
  gameOwner,
  gameConsumers,
  gameDependencies,
  gameBaseline,
  gameValidation,
  injectGameDefect,
  neutralApproved,
  neutralBefore,
  fullRunPlan,
} from '../../examples/temporal-consumers/full/spec.mjs';
import { saveInventory } from '../../examples/temporal-consumers/full/inventories.mjs';
import {
  copyPinnedBinary,
  verifyPinnedBinary,
  ownProcess,
  mayRemoveFullRun,
} from '../../examples/temporal-consumers/full/safety.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function gameCheckerVerifyCommand(deniedSources, yarn) {
  assert.ok(yarn.startsWith('/'));
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', denialPolicy(deniedSources, true), yarn, 'agent-workflow:consumer:check'],
  };
}
export function consumerCheckCommands(name, yarn, deniedSources) {
  assert.ok(['game', 'neutral'].includes(name));
  return Object.fromEntries(
    ['baseline', 'validate'].map((kind) => [
      kind,
      {
        executable: '/usr/bin/sandbox-exec',
        args: [
          '-p',
          denialPolicy(deniedSources),
          name === 'game' ? yarn : process.execPath,
          ...(name === 'game'
            ? kind === 'baseline'
              ? gameBaseline
              : gameValidation
            : ['--test', kind === 'baseline' ? 'baseline.test.mjs' : 'total.test.mjs']),
        ],
      },
    ]),
  );
}
export function denialPolicy(roots, offline = false) {
  assert.ok(roots.length > 0);
  for (const root of roots) assert.ok(root.startsWith('/') && !/[\r\n]/u.test(root));
  return (
    '(version 1) (allow default) ' +
    (offline ? '(deny network*) ' : '') +
    roots.map((root) => `(deny file-read* (subpath ${JSON.stringify(root)}))`).join(' ')
  );
}
export function parseFullRequest(raw) {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  const neutral = Object.hasOwn(raw, 'consumer');
  if (neutral) assert.equal(raw.consumer, 'neutral');
  assert.deepEqual(
    Object.keys(raw).sort(),
    [
      'archive',
      'archiveSha256',
      'evidence',
      'schemaVersion',
      'temporalBinary',
      'temporalBinarySha256',
      ...(neutral ? ['consumer'] : ['gameSource']),
    ].sort(),
  );
  assert.equal(raw.schemaVersion, 2, 'installed consumer request version 2 required');
  const absolute = (value) => {
    assert.ok(
      typeof value === 'string' &&
        value.startsWith('/') &&
        resolve(value) === value &&
        !/[\r\n\0]/u.test(value),
      'canonical absolute path required',
    );
  };
  for (const name of ['archive', 'evidence', 'temporalBinary']) absolute(raw[name]);
  for (const name of ['archiveSha256', 'temporalBinarySha256'])
    assert.match(raw[name], /^[a-f0-9]{64}$/u);
  if (!neutral) {
    const binding = raw.gameSource;
    assert.ok(binding && typeof binding === 'object' && !Array.isArray(binding));
    assert.deepEqual(Object.keys(binding).sort(), ['root', 'snapshot']);
    absolute(binding.root);
    const pin = binding.snapshot;
    assert.ok(pin && typeof pin === 'object' && !Array.isArray(pin));
    assert.deepEqual(Object.keys(pin).sort(), ['bytes', 'path', 'sha256']);
    absolute(pin.path);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      Number.isSafeInteger(pin.bytes) && pin.bytes > 0,
      'source snapshot byte pin required',
    );
  }
  return raw;
}
export function installedFullConsumerPlan(raw) {
  const plan = fullRunPlan();
  if (raw === undefined) return plan;
  parseFullRequest(raw);
  if (raw.consumer === undefined) return { ...plan, request: raw };
  return {
    ...plan,
    kind: 'installed-neutral-consumer-plan',
    scope: 'neutral-only',
    partialScope: true,
    request: raw,
    consumers: ['neutral'],
    offlineInstalls: 1,
    sdkExecutions: 1,
    game: null,
    services: {
      temporal: 'one temporary CLI v1.9.1 instance',
      checker: 'one temporary Unix socket service with fixed process queries',
    },
    bounds: { ...plan.bounds, gameValidateRuns: 0, deadlineMinutes: 10 },
    isolation:
      'runtime/driver/workers cannot read source checkouts or the trusted neutral checker copy; checker reads its own pinned neutral snapshot',
  };
}
export function mayRemoveInstalledFullRun(report) {
  if (report.request?.consumer === undefined) return mayRemoveFullRun(report);
  return (
    report.request.consumer === 'neutral' &&
    report.scope === 'neutral-only' &&
    report.partialScope === true &&
    report.qualification === false &&
    report.status === 'passed' &&
    report.actualInstalls === 1 &&
    report.consumers.length === 1 &&
    report.consumers[0].name === 'neutral' &&
    report.consumers[0].status === 'done' &&
    report.consumers[0].evidenceComplete === true &&
    report.stops.length > 0 &&
    report.stops.every((item) => item.stopped === true) &&
    report.cleanupErrors.length === 0 &&
    report.listenerStopUnknown !== true
  );
}
export async function runInstalledFullConsumers(raw) {
  const request = parseFullRequest(raw);
  const plan = installedFullConsumerPlan(request);
  const deadline = performance.now() + plan.bounds.deadlineMinutes * 60000;
  const operationDeadline = deadline - 30000;
  const execute = (command, args, options = {}) => {
    const remaining = operationDeadline - performance.now();
    const timeout = Math.floor(Math.min(options.timeout ?? remaining, remaining));
    assert.ok(timeout > 0, 'full consumer setup deadline exceeded');
    return execFileSync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
      timeout,
    });
  };
  assert.equal(process.platform, 'darwin');
  assert.equal(existsSync(request.evidence), false);
  assert.equal(digest(readFileSync(request.archive)), request.archiveSha256);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-installed-full-')));
  mkdirSync(request.evidence, { recursive: true });
  const report = {
    ...plan,
    status: 'preparing',
    request,
    temporaryRoot: root,
    consumers: [],
    actualInstalls: 0,
    modelCalls: 0,
    cleaned: false,
    binaries: [],
    stops: [],
    cleanupErrors: [],
    checkerSources: [],
  };
  const cancellation = new globalThis.AbortController();
  const owned = new Set();
  const cancel = () => {
    cancellation.abort(new Error('Full consumer run interrupted'));
    for (const control of owned) void control.stop();
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const budgetTimer = setTimeout(cancel, Math.max(1, operationDeadline - performance.now()));
  function tracked(command, args, options, listenerPaths = [], timeoutMs = 3600000) {
    cancellation.signal.throwIfAborted();
    assert.ok(
      Math.floor(operationDeadline - performance.now()) > 0,
      'full consumer setup deadline exceeded before spawn',
    );
    const child = spawn(command, args, { ...options, detached: true });
    const control = ownProcess(child, {
      deadline: Math.min(deadline, performance.now() + timeoutMs),
      listenerPaths,
    });
    owned.add(control);
    control.done.then((receipt) => {
      report.stops.push({ command, ...receipt });
    });
    return control;
  }
  async function run(command, args, cwd, log, options = {}) {
    cancellation.signal.throwIfAborted();
    const fd = openSync(log, 'wx', 0o600);
    let control;
    try {
      control = tracked(
        command,
        args,
        { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, ...options.env } },
        [],
        options.timeoutMs,
      );
    } finally {
      closeSync(fd);
    }
    const receipt = await control.done;
    assert.ok(
      receipt.stopped && receipt.code === 0 && !cancellation.signal.aborted,
      `${command}: code=${receipt.code} signal=${receipt.signal}; stop=${receipt.stopped}; log=${log}`,
    );
    return receipt;
  }
  try {
    const temporalBinary = copyPinnedBinary(
      request.temporalBinary,
      request.temporalBinarySha256,
      join(root, 'temporal'),
    );
    assert.match(
      execute(temporalBinary, ['--version'], { encoding: 'utf8' }).trim(),
      /^temporal version 1\.9\.1\b/u,
    );
    const deniedSources = sourceCheckouts(
      [source, ...(request.gameSource ? gameSourceRoots(request.gameSource.root) : [])],
      execute,
    );
    const gameSnapshot = request.gameSource ? readGameSource(request.gameSource, execute) : null;
    if (gameSnapshot) {
      report.gameSource = {
        binding: request.gameSource,
        head: gameSnapshot.head,
        files: gameSnapshot.files.length,
      };
      writeFileSync(
        join(request.evidence, 'game-source.json'),
        JSON.stringify(gameSnapshot, null, 2) + '\n',
      );
    }
    const yarn = realpathSync(execute('/usr/bin/which', ['yarn'], { encoding: 'utf8' }).trim());
    report.binaries = [process.execPath, yarn, temporalBinary].map((path) => ({
      path,
      sha256: digest(readFileSync(path)),
    }));
    cpSync(request.archive, join(root, 'runtime.tgz'));
    assert.equal(
      digest(readFileSync(join(root, 'runtime.tgz'))),
      request.archiveSha256,
      'copied runtime archive changed',
    );
    const entries = execute('/usr/bin/tar', ['-tzf', join(root, 'runtime.tgz')], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    const npmArchive = !entries.includes('package/yarn.lock');
    checkPackageFiles(entries, { npmArchive });
    const metadata = JSON.parse(
      execute('/usr/bin/tar', ['-xOf', join(root, 'runtime.tgz'), 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    const { createHash } = await import('node:crypto');
    const lock = consumerLock(
      npmArchive
        ? readGameSnapshotInput(gameSnapshot, 'yarn.lock').bytes.toString('utf8')
        : execute('/usr/bin/tar', ['-xOf', join(root, 'runtime.tgz'), 'package/yarn.lock'], {
            encoding: 'utf8',
          }),
      metadata,
      createHash('sha1').update(readFileSync(request.archive)).digest('hex'),
    );
    writeFileSync(
      join(request.evidence, 'package.json'),
      JSON.stringify(
        { name: metadata.name, version: metadata.version, sha256: request.archiveSha256 },
        null,
        2,
      ),
    );
    cpSync(join(source, 'examples/temporal-consumers/full'), join(root, 'support'), {
      recursive: true,
    });
    report.support = saveInventory(
      join(root, 'support'),
      join(request.evidence, 'support-inventory.json'),
    );
    for (const name of plan.consumers) {
      cancellation.signal.throwIfAborted();
      const evidence = join(request.evidence, name),
        checker = join(root, 'checker-' + name),
        driver = join(root, name);
      mkdirSync(evidence);
      mkdirSync(driver);
      let release = null;
      let checkerPreparation = null;
      if (name === 'game') {
        copyGameSource(request.gameSource, checker, execute);
        release = bindGameRuntime(checker, join(root, 'runtime.tgz'), metadata, execute);
        assert.equal(
          release.archive.sha256,
          request.archiveSha256,
          'checker runtime differs from driver archive',
        );
        report.checkerSources.push({ consumer: name, head: gameSnapshot.head, release });
        writeFileSync(
          join(evidence, 'runtime-binding.json'),
          JSON.stringify(release, null, 2) + '\n',
        );
        await run(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            denialPolicy(deniedSources, true),
            yarn,
            'install',
            '--frozen-lockfile',
            '--offline',
            '--non-interactive',
            '--ignore-scripts',
          ],
          checker,
          join(evidence, 'game-install.log'),
        );
        report.actualInstalls++;
        const command = gameCheckerVerifyCommand(deniedSources, yarn);
        const stopIndex = report.stops.length;
        checkerPreparation = {
          command,
          log: join(evidence, 'game-consumer-check.log'),
          status: 'running',
          stop: null,
        };
        const savePreparation = () =>
          writeFileSync(
            join(evidence, 'checker-preparation.json'),
            JSON.stringify(
              { head: gameSnapshot.head, release, verification: checkerPreparation },
              null,
              2,
            ) + '\n',
          );
        report.checkerSources.at(-1).preparation = checkerPreparation;
        savePreparation();
        try {
          checkerPreparation.stop = await run(
            command.executable,
            command.args,
            checker,
            checkerPreparation.log,
          );
          checkerPreparation.status = 'passed';
        } finally {
          checkerPreparation.stop ??= report.stops[stopIndex] ?? null;
          if (checkerPreparation.status !== 'passed')
            checkerPreparation.status = 'failed-or-unknown';
          savePreparation();
        }
      } else {
        mkdirSync(checker);
        writeFileSync(join(checker, 'total.mjs'), neutralBefore);
        writeFileSync(
          join(checker, 'baseline.test.mjs'),
          "import {test} from 'node:test';import assert from 'node:assert/strict';import {total} from './total.mjs';test('empty sum',()=>assert.equal(total([]),0));\n",
        );
        writeFileSync(
          join(checker, 'total.test.mjs'),
          "import {test} from 'node:test';import assert from 'node:assert/strict';import {total} from './total.mjs';test('all sums',()=>{assert.equal(total([]),0);assert.equal(total([2,3]),5);assert.equal(total([-2,3]),1);});\n",
        );
      }
      const owner = name === 'game' ? gameOwner : 'total.mjs';
      const approved =
        name === 'game' ? readFileSync(join(checker, owner), 'utf8') : neutralApproved;
      const before = name === 'game' ? injectGameDefect(approved) : neutralBefore;
      const sourceFiles =
        name === 'game'
          ? snapshotGameSource(checker, execute).files.map(({ path }) => path)
          : ['total.mjs', 'baseline.test.mjs', 'total.test.mjs'];
      writeFileSync(
        join(evidence, 'source-snapshot.json'),
        JSON.stringify(
          {
            head: name === 'game' ? gameSnapshot.head : null,
            release,
            preparation: checkerPreparation,
            owner,
            injectedBefore: digest(before),
            approvedAfter: digest(approved),
            files: sourceFiles.map((path) => {
              const bytes = readFileSync(join(checker, path));
              return {
                path,
                sha256: digest(bytes),
                bytes: bytes.length,
                mode: statSync(join(checker, path)).mode & 0o777,
              };
            }),
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(checker, owner), before);
      const copied =
        name === 'game'
          ? [owner, ...gameConsumers, ...gameDependencies]
          : [owner, 'baseline.test.mjs', 'total.test.mjs'];
      const task = join(driver, 'task');
      for (const file of copied) {
        mkdirSync(dirname(join(task, file)), { recursive: true });
        cpSync(join(checker, file), join(task, file));
      }
      const project =
        name === 'game'
          ? {
              ...JSON.parse(
                readFileSync(join(checker, 'tools/agent-workflow/project/temporal.json'), 'utf8'),
              ),
              workspaceId: 'game-installed-copy',
            }
          : {
              schemaVersion: 1,
              projectId: 'installed-neutral',
              workspaceId: 'neutral-copy',
              rules: ['RULES.md'],
              cardRoot: 'work-items',
              roles: [{ id: 'reviewer', profile: 'profiles/reviewer.md' }],
              checks: ['baseline', 'validate'],
            };
      const card = project.cardRoot + '/installed-consumer.md';
      for (const directory of [project.cardRoot, 'profiles', 'approved'])
        mkdirSync(join(task, directory), { recursive: true });
      writeFileSync(join(task, 'approved/owner.txt'), approved);
      writeFileSync(
        join(task, 'RULES.md'),
        'Only the exact approved M1 repair is allowed. Keep every other file unchanged; no model, background work or external publication.\n',
      );
      writeFileSync(
        join(task, 'profiles/reviewer.md'),
        'SDK deterministic review of exact material and primary application validation evidence; this is not native independent acceptance.\n',
      );
      writeFileSync(
        join(task, card),
        `# Installed ${name} task\nRestore the exact pre-injection implementation of ${owner}. All declared checks, exact bytes and confirmed stops are mandatory. The defect exists only in this disposable copy.\n`,
      );
      if (name === 'game') {
        cpSync(join(checker, 'AGENTS.md'), join(task, 'AGENTS.md'));
        for (const role of project.roles) {
          const profile = 'profiles/' + role.id + '.md';
          cpSync(join(checker, role.profile), join(task, profile));
          role.profile = profile;
        }
      }
      writeFileSync(join(task, 'project.json'), JSON.stringify(project));
      mkdirSync(join(driver, 'artifacts'));
      cpSync(join(root, 'support'), driver, { recursive: true });
      writeFileSync(
        join(driver, 'package.json'),
        JSON.stringify({
          name: 'installed-full-' + name,
          private: true,
          type: 'module',
          dependencies: {
            '@krivega/agent-workflow': 'file:../runtime.tgz',
            '@temporalio/testing': '1.25.0',
          },
        }),
      );
      writeFileSync(join(driver, 'yarn.lock'), lock);
      const runtimeDenial = denialPolicy([
        ...deniedSources,
        ...['game', 'neutral'].map((kind) => join(root, 'checker-' + kind)),
      ]);
      const offlinePolicy = denialPolicy([...deniedSources, checker], true);
      await run(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          offlinePolicy,
          yarn,
          'install',
          '--frozen-lockfile',
          '--offline',
          '--non-interactive',
          '--ignore-scripts',
        ],
        driver,
        join(evidence, 'runtime-install.log'),
      );
      report.actualInstalls++;
      assert.equal(digest(readFileSync(join(root, 'runtime.tgz'))), request.archiveSha256);
      assert.equal(readFileSync(join(driver, 'yarn.lock'), 'utf8'), lock);
      const socket = join(root, name + '.sock');
      const checkerConfiguration = {
        socket,
        evidence: join(evidence, 'checks'),
        snapshot: join(evidence, 'source-snapshot.json'),
        consumer: {
          name,
          workspace: checker,
          owner,
          before: digest(before),
          approved: digest(approved),
          commands: consumerCheckCommands(name, yarn, deniedSources),
          env: { PATH: join(driver, 'bin') + delimiter + process.env.PATH },
        },
      };
      writeFileSync(join(evidence, 'checker.json'), JSON.stringify(checkerConfiguration, null, 2));
      writeFileSync(
        join(driver, 'full-consumer.json'),
        JSON.stringify({
          socket,
          owner,
          card,
          approvedSha256: digest(approved),
          links: copied.filter((file) => file !== owner),
          temporalBinary: join(root, 'temporal'),
          temporalBinarySha256: request.temporalBinarySha256,
          packageSha256: request.archiveSha256,
        }),
      );
      mkdirSync(join(driver, 'bin'));
      writeFileSync(join(driver, 'bin/package.json'), '{"type":"commonjs"}');
      writeFileSync(
        join(driver, 'bin/ps'),
        `#!${process.execPath}\n` + readFileSync(join(root, 'support/ps-client.cjs'), 'utf8'),
        { mode: 0o700 },
      );
      // The trusted checker also supplies the fixed /bin/ps observer that macOS disallows under Seatbelt.
      writeFileSync(
        join(evidence, 'inventories-before.json'),
        JSON.stringify(
          {
            driver: saveInventory(driver, join(evidence, 'driver-before.json')),
            checker: saveInventory(checker, join(evidence, 'checker-before.json')),
          },
          null,
          2,
        ),
      );
      const serviceControl = tracked(
        process.execPath,
        [join(root, 'support/check-server.mjs'), join(evidence, 'checker.json')],
        { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
        [socket],
      );
      const service = serviceControl.child;
      let serviceStop;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('trusted checker readiness timeout')),
            30000,
          );
          service.stdout.once('data', () => {
            clearTimeout(timer);
            resolve();
          });
          service.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          service.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('trusted checker exited'));
          });
        });
        for (const forbidden of [
          ...deniedSources.map((path) => join(path, 'package.json')),
          join(checker, owner),
        ]) {
          const deniedControl = tracked(
            '/usr/bin/sandbox-exec',
            ['-p', runtimeDenial, '/bin/cat', forbidden],
            { cwd: driver, stdio: ['ignore', 'ignore', 'pipe'] },
            [],
            30000,
          );
          const denied = deniedControl.child;
          let stderr = '';
          denied.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          const receipt = await deniedControl.done;
          assert.ok(
            receipt.stopped && receipt.code !== 0 && /Operation not permitted/u.test(stderr),
            'source denial failed: ' + forbidden,
          );
        }
        verifyPinnedBinary(temporalBinary, request.temporalBinarySha256);
        await run(
          '/usr/bin/sandbox-exec',
          ['-p', runtimeDenial, process.execPath, 'sdk-run.mjs'],
          driver,
          join(evidence, 'sdk.log'),
          { env: { PATH: join(driver, 'bin') + delimiter + process.env.PATH } },
        );
        assert.equal(digest(readFileSync(join(root, 'runtime.tgz'))), request.archiveSha256);
        report.consumers.push({
          name,
          status: 'done',
          sourceReadDenied: true,
          trustedCheckerHasOwnSource: name === 'game',
          modelCalls: 0,
          qualification: false,
          evidenceComplete: false,
        });
      } finally {
        serviceStop = await serviceControl.stop();
        if (!serviceStop.stopped)
          report.cleanupErrors.push({ consumer: name, checkerStop: serviceStop });
        try {
          writeFileSync(
            join(evidence, 'inventories-after.json'),
            JSON.stringify(
              {
                driver: saveInventory(driver, join(evidence, 'driver-after.json')),
                checker: saveInventory(checker, join(evidence, 'checker-after.json')),
              },
              null,
              2,
            ),
          );
          for (const file of [
            'result.json',
            'recovery.json',
            'failure.json',
            'history-export-error.json',
            'stop.json',
            'histories',
            'artifacts',
            'host',
            'temporal.sqlite',
            'task',
            'full-consumer.json',
          ])
            if (existsSync(join(driver, file)))
              cpSync(join(driver, file), join(evidence, file), { recursive: true });
          writeFileSync(
            join(evidence, 'source-after.json'),
            JSON.stringify(
              sourceFiles.map((path) => {
                const bytes = readFileSync(join(checker, path));
                return {
                  path,
                  sha256: digest(bytes),
                  bytes: bytes.length,
                  mode: statSync(join(checker, path)).mode & 0o777,
                };
              }),
              null,
              2,
            ),
          );
          const stopped = join(driver, 'stop.json');
          if (
            !existsSync(stopped) ||
            JSON.parse(readFileSync(stopped, 'utf8')).listenerClosed !== true
          )
            report.listenerStopUnknown = true;
          const entry = report.consumers.find((item) => item.name === name);
          if (entry) {
            const required = [
              'result.json',
              'recovery.json',
              'stop.json',
              'histories',
              'artifacts',
              'source-after.json',
              'inventories-before.json',
              'inventories-after.json',
            ];
            assert.ok(
              required.every((file) => existsSync(join(evidence, file))),
              'consumer evidence incomplete',
            );
            const checkRoot = join(evidence, 'checks');
            const checks = readdirSync(checkRoot)
              .sort()
              .map((file) => join(checkRoot, file));
            const expectedChecks = ['baseline', ...project.checks, ...project.checks];
            assert.equal(
              checks.length,
              1 + 2 * project.checks.length,
              'all baseline/candidate/integrated check receipts required',
            );
            for (const [index, directory] of checks.entries()) {
              const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
              assert.equal(receipt.kind, expectedChecks[index], 'check kind/order mismatch');
              assert.equal(
                receipt.sha256,
                digest(index === 0 ? before : approved),
                'check owner hash mismatch',
              );
              assert.deepEqual(
                receipt.command,
                checkerConfiguration.consumer.commands[expectedChecks[index]],
                'check command mismatch',
              );
              assert.ok(
                receipt.code === 0 &&
                  receipt.sourceError === null &&
                  receipt.stopped === true &&
                  receipt.timeout === false,
                'check did not pass and stop',
              );
              assert.ok(existsSync(join(directory, 'full.log')), 'complete check log required');
              if (name === 'game' && receipt.kind === 'validate') {
                assert.ok(
                  statSync(join(directory, 'coverage-lcov.info')).size > 0,
                  'fresh LCOV required',
                );
                assert.ok(
                  readdirSync(directory).some(
                    (file) =>
                      file.startsWith('validation-') &&
                      existsSync(join(directory, file, 'full.log')),
                  ),
                  'canonical root full.log required',
                );
              }
            }
            entry.evidenceComplete = serviceStop.stopped && report.listenerStopUnknown !== true;
          }
        } catch (error) {
          report.cleanupErrors.push({ consumer: name, evidence: String(error) });
        }
      }
      assert.ok(
        serviceStop.stopped && report.cleanupErrors.length === 0,
        'checker stop/evidence incomplete',
      );
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    clearTimeout(budgetTimer);
    await Promise.all([...owned].map((control) => control.stop()));
    let unconfirmed = true;
    try {
      unconfirmed = plan.consumers.some((name) => {
        const checks = join(request.evidence, name, 'checks');
        return (
          existsSync(checks) &&
          readdirSync(checks).some((entry) => {
            const receipt = join(checks, entry, 'receipt.json');
            try {
              return (
                !existsSync(receipt) || JSON.parse(readFileSync(receipt, 'utf8')).stopped !== true
              );
            } catch (error) {
              report.cleanupErrors.push({ receipt, error: String(error) });
              return true;
            }
          })
        );
      });
    } catch (error) {
      report.cleanupErrors.push({ checkReceipts: String(error) });
    }
    report.cleanupBlocked = !mayRemoveInstalledFullRun(report) || unconfirmed;
    if (report.cleanupBlocked && report.status === 'passed') {
      report.status = 'failed';
      report.error = 'Cleanup retained the temporary root because a process stop is unconfirmed';
    }
    const saveReport = () => {
      try {
        writeFileSync(
          join(request.evidence, 'report.json'),
          JSON.stringify(report, null, 2) + '\n',
        );
      } catch (error) {
        report.cleanupErrors.push({ reportExport: String(error) });
        report.status = 'failed';
        report.error ??= String(error);
        report.cleanupBlocked = true;
      }
    };
    saveReport();
    if (!report.cleanupBlocked) {
      try {
        rmSync(root, { recursive: true });
      } catch (error) {
        report.status = 'failed';
        report.error ??= String(error);
        report.cleanupBlocked = true;
        report.cleanupErrors.push({ remove: String(error) });
      }
    }
    report.cleaned = !existsSync(root);
    saveReport();
  }
  assert.equal(report.status, 'passed', report.error);
  console.log(
    JSON.stringify({
      status: report.status,
      evidence: request.evidence,
      qualification: false,
      ...(request.consumer === 'neutral' ? { scope: 'neutral-only', partialScope: true } : {}),
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--plan') {
    assert.ok(process.argv.length === 3 || process.argv.length === 4);
    const plan = installedFullConsumerPlan(
      process.argv[3] === undefined ? undefined : JSON.parse(readFileSync(process.argv[3], 'utf8')),
    );
    console.log(JSON.stringify(plan, null, 2));
  } else if (process.argv[2] === '--snapshot') {
    assert.equal(process.argv.length, 4);
    console.log(JSON.stringify(snapshotGameSource(resolve(process.argv[3])), null, 2));
  } else {
    assert.equal(
      process.argv[2],
      '--run',
      'Use --snapshot GAME_ROOT, --plan [REQUEST.json] or --run REQUEST.json; run requires separate authorization',
    );
    assert.equal(process.argv.length, 4);
    await runInstalledFullConsumers(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  }
}
