import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const installed = fileURLToPath(new URL('..', import.meta.url));
const marker = 'runtime_package_version';
const mismatch = 'Saved task requires its original agent-workflow release';
const readOnly = new Set([
  'read-artifact',
  'resolve-tool',
  'preflight-chat',
  'read-chat',
  'observe-chat',
  'wait-council',
  'status-chat',
  'compact-context-chat',
  'comparison-report',
  'preview-task',
]);
const prepareEvidence = new Set([
  'freeze-checks',
  'package-checks',
  'refresh-council',
  'repeat-council',
]);
const maintenance = new Set(['retain-store', 'relocate-files', 'materialize-files']);

export async function checkConsumerRelease(args, { root, version }) {
  const [action, file] = args;
  if (!file || readOnly.has(action)) return;
  if (!(
    action.endsWith('-chat') ||
    action === 'comparison-run' ||
    maintenance.has(action) ||
    prepareEvidence.has(action) ||
    ['apply-task', 'disable-task', 'rollback-task'].includes(action)
  ))
    return;
  let stateDirectory;
  if (action === 'task-chat') {
    const index = args.indexOf('--state');
    if (file === 'wait' || index < 0 || !args[index + 1]) return;
    stateDirectory = resolve(root, args[index + 1]);
  }
  const { readManaged } = await tsImport(
    '../adapters/storage/managedChatFiles.ts',
    import.meta.url,
  );
  const load = (file) => readManaged(resolve(root, file));
  function current(document) {
    assert.equal(document?.[marker], version, mismatch);
  }
  function managed(directory) {
    if (typeof directory !== 'string') return false;
    const path = resolve(root, directory, 'managed-chat.json');
    if (!existsSync(path)) return false;
    current(load(path));
    return true;
  }
  function journal(directory) {
    let present = false;
    for (const name of ['selection.json', 'backup.json']) {
      const path = join(directory, name);
      if (existsSync(resolve(root, path))) {
        current(load(path));
        present = true;
      }
    }
    return present;
  }

  if (stateDirectory !== undefined) {
    if (managed(stateDirectory)) return;
    assert.equal(file, 'start', mismatch);
    if (!journal(join(stateDirectory, 'connection')))
      assert.ok(!existsSync(join(stateDirectory, 'store')), mismatch);
    return;
  }
  if (action === 'apply-task') {
    current(load(file));
    if (args[2]) journal(args[2]);
    return;
  }
  if (action === 'disable-task' || action === 'rollback-task') {
    current(load(join(file, 'backup.json')));
    return;
  }

  const request = load(file);
  if (request?.[marker] !== undefined) current(request);
  if (action === 'comparison-run') {
    const series = load(request.series);
    const manifest = series?.runner?.inputs?.inputs?.find(
      (input) => input.locator === 'package.json',
    );
    assert.equal(series?.runner?.root, resolve(installed), mismatch);
    assert.equal(
      manifest?.hash,
      createHash('sha256')
        .update(readFileSync(join(installed, 'package.json')))
        .digest('hex'),
      mismatch,
    );
    return;
  }

  const evidence = managed(request.evidence_root);
  if (typeof request.connection_journal === 'string') journal(request.connection_journal);
  managed(request.namespace);
  if (action === 'connect-chat') {
    if (typeof request.journal === 'string') {
      managed(dirname(resolve(root, request.journal)));
      journal(request.journal);
    }
    return;
  }
  if (prepareEvidence.has(action)) return;
  const store = request.storage?.root;
  if (typeof store === 'string') {
    const directory = resolve(root, store);
    const owned = managed(dirname(directory));
    if (existsSync(directory)) {
      current(load(join(directory, 'identity.json')));
      return;
    }
    if (owned) return;
    if (['prepare-chat', 'bootstrap-chat'].includes(action) && !existsSync(directory)) return;
  } else if (evidence) return;
  current(request);
}
