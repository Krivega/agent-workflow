import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPackageClosure } from './temporal/packageClosure.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

function checkPackagedWorker(root, temporary, run) {
  const worker = join(root, 'examples/temporal-host/worker.mjs');
  const route = { address: '127.0.0.1:7233', namespace: 'host-test', taskQueue: 'tasks' };
  const registration = {
    schemaVersion: 1,
    ...route,
    registration: {
      project: JSON.parse(readFileSync(join(root, 'examples/neutral/project.json'), 'utf8')),
      hostId: 'host',
      owner: 'owner',
      generation: 1,
      workspaceRoot: temporary,
      artifactRoot: join(temporary, 'artifacts'),
      commands: {},
      taskBackend: 'required',
    },
  };
  const file = join(temporary, 'worker-registration.json');
  const save = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(file, registration);
  const config = {
    codexBinary: join(temporary, 'codex'),
    codexHome: temporary,
    disabledServers: [],
    profile: { model: 'test', effort: 'medium', clientVersion: '0.171.0-alpha.13' },
    maxTurnStarts: 0,
    projects: [{ file, threadId: 'issuer' }],
  };
  save(join(temporary, 'worker.json'), config);
  assert.deepEqual(JSON.parse(run(process.execPath, [worker, '--check', temporary])), {
    ...route,
    queues: ['tasks', 'tasks.control'],
    projects: 1,
  });
  const writerAccount = join(temporary, 'writer-account.json');
  const inventory = join(temporary, 'writer-inventory.json');
  writeFileSync(
    config.codexBinary,
    `#!${process.execPath}
if (process.argv[2] === '--version') {
  console.log('codex-cli 0.171.0-alpha.13.2');
} else {
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  assert.equal(path.dirname(process.cwd()), ${JSON.stringify(join(temporary, 'artifacts', 'copies'))});
  assert.equal(process.env.CODEX_HOME, ${JSON.stringify(config.codexHome)});
  assert.deepEqual(process.argv.slice(-2), ['app-server', '--stdio']);
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialized') return;
    let result;
    if (method === 'initialize') result = {};
    else if (method === 'account/read') {
      assert.deepEqual(params, { refreshToken: false });
      result = JSON.parse(fs.readFileSync(${JSON.stringify(writerAccount)}));
    } else if (method === 'mcpServerStatus/list') {
      assert.deepEqual(params, { limit: 100, detail: 'toolsAndAuthOnly' });
      result = JSON.parse(fs.readFileSync(${JSON.stringify(inventory)}));
    } else throw Error('unexpected RPC ' + method);
    console.log(JSON.stringify({ id, result }));
  });
}
`,
    { mode: 0o700 },
  );
  save(writerAccount, { requiresOpenaiAuth: true, account: null });
  for (const action of ['--check-writer', '--run']) {
    const denied = spawnSync(process.execPath, [worker, action, temporary], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /Writer login unavailable/u);
  }
  save(writerAccount, { requiresOpenaiAuth: true, account: { type: 'chatgpt' } });
  save(inventory, { data: [], nextCursor: 'more' });
  const partial = spawnSync(process.execPath, [worker, '--check-writer', temporary], {
    encoding: 'utf8',
  });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /task-tools-inventory-unknown/u);
  save(inventory, { data: [], nextCursor: null });
  assert.deepEqual(JSON.parse(run(process.execPath, [worker, '--check-writer', temporary])), {
    writerPreflight: 'passed',
    projects: 1,
  });
  assert.deepEqual(readdirSync(join(temporary, 'artifacts', 'copies')), []);
  for (const clientVersion of ['0.169.1', '0.171.0-alpha.13.1']) {
    save(join(temporary, 'worker.json'), {
      ...config,
      profile: { ...config.profile, clientVersion },
    });
    const incompatible = spawnSync(process.execPath, [worker, '--check-writer', temporary], {
      encoding: 'utf8',
    });
    assert.equal(incompatible.status, 1);
    assert.ok(
      incompatible.stderr.includes(
        `Expected Codex CLI ${clientVersion}, got codex-cli 0.171.0-alpha.13.2`,
      ),
    );
  }
  save(join(temporary, 'worker.json'), config);
  if (process.platform === 'darwin') {
    const plist = run(process.execPath, [worker, '--plist', temporary]);
    const parsed = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
        input: plist,
      }),
    );
    assert.deepEqual(parsed.ProgramArguments, [process.execPath, worker, '--run', temporary]);
    assert.equal(parsed.WorkingDirectory, temporary);
  }
  const second = join(temporary, 'second.json');
  save(second, { ...registration, namespace: 'other' });
  config.projects.push({ file: second, threadId: 'issuer' });
  save(join(temporary, 'worker.json'), config);
  const mismatch = spawnSync(process.execPath, [worker, '--check', temporary], {
    encoding: 'utf8',
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Project routes must match/u);
}

test('actual package keeps CLI, SDK and versioned instructions without development payloads', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-package-supply-')));
  const run = (file, args, cwd = temporary) =>
    execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    const original = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
    for (const hook of ['prepack', 'postpack', 'prepare'])
      assert.equal(original.scripts[hook], undefined);
    const [packed] = JSON.parse(
      run(
        'npm',
        ['pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', temporary],
        repository,
      ),
    );
    const archive = join(temporary, packed.filename);
    const entries = run('/usr/bin/tar', ['-tzf', archive]).trim().split('\n');
    for (const entry of entries) {
      assert.doesNotMatch(
        entry,
        /\.(?:test|integration\.test)\.ts$|\.map$|__pycache__|\.DS_Store/u,
      );
      assert.doesNotMatch(
        entry,
        /^package\/(?:comparison|examples\/temporal-consumers|src\/(?:client|workflows|worker))\//u,
      );
      assert.doesNotMatch(entry, /^package\/harness2\/(?!README\.md$)/u);
    }
    for (const testOnly of [
      'cli/storageWorker.ts',
      'adapters/storage/processEvidenceStore.ts',
      'cli/legacyTaskChatCommand.ts',
      'cli/main.ts',
      'cli/harness2-entry.mjs',
      'tests/fixtures/qualification/suite.json',
    ])
      assert.ok(
        !entries.includes('package/' + testOnly),
        'unexpected storage process: ' + testOnly,
      );
    const bytes = readFileSync(archive);
    const closure = checkPackageClosure({
      schemaVersion: 1,
      npmIntegrity: packed.integrity,
      archive: {
        path: archive,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      },
      additionalRoots: [],
      trustedAssets: [],
    });
    assert.deepEqual(closure.errors, []);
    for (const entry of entries.filter((name) =>
      /^package\/(?:src|application|adapters\/storage)\/.*\.ts$/u.test(name),
    ))
      assert.ok(closure.reachable.includes(entry), 'unreachable runtime source: ' + entry);
    run('/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
    const root = join(temporary, 'package');
    // Check file contents as well as names: a public guide can acquire a machine-local path.
    for (const entry of entries) {
      const path = join(temporary, entry);
      if (entry.endsWith('/')) continue;
      assert.doesNotMatch(
        readFileSync(path, 'utf8'),
        /(?:^|[^a-z0-9])(?:\/(?:Users|home)\/[^/\s]+\/|\/(?:private\/)?var\/folders\/|[A-Z]:[\\/]+Users[\\/])/iu,
        entry,
      );
    }
    for (const directory of ['.agents/skills', 'procedures', 'roles']) {
      for (const file of readdirSync(join(repository, directory), { recursive: true })) {
        if (!/\.(?:md|yaml)$/u.test(file)) continue;
        assert.deepEqual(
          readFileSync(join(root, directory, file)),
          readFileSync(join(repository, directory, file)),
        );
      }
    }
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(metadata.exports, original.exports);
    assert.deepEqual(metadata.bin, original.bin);
    assert.deepEqual(metadata.dependencies, original.dependencies);
    const descriptor = JSON.parse(readFileSync(join(root, 'project/workflow.json'), 'utf8'));
    for (const procedure of descriptor.procedures) {
      const content = readFileSync(join(root, procedure.locator));
      assert.equal(createHash('sha256').update(content).digest('hex'), procedure.hash);
    }
    // Reuse declared local dependencies; this checks extracted files without an installation or server.
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    const cli = join(root, metadata.bin['agent-workflow']);
    assert.match(run(process.execPath, [cli, '--help'], root), /Использование: agent-workflow/u);

    checkPackagedWorker(root, temporary, run);

    const setup = join(temporary, 'setup');
    mkdirSync(join(setup, 'node_modules/@krivega'), { recursive: true });
    symlinkSync(root, join(setup, 'node_modules/@krivega/agent-workflow'), 'dir');
    writeFileSync(
      join(setup, 'package.json'),
      JSON.stringify({ name: '@example/neutral', scripts: { validate: 'node checks.mjs' } }),
    );
    const missing = () =>
      spawnSync(process.execPath, [cli, 'doctor'], { cwd: setup, encoding: 'utf8' });
    assert.equal(missing().status, 1);
    assert.deepEqual(readdirSync(setup).sort(), ['node_modules', 'package.json']);
    const created = JSON.parse(run(process.execPath, [cli, 'init'], setup));
    assert.equal(created.projectId, 'neutral');
    assert.equal(created.version, metadata.version);
    const skillPath = join(setup, created.skill);
    const currentSkill = readFileSync(skillPath, 'utf8');
    assert.ok(currentSkill.includes('@krivega/agent-workflow'));
    const previousSkill = currentSkill.replaceAll(
      '@krivega/agent-workflow',
      '@agent-workflow/runtime',
    );
    writeFileSync(skillPath, previousSkill);
    const stale = missing();
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Обновите ссылку на пакет/u);
    assert.equal(readFileSync(skillPath, 'utf8'), previousSkill);
    writeFileSync(skillPath, currentSkill);
    const configuration = join(setup, created.descriptor);
    const customized = JSON.parse(readFileSync(configuration, 'utf8'));
    customized.workspaceId = 'custom-workspace';
    const exact = JSON.stringify(customized);
    writeFileSync(configuration, exact);
    writeFileSync(join(setup, 'AGENTS.md'), 'Project rules');
    assert.deepEqual(JSON.parse(run(process.execPath, [cli, 'init'], setup)), created);
    assert.deepEqual(JSON.parse(run(process.execPath, [cli, 'doctor'], setup)), created);
    assert.equal(readFileSync(configuration, 'utf8'), exact);
    assert.equal(readFileSync(join(setup, 'AGENTS.md'), 'utf8'), 'Project rules');
    rmSync(join(setup, customized.roles[0].profile));
    assert.equal(missing().status, 1);

    const consumer = join(temporary, 'consumer');
    mkdirSync(consumer);
    run('git', ['init', '-q'], consumer);
    const backend = join(consumer, '.git', 'agent-workflow');
    mkdirSync(backend);
    const input = join(consumer, 'input.json'),
      registration = join(temporary, 'registration.json');
    const files = new Map([
      [join(consumer, '.agent-workflow-backend.json'), { schemaVersion: 1, required: true }],
      [
        join(backend, 'backend-policy.json'),
        {
          schemaVersion: 2,
          newTasks: 'temporal',
          startAdmission: 'task-start-admission/1',
        },
      ],
      [input, {}],
      [
        registration,
        {
          schemaVersion: 2,
          address: '127.0.0.1:1',
          namespace: 'default',
          taskQueue: 'task',
          registration: {},
        },
      ],
    ]);
    for (const [path, value] of files) writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const refused = spawnSync(
      process.execPath,
      [
        cli,
        'task-chat',
        'start',
        '--temporal-input',
        input,
        '--temporal-registration',
        registration,
      ],
      { cwd: consumer, encoding: 'utf8', timeout: 30000 },
    );
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr.trim(), 'task-chat-temporal-registration-version');
    const externalRequest = join(temporary, 'freeze-request.json');
    writeFileSync(externalRequest, JSON.stringify({ schema_version: 1, root: consumer }), {
      mode: 0o600,
    });
    const external = spawnSync(process.execPath, [cli, 'freeze-checks', externalRequest], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(external.error);
    assert.equal(external.status, 1);
    assert.equal(external.stderr.trim(), 'backend-consumer-not-qualified');
    assert.deepEqual(readdirSync(consumer).sort(), [
      '.agent-workflow-backend.json',
      '.git',
      'input.json',
    ]);
    assert.deepEqual(readdirSync(backend), ['backend-policy.json']);
    for (const [path, value] of files)
      assert.equal(readFileSync(path, 'utf8'), JSON.stringify(value));

    for (const [entry, name] of [
      ['./task-execution', 'artifactStore'],
      ['./task-backend', 'checkTaskStartAdmission'],
    ]) {
      const declaration = metadata.exports[entry].replace(/\.js$/u, '.d.ts');
      assert.match(
        readFileSync(join(root, declaration), 'utf8'),
        new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 'u'),
      );
    }
    const loaded = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { resolve } from 'node:path';
      import { artifactStore } from '@krivega/agent-workflow/task-execution';
      import { checkTaskStartAdmission } from '@krivega/agent-workflow/task-backend';
      const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
      for (const path of Object.values(metadata.exports)) await import(pathToFileURL(resolve(path)).href);
      assert.equal(typeof checkTaskStartAdmission, 'function');
      const directory = process.argv[1];
      const content = Buffer.from('packed SDK artifact');
      const ref = artifactStore(directory).publish(content);
      assert.deepEqual(ref, { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
      assert.deepEqual(artifactStore(directory, { existingOnly: true }).read(ref), content);
      process.stdout.write(String(Object.keys(metadata.exports).length));
    `,
        join(temporary, 'sdk-artifacts'),
      ],
      root,
    );
    assert.equal(Number(loaded), Object.keys(original.exports).length);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
