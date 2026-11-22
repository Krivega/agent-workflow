import { readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as storeFiles from '../adapters/storage/storeFiles.js';
import { workflowFixture, designReviewFixture } from './workflowFixtures.js';
import { artifactDependencies } from '../adapters/storage/artifactDependencies.js';
import {
  encodeProofArtifact,
  encodeChatArtifact,
  shareArtifactPool,
} from '../adapters/storage/sharedArtifacts.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { refreshCouncilInputs, restoreCouncilSelection } from '../cli/refreshCouncilInputs.js';
import {
  answerCouncil,
  assignAdviser,
  councilBlockers,
  councilReviewRequest,
  councilRoles,
  createCouncil,
  repeatCouncil,
  revisePlanning,
} from '../core/council.js';
import { compareInputs } from '../core/evidence.js';
import { verifyCouncilInputs } from '../application/executionWorkflow.js';
import { runChatCommand } from '../cli/chatCommand.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});

it('preserves directory discovery when the only new file is a restored reachable fragment', async () => {
  const p = await packed();
  const path = resolve(f.root, p.graph[0]!.locator);
  const bytes = await readFile(path);
  await rm(path);
  const discovery = { files: ['artifact.json'], directories: ['shared-json'] };
  const original = await f.inputs.capture(discovery, 'role');
  f.selection.architect.inputs = original;
  f.target.inputs = original;
  const council = f.council('acceptance');
  await writeFile(path, bytes);
  expect(compareInputs(original, await f.inputs.current(original))).toBe('applicable');
  const target = { ...council.target, inputs: await f.inputs.capture(discovery, 'new target') };
  const next = await refreshCouncilInputs(council, target, f.inputs);
  expect(next.advisers).toEqual(council.advisers);
  expect(councilBlockers(next)).toEqual([]);
  await f.file('shared-json/unrelated.txt', 'new independent material');
  expect(compareInputs(original, await f.inputs.current(original))).toBe('changed');
});

it('rejects a changed root and a root replaced between hashing and reading its graph', async () => {
  const p = await packed();
  const ref = { ...p.ref, locator: resolve(f.root, p.ref.locator) };
  expect(() => artifactDependencies({ ...ref, hash: 'wrong' }, () => undefined)).toThrow(
    'workflow-input-changed',
  );
  const original = await readFile(ref.locator, 'utf8');
  expect(artifactDependencies(ref, () => undefined, original)).toHaveLength(p.graph.length);
  const read = storeFiles.readPrivateFile;
  vi.spyOn(storeFiles, 'readPrivateFile').mockImplementation((path, prefix) => {
    const bytes = read(path, prefix);
    if (path === ref.locator && prefix !== undefined) writeFileSync(path, original + ' ');
    return bytes;
  });
  expect(() => artifactDependencies(ref, () => undefined)).toThrow('workflow-input-changed');
});
async function packed() {
  await f.file('artifact.json', encodeProofArtifact(f.root, { before: f.target.inputs.inputs }));
  const ref = await f.ref('artifact.json');
  const graph = await f.inputs.dependencies([ref]);
  const inputs = await f.inputs.capture({ files: ['artifact.json'], directories: [] }, 'owner');
  return { ref, graph, inputs };
}
async function fixture(phase: 'planning' | 'acceptance') {
  const p = await packed();
  const selection = structuredClone(f.selection);
  for (const role of councilRoles) {
    selection[role].trigger = !['product', 'backend'].includes(role);
    selection[role].inputs = p.inputs;
  }
  const target = { ...f.target, inputs: p.inputs };
  let council = createCouncil(phase, selection, target);
  for (const role of councilRoles) {
    if (!selection[role].trigger) continue;
    const rules = [...f.spec.rules, ...f.profiles[role]];
    const run = {
      ...f.adviser,
      spec: { ...f.adviser.spec, rules, sources: [...f.spec.sources, ...f.profiles[role]] },
      loaded: { ...f.adviser.loaded!, rules },
    };
    council = assignAdviser(council, role, run);
    const answer = f.answer(council);
    answer.binding!.request = councilReviewRequest(council, role, run);
    if (role === 'devops') {
      answer.verdict = 'NOT RUN';
      answer.coverage = 'partial';
    }
    if (role === 'ui-ux-designer') answer.design = designReviewFixture(phase, p.ref);
    council = answerCouncil(council, role, run.spec.session_id, answer);
  }
  const actual = structuredClone(selection);
  for (const role of councilRoles)
    if (actual[role].trigger)
      actual[role].inputs = { ...p.inputs, inputs: [...p.inputs.inputs, ...p.graph] };
  const updatedTarget = {
    ...target,
    inputs: { ...p.inputs, inputs: [...p.inputs.inputs, ...p.graph] },
  };
  return { ...p, council, actual, target: updatedTarget };
}

it.each(['planning', 'acceptance'] as const)(
  'retains seven original %s PASS bindings and repeats only DevOps after restoring a graph',
  async (phase) => {
    const p = await fixture(phase);
    const before = structuredClone(p.council);
    const path = resolve(f.root, p.graph[0]!.locator);
    const bytes = await readFile(path);
    await rm(path);
    expect((await f.inputs.current(p.inputs)).complete).toBe(false);
    await writeFile(path, bytes);
    const selection = await restoreCouncilSelection(p.council, p.actual, f.inputs);
    const next =
      phase === 'planning'
        ? revisePlanning(p.council, selection, p.target)
        : repeatCouncil(p.council, p.target, ['devops'], selection);
    for (const role of councilRoles.filter((r) => selection[r].trigger && r !== 'devops'))
      expect(next.advisers[role]).toEqual(p.council.advisers[role]);
    expect(next.advisers.devops!.status).toBe('running');
    expect(next.advisers.devops!.answer).toBeNull();
    expect(next.history).toEqual(p.council.history);
    expect(next.review_turns).toEqual(p.council.review_turns);
    expect(councilBlockers(next)).toEqual(['devops:running']);
    await verifyCouncilInputs(next, f.inputs);
    expect(p.council).toEqual(before);
    await writeFile(path, 'corrupt');
    await expect(verifyCouncilInputs(next, f.inputs)).rejects.toThrow(
      'council-inputs-stale-or-unknown',
    );
  },
);

it.each(['FAIL', 'NOT RUN', 'partial'] as const)(
  'reopens %s while retaining historical evidence on planning refresh',
  async (verdict) => {
    const p = await packed();
    f.selection.architect.inputs = p.inputs;
    f.target.inputs = p.inputs;
    const council = f.council('planning');
    if (verdict === 'partial') council.advisers.architect!.answer!.coverage = 'partial';
    else council.advisers.architect!.answer!.verdict = verdict;
    const refreshed = await refreshCouncilInputs(council, council.target, f.inputs);
    expect(refreshed.advisers.architect!.status).toBe('running');
    expect(refreshed.history).toEqual(council.history);
  },
);

it.each(['requirement', 'reason', 'discovery', 'incomplete', 'source', 'extra', 'duplicate'])(
  'does not normalize a %s change into a dependency restoration',
  async (change) => {
    const p = await fixture('acceptance');
    const role = p.actual.architect;
    if (change === 'requirement') role.requirements[0] = { ...f.proof, hash: 'changed' };
    if (change === 'reason') role.reason = 'new responsibility';
    if (change === 'discovery') role.inputs.discovery_rule = '{"version":1}';
    if (change === 'incomplete') role.inputs.complete = false;
    if (change === 'source') role.inputs.inputs[0] = { ...p.ref, hash: 'changed' };
    if (change === 'extra') role.inputs.inputs.push(f.proof);
    if (change === 'duplicate') role.inputs.inputs.push(p.graph[0]!);
    const result = await restoreCouncilSelection(p.council, p.actual, f.inputs);
    expect(result.architect).toEqual(role);
  },
);

it('rejects a corrupt restored graph instead of retaining a PASS', async () => {
  const p = await fixture('acceptance');
  await writeFile(resolve(f.root, p.graph[0]!.locator), 'changed');
  await expect(restoreCouncilSelection(p.council, p.actual, f.inputs)).rejects.toThrow(
    'chat-artifact-conflict',
  );
});

it('keeps exact PASS inputs on refresh and prevents changed document reuse', async () => {
  const p = await packed();
  f.selection.architect.inputs = p.inputs;
  f.target.inputs = p.inputs;
  const council = f.council('acceptance');
  const target = {
    ...council.target,
    inputs: { ...p.inputs, inputs: [...p.inputs.inputs, ...p.graph] },
  };
  const next = await refreshCouncilInputs(council, target, f.inputs);
  expect(next.advisers).toEqual(council.advisers);
  expect(councilBlockers(next)).toEqual([]);
  await f.file('artifact.json', encodeProofArtifact(f.root, { before: [f.proof] }));
  expect(compareInputs(p.inputs, await f.inputs.current(p.inputs))).toBe('changed');
});

it.each([true, false])(
  'prepares a public DevOps-only repeat with explicit selection=%s',
  async (explicit) => {
    const p = await fixture('acceptance');
    await f.file(
      'repeat.json',
      JSON.stringify({
        schema_version: 1,
        root: f.root,
        evidence_root: f.root,
        council: p.council,
        target: explicit ? p.target : p.council.target,
        roles: ['devops'],
        ...(explicit ? { selection: p.actual } : {}),
      }),
    );
    const output: string[] = [];
    expect(
      await runChatCommand(
        ['repeat-council', resolve(f.root, 'repeat.json')],
        (s) => output.push(s),
        (s) => output.push(s),
      ),
    ).toBe(0);
    expect(output.join()).not.toContain('unreviewed-input-change');
  },
);

it('checks nested shared and archived dependencies, inline retained packets, and plain files', async () => {
  const value = { large: 'immutable '.repeat(1500), before: f.target.inputs.inputs };
  await f.file('nested.json', encodeProofArtifact(f.root, value));
  expect((await f.inputs.dependencies([await f.ref('nested.json')])).length).toBeGreaterThan(1);
  const execution = {
    schema_version: 2,
    task_id: 'task',
    reviewer_sessions: {},
    history: [{ id: 'event', payload: JSON.stringify(value) }],
  };
  await f.file('archived.json', encodeChatArtifact(f.root, execution, true));
  const paths: string[] = [];
  expect(
    artifactDependencies(
      { ...(await f.ref('archived.json')), locator: resolve(f.root, 'archived.json') },
      (p) => paths.push(p),
    ).length,
  ).toBeGreaterThan(0);
  expect(paths.length).toBeGreaterThan(0);
  await f.file('inline.json', encodeChatArtifact(f.root, value, 'minimal'));
  expect(await f.inputs.dependencies([await f.ref('inline.json')])).toEqual([]);
  expect(await f.inputs.dependencies([await f.ref('source.txt')])).toEqual([]);
});

it('validates external pools within authority and rejects an unauthorized parent pool or symlink', async () => {
  const child = resolve(f.root, 'child');
  await mkdir(child);
  shareArtifactPool(child, f.root);
  await f.file(
    'child/artifact.json',
    encodeProofArtifact(child, { before: f.target.inputs.inputs }),
  );
  const files = new FileWorkflowInputs(child, f.root);
  const ref = await files.ref('artifact.json');
  const graph = await files.dependencies([ref]);
  expect(graph[0]!.locator).toBe(resolve(f.root, 'shared-json', graph[0]!.hash));
  const restricted = new FileWorkflowInputs(child);
  await expect(restricted.dependencies([ref])).rejects.toThrow('external-evidence-not-authorized');
  const bytes = await readFile(graph[0]!.locator);
  await rm(graph[0]!.locator);
  await f.file('original-node', bytes.toString());
  await symlink(resolve(f.root, 'original-node'), graph[0]!.locator);
  await expect(files.dependencies([ref])).rejects.toThrow();
});
