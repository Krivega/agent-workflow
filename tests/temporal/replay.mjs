import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { historyToJSON } from '@temporalio/common/proto-utils';
import { finalizationBundleOptions } from './finalizationSdk.mjs';
import { readHistorySource } from './historySources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpora = [
  ['c19d7292', 10],
  ['b1-first-20261028', 3],
  ['m1-first-20261028', 5],
  ['substantial-first-20261028', 7],
  ['correction-first-20261028', 9],
  ['arbitration-native-20261028', 15, 28],
  ['initial-conflict-native-20261029', 12, 17],
  ['reader-client-native-20261029', 4, 4],
  ['auditor-native-20261029', 9, 12],
  ['task-audit-native-20261029', 39, 24],
  ['task-stages-native-20261029', 21, 15],
  ['task-progress-native-20261029', 47, 30],
  ['task-control-archive-sdk-20261029', 43, 0],
  ['task-requirements-held-native-20261029', 1, 4],
  ['task-execution-sdk-20261029', 40],
].map(([directory, count, nativeStarts]) => {
  const path = join(root, 'tests/temporal/histories', directory),
    manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.producer.modelStarts, 0);
  assert.equal(manifest.cases.length, count);
  if (nativeStarts !== undefined) assert.equal(manifest.origin.nativeModelStarts, nativeStarts);
  return { path, manifest, native: nativeStarts !== undefined };
});
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const workflowBundle = await bundleWorkflowCode({
  workflowsPath: join(root, 'dist/workflows/localTask.js'),
});
const profileBundles = new Map([['default', workflowBundle]]);
for (const corpus of corpora)
  for (const inventory of corpus.manifest.sourceInventories ?? []) {
    const bytes = readHistorySource(corpus.path, inventory);
    assert.ok(Array.isArray(JSON.parse(bytes)));
  }
for (const corpus of corpora)
  for (const fixture of corpus.manifest.fixtures ?? []) {
    assert.match(fixture.file, /^[a-z0-9-]+-fixture\.json$/u);
    const bytes = readFileSync(join(corpus.path, fixture.file)),
      saved = JSON.parse(bytes);
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    assert.equal(saved.mode, fixture.mode);
    if (saved.controlledTimeout !== null) {
      assert.equal(saved.mode, '--finalization-timeout-cancel');
      assert.equal(saved.controlledTimeout.startToCloseTimeoutMs, 1000);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(root, 'tests/temporal/finalization-timeout-interceptor.mjs')))
          .digest('hex'),
        saved.interceptor,
      );
    } else assert.equal(saved.interceptor, null);
  }
for (const corpus of corpora)
  for (const entry of corpus.manifest.cases) {
    assert.match(entry.file, /^[a-z0-9-]+\.json$/u);
    const bytes = readFileSync(join(corpus.path, entry.file));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(entry.expected, 'compatible');
    const saved = JSON.parse(bytes),
      history = corpus.native ? JSON.parse(historyToJSON(saved)) : saved;
    const profile = entry.replayProfile ?? 'default';
    assert.ok(['default', 'finalization', 'finalization-timeout'].includes(profile));
    if (profile !== 'default') assert.equal(entry.workflowType, 'FinalizationWorkflow');
    if (!profileBundles.has(profile))
      profileBundles.set(
        profile,
        await bundleWorkflowCode(
          finalizationBundleOptions(
            root,
            profile === 'finalization-timeout' ? '--finalization-timeout-cancel' : '--finalization',
          ),
        ),
      );
    await Worker.runReplayHistory(
      { workflowBundle: profileBundles.get(profile) },
      history,
      entry.workflowId,
    );
  }
const original = corpora[0],
  negative = original.manifest.cases.find((entry) => entry.scenario === 'reader-answered');
await assert.rejects(
  Worker.runReplayHistory(
    { workflowsPath: join(root, 'tests/temporal/replay-incompatible.mjs') },
    JSON.parse(readFileSync(join(original.path, negative.file), 'utf8')),
    negative.workflowId,
  ),
  /determinism|mismatch|nondetermin/i,
);
console.log(
  JSON.stringify({
    status: 'PASS',
    previousCommit: original.manifest.producer.commit,
    histories: corpora.reduce((total, corpus) => total + corpus.manifest.cases.length, 0),
    b1SourceBase: corpora[1].manifest.producer.baseCommit,
    unfinishedWait: true,
    incompatibleBundleRejected: true,
    modelStarts: 0,
  }),
);
