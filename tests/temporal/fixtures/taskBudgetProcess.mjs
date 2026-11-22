import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const sources = {
  reader: new URL('../../../src/adapters/codex/readerBudget.ts', import.meta.url).href,
  budget: new URL('../../../src/worker/taskBudget.ts', import.meta.url).href,
  files: new URL('../../../src/adapters/artifacts/files.ts', import.meta.url).href,
  project: new URL('../../../src/contracts/project.ts', import.meta.url).href,
};
const imports = new Map([
  [sources.reader + '\0../artifacts/files.js', sources.files],
  [sources.reader + '\0../../contracts/project.js', sources.project],
  [sources.budget + '\0../contracts/project.js', sources.project],
  [sources.budget + '\0../adapters/artifacts/files.js', sources.files],
  [sources.files + '\0../../contracts/project.js', sources.project],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(imports.get(context.parentURL + '\0' + specifier) ?? specifier, context);
  },
});
const { readerBudget } = await import(sources.reader);
const { captureTaskBudget } = await import(sources.budget);
const { artifactStore, digest, readPrivateFile } = await import(sources.files);
const [mode, root, previousText] = process.argv.slice(2);
assert(['reserve-kill', 'recover', 'capture'].includes(mode));
assert(root);
const directory = join(root, 'credits'),
  store = artifactStore(join(root, 'artifacts'), { existingOnly: mode !== 'reserve-kill' }),
  previous = JSON.parse(previousText),
  first = [digest('first-operation'), digest('unknown-first-request')],
  second = [digest('second-operation'), digest('second-request')];
function emit(value) {
  writeSync(1, JSON.stringify({ mode, pid: process.pid, ...value }) + '\n');
}
function failure(run) {
  try {
    run();
    return null;
  } catch (error) {
    assert(error instanceof Error);
    return error.message;
  }
}
if (mode === 'reserve-kill') {
  assert.equal(previous, null);
  const reserve = readerBudget(directory, 2);
  reserve(...first);
  const budget = captureTaskBudget(directory, store, null),
    bytes = readPrivateFile(join(directory, '0.credit'));
  emit({
    budget,
    record: JSON.parse(store.read(budget.manifest).toString()),
    firstCredit: { sha256: digest(bytes), bytes: bytes.length },
  });
  // Only this fixture process dies; the reservation and snapshot have already been fsynced.
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'recover') {
  const changedLimit = failure(() => readerBudget(directory, 3)),
    reserve = readerBudget(directory, 2),
    before = captureTaskBudget(directory, store, previous);
  reserve(...first);
  const duplicate = captureTaskBudget(directory, store, previous);
  reserve(...second);
  const after = captureTaskBudget(directory, store, before.manifest),
    exhaustion = failure(() => reserve(digest('third-operation'), digest('third-request'))),
    exhausted = captureTaskBudget(directory, store, after.manifest);
  emit({
    before,
    duplicate,
    after,
    exhausted,
    record: JSON.parse(store.read(after.manifest).toString()),
    changedLimit,
    exhaustion,
  });
} else {
  emit({ error: failure(() => captureTaskBudget(directory, store, previous)) });
}
