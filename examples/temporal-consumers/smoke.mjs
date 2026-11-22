import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { parseProject } from '@krivega/agent-workflow/contracts';
import { preparationActivities } from '@krivega/agent-workflow/activities';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(process.cwd());
const pin = JSON.parse(readFileSync('pin.json', 'utf8'));
assert.equal(digest(readFileSync('../runtime.tgz')), pin.sha256, 'changed package archive');
const installed = resolve('node_modules/@krivega/agent-workflow');
assert.equal(lstatSync(installed).isSymbolicLink(), false);
assert.equal(realpathSync(installed), installed, 'linked source package');
const metadata = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
assert.equal(metadata.name, pin.name);
assert.equal(metadata.version, pin.version);
for (const key of Object.keys(metadata.exports)) {
  const url = import.meta.resolve(metadata.name + key.slice(1));
  assert.equal(new URL(url).protocol, 'file:', 'export must resolve to a local module');
  const path = fileURLToPath(url);
  assert.ok(realpathSync(path).startsWith(installed + sep), 'export escapes installed package');
  assert.ok(lstatSync(path).isFile(), 'export must resolve to an existing module file');
  const module = await import(url);
  assert.equal(Object.prototype.toString.call(module), '[object Module]');
}
const project = parseProject(JSON.parse(readFileSync('project.json', 'utf8')));
const input = {
  schemaVersion: 1,
  taskId: 'installation-only',
  project,
  hostId: 'pinned-copy',
  owner: 'installation-check',
  generation: 1,
  revision: 1,
  card: pin.card,
};
const registration = {
  project,
  hostId: input.hostId,
  owner: input.owner,
  generation: input.generation,
  workspaceRoot: root,
  artifactRoot: resolve('artifacts'),
  commands: pin.commands,
};
const activities = preparationActivities(registration);
const result = await activities.prepareProject(input);
assert.equal(result.status, 'prepared');
const bytes = readFileSync(resolve('artifacts', result.manifest.sha256));
assert.equal(digest(bytes), result.manifest.sha256);
assert.equal(bytes.length, result.manifest.bytes);
const manifest = JSON.parse(bytes);
assert.deepEqual(manifest.input, input);
for (const ref of manifest.inputs) {
  const bytes = readFileSync(ref.path);
  assert.equal(digest(bytes), ref.sha256);
  assert.equal(bytes.length, ref.bytes);
}
await assert.rejects(activities.prepareProject({ ...input, owner: 'other-owner' }));
await assert.rejects(
  activities.prepareProject({ ...input, card: project.cardRoot + '/absent.md' }),
);
console.log(
  JSON.stringify({
    status: 'prepared-installed-consumer',
    projectId: project.projectId,
    package: { name: metadata.name, version: metadata.version, sha256: pin.sha256 },
    manifest: result.manifest,
    inputs: manifest.inputs,
    exports: Object.keys(metadata.exports),
    modelCalls: 0,
    servicesStarted: 0,
    checksExecuted: 0,
    qualification: false,
  }),
);
