import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { workflowFixture } from './workflowFixtures.js';
import {
  freezeChecks,
  packageChecks,
  preparedChecks,
  preparedProof,
  runPreparedChecks,
  verifyPreparedRuntime,
} from '../adapters/project/preparedChecks.js';
import type { PreparedChecks } from '../adapters/project/preparedChecks.js';
import { checkEnvironment } from '../adapters/project/checkEnvironment.js';
import { nativeStartupChecks } from '../adapters/project/nativeStartup.js';
import {
  checkRuntime,
  reusableChatCheck,
  runChatCheck,
  verifyChatCheck,
} from '../adapters/project/chatChecks.js';
import type { ChatCheckProof, ChatCheckRequest } from '../adapters/project/chatChecks.js';
import type { CriterionCheckPlan } from '../adapters/project/checkReadiness.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { readChatArtifact, saveChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { saveManaged } from '../adapters/storage/managedChatFiles.js';
import type { InputRef } from '../core/localRun.js';
import { createExecution, applyExecution } from '../core/execution.js';
import { answerCouncil, assignAdviser, createCouncil } from '../core/council.js';
import type { Check } from '../core/execution.js';
import type { InputManifest } from '../core/evidence.js';
import { compareInputs } from '../core/evidence.js';
import * as diskSpace from '../adapters/project/workflowDiskSpace.js';
import { executionEvent } from './workflowFixtures.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let external: string, engine: string, count: string;
let checks: CriterionCheckPlan[];
beforeEach(async () => {
  f = await workflowFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'prepared-checks-'));
  count = resolve(external, 'processes.log');
  await mkdir(resolve(external, 'bin'));
  engine = resolve(external, 'bin/yarn');
  await writeFile(
    engine,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(count)}, process.argv.slice(2).join(' ')+'\\n'); console.log('ready');\n`,
  );
  await chmod(engine, 0o700);
  vi.stubEnv('PATH', resolve(external, 'bin') + ':' + process.env.PATH);
  await f.file('plan.md', '# Plan\n\n## Критерии\n\n- [ ] C1: observed check\n');
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  checks = ['C1', 'validate'].map((criterion) => ({
    criterion,
    implementation: ['source.txt'],
    verification: ['plan.md'],
    check: {
      id: criterion === 'C1' ? 'one' : 'validation',
      criterion,
      command: { file: 'yarn', args: [criterion === 'C1' ? 'unit' : 'validate:brief'] },
      discovery: { files: ['source.txt', 'plan.md', engine], directories: [] },
      attested_by: 'owner',
    },
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.dispose();
  await rm(external, { recursive: true, force: true });
});
const freeze = () => freezeChecks(f.root, external, 'plan.md', checks);
const run = (request: ChatCheckRequest) => runChatCheck(f.root, external, request);
const files = () => new FileWorkflowInputs(f.root, external);
const ref = (name: string) => files().ref(resolve(external, name));
const processes = async () => (await readFile(count, 'utf8')).trim().split('\n');

it('rejects an invalid final validate command while freezing, before any check process', async () => {
  checks[1]!.check.command = { file: process.execPath, args: ['-e', 'console.log("late")'] };
  await expect(freeze()).rejects.toThrow('chat-validate-command-required');
  await expect(readFile(count)).rejects.toThrow('ENOENT');
});

it('blocks low disk space before capturing a plan or starting processes', async () => {
  const guard = vi
    .spyOn(diskSpace, 'requireWorkflowDiskSpace')
    .mockRejectedValueOnce(new Error('workflow-disk-space-low:fixture'));
  try {
    await expect(freeze()).rejects.toThrow('workflow-disk-space-low:fixture');
    await expect(readFile(count)).rejects.toThrow('ENOENT');
  } finally {
    guard.mockRestore();
  }
});

it('captures the common readiness discovery once for all criteria', async () => {
  const capture = vi.spyOn(FileWorkflowInputs.prototype, 'capture');
  try {
    await freeze();
    expect(capture).toHaveBeenCalledTimes(2);
  } finally {
    capture.mockRestore();
  }
});

it('verifies a shared manifest once per call while rechecking changed and distinct manifests', async () => {
  const plan = await freeze();
  const current = vi.spyOn(FileWorkflowInputs.prototype, 'current');
  try {
    await preparedChecks(f.root, external, plan);
    expect(current).toHaveBeenCalledTimes(1);
    current.mockClear();
    const value = readChatArtifact(plan) as PreparedChecks;
    value.checks[1]!.inputs = { ...value.checks[1]!.inputs, attested_by: 'separate attestation' };
    await preparedChecks(f.root, external, saveChatArtifact(external, 'distinct', value));
    expect(current).toHaveBeenCalledTimes(2);
    await f.file('source.txt', 'changed after previous verification');
    await expect(preparedChecks(f.root, external, plan)).rejects.toThrow(
      'prepared-check-inputs-changed',
    );
  } finally {
    current.mockRestore();
  }
});

it('runs once, expands an independently hashed package and resumes under different invocation metadata without new processes', async () => {
  vi.stubEnv('npm_config_argv', 'freeze invocation');
  const plan = await freeze();
  vi.stubEnv('npm_config_argv', 'checks invocation');
  vi.stubEnv('npm_lifecycle_script', 'new caller');
  const first = await runPreparedChecks(f.root, external, plan, run);
  assert('details' in first);
  const bundle = readChatArtifact(first.details!) as {
    source_inputs: { inputs: InputRef[] };
    acceptance_inputs: { inputs: InputRef[] };
    proofs: InputRef[];
  };
  expect(await processes()).toEqual(['unit', 'validate:brief']);
  expect(bundle.source_inputs.inputs.every((r) => !r.locator.endsWith('/one.json'))).toBe(true);
  expect(bundle.acceptance_inputs.inputs).toContainEqual(await ref('one.json'));
  await writeFile(resolve(external, 'new-evidence.txt'), 'new acceptance material');
  vi.stubEnv('PACKAGE_CALLER_ONLY', 'not a checked process');
  const expanded = await packageChecks(f.root, external, plan, bundle.proofs, [
    resolve(external, 'new-evidence.txt'),
  ]);
  expect(expanded.details.hash).not.toBe(first.details!.hash);
  expect((readChatArtifact(expanded.details) as typeof bundle).source_inputs).toEqual(
    bundle.source_inputs,
  );
  vi.stubEnv('PACKAGE_CALLER_ONLY', undefined);
  await runPreparedChecks(f.root, external, plan, run);
  expect(await processes()).toEqual(['unit', 'validate:brief']);
});

it('accepts an expanded evidence package through REVIEW, ACCEPT and DONE using the original full-check inputs', async () => {
  const plan = await freeze();
  const first = await runPreparedChecks(f.root, external, plan, run);
  assert('details' in first);
  const original = readChatArtifact(first.details) as { proofs: InputRef[] };
  await writeFile(resolve(external, 'screens.txt'), 'new observed evidence');
  const packed = await packageChecks(f.root, external, plan, original.proofs, [
    resolve(external, 'screens.txt'),
  ]);
  const bundle = readChatArtifact(packed.details) as {
    source_inputs: InputManifest;
    acceptance_inputs: InputManifest;
    checks: Check[];
  };
  const target = {
    ...f.target,
    inputs: bundle.source_inputs,
    evidence_inputs: bundle.acceptance_inputs,
  };
  const council = (phase: 'planning' | 'acceptance') => {
    const pending = assignAdviser(
      createCouncil(phase, f.selection, target),
      'architect',
      f.adviser,
    );
    return answerCouncil(pending, 'architect', 'session', f.answer(pending));
  };
  let state = createExecution(
    'task',
    1,
    target,
    bundle.checks.map((check) => ({
      id: check.id,
      kind: 'check',
      applicable: true,
      reason: 'frozen map',
    })),
    true,
    'substantial',
  );
  state = applyExecution(
    state,
    executionEvent(state, { type: 'PLAN', council: council('planning') }),
  );
  state = applyExecution(
    state,
    executionEvent(state, {
      type: 'REVIEW',
      target,
      selection: f.selection,
      baseline: {
        kind: 'real',
        scenario: 'actual isolated command',
        evidence: bundle.checks[0]!.evidence,
        inputs: bundle.source_inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
      checks: bundle.checks,
    }),
  );
  state = applyExecution(
    state,
    executionEvent(state, { type: 'ACCEPT', council: council('acceptance'), findings: [] }),
  );
  state = applyExecution(
    state,
    executionEvent(state, {
      type: 'RESULT',
      result: {
        scope: target.scope,
        target,
        evidence: [
          packed.details,
          f.proof,
          f.target.diff,
          ...bundle.checks.map((check) => check.evidence),
        ],
        child_results: [],
        limitations: ['isolated fixture'],
        summary: 'hash-verified expanded package',
      },
    }),
  );
  state = applyExecution(state, executionEvent(state, { type: 'DONE' }));
  expect(state.status).toBe('done');
  expect(state.checks.map((check) => compareInputs(check.inputs, bundle.source_inputs))).toEqual([
    'applicable',
    'applicable',
  ]);
  expect(await processes()).toEqual(['unit', 'validate:brief']);
  await writeFile(resolve(external, 'screens.txt'), 'tampered');
  expect((await files().current(target.evidence_inputs)).inputs).not.toEqual(
    target.evidence_inputs.inputs,
  );
});

it('recovers a completed process after its caller loses the reply without replacing its proof', async () => {
  const plan = await freeze();
  await expect(
    runPreparedChecks(f.root, external, plan, async (request) => {
      await run(request);
      throw new Error('lost completed reply');
    }),
  ).rejects.toThrow('lost completed reply');
  const original = await ref('one.json');
  await runPreparedChecks(f.root, external, plan, run);
  expect(await ref('one.json')).toEqual(original);
  expect(await processes()).toEqual(['unit', 'validate:brief']);
});

it('runs the unchanged checks across distinct Codex tool calls without passing caller metadata to processes', async () => {
  vi.stubEnv('CODEX_TOOL_CALL_ID', 'freeze-call');
  const plan = await freeze();
  vi.stubEnv('CODEX_TOOL_CALL_ID', 'checks-call');
  expect(checkEnvironment(f.root).CODEX_TOOL_CALL_ID).toBe('checks-call');
  expect(checkEnvironment(f.root, 'workflow-v1').CODEX_TOOL_CALL_ID).toBeUndefined();
  await runPreparedChecks(f.root, external, plan, run);
  expect(await processes()).toEqual(['unit', 'validate:brief']);
});

it('blocks a different effective environment before any process while preserving all non-wrapper variables', async () => {
  const plan = await freeze();
  vi.stubEnv('AW_CHECK_SIGNIFICANT', 'changed');
  const execute = vi.fn(run);
  await expect(runPreparedChecks(f.root, external, plan, execute)).rejects.toThrow(
    'prepared-check-runtime-changed',
  );
  expect(execute).not.toHaveBeenCalled();
  expect(checkEnvironment(f.root, 'workflow-v1').AW_CHECK_SIGNIFICANT).toBe('changed');
  vi.stubEnv('npm_config_argv', 'legacy caller');
  expect(checkEnvironment(f.root).npm_config_argv).toBe('legacy caller');
  expect(checkEnvironment(f.root, 'workflow-v1').npm_config_argv).toBeUndefined();
  expect(checkEnvironment(f.root, 'workflow-v1').PWD).toBe(f.root);
  expect(() => checkEnvironment(f.root, 'other' as 'workflow-v1')).toThrow(
    'unknown-check-environment',
  );
});

it.each(['added', 'changed', 'removed'])(
  'rejects a %s repository source before a process or evidence package is accepted',
  async (change) => {
    const plan = await freeze();
    if (change === 'added') await f.file('new.ts', 'new dependency');
    if (change === 'changed') await f.file('source.txt', 'changed');
    if (change === 'removed') await rm(resolve(f.root, 'source.txt'));
    const execute = vi.fn(run);
    await expect(runPreparedChecks(f.root, external, plan, execute)).rejects.toThrow(
      'prepared-check-inputs-changed',
    );
    await expect(packageChecks(f.root, external, plan, [])).rejects.toThrow(
      'prepared-check-inputs-changed',
    );
    expect(execute).not.toHaveBeenCalled();
  },
);

it('discovers tracked deletions, additions and corrupt discovery without treating missing explicit dependencies as complete', async () => {
  const tracked = 'учтённый.txt';
  const untracked = 'новый.txt';
  await f.file(tracked, 'tracked');
  await f.file('.gitignore', 'ignored.txt\n');
  await f.file('ignored.txt', 'ignored');
  execFileSync('git', ['add', '--', 'source.txt', tracked], { cwd: f.root });
  const inputs = await files().capture({ files: [], directories: [], repository: true }, 'owner');
  const explicit = await files().capture(
    { files: ['source.txt'], directories: [], repository: true },
    'owner',
  );
  await f.file(untracked, 'untracked');
  await rm(resolve(f.root, 'source.txt'));
  const current = await files().current(inputs);
  expect(current.complete).toBe(true);
  const names = current.inputs.map((r) => r.locator);
  expect(names).toContain(tracked);
  expect(names).toContain(untracked);
  expect(names).not.toContain('source.txt');
  expect(names).not.toContain('ignored.txt');
  expect((await files().current(explicit)).complete).toBe(false);
  await f.file('unsafe\nname.txt', 'rejected locator');
  expect((await files().current(inputs)).complete).toBe(false);
  expect(
    (
      await files().current({
        ...inputs,
        discovery_rule: JSON.stringify({ files: [], directories: [], repository: 'bad' }),
      })
    ).complete,
  ).toBe(false);
});

it('keeps an unknown check blocked rather than silently sending another process', async () => {
  const plan = await freeze();
  const entry = (readChatArtifact(plan) as PreparedChecks).checks[0]!;
  await writeFile(
    resolve(external, 'one.intent.json'),
    JSON.stringify({ request_hash: 'unknown', request: entry.check }),
  );
  await expect(runPreparedChecks(f.root, external, plan, run)).rejects.toThrow(
    'chat-check-outcome-unknown',
  );
  await expect(readFile(count)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects incomplete maps, duplicate IDs, invalid envelopes and runtime declarations', async () => {
  await expect(freezeChecks(f.root, f.root, 'plan.md', checks)).rejects.toThrow(
    'check-results-must-be-external',
  );
  await expect(freezeChecks(f.root, external, 'plan.md', checks.slice(0, 1))).rejects.toThrow(
    'prepared-check-map-incomplete',
  );
  await expect(
    freezeChecks(f.root, external, 'plan.md', checks, [checks[0]!.check]),
  ).rejects.toThrow('duplicate-prepared-check-id');
  const plan = await freeze();
  const value = readChatArtifact(plan) as PreparedChecks;
  for (const bad of [
    { ...value, schema_version: 2 },
    {
      ...value,
      checks: value.checks.map((e) => ({ ...e, check: { ...e.check, environment: 'other' } })),
    },
    { ...value, checks: value.checks.map((e) => ({ ...e, runtime_hash: null })) },
  ]) {
    await expect(
      preparedChecks(f.root, external, saveChatArtifact(external, 'bad', bad)),
    ).rejects.toThrow();
  }
  await expect(packageChecks(f.root, external, plan, [])).rejects.toThrow(
    'prepared-check-proofs-incomplete',
  );
  checks[0]!.check.command.file = 'missing-prepared-executable';
  await expect(freeze()).rejects.toThrow('prepared-check-executable-missing');
  expect(checkRuntime(f.root, { file: 'missing-prepared-executable', args: [] })).toBeNull();
});

it('validates exact proof identities, failure markers, original FAIL and changed reuse obligations', async () => {
  const plan = await freeze();
  const entry = (readChatArtifact(plan) as PreparedChecks).checks[0]!;
  const proof = await run(entry.check);
  await preparedProof(f.root, external, entry, await ref('one.json'));
  await expect(
    preparedProof(
      f.root,
      external,
      { ...entry, runtime_hash: 'a'.repeat(64) },
      await ref('one.json'),
    ),
  ).rejects.toThrow('prepared-check-proof-not-applicable');
  const other = saveChatArtifact(external, 'copy', proof);
  await expect(preparedProof(f.root, external, entry, other)).rejects.toThrow(
    'prepared-check-proof-not-applicable',
  );
  expect(
    await reusableChatCheck(
      f.root,
      external,
      { ...entry.check, id: 'different', reuse: await ref('one.json'), reject_output: ['ready'] },
      proof.before,
    ),
  ).toBeNull();
  const rejected = await run({ ...entry.check, id: 'rejected', reject_output: ['ready'] });
  expect(rejected.check.verdict).toBe('FAIL');
  expect((await verifyChatCheck(f.root, external, rejected.check)).operation_id).toBe('rejected');
  const { criterion: _criterion, ...withoutCriterion } = entry.check;
  const fallback = { ...entry, check: { ...withoutCriterion, id: 'fallback-id' } };
  await run(fallback.check);
  expect(
    (await preparedProof(f.root, external, fallback, await ref('fallback-id.json'))).check.id,
  ).toBe('fallback-id');
  const forged = { ...rejected, check: { ...rejected.check, verdict: 'PASS' as const } };
  saveManaged(resolve(external, 'rejected.json'), forged);
  await expect(verifyChatCheck(f.root, external, forged.check)).rejects.toThrow(
    'chat-check-output-rejected',
  );
  expect(proof.check.verdict).toBe('PASS');
});

it('builds and resumes engine/import/graphics probes before the main checks and rejects unsafe import configuration', async () => {
  const project = resolve(external, 'native');
  await mkdir(project);
  await mkdir(resolve(project, 'nested'));
  await mkdir(resolve(project, '.godot'));
  await writeFile(resolve(project, '.godot/generated'), 'not source');
  await writeFile(resolve(project, 'nested/asset.txt'), 'source resource');
  await writeFile(
    resolve(project, 'project.godot'),
    '[editor]\nimport/use_multiple_threads=false\n[application]\n',
  );
  const native = { engine, project, driver: 'opengl3', id: 'native' };
  const probes = await nativeStartupChecks(native);
  expect(probes[0]!.discovery.files).not.toContain(resolve(project, '.godot/generated'));
  const plan = await freezeChecks(f.root, external, 'plan.md', checks, [], native);
  const startup = await runPreparedChecks(f.root, external, plan, run, 'preflight');
  expect(startup).toMatchObject({ scope: 'startup-only', ready: true });
  expect(await processes()).toHaveLength(3);
  await runPreparedChecks(f.root, external, plan, run);
  expect(await processes()).toHaveLength(5);
  const prepared = readChatArtifact(plan) as PreparedChecks;
  verifyPreparedRuntime(f.root, prepared);
  await writeFile(
    resolve(project, 'project.godot'),
    '[editor]\nimport/use_multiple_threads=true\n',
  );
  await expect(nativeStartupChecks(native)).rejects.toThrow(
    'native-import-must-be-single-threaded',
  );
  await expect(nativeStartupChecks({ ...native, id: 'bad/id' })).rejects.toThrow(
    'invalid-native-startup-id',
  );
});

it('stops at a failed startup probe and never launches validate', async () => {
  const probe: ChatCheckRequest = {
    ...checks[0]!.check,
    id: 'startup',
    criterion: 'startup-graphics',
    reject_output: ['ready'],
  };
  const plan = await freezeChecks(f.root, external, 'plan.md', checks, [probe]);
  await expect(runPreparedChecks(f.root, external, plan, run)).rejects.toThrow(
    'prepared-check-proof-not-applicable',
  );
  expect(await processes()).toHaveLength(1);
  expect((readChatArtifact(await ref('startup.json')) as ChatCheckProof).check.verdict).toBe(
    'FAIL',
  );
});

it('exposes preparation and packaging through the CLI without helper scripts or process execution during packaging', async () => {
  const request = resolve(external, 'prepare.json');
  const allowed = [{ file: engine, args: ['check-all'] }];
  const descriptor = { ...f.connection, validation_commands: allowed };
  checks.find((entry) => entry.criterion === 'validate')!.check.command = allowed[0]!;
  await writeFile(
    request,
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      evidence_root: external,
      card: 'plan.md',
      checks,
    }),
  );
  const output: string[] = [];
  const errors: string[] = [];
  expect(
    await runChatCommand(
      ['freeze-checks', request],
      () => {},
      (v) => errors.push(v),
    ),
  ).toBe(1);
  expect(errors).toContain('chat-validate-command-required');
  await f.file('project/workflow.json', JSON.stringify(descriptor));
  expect(
    await runChatCommand(
      ['freeze-checks', request],
      (v) => output.push(v),
      (v) => {
        throw new Error(v);
      },
    ),
  ).toBe(0);
  const plan = (JSON.parse(output[0]!) as { details: InputRef }).details;
  const result = await runPreparedChecks(
    f.root,
    external,
    plan,
    (check) => runChatCheck(f.root, external, check, undefined, allowed),
    'checks',
    undefined,
    allowed,
  );
  assert('details' in result);
  const bundle = readChatArtifact(result.details!) as { proofs: InputRef[] };
  await writeFile(
    request,
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      evidence_root: external,
      check_plan: plan,
      proofs: bundle.proofs,
      descriptor: 'project/workflow.json',
    }),
  );
  expect(
    await runChatCommand(
      ['package-checks', request],
      (v) => output.push(v),
      (v) => {
        throw new Error(v);
      },
    ),
  ).toBe(0);
  expect(JSON.parse(output[1]!) as { ready: boolean }).toMatchObject({ ready: true });
  expect(await processes()).toHaveLength(2);
});
