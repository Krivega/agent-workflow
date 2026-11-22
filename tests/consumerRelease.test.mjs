import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { checkConsumerRelease } from './legacyConsumerRelease.mjs';

const installed = resolve(import.meta.dirname, '..');
const metadata = readFileSync(join(installed, 'package.json'));
const version = JSON.parse(metadata).version;
const current = { runtime_package_version: version };
const old = { runtime_package_version: '0.0.0' };
const refusal = /original agent-workflow release/;
const { saveManaged } = await tsImport('../adapters/storage/managedChatFiles.ts', import.meta.url);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    check: (...args) => checkConsumerRelease(args, { root, version }),
    put(file, value, format = false) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (format) saveManaged(path, value, true, format);
      else writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    },
  };
}

test('the consumer wrapper checks a Temporal start without loading Legacy storage', async (t) => {
  const { root } = fixture(t);
  const entry = join(root, 'consumerRelease.mjs');
  copyFileSync(join(installed, 'cli/consumerRelease.mjs'), entry);
  symlinkSync(join(installed, 'node_modules'), join(root, 'node_modules'));
  const guard = await import(pathToFileURL(entry).href);
  await guard.checkConsumerRelease(
    [
      'task-chat',
      'start',
      '--temporal-input',
      'input.json',
      '--temporal-registration',
      'host.json',
    ],
    { root, version },
  );
  await assert.rejects(
    guard.checkConsumerRelease(['task-chat', 'start', '--state', 'old']),
    /backend-consumer-not-qualified/,
  );
});

test('fresh starts, previews and read-only commands accept unmarked input without touching it', async (t) => {
  const { check, put } = fixture(t);
  put('request', {});
  put('old/managed-chat.json', old);
  for (const action of [
    'read-artifact',
    'resolve-tool',
    'preflight-chat',
    'read-chat',
    'observe-chat',
    'wait-council',
    'status-chat',
    'compact-context-chat',
    'preview-task',
    'inspect-project',
    'inspect-connection',
  ])
    await check(action, 'request');
  for (const action of ['freeze-checks', 'package-checks', 'repeat-council', 'refresh-council'])
    await check(action, 'request');
  await check('task-chat', 'start');
  await check('task-chat', 'start', '--state');
  await check('task-chat', 'start', '--state', 'fresh');
  await check('task-chat', 'wait', '--state', 'old');
  for (const name of ['connect-chat', 'prepare-chat', 'bootstrap-chat']) {
    put('fresh.json', { storage: { root: 'fresh/store' }, journal: 'fresh/connection' });
    await check(name, 'fresh.json');
  }
});

test('unmarked or mismatched stateful requests fail before effects; matching managed ownership permits new maintenance requests', async (t) => {
  const { root, check, put } = fixture(t);
  const input = {
    storage: { root: join(root, 'state/store') },
    evidence_root: join(root, 'state'),
  };
  put('request', input);
  for (const action of [
    'retain-store',
    'relocate-files',
    'materialize-files',
    'continue-chat',
    'execution-chat',
    'control-chat',
    'authorize-chat',
  ])
    await assert.rejects(check(action, 'request'), refusal);
  for (const format of ['minimal', true]) {
    const state = 'state/managed-chat.json';
    for (const marker of [{}, old, current]) {
      const shared = Array(128).fill('X'.repeat(1024));
      put(state, { ...marker, shared }, format);
      const bytes = readFileSync(join(root, state));
      assert.match(bytes.toString('utf8'), format === 'minimal' ? /^AWRETAIN2/u : /^AWJSON1/u);
      const actions = [
        check('task-chat', 'continue', '--state', 'state'),
        check('retain-store', 'request'),
      ];
      if (marker === current) await Promise.all(actions);
      else await Promise.all(actions.map((result) => assert.rejects(result, refusal)));
      assert.deepEqual(readFileSync(join(root, state)), bytes);
    }
  }
  put('request', { ...input, ...old });
  await assert.rejects(check('relocate-files', 'request'), refusal);
  put('state/managed-chat.json', old);
  put('request', { ...input, ...current });
  await assert.rejects(check('materialize-files', 'request'), refusal);
  put('request', { ...input, evidence_root: 'other' });
  put('other/managed-chat.json', current);
  put('authorization', { evidence_root: 'other' });
  await check('authorize-chat', 'authorization');
  await assert.rejects(check('retain-store', 'request'), refusal);
});

test('new standalone low-level stores carry their own release and refuse old storage even if the request claims the current version', async (t) => {
  const { check, put, root } = fixture(t);
  const { initializeStore } = await tsImport(
    '../adapters/storage/storeDatabase.ts',
    import.meta.url,
  );
  initializeStore(join(root, 'new-store'), {
    schema_version: 'aw-evidence/1-draft',
    project_id: 'project',
    task_id: 'task',
  });
  put('request', { storage: { root: 'new-store' } });
  await check('retain-store', 'request');
  await check('bootstrap-chat', 'request');
  put('old-store/identity.json', { schema: 2, project: 'project', task: 'task' });
  put('request', { ...current, storage: { root: 'old-store' } });
  await assert.rejects(check('retain-store', 'request'), refusal);
  put('journal/backup.json', old);
  put('request', { connection_journal: 'journal', storage: { root: 'new-store' } });
  await assert.rejects(check('continue-chat', 'request'), refusal);
});

test('newly prepared connection plans and journals must match before apply, disable, rollback or retries', async (t) => {
  const { check, put } = fixture(t);
  for (const marker of [{}, old, current]) {
    put('plan', marker);
    put('journal/backup.json', marker);
    put('journal/selection.json', marker);
    put('connect', { journal: 'journal' });
    const actions = [
      check('apply-task', 'plan', 'journal'),
      check('disable-task', 'journal'),
      check('rollback-task', 'journal'),
      check('connect-chat', 'connect'),
    ];
    if (marker === current) await Promise.all(actions);
    else await Promise.all(actions.map((result) => assert.rejects(result, refusal)));
  }
  put('journal/selection.json', {});
  await assert.rejects(check('apply-task', 'plan', 'journal'), refusal);
  put('pre/connection/selection.json', old);
  await assert.rejects(check('task-chat', 'start', '--state', 'pre'), refusal);
  await assert.rejects(check('task-chat', 'revise', '--state', 'missing'), refusal);
});
