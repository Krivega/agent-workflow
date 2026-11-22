import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
  statSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/proto-utils';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { localPlanningRisks } from '../../dist/policy/localPlanning.js';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { startReview } from '../../dist/client/review.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import { startLocalTask } from '../../dist/client/localTask.js';
import {
  controlTaskPlanning,
  makeTaskPlanningCommand,
} from '../../dist/client/taskContinuation.js';
import { taskControlTarget } from '../../dist/policy/taskContinuation.js';
import {
  nativeReaderAuthority,
  nativeHumanAuthorizationText,
} from '../../dist/adapters/codex/readerAuthority.js';
import { qualifyFinalization, finalizationBundleOptions } from './finalizationSdk.mjs';
import { auditorRuntime } from './auditorRuntime.mjs';
import { auditParentProfile } from '../../dist/adapters/codex/nativeAudit.js';
import { NativeWriterProcesses } from '../../dist/adapters/codex/writerProcesses.js';

const [mode, model, grantFile] = process.argv.slice(2),
  finalization = [
    '--finalization',
    '--finalization-cancel-before',
    '--finalization-cancel-after',
    '--finalization-timeout-cancel',
  ].includes(mode),
  continuation = mode === '--continuation' || mode === '--requirements',
  requirementsChange = mode === '--requirements',
  progressCancel = mode === '--progress-cancel',
  progressHeld = mode === '--progress-held' || mode === '--progress-partial',
  progressSupervised =
    progressCancel ||
    progressHeld ||
    mode === '--progress-no-progress' ||
    mode === '--progress-doubt',
  progressKind = mode === '--progress-doubt' ? 'doubt' : 'no-progress',
  stageSupervisedCancel = mode === '--stage-supervised-cancel',
  stageSupervised = progressSupervised || stageSupervisedCancel || mode === '--stage-supervised',
  supervisedCancel = progressCancel || stageSupervisedCancel || mode === '--supervised-cancel',
  supervised = stageSupervised || supervisedCancel || mode === '--supervised',
  mechanical = mode === '--mechanical',
  initial = mode === '--initial-conflict',
  arbitration =
    initial || mode === '--arbitration' || Boolean(mode?.startsWith('--arbitration-fault=')),
  correction =
    !initial &&
    (arbitration || mode === '--correction' || Boolean(mode?.startsWith('--correction-fault='))),
  substantial =
    continuation ||
    supervised ||
    initial ||
    correction ||
    mode === '--substantial' ||
    Boolean(mode?.startsWith('--substantial-fault=')),
  native =
    mode === '--native' ||
    ((initial ||
      supervised ||
      mechanical ||
      continuation ||
      mode === '--substantial' ||
      mode === '--correction' ||
      mode === '--arbitration') &&
      Boolean(model)),
  maxStarts = continuation
    ? 15
    : initial
      ? 17
      : arbitration
        ? 28
        : correction
          ? mode?.endsWith('third-fail')
            ? 21
            : 16
          : substantial
            ? 11
            : mechanical
              ? 4
              : 5,
  fault = progressHeld
    ? 'progress-held'
    : supervisedCancel
      ? 'cancel-supervision'
      : mode?.startsWith('--arbitration-fault=')
        ? mode.slice('--arbitration-fault='.length)
        : mode?.startsWith('--correction-fault=')
          ? mode.slice('--correction-fault='.length)
          : mode?.startsWith('--substantial-fault=')
            ? mode.slice('--substantial-fault='.length)
            : mode?.startsWith('--fault=')
              ? mode.slice(8)
              : null;
assert.ok(
  mode === undefined ||
    (native && model) ||
    initial ||
    continuation ||
    finalization ||
    supervised ||
    mechanical ||
    mode === '--substantial' ||
    mode === '--correction' ||
    mode === '--arbitration' ||
    (arbitration &&
      [
        'no-decision',
        'compromise-held',
        'compromise-ready',
        'post-fail',
        'cancel-arbiter',
        'cancel-post-writer',
      ].includes(fault)) ||
    (correction &&
      ['exhausted', 'third-fail', 'cancel-correction-writer', 'cancel-affected'].includes(fault)) ||
    (substantial &&
      [
        'planning',
        'missing',
        'changed',
        'cancel-planning',
        'baseline',
        'acceptance',
        'cancel-writer',
        'cancel-check',
      ].includes(fault)) ||
    ['baseline', 'acceptance', 'cancel-writer', 'cancel-check'].includes(fault),
  'Pass no arguments, --fault=CASE, --native AUTHORIZED_MODEL or --mechanical [AUTHORIZED_MODEL]',
);
assert.ok(
  !finalization || !model,
  'Archive qualification is SDK-only; native archive requires a separate primary grant',
);
assert.ok(
  !native || !continuation || (requirementsChange && grantFile),
  'Native continuation requires --requirements MODEL EXPLICIT_GRANT_FILE',
);
assert.ok(
  !supervisedCancel || !native,
  'This cancellation fixture is SDK-only; native cancellation requires a separate bounded batch',
);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(join(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(
    mkdtempSync(
      join(
        packageRoot,
        continuation
          ? 'tmp/temporal-continuation-'
          : progressSupervised
            ? 'tmp/temporal-progress-'
            : supervised
              ? 'tmp/temporal-supervised-'
              : initial
                ? 'tmp/temporal-initial-conflict-'
                : arbitration
                  ? 'tmp/temporal-arbitration-'
                  : correction
                    ? 'tmp/temporal-correction-'
                    : substantial
                      ? 'tmp/temporal-substantial-'
                      : mechanical
                        ? 'tmp/temporal-m1-'
                        : 'tmp/temporal-b1-',
      ),
    ),
  ),
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-b1-'))),
  artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aw-b1-artifacts-')));
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value), { mode: 0o600 });
function readRawReplayHistory(name) {
  const saved = JSON.parse(readFileSync(join(evidence, name), 'utf8'));
  return JSON.parse(historyToJSON(saved));
}
save('locations.json', { workspace, artifactRoot, evidence });
const started = Date.now(),
  nativeDeadline = native ? started + 44 * 60_000 : Number.POSITIVE_INFINITY,
  usage = [],
  ports = [],
  children = [],
  histories = [];
const modelTurns = [],
  rpcCounts = {};
let starts = 0,
  auditStarts = 0,
  controlledStop = true,
  environment,
  handle;
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)],
  );
}
function sourceInventory() {
  return [...files(join(packageRoot, 'src')), ...files(join(packageRoot, 'dist'))]
    .sort()
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: path.slice(packageRoot.length + 1),
        sha256: digest(bytes),
        bytes: bytes.length,
      };
    });
}
const before = supervised || continuation || finalization ? sourceInventory() : null;
if (supervised || continuation || finalization) save('source-before.json', before);
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
try {
  mkdirSync(join(workspace, 'tasks'));
  const contents = {
    'RULES.md':
      'Read only unless explicitly assigned as executor. No network, helpers or background jobs. Use only declared inputs.\n',
    'reviewer.md':
      'Independently review the final local implementation against accepted.md and the full evidence packet. Check the before/after change, actual smoke/validate logs, physical stop and integration evidence. Do not implement, execute tests, or accept self-reported PASS.\n',
    'executor.md':
      'Implement only the accepted local plan in your isolated copy. No network, helpers, background jobs or tests; the host runs the registered checks. Preserve every other file.\n',
    'accepted.md':
      'Existing contract: a name is displayed after trimming surrounding whitespace; ordinary names remain unchanged. Correcting a violation changes neither the contract nor its consumers.\n',
    'owner.cjs': 'module.exports = name => name;\n',
    'consumer.cjs': "module.exports = require('./owner.cjs');\n",
    'smoke.cjs':
      "require('node:assert/strict').equal(require('./consumer.cjs')('Ada'),'Ada'); console.log('real functional smoke PASS');\n",
    'validate.test.cjs':
      "const test=require('node:test');const assert=require('node:assert/strict');const label=require('./consumer.cjs');test('accepted trimming contract',()=>{assert.equal(label(' Ada '),'Ada');assert.equal(label('Ada'),'Ada');assert.equal(label('  '),'');});\n",
    'tasks/one.md':
      '# B1 qualification\nGoal: correct the existing trimming contract locally.\nCriterion B1-01: surrounding whitespace is trimmed and ordinary names remain unchanged.\nBounds: owner.cjs only; no new behavior, contracts, storage, authority or unknown consumers.\n',
  };
  if (fault === 'baseline')
    contents['smoke.cjs'] = "throw new Error('injected real baseline FAIL');\n";
  if (fault === 'cancel-check')
    contents['smoke.cjs'] = "console.log('cancel-check-ready');setInterval(()=>{},1000);\n";
  for (const [file, body] of Object.entries(contents)) writeFileSync(join(workspace, file), body);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  if (mechanical) {
    writeFileSync(
      join(workspace, 'tasks/one.md'),
      '# M1 qualification\nGoal: apply the exact approved trimming implementation.\nCriterion M1-01: exact approved bytes and modes are integrated, whitespace is trimmed and ordinary names remain unchanged.\nBounds: owner.cjs only; no new semantics, contracts, storage, authority or unknown consumers.\n',
    );
    mkdirSync(join(workspace, 'approved'));
    writeFileSync(join(workspace, 'approved/owner.cjs'), 'module.exports = name => name.trim();\n');
    writeFileSync(
      join(workspace, 'reviewer.md'),
      'Independently assess the declared phase. During planning, check material.json exact before/after bytes and modes, complete links and trimming contract, and reject any semantic addition. During acceptance, check the exact material delta, full actual check logs, physical stop and integration evidence. Do not implement or execute tests. Do not accept self-reported PASS.\n',
    );
  }
  if (substantial) {
    writeFileSync(
      join(workspace, 'tasks/one.md'),
      '# Substantial qualification\nGoal: introduce the new trimming behavior after independent planning.\nCriterion S1: trim surrounding whitespace while preserving ordinary names.\nBounds: owner.cjs only; full consumers are declared, no storage, new authority or network.\n',
    );
    writeFileSync(
      join(workspace, 'accepted.md'),
      'Current contract: names pass through unchanged.\n',
    );
    writeFileSync(
      join(workspace, 'proposal.md'),
      'Proposal S1: introduce trimming of surrounding whitespace. Preserve ordinary names and consumers. Change only owner.cjs. Full consumers: consumer.cjs, smoke.cjs and validate.test.cjs. No storage, new authority, security changes, network or architecture.\n',
    );
    writeFileSync(
      join(workspace, 'reviewer.md'),
      'Independently assess the declared phase. During planning, assess the exact new proposal, scope, current behavior, complete consumer map and risks. During acceptance, check the actual diff against the approved proposal, full check logs, physical stop and integration. Do not implement or execute tests. Report only observed evidence.\n',
    );
    writeFileSync(
      join(workspace, 'tester.md'),
      'Independently assess the declared phase as a test specialist. During planning, assess complete criteria, baseline and planned checks for proposal S1. During acceptance, check full actual command logs, accepted behavior, scope, stop and integration evidence. Do not implement or execute tests. Reject self-reported PASS without evidence.\n',
    );
  }
  if (initial) {
    writeFileSync(
      join(workspace, 'proposal.md'),
      'Qualification alternative: preserve surrounding whitespace in names. This conflicts with S1 trimming in tasks/one.md and plan.json. The primary reviewer must confirm the exact contradiction before an independent arbiter chooses a direction preserving all mandatory criteria and checks. The arbiter may choose to follow S1; it does not accept or implement.\n',
    );
    writeFileSync(
      join(workspace, 'reviewer.md'),
      'Assess only the declared phase. In the first planning packet, explicitly confirm the contradiction between proposal.md and tasks/one.md as blocking INITIAL-CONFLICT with both exact source tuples in conflicts. Do not resolve it yourself. In replanning, check the independent arbitration direction and explicitly resolve INITIAL-CONFLICT only if all mandatory S1 criteria/checks remain. During acceptance check actual diff, full logs, stop and integration. Never implement or run tests.\n',
    );
    writeFileSync(
      join(workspace, 'tester.md'),
      'Assess the test plan and actual registered checks in the declared phase. During initial planning confirm S1 smoke/validate coverage; primary source contradiction belongs to reviewer. During replanning verify that arbitration keeps all mandatory checks and criteria. Acceptance checks actual logs, scope, stop and integration. Never implement or run tests.\n',
    );
  }
  if (requirementsChange) {
    writeFileSync(
      join(workspace, 'proposal.md'),
      'The current proposal preserves surrounding whitespace. This contradicts mandatory S1 trimming in tasks/one.md. Reject planning until a human supplies a consistent requirements revision; do not implement or resolve this contradiction yourself.\n',
    );
  }
  if (correction) {
    writeFileSync(
      join(workspace, 'tasks/one.md'),
      '# C1 addressed correction\nGoal: implement two independent modules. Criterion C1: owner.cjs trims surrounding whitespace and side.cjs exports 11. No DEBUG_MARKER may remain in either module. Keep known scopes and registered checks.\n',
    );
    writeFileSync(
      join(workspace, 'proposal.md'),
      'Proposal C1: owner.cjs trims names, side.cjs exports 11. Both must contain no DEBUG_MARKER. These modules are independent; preserve all other files. Full consumers: consumer.cjs, smoke.cjs, validate.test.cjs and side-check.cjs. No new authority, storage, network or architecture.\n',
    );
    writeFileSync(join(workspace, 'side.cjs'), 'module.exports = 7;\n');
    writeFileSync(
      join(workspace, 'side-check.cjs'),
      "require('node:assert/strict').equal(require('./side.cjs'),11);console.log('side PASS');\n",
    );
    writeFileSync(
      join(workspace, 'reviewer.md'),
      'Review only owner.cjs and its declared dependencies in the declared phase. Planning assesses the proposal and checks before implementation. Acceptance must verify trimming and absence of DEBUG_MARKER in the actual file/diff. If DEBUG_MARKER is present, report blocking finding C1-DEBUG; if it has been removed, verify closure explicitly in resolved. Read the complete own evidence packet. Do not implement or run tests.\n',
    );
    writeFileSync(
      join(workspace, 'tester.md'),
      'Review only the independent side.cjs module and side-check.cjs in the declared phase. Planning assesses the proposed value 11 and its check. Acceptance verifies the actual value 11 and absence of DEBUG_MARKER in side.cjs using full own evidence. Owner.cjs belongs to another reviewer. Do not implement or run tests.\n',
    );
  }
  if (arbitration)
    writeFileSync(
      join(workspace, 'arbiter.md'),
      readFileSync(join(packageRoot, 'procedures/arbitration.md')),
    );
  if (supervised) {
    mkdirSync(join(workspace, '.codex/agents'), { recursive: true });
    writeFileSync(
      join(workspace, 'auditor.toml'),
      native
        ? readFileSync(join(packageRoot, '.codex/agents/auditor.toml'))
        : `name = "auditor"
description = "Independent auditor in SDK qualification."
model = "gpt-6.2-sol"
model_reasoning_effort = "xhigh"
developer_instructions = "Read only the technical LOAD and immutable audit card. Never implement, delegate or grant acceptance."
[features]
apps = false
plugins = false
memories = false
request_permissions_tool = false
`,
    );
    if (native) {
      cpSync(
        join(packageRoot, '.codex/agents/auditor.toml'),
        join(workspace, '.codex/agents/auditor.toml'),
      );
      mkdirSync(join(workspace, 'procedures'), { recursive: true });
      for (const name of ['audit', 'evidence'])
        cpSync(
          join(packageRoot, 'procedures', name + '.md'),
          join(workspace, 'procedures', name + '.md'),
        );
    }
  }
  const project = {
    schemaVersion: 1,
    projectId: continuation
      ? 'neutral-continuation'
      : progressSupervised
        ? 'neutral-progress'
        : supervised
          ? 'neutral-supervised'
          : initial
            ? 'neutral-initial-conflict'
            : correction
              ? 'neutral-correction'
              : substantial
                ? 'neutral-substantial'
                : mechanical
                  ? 'neutral-m1'
                  : 'neutral-b1',
    workspaceId: 'isolated',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [
      { id: 'reviewer', profile: 'reviewer.md' },
      ...(substantial ? [{ id: 'tester', profile: 'tester.md' }] : []),
      ...(supervised ? [{ id: 'auditor', profile: 'auditor.toml' }] : []),
      ...(arbitration ? [{ id: 'arbiter', profile: 'arbiter.md' }] : []),
    ],
    checks: ['smoke', 'validate', ...(correction ? ['side'] : [])],
  };
  const preparation = {
    schemaVersion: 1,
    project,
    taskId: 'one',
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    revision: 1,
    card: 'tasks/one.md',
  };
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot,
    commands: {
      ...(correction
        ? { side: { executable: process.execPath, args: ['side-check.cjs'], timeoutMs: 30000 } }
        : {}),
      smoke: { executable: process.execPath, args: ['smoke.cjs'], timeoutMs: 30000 },
      validate: {
        executable: process.execPath,
        args: ['--test', 'validate.test.cjs'],
        timeoutMs: 30000,
      },
    },
  };
  const store = artifactStore(registration.artifactRoot),
    record = (value) => store.publish(Buffer.from(JSON.stringify(value))),
    read = (ref) => JSON.parse(store.read(ref).toString());
  const ref = (locator) => ({ locator, hash: digest(readFileSync(join(workspace, locator))) });
  const plan = {
    schema_version: substantial ? 2 : 1,
    ...(substantial ? { plan_id: correction ? 'C1' : 'S1' } : {}),
    requirement: ref('tasks/one.md'),
    basis: [ref('accepted.md'), ...(substantial ? [ref('proposal.md')] : [])],
    owner: ref('owner.cjs'),
    consumers: [
      'consumer.cjs',
      'smoke.cjs',
      'validate.test.cjs',
      ...(correction ? ['side.cjs', 'side-check.cjs'] : []),
    ].map(ref),
    consumers_complete: true,
    paths: ['owner.cjs', ...(correction ? ['side.cjs'] : [])],
    risks: Object.fromEntries(
      localPlanningRisks.map((r) => [
        r,
        substantial && ['new_behavior', 'new_contract'].includes(r),
      ]),
    ),
    reason: correction
      ? 'Implement C1 in two independent module scopes with an explicit bounded correction budget'
      : substantial
        ? 'Introduce proposal S1 after independent planning with a complete consumer map'
        : 'Correct the implementation of an already accepted local contract with a complete consumer map',
    checks: ['smoke', 'validate', ...(correction ? ['side'] : [])],
    criterion: correction
      ? 'C1: owner trims names; independent side exports 11; neither contains DEBUG_MARKER'
      : substantial
        ? 'S1: introduce trimming while preserving ordinary names'
        : 'B1-01: whitespace is trimmed and ordinary names remain unchanged',
  };
  if (substantial && fault === 'missing')
    plan.basis.push({ locator: 'missing.md', hash: ref('proposal.md').hash });
  const bytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(join(workspace, 'plan.json'), bytes);
  const material = mechanical
    ? {
        schemaVersion: 1,
        kind: 'mechanical-material',
        materialId: 'M1-01',
        requirement: ref('tasks/one.md'),
        links: ['accepted.md', 'consumer.cjs', 'smoke.cjs', 'validate.test.cjs'].map(ref),
        linksComplete: true,
        semanticDelta: false,
        files: [
          {
            path: 'owner.cjs',
            before: {
              content: store.publish(readFileSync(join(workspace, 'owner.cjs'))),
              mode: statSync(join(workspace, 'owner.cjs')).mode & 0o777,
            },
            after: {
              source: ref('approved/owner.cjs'),
              mode: statSync(join(workspace, 'owner.cjs')).mode & 0o777,
            },
          },
        ],
        checks: ['smoke', 'validate'],
        criterion:
          'M1-01: apply the exact approved trimming implementation without semantic additions',
      }
    : null;
  if (mechanical) writeFileSync(join(workspace, 'material.json'), JSON.stringify(material));
  const acceptance = record({
    ...(supervised
      ? {
          schemaVersion: 2,
          evidence: [
            record(
              progressSupervised
                ? {
                    kind: 'controlled-progress-checkpoint',
                    cause:
                      'The neutral project explicitly requests independent assessment after completed planning and baseline, before the first writer. This is a caller-reported no-progress/doubt concern, not evidence that a model is stalled. Use the original goal, primary answers and completed chain; preserve every actual finding and mandatory check. No internal delay is injected.',
                  }
                : {
                    kind: stageSupervised ? 'controlled-writing-wait' : 'controlled-planning-wait',
                    cause: stageSupervised
                      ? 'The fixture deliberately withholds observation of the original writer completion until the first auditor turn. This is a bounded internal wait, not an external wait or a spontaneously stalled model. Maximum wait 120000 ms. Retain the original operation, every actual finding and all checks.'
                      : 'The fixture deliberately withholds completed LOAD observations until the first auditor turn. This is a bounded internal wait, not an external wait or a spontaneously stalled model. Maximum wait 120000 ms. Complete the original council after audit release; retain every actual finding and all checks.',
                  },
            ),
          ],
          expectedFiles: [],
        }
      : arbitration
        ? {
            schemaVersion: 2,
            evidence: [
              record({
                kind: initial
                  ? 'controlled-initial-conflict-qualification'
                  : 'controlled-arbitration-qualification',
                fault: initial
                  ? 'The fixture declares a primary contradiction between the alternative proposal and the mandatory S1 task criterion. No writer may start before independent direction and repeated planning.'
                  : 'The fixture reinjects DEBUG_MARKER after the first three completed implementations before the host captures their bytes. It stops this injection before the fourth writer.',
                authority: initial
                  ? 'The neutral fixture allows an independent direction retaining S1 and all checks; no compromise is authorized. Preserve the original conflict and rerun applicable planning before any writer.'
                  : 'This is a declared synthetic fault source, not a spontaneous model defect. Each FAIL must still be derived from actual bytes; the arbiter must not close the finding. After the three confirmed FAIL, a direction may request a narrow correction of owner.cjs. All mandatory criteria, checks, physical stops and original affected review remain required.',
              }),
            ],
            expectedFiles: [],
          }
        : { schemaVersion: 1 }),
    phase: 'acceptance',
    scope: correction ? 'C1' : substantial ? 'S1' : mechanical ? 'M1-01' : 'B1-01',
    sharedPaths: [
      ...(mechanical ? ['material.json', 'approved/owner.cjs'] : []),
      ...(substantial ? ['plan.json', 'proposal.md'] : []),
      'accepted.md',
      ...(correction ? [] : ['consumer.cjs', 'smoke.cjs', 'validate.test.cjs']),
    ],
    roles: project.roles.map((role) => ({
      roleId: role.id,
      applies: role.id !== 'arbiter' && role.id !== 'auditor',
      reason: substantial
        ? 'New proposed behavior and independent assessment of the declared phase'
        : 'Local contract parity and independent verification of actual evidence',
      paths:
        role.id === 'arbiter' || role.id === 'auditor'
          ? []
          : correction
            ? role.id === 'reviewer'
              ? ['owner.cjs', 'consumer.cjs', 'smoke.cjs', 'validate.test.cjs']
              : ['side.cjs', 'side-check.cjs']
            : ['owner.cjs'],
      complete: true,
      attestedBy: 'qualification project adapter',
      discoveryRule: 'declared local module and both real consumers/checks',
      history: { complete: true, answers: [] },
    })),
  });
  let input = {
    schemaVersion: 1,
    admission: {
      schemaVersion: 1,
      preparation,
      plan: { path: 'plan.json', sha256: digest(bytes) },
      acceptance,
    },
    executor: { path: 'executor.md', sha256: digest(contents['executor.md']) },
    baseline: 'smoke',
  };
  if (substantial)
    input = {
      schemaVersion: 3,
      admission: {
        schemaVersion: 3,
        preparation,
        plan: { path: 'plan.json', sha256: digest(bytes) },
        planning: record({ ...read(acceptance), phase: 'planning' }),
        acceptance,
      },
      executor: input.executor,
      baseline: 'smoke',
    };
  if (supervised)
    input = stageSupervised
      ? {
          ...input,
          schemaVersion: 8,
          audit: {
            planningEstimateMs: 120000,
            stages: {
              baseline: 10000,
              writing: progressSupervised ? 120000 : native ? 15000 : 100,
              'candidate-checks': 20000,
              integration: 10000,
              'integrated-checks': 20000,
              acceptance: 120000,
            },
          },
        }
      : { ...input, schemaVersion: 7, audit: { planningEstimateMs: native ? 15000 : 100 } };
  if (continuation)
    input = { ...input, schemaVersion: 10, continuation: { attempt: 0, previous: null } };
  if (progressSupervised) {
    const goal = {
      path: plan.requirement.locator,
      ...store.publish(readFileSync(join(workspace, plan.requirement.locator))),
    };
    const note = record({
      schemaVersion: 1,
      kind: 'task-progress-request',
      preparation,
      checkpoint: 'before-writing',
      trigger: progressKind,
      goal,
      evidence: [
        record({
          kind: 'primary-progress-concern',
          source: 'neutral qualification project adapter',
          reason:
            'Assess whether the completed preparation and the proposed first implementation advance the exact original task. The concern alone does not establish a lack of progress; no model result or future check is asserted.',
        }),
      ],
      reason:
        'Нужна независимая оценка приближения к исходной цели после подготовки; причина обращения сама по себе не доказывает отсутствие прогресса.',
    });
    input = {
      ...input,
      schemaVersion: 9,
      progress: { checkpoint: 'before-writing', trigger: { kind: progressKind, evidence: note } },
    };
    save('progress-request.json', {
      input: input.progress,
      note: read(note),
      location: 'after-baseline-before-writing',
      stage: null,
      estimateMs: null,
      stageElapsedMs: null,
      modelWaitInjected: false,
    });
  }
  if (supervised && !progressSupervised)
    save('controlled-planning-wait.json', {
      kind: 'qualification-internal-wait',
      stage: stageSupervised ? 'writing' : 'planning',
      reason:
        'Withhold the selected original operation completion until the first auditor launch to exercise the durable 2x checkpoint. This is internal elapsed time, not an external wait or a spontaneous model slowdown.',
      planningEstimateMs: input.audit.planningEstimateMs,
      stageEstimateMs: stageSupervised
        ? input.audit.stages.writing
        : input.audit.planningEstimateMs,
      maximumInternalWaitMs: 120000,
      mainMaximumStarts: maxStarts,
      auditorMaximumStarts: 4,
    });
  if (correction)
    input = {
      ...input,
      schemaVersion: 4,
      corrections: {
        maxRounds: arbitration || fault === 'third-fail' ? 2 : 1,
        checks: [
          { roleId: 'reviewer', commands: ['smoke', 'validate'] },
          { roleId: 'tester', commands: ['side'] },
          ...(arbitration ? [{ roleId: 'arbiter', commands: [] }] : []),
        ],
      },
    };
  const arbiterProfile = {
    model: model ?? 'test-reader',
    effort: 'high',
    clientVersion: '0.154.0',
  };
  if (arbitration)
    input = {
      ...input,
      schemaVersion: initial ? 6 : 5,
      arbitration: {
        roleId: 'arbiter',
        profile: arbiterProfile,
        ...(!initial
          ? {
              compromiseFindings:
                fault === 'compromise-ready' ? [{ roleId: 'reviewer', findingId: 'C1-DEBUG' }] : [],
            }
          : {}),
      },
    };
  const planningInput = mechanical
    ? {
        schemaVersion: 1,
        preparation,
        reviewId: 'M1-planning',
        request: record({
          ...read(acceptance),
          phase: 'planning',
          scope: material.materialId,
        }),
      }
    : null;
  let planningResult,
    writerRuntimes = 0;
  const profile = { model: model ?? 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
  let releasePlanning;
  const planningWait = new Promise((done) => {
    releasePlanning = done;
  });
  function counted(port) {
    const wrapped = {
      pid: port.pid,
      initialize: () => port.initialize(),
      close: () => port.close(),
      async completed(...args) {
        await port.completed(...args);
        if (
          supervised &&
          !progressSupervised &&
          (stageSupervised ? Boolean(wrapped.writerRoot) : !wrapped.writerRoot)
        ) {
          const signal = globalThis.AbortSignal.any([
            ...(args[2] ? [args[2]] : []),
            globalThis.AbortSignal.timeout(120000),
          ]);
          signal?.throwIfAborted();
          let interrupted;
          try {
            await Promise.race([
              planningWait,
              new Promise((_, reject) => {
                interrupted = () => reject(signal.reason);
                signal?.addEventListener('abort', interrupted, { once: true });
              }),
            ]);
          } finally {
            if (interrupted) signal?.removeEventListener('abort', interrupted);
          }
        }
        if (native && correction && wrapped.writerRoot) {
          const turn = modelTurns.find((t) => t.session === args[0] && t.turn === args[1]);
          if (
            turn?.operation.includes('task-implement-') &&
            (wrapped.writerRound <= (arbitration ? 3 : 1) ||
              ['exhausted', 'third-fail', 'post-fail'].includes(fault))
          ) {
            writeFileSync(
              join(wrapped.writerRoot, 'owner.cjs'),
              readFileSync(join(wrapped.writerRoot, 'owner.cjs'), 'utf8') +
                '// DEBUG_MARKER round ' +
                wrapped.writerRound +
                '\n',
            );
            save('fault-injection-' + wrapped.writerRound + '.json', {
              kind: 'injected-acceptance-defect',
              session: args[0],
              turn: args[1],
              path: 'owner.cjs',
              stage: 'after native implementation completion, before host candidate snapshot',
              marker: 'DEBUG_MARKER',
              modelStarts: 0,
            });
          }
        }
        const turn = modelTurns.find((turn) => turn.session === args[0] && turn.turn === args[1]);
        if (turn && turn.completedAt == null) turn.completedAt = Date.now();
      },
      async request(method, params) {
        if (supervisedCancel && method === 'turn/interrupt') releasePlanning();
        rpcCounts[method] = (rpcCounts[method] ?? 0) + 1;
        let turn;
        if (method === 'turn/start') {
          assert.ok(Date.now() < nativeDeadline, 'Native observation budget exhausted');
          assert.ok(starts < maxStarts, `Qualification batch permits ${maxStarts} turn starts`);
          starts++;
          turn = {
            session: params.threadId,
            startedAt: Date.now(),
            operation: params.input[0].text.split('\n')[0],
          };
          modelTurns.push(turn);
        }
        const result = await port.request(method, params);
        if (turn) {
          turn.turn = result.turn.id;
          turn.acceptedAt = Date.now();
        }
        return result;
      },
    };
    return wrapped;
  }
  let readerRpc, createRuntime;
  let disabled = [];
  if (native) {
    assert.equal(
      execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      'codex-cli 0.154.0',
    );
    const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
    const base = [
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.multi_agent=false',
    ];
    const probe = new StdioAppServer(
      'codex',
      [...base, 'app-server', '--stdio'],
      workspace,
      join(evidence, 'probe.jsonl'),
    );
    ports.push(probe);
    await probe.initialize();
    const inventory = await probe.request('mcpServerStatus/list', {
      limit: 100,
      detail: 'toolsAndAuthOnly',
    });
    assert.ok(Array.isArray(inventory.data) && inventory.nextCursor == null);
    disabled = inventory.data.map((server) => server.name);
    for (const name of disabled) assert.match(name, /^[A-Za-z0-9_-]+$/u);
    save('tool-inventory.json', { disabled, inventory });
    probe.close();
    const args = [
      ...base,
      ...disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
      'app-server',
      '--stdio',
    ];
    function port(root, label) {
      const rpc = new StdioAppServer('codex', args, root, join(evidence, label + '.jsonl'));
      rpc.observe((message) => {
        if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
      });
      ports.push(rpc);
      return counted(rpc);
    }
    readerRpc = port(workspace, 'reader-rpc');
    await readerRpc.initialize();
    createRuntime = (root) => {
      const rpc = port(root, correction ? 'writer-rpc-' + writerRuntimes : 'writer-rpc');
      rpc.writerRoot = root;
      rpc.writerRound = writerRuntimes;
      return rpc;
    };
  } else {
    let threadSerial = 0;
    function fake(root, writer) {
      const writerRound = writerRuntimes;
      let interrupted,
        wasInterrupted = false;
      const child = writer
        ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            cwd: root,
            stdio: 'ignore',
          })
        : null;
      if (child) children.push(child);
      const threads = new Map();
      const rpc = {
        pid: child?.pid,
        async initialize() {},
        close() {},
        async completed(session, turn) {
          if (
            ((((writer &&
              (fault === 'cancel-writer' ||
                (fault === 'cancel-correction-writer' && writerRound === 2))) ||
              (!writer &&
                (fault === 'cancel-planning' || (supervisedCancel && !stageSupervised)))) &&
              turn === 'turn-1') ||
              (!writer && fault === 'cancel-affected' && turn === 'turn-3') ||
              (!writer &&
                fault === 'cancel-arbiter' &&
                session === 'reader-8' &&
                turn === 'turn-1') ||
              (writer &&
                fault === 'cancel-post-writer' &&
                writerRound === 4 &&
                turn === 'turn-1')) &&
            !wasInterrupted
          )
            await new Promise((done) => {
              interrupted = done;
            });
        },
        async request(method, params) {
          if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
          if (method === 'model/list')
            return {
              data: [
                {
                  model: profile.model,
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'medium' },
                    { reasoningEffort: 'high' },
                  ],
                },
              ],
            };
          if (method === 'thread/start' || method === 'thread/resume') {
            const thread = threads.get(params.threadId) ?? {
              id: (writer ? 'writer-' : 'reader-') + ++threadSerial,
              cwd: root,
              path: join(evidence, 'fake-transcript-' + threadSerial + '.jsonl'),
              turns: [],
              forkedFromId: null,
              parentThreadId: null,
              projectId: null,
            };
            threads.set(thread.id, thread);
            return {
              cwd: root,
              model: profile.model,
              reasoningEffort: params.config.model_reasoning_effort,
              approvalPolicy: 'never',
              sandbox: writer
                ? {
                    type: 'workspaceWrite',
                    networkAccess: false,
                    excludeSlashTmp: true,
                    excludeTmpdirEnvVar: true,
                    writableRoots: [root],
                  }
                : { type: 'readOnly', networkAccess: false },
              thread: globalThis.structuredClone(thread),
            };
          }
          if (method === 'thread/loaded/list')
            return { data: [...threads.keys()], nextCursor: null };
          if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
          if (method === 'turn/interrupt') {
            const thread = threads.get(params.threadId);
            thread.turns.find((t) => t.id === params.turnId).status = 'interrupted';
            wasInterrupted = true;
            interrupted?.();
            return {};
          }
          if (method === 'thread/read')
            return { thread: globalThis.structuredClone(threads.get(params.threadId)) };
          if (method === 'turn/start') {
            const thread = threads.get(params.threadId),
              text = params.input[0].text,
              offset = text.indexOf('Пути и хеши: ');
            let items;
            if (offset >= 0) {
              const refs = JSON.parse(
                text.slice(offset + 'Пути и хеши: '.length, text.indexOf('. Для больших', offset)),
              );
              items = [
                {
                  type: 'commandExecution',
                  status: 'completed',
                  exitCode: 0,
                  aggregatedOutput: refs
                    .map((ref) =>
                      JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }),
                    )
                    .join('\n'),
                },
              ];
            } else if (writer) {
              if (text.includes('Выполни локальный план')) {
                writeFileSync(
                  join(root, 'owner.cjs'),
                  'module.exports = name => name.trim();\n' +
                    (correction &&
                    (writerRound <= (arbitration ? 3 : 1) ||
                      ['exhausted', 'third-fail', 'post-fail'].includes(fault))
                      ? '// DEBUG_MARKER round ' + writerRound + '\n'
                      : ''),
                );
                if (correction && writerRound === 1)
                  writeFileSync(join(root, 'side.cjs'), 'module.exports = 11;\n');
              }
              items = [{ type: 'agentMessage', text: 'Local implementation candidate.' }];
            } else {
              const begin = text.indexOf('Markdown: ') + 'Markdown: '.length,
                report = JSON.parse(text.slice(begin, text.indexOf('. PASS несовместим', begin)));
              const reject =
                (correction &&
                  report.phase === 'acceptance' &&
                  report.roleId === 'reviewer' &&
                  readFileSync(join(workspace, 'owner.cjs'), 'utf8').includes('DEBUG_MARKER')) ||
                (fault === 'acceptance' && report.phase === 'acceptance') ||
                (fault === 'planning' && report.phase === 'planning') ||
                (continuation && report.phase === 'planning' && starts <= 4);
              Object.assign(report, {
                verdict: reject ? 'FAIL' : 'PASS',
                coverage: 'complete',
                findings: reject
                  ? [
                      {
                        id: correction ? 'C1-DEBUG' : 'injected',
                        blocking: true,
                        text: correction
                          ? 'Remove DEBUG_MARKER from owner.cjs without changing accepted behavior'
                          : 'Independent rejection',
                      },
                    ]
                  : [],
                limitations: [],
              });
              if (substantial && fault === 'changed' && report.phase === 'planning' && starts === 4)
                writeFileSync(join(workspace, 'proposal.md'), 'changed during planning');
              if (report.schemaVersion === 4 && report.roleId === 'reviewer') {
                report.verdict = 'FAIL';
                report.findings = [
                  {
                    id: 'INITIAL-CONFLICT',
                    blocking: true,
                    text: 'proposal.md contradicts mandatory S1 trimming in tasks/one.md',
                  },
                ];
                report.conflicts = [
                  {
                    findingId: 'INITIAL-CONFLICT',
                    sources: read(report.review).files.filter((f) =>
                      ['proposal.md', 'tasks/one.md'].includes(f.path),
                    ),
                  },
                ];
              }
              if (report.schemaVersion === 3) {
                report.verdict = 'NOT RUN';
                report.findings = [];
                report.decision =
                  fault === 'no-decision'
                    ? {
                        kind: 'no-decision',
                        mandatoryDefect: null,
                        direction: null,
                        exception: null,
                        residualRisk: null,
                        dissent: [],
                        condition: 'Need a concrete source decision before further writing',
                      }
                    : fault?.startsWith('compromise-')
                      ? {
                          kind: 'compromise',
                          mandatoryDefect: fault !== 'compromise-ready',
                          direction: 'Remove the marker and preserve all mandatory checks',
                          exception:
                            'Only the declared disputed finding is eligible, no criterion or check waived',
                          residualRisk: 'The original dissent remains visible',
                          dissent: ['Original FAIL retained'],
                          condition: null,
                        }
                      : {
                          kind: 'direction',
                          mandatoryDefect: true,
                          direction: initial
                            ? 'Follow mandatory S1 trimming in tasks/one.md. Discard the conflicting alternative proposal; preserve every check, scope and criterion. Repeat applicable planning before writer.'
                            : 'Remove DEBUG_MARKER from owner.cjs. Keep side.cjs and all criteria/checks unchanged',
                          exception: null,
                          residualRisk: null,
                          dissent: ['Original FAIL remains until affected review'],
                          condition: null,
                        };
              }
              if (report.schemaVersion === 2) {
                const marker = 'Открытые finding IDs: ',
                  offset = text.indexOf(marker);
                report.resolved =
                  !reject && offset >= 0
                    ? JSON.parse(
                        text.slice(offset + marker.length, text.indexOf('. В resolved', offset)),
                      )
                    : [];
              }
              items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
            }
            const turn = {
              id: 'turn-' + (thread.turns.length + 1),
              status: 'completed',
              items: [{ type: 'userMessage', content: params.input }, ...items],
            };
            thread.turns.push(turn);
            if (
              (((writer &&
                (fault === 'cancel-writer' ||
                  (fault === 'cancel-correction-writer' && writerRound === 2))) ||
                (!writer &&
                  (fault === 'cancel-planning' || (supervisedCancel && !stageSupervised)))) &&
                turn.id === 'turn-1') ||
              (!writer && fault === 'cancel-affected' && turn.id === 'turn-3') ||
              (!writer &&
                fault === 'cancel-arbiter' &&
                thread.id === 'reader-8' &&
                turn.id === 'turn-1') ||
              (writer &&
                fault === 'cancel-post-writer' &&
                writerRound === 4 &&
                turn.id === 'turn-1')
            )
              turn.status = 'inProgress';
            if (writer) {
              const contexts = thread.turns.map((t) => ({
                type: 'turn_context',
                payload: {
                  turn_id: t.id,
                  cwd: root,
                  model: profile.model,
                  effort: 'medium',
                  approval_policy: 'never',
                  sandbox_policy: {
                    type: 'workspace-write',
                    network_access: false,
                    exclude_slash_tmp: true,
                    exclude_tmpdir_env_var: true,
                  },
                  permission_profile: {
                    type: 'managed',
                    network: 'restricted',
                    file_system: {
                      type: 'restricted',
                      entries: [{ access: 'write', path: { type: 'path', path: root } }],
                    },
                  },
                },
              }));
              writeFileSync(
                thread.path,
                [
                  {
                    type: 'session_meta',
                    payload: { id: thread.id, cwd: root, cli_version: profile.clientVersion },
                  },
                  ...contexts,
                ]
                  .map((r) => JSON.stringify(r))
                  .join('\n') + '\n',
              );
            }
            return { turn: { id: turn.id } };
          }
          throw new Error('Unexpected qualification RPC ' + method);
        },
      };
      return counted(rpc);
    }
    readerRpc = fake(workspace, false);
    createRuntime = (root) => fake(root, true);
  }
  const nativeFactory = createRuntime;
  createRuntime = (root) => {
    writerRuntimes++;
    return nativeFactory(root);
  };
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      dbFilename: join(evidence, 'temporal.sqlite'),
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: join(packageRoot, 'tmp/temporal-downloads'),
      },
    },
  });
  bindTaskBackendClient(environment.client, registration);
  const workflowsPath = join(packageRoot, 'dist/workflows/localTask.js'),
    queue = correction
      ? 'correction-qualification'
      : substantial
        ? 'substantial-qualification'
        : mechanical
          ? 'm1-qualification'
          : 'b1-qualification';
  let auditorRpc, auditPort;
  if (supervised) {
    let runtime;
    if (native) {
      const binary =
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
      assert.equal(
        execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
        'codex-cli ' + auditParentProfile.clientVersion,
      );
      const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
      auditPort = new StdioAppServer(
        binary,
        [
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.memories=false',
          '-c',
          `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
          'app-server',
          '--stdio',
        ],
        workspace,
        join(evidence, 'auditor-rpc.jsonl'),
      );
      auditPort.observe((message) => {
        if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
      });
      ports.push(auditPort);
      await auditPort.initialize();
    } else {
      runtime = auditorRuntime(
        {
          root: evidence,
          workspace,
          store,
          response: {
            cwd: workspace,
            model: auditParentProfile.model,
            reasoningEffort: 'medium',
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
            thread: {
              id: 'parent',
              cwd: workspace,
              projectId: null,
              parentThreadId: null,
              forkedFromId: null,
              turns: [],
            },
          },
        },
        auditParentProfile,
      );
      runtime.state.loadPending = supervisedCancel;
      if (progressHeld) {
        runtime.state.coverage = mode === '--progress-partial' ? 'partial' : 'complete';
        runtime.state.direction = mode === '--progress-partial' ? null : 'replace-approach';
      }
      auditPort = runtime.rpc;
    }
    auditorRpc = {
      completed: (...args) => auditPort.completed(...args),
      async request(method, params) {
        if (method === 'turn/start') {
          assert.ok(
            auditStarts + 2 <= 4,
            'The separate audit batch permits four starts including both child turns',
          );
          auditStarts += 2;
          if (runtime) {
            const bindings = files(join(evidence, 'audit-host'))
              .filter((path) => path.endsWith('/binding.json'))
              .map((path) => JSON.parse(readFileSync(path, 'utf8')))
              .filter(
                (value) =>
                  value.auditId ===
                  (progressSupervised
                    ? 'progress-before-writing'
                    : stageSupervised
                      ? 'writing-overrun'
                      : 'planning-overrun'),
              );
            assert.equal(bindings.length, 1);
            runtime.bind(bindings[0]);
          }
          if (!supervisedCancel) releasePlanning();
        }
        return auditPort.request(method, params);
      },
    };
  }
  let continuationAuthority = null;
  const host = await createReaderHost(
    environment.nativeConnection,
    queue,
    workflowsPath,
    [
      {
        registration,
        rpc: readerRpc,
        authority: {
          async verify(command) {
            if (continuation) {
              if (native) {
                assert.ok(continuationAuthority, 'A primary native human grant is required');
                return continuationAuthority.verify(command);
              }
              return {
                origin: 'human',
                author: command.author,
                hash: command.hash,
                proof: record({ kind: 'simulated-human-command', command, native: false }),
              };
            }
            throw new Error('No human RESUME in B1 qualification');
          },
        },
        localTasks: {
          profile,
          createRuntime,
          disabledServers: disabled,
          ...(supervised ? { auditorRpc } : {}),
          ...(arbitration ? { arbiter: { roleId: 'arbiter', profile: arbiterProfile } } : {}),
        },
      },
    ],
    profile,
    join(evidence, 'host'),
    arbitration ? maxStarts - 2 : maxStarts,
  );
  const arbiterHost = arbitration
    ? await createReaderHost(
        environment.nativeConnection,
        queue + '.arbitration',
        workflowsPath,
        [
          {
            registration,
            rpc: readerRpc,
            authority: {
              async verify() {
                throw new Error('No human RESUME in arbitration qualification');
              },
            },
          },
        ],
        arbiterProfile,
        join(evidence, 'arbiter-host'),
        2,
      )
    : null;
  const auditHost = supervised
    ? await createReaderHost(
        environment.nativeConnection,
        queue + '.audit',
        workflowsPath,
        [
          {
            registration,
            rpc: auditorRpc,
            auditor: true,
            authority: {
              async verify() {
                throw new Error('No human commands in planning audit qualification');
              },
            },
          },
        ],
        auditParentProfile,
        join(evidence, 'audit-host'),
        4,
      )
    : null;
  const runMain = (run) =>
    arbiterHost === null ? host.runUntil(run) : arbiterHost.runUntil(() => host.runUntil(run));
  const runHosts = (run) =>
    auditHost === null ? runMain(run) : auditHost.runUntil(() => runMain(run));
  await environment.client.connection.withDeadline(
    Math.min(Date.now() + 45 * 60_000, nativeDeadline),
    () =>
      runHosts(async () => {
        if (mechanical) {
          const planning = await startReview(environment.client, planningInput, queue);
          planningResult = await planning.result();
          save('planning-result.json', planningResult);
          assert.equal(planningResult.complete, true, JSON.stringify(planningResult));
          input = {
            schemaVersion: 2,
            admission: {
              schemaVersion: 2,
              preparation,
              plan: { path: 'material.json', sha256: ref('material.json').hash },
              accepted: planningResult.manifest,
              acceptance,
            },
            baseline: 'smoke',
          };
        }
        controlledStop = false;
        handle = await startLocalTask(environment.client, input, queue);
        if (continuation) {
          const until = Math.min(Date.now() + (native ? 2700000 : 30000), nativeDeadline);
          let held;
          while (!held) {
            const status = await handle.query('localTaskStatus');
            if (status.phase === 'waiting-human') held = status.continuation.held;
            assert.ok(Date.now() < until, 'The task must reach confirmed held planning');
            if (!held) await new Promise((done) => setTimeout(done, 50));
          }
          assert.equal(writerRuntimes, 0);
          assert.equal(starts, 4);
          const initialFailure = read(read(held).review);
          assert.equal(initialFailure.complete, false);
          save('held-planning.json', { held, record: read(held), initialFailure });
          save('pending-main-history.json', await handle.fetchHistory());
          save('pending-source-before.json', before);
          let admission = input.admission;
          if (requirementsChange) {
            writeFileSync(
              join(workspace, 'proposal.md'),
              'Human clarification S1: introduce trimming of surrounding whitespace while preserving ordinary names and every mandatory check. The earlier contradictory proposal is withdrawn. Change only owner.cjs.\n',
            );
            const nextPlan = { ...plan, basis: [ref('accepted.md'), ref('proposal.md')] };
            const nextBytes = Buffer.from(JSON.stringify(nextPlan));
            writeFileSync(join(workspace, 'plan.json'), nextBytes);
            admission = {
              ...admission,
              preparation: { ...preparation, revision: preparation.revision + 1 },
              plan: { path: 'plan.json', sha256: digest(nextBytes) },
            };
          }
          const payload = record({
            schemaVersion: 1,
            kind: 'task-planning-resume',
            held,
            admission,
          });
          const template = {
            schemaVersion: 2,
            commandId: 'resume-planning',
            target: taskControlTarget(input),
            expectedRevision: 0,
            author: preparation.owner,
            action: 'resume',
            attempt: 1,
            payload,
          };
          save('task-resume-pending.json', {
            native,
            template,
            held,
            artifactRoot,
            workspace,
            grantFile: grantFile ?? null,
            humanAuthorization: nativeHumanAuthorizationText(template),
            primaryFailure: { review: read(held).review, complete: false },
            budget: {
              maxTurnStarts: maxStarts,
              usedTurnStarts: starts,
              remainingTurnStarts: maxStarts - starts,
              observationMs: 2700000,
              model: profile.model,
              effort: profile.effort,
            },
            primarySource: {
              supportedClientVersions: ['0.164.0-alpha.11.1', '0.165.0-alpha.1.2'],
              requiredSessionIdEqualsThreadId: true,
              currentClient: {
                version: '0.165.0-alpha.1.2',
                source: 'vscode',
                forked_from_id: null,
              },
            },
          });
          let command;
          if (native) {
            while (!existsSync(grantFile)) {
              assert.ok(
                Date.now() < until,
                'Wait for separately issued human RESUME exceeded the granted observation window',
              );
              await new Promise((done) => setTimeout(done, 250));
            }
            const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
            continuationAuthority = nativeReaderAuthority(store, grant.issuer);
            command = grant.command;
            assert.deepEqual(command.payload, payload);
          } else
            command = makeTaskPlanningCommand({
              ...template,
              source: record({ kind: 'simulated-human-source', native: false }),
            });
          const ack = await controlTaskPlanning(environment.client, handle.workflowId, command);
          assert.deepEqual(
            await controlTaskPlanning(environment.client, handle.workflowId, command),
            ack,
          );
          await assert.rejects(
            controlTaskPlanning(
              environment.client,
              handle.workflowId,
              makeTaskPlanningCommand({ ...command, payload: held }),
            ),
            (error) =>
              error instanceof WorkflowUpdateFailedError &&
              error.cause instanceof ApplicationFailure &&
              error.cause.type === 'TaskCommandRejected' &&
              error.cause.message === 'Error: task-command-id-conflict',
          );
          save('task-resume-accepted.json', { native, command, ack });
          assert.equal(
            (await startLocalTask(environment.client, input, queue)).workflowId,
            handle.workflowId,
          );
        }
        if (progressSupervised) {
          const duplicate = await startLocalTask(environment.client, input, queue);
          assert.equal(duplicate.workflowId, handle.workflowId);
          await assert.rejects(
            startLocalTask(
              environment.client,
              { ...input, progress: { ...input.progress, checkpoint: 'other' } },
              queue,
            ),
            /local-task-start-conflict/u,
          );
        }
        if (
          fault === 'cancel-supervision' ||
          fault === 'cancel-writer' ||
          fault === 'cancel-check' ||
          fault === 'cancel-planning' ||
          fault === 'cancel-correction-writer' ||
          fault === 'cancel-affected' ||
          fault === 'cancel-arbiter' ||
          fault === 'cancel-post-writer'
        ) {
          const until = Date.now() + (arbitration ? 180000 : 30000);
          while (true) {
            const active =
              fault === 'cancel-supervision'
                ? auditStarts === 2
                : fault === 'cancel-arbiter'
                  ? starts === 22
                  : fault === 'cancel-post-writer'
                    ? starts === 24
                    : fault === 'cancel-correction-writer'
                      ? starts === 12
                      : fault === 'cancel-affected'
                        ? starts === 15
                        : fault === 'cancel-writer' || fault === 'cancel-planning'
                          ? starts === (substantial && fault === 'cancel-writer' ? 5 : 1)
                          : (() => {
                              const directory = join(
                                workspace,
                                '.git/agent-workflow/tasks',
                                digest(`aw/task/${project.projectId}/one`),
                                'check-logs',
                              );
                              return (
                                existsSync(directory) &&
                                readdirSync(directory).some((name) =>
                                  readFileSync(join(directory, name), 'utf8').includes(
                                    'cancel-check-ready',
                                  ),
                                )
                              );
                            })();
            if (active) break;
            assert.ok(Date.now() < until, 'fault must reach its actual active external process');
            await new Promise((done) => setTimeout(done, 50));
          }
          await handle.cancel();
        }
        if (substantial && fault === 'changed') {
          const until = Date.now() + 30000;
          let observed;
          while (!observed) {
            const executions =
              await environment.client.connection.workflowService.listWorkflowExecutions({
                namespace: 'default',
                query: "ExecutionStatus = 'Running'",
                pageSize: 100,
              });
            for (const info of executions.executions)
              if (info.execution.workflowId.startsWith('aw/review-reader/')) {
                const state = await environment.client.workflow
                  .getHandle(info.execution.workflowId)
                  .query('readerStatus');
                if (state.mode === 'blocked' && state.error.includes('review-input-changed')) {
                  observed = state;
                  break;
                }
              }
            assert.ok(Date.now() < until, 'changed input must block before any writer');
            if (!observed) await new Promise((done) => setTimeout(done, 25));
          }
          save('changed-input-state.json', observed);
          assert.equal(writerRuntimes, 0);
          await handle.cancel();
        }
        const result = await handle.result();
        save('result.json', result);
        if (finalization) {
          assert.equal(result.status, 'done');
          await qualifyFinalization({
            environment,
            packageRoot,
            evidence,
            registration,
            preparation,
            result,
            main: handle,
            queue,
            mode,
            before,
            save,
          });
        }
        controlledStop = result.status === 'done' || read(result.stop).confirmed === true;
        if (fault !== null && fault !== 'compromise-ready') {
          assert.equal(
            result.status,
            fault.startsWith('cancel-') || (substantial && fault === 'changed')
              ? 'cancelled'
              : 'blocked',
            JSON.stringify(result),
          );
          assert.equal(read(result.stop).confirmed, true);
          assert.ok(
            !readFileSync(join(workspace, 'tasks/one.md'), 'utf8').includes('Результат: DONE'),
          );
          const expected = arbitration
            ? {
                'no-decision': 23,
                'compromise-held': 23,
                'post-fail': 28,
                'cancel-arbiter': 22,
                'cancel-post-writer': 24,
              }[fault]
            : correction
              ? {
                  exhausted: 16,
                  'third-fail': 21,
                  'cancel-correction-writer': 12,
                  'cancel-affected': 15,
                }[fault]
              : substantial
                ? {
                    'progress-held': 4,
                    missing: 0,
                    planning: 4,
                    changed: 4,
                    'cancel-planning': 1,
                    baseline: 4,
                    acceptance: 11,
                    'cancel-writer': 5,
                    'cancel-check': 4,
                  }[fault]
                : fault === 'acceptance'
                  ? 5
                  : fault === 'cancel-writer'
                    ? 1
                    : 0;
          if (supervisedCancel) {
            assert.ok(
              progressCancel
                ? starts === 4
                : stageSupervisedCancel
                  ? starts >= 5 && starts <= 7
                  : starts >= 1 && starts <= 2,
            );
            assert.equal(writerRuntimes, stageSupervisedCancel ? 1 : 0);
          } else assert.equal(starts, expected);
          if (progressSupervised) assert.equal(writerRuntimes, 0);
          if (
            substantial &&
            [
              'missing',
              'planning',
              'changed',
              'cancel-planning',
              'baseline',
              'cancel-check',
            ].includes(fault)
          )
            assert.equal(writerRuntimes, 0);
          save('verified-summary.json', { status: 'PASS', fault, result, starts });
        } else {
          assert.equal(result.status, 'done', JSON.stringify(result));
          assert.equal(starts, maxStarts);
          assert.equal(
            writerRuntimes,
            initial ? 1 : arbitration ? 4 : correction ? 2 : mechanical ? 0 : 1,
          );
          if (correction) assert.equal(result.corrections, arbitration ? 3 : 1);
          assert.ok(readFileSync(join(workspace, 'owner.cjs'), 'utf8').includes('trim'));
          assert.ok(
            readFileSync(join(workspace, 'tasks/one.md'), 'utf8').includes('Результат: DONE'),
          );
          if (arbitration) {
            const resolved = read(result.arbitration);
            assert.equal(
              resolved.kind,
              initial ? 'initial-arbitration-result' : 'task-arbitration-result',
            );
            assert.equal(resolved.ready, true);
            assert.equal(read(resolved.answer).profile.effort, 'high');
          }
          const manifest = read(result.result),
            reviewed = read(manifest.review);
          if (continuation) {
            assert.equal(result.continuation.revision, 1);
            assert.equal(result.continuation.history.length, 1);
            assert.equal(read(read(result.continuation.history[0]).review).complete, false);
            assert.equal(manifest.input.continuation.attempt, 1);
            assert.equal(manifest.input.admission.preparation.revision, requirementsChange ? 2 : 1);
            assert.equal(
              read(manifest.input.continuation.previous).kind,
              'task-planning-continuation',
            );
          }
          if (stageSupervised) {
            assert.equal(
              read(read(input.admission.acceptance).evidence[0]).kind,
              progressSupervised ? 'controlled-progress-checkpoint' : 'controlled-writing-wait',
            );
            assert.equal(result.stageRecords.length, 6);
            assert.deepEqual(manifest.stages, result.stageRecords);
            assert.deepEqual(
              result.stageRecords.map((ref) => read(ref).context.stage),
              [
                'baseline',
                'writing',
                'candidate-checks',
                'integration',
                'integrated-checks',
                'acceptance',
              ],
            );
            if (progressSupervised) {
              const progress = read(manifest.progress),
                card = read(progress.audit.input.card);
              assert.equal(progress.timing, null);
              assert.equal(card.timing, null);
              assert.equal(card.trigger.kind, progressKind);
              assert.equal(card.checkpoint, 'before-writing');
              assert.ok(
                progress.claim.startsWith('task-progress:before-writing:' + progressKind + ':'),
              );
              assert.equal(progress.context.snapshot.sha256, manifest.snapshot.sha256);
              assert.ok(
                Number.isSafeInteger(progress.context.taskElapsedMs) &&
                  progress.context.taskElapsedMs >= 0,
              );
              assert.equal(manifest.stageVerification.filter(Boolean).length, 0);
              assert.ok(manifest.progressVerification.sha256);
            } else {
              assert.equal(read(result.stageRecords[1]).claim, 'writing:overrun');
              assert.equal(manifest.stageVerification.filter(Boolean).length, 1);
              assert.equal(read(result.stageRecords[1]).audit.input.auditId, 'writing-overrun');
            }
            assert.equal(read(manifest.supervision).claim, null);
          }

          assert.equal(reviewed.complete, true);
          assert.equal(reviewed.reports.length, substantial ? 2 : 1);
          if (substantial) {
            const body = read(manifest.snapshot),
              admission = read(body.admission);
            planningResult = { manifest: admission.planning.accepted };
            const approved = read(planningResult.manifest);
            assert.equal(approved.complete, true);
            assert.equal(approved.reports.length, 2);
            const sessions = [...approved.reports, ...reviewed.reports].map(
              (r) => read(r.answer).session,
            );
            assert.equal(new Set(sessions).size, 4);
            if (correction) {
              const previous = read(body.correction.previous.review);
              assert.equal(previous.complete, false);
              const old = read(previous.reports.find((r) => r.roleId === 'reviewer').answer);
              assert.equal(old.report.verdict, 'FAIL');
              const updated = read(reviewed.reports.find((r) => r.roleId === 'reviewer').answer);
              assert.equal(old.session, updated.session);
              assert.ok(
                old.report.findings
                  .filter((finding) => finding.blocking)
                  .every((finding) => updated.report.resolved.includes(finding.id)),
              );
              assert.equal(reviewed.reports.find((r) => r.roleId === 'tester').source, 'reuse');
              assert.deepEqual(
                read(previous.reports.find((r) => r.roleId === 'tester').answer).session,
                read(reviewed.reports.find((r) => r.roleId === 'tester').answer).session,
              );
            }
            assert.ok(sessions.every((session) => session !== manifest.writer.session));
          }
          const writerSession = manifest.writer.session,
            readerSession = read(reviewed.reports[0].answer).session;
          assert.notEqual(writerSession, readerSession);
          if (mechanical) {
            assert.equal(writerSession, null);
            assert.equal(read(manifest.writer.answer).modelStarts, 0);
            assert.equal(read(manifest.writer.stop).kind, 'task-mechanical-stopped');
            const planned = read(planningResult.manifest),
              planningSession = read(planned.reports[0].answer).session;
            assert.notEqual(planningSession, readerSession);
            assert.deepEqual(
              readFileSync(join(workspace, 'owner.cjs')),
              readFileSync(join(workspace, 'approved/owner.cjs')),
            );
          }
          const packetRef = read(manifest.packet.request).evidence.find(
            (ref) => read(ref).kind === 'local-task-acceptance-packet',
          );
          assert.ok(packetRef, 'The full final packet must be retained after original evidence');
          const packet = read(packetRef),
            packetBytes = packetRef.bytes;
          assert.ok(packet.logs.every((log) => log.status === 'PASS' && log.code === 0));
          assert.equal(packet.stop.confirmed, true);
          save('verified-summary.json', {
            status: 'PASS',
            writerSession,
            writerRuntimes,
            planning: planningResult ?? null,
            readerSession,
            starts,
            packetBytes,
            checks: packet.logs.map((log) => ({
              stage: log.stage,
              name: log.name,
              code: log.code,
              elapsedMs: log.elapsedMs,
              status: log.status,
            })),
            ...(supervised ? { supervision: read(manifest.supervision), auditStarts } : {}),
            ...(stageSupervised ? { stages: result.stageRecords.map(read) } : {}),
            result: manifest,
            projection: read(result.projection),
          });
        }
        const execution =
          await environment.client.connection.workflowService.listWorkflowExecutions({
            namespace: 'default',
            query:
              substantial || finalization
                ? "ExecutionStatus != 'Running'"
                : "ExecutionStatus = 'Completed'",
            pageSize: 100,
          });
        for (const info of execution.executions) {
          const id = info.execution.workflowId,
            child = environment.client.workflow.getHandle(id),
            history = await child.fetchHistory();
          histories.push({ workflowId: id, history });
          save(digest(id) + '-history.json', history);
        }
      }),
  );
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  for (const item of histories.filter((item) => !item.workflowId.startsWith('aw/finalization/')))
    await Worker.runReplayHistory({ workflowBundle }, item.history, item.workflowId);
  if (continuation) {
    await Worker.runReplayHistory(
      { workflowBundle },
      readRawReplayHistory('pending-main-history.json'),
      handle.workflowId,
    );
    save('pending-replay.json', {
      status: 'PASS',
      workflowId: handle.workflowId,
      sourceBefore: before,
    });
  }
  if (finalization) {
    const archiveBundle = await bundleWorkflowCode({
      ...finalizationBundleOptions(packageRoot, mode),
    });
    for (const item of histories.filter((item) => item.workflowId.startsWith('aw/finalization/')))
      await Worker.runReplayHistory(
        { workflowBundle: archiveBundle },
        item.history,
        item.workflowId,
      );
    for (const name of [
      'pending-finalization-history.json',
      ...(existsSync(join(evidence, 'unknown-finalization-history.json'))
        ? ['unknown-finalization-history.json']
        : []),
    ])
      await Worker.runReplayHistory(
        { workflowBundle: archiveBundle },
        readRawReplayHistory(name),
        histories.find((item) => item.workflowId.startsWith('aw/finalization/')).workflowId,
      );
  }
  assert.equal(
    histories.length,
    finalization
      ? 4
      : continuation
        ? 10
        : supervised
          ? supervisedCancel || progressHeld
            ? 5
            : 8
          : initial
            ? 12
            : arbitration
              ? fault === 'no-decision' || fault === 'compromise-held' || fault === 'cancel-arbiter'
                ? 13
                : fault === 'cancel-post-writer'
                  ? 13
                  : 15
              : correction
                ? fault === null || fault === 'exhausted' || fault === 'cancel-affected'
                  ? 9
                  : fault === 'third-fail'
                    ? 11
                    : 7
                : substantial
                  ? fault === null || fault === 'acceptance'
                    ? 7
                    : fault === 'missing'
                      ? 1
                      : 4
                  : fault === null || fault === 'acceptance'
                    ? mechanical
                      ? 5
                      : 3
                    : 1,
  );
  assert.equal(existsSync(join(evidence, 'host/host-owner')), false);
  if (arbitration) assert.equal(existsSync(join(evidence, 'arbiter-host/host-owner')), false);
  if (supervised) {
    assert.equal(auditStarts, supervisedCancel ? 2 : 4);
    assert.equal(existsSync(join(evidence, 'audit-host/host-owner')), false);
  }
  const time = (value) => Number(value.seconds) * 1000 + Number(value.nanos ?? 0) / 1e6;
  const activities = histories.flatMap(({ workflowId, history }) => {
    const rows = new Map();
    for (const event of history.events) {
      const scheduled = event.activityTaskScheduledEventAttributes,
        started = event.activityTaskStartedEventAttributes,
        completed = event.activityTaskCompletedEventAttributes,
        failed = event.activityTaskFailedEventAttributes,
        cancelled = event.activityTaskCanceledEventAttributes;
      if (scheduled)
        rows.set(String(event.eventId), {
          workflowId,
          activity: scheduled.activityType.name,
          scheduledAt: time(event.eventTime),
        });
      const update = started ?? completed ?? failed ?? cancelled;
      if (update) {
        const row = rows.get(String(update.scheduledEventId));
        if (row) {
          if (started) row.startedAt = time(event.eventTime);
          else {
            row.finishedAt = time(event.eventTime);
            row.outcome = completed ? 'completed' : failed ? 'failed' : 'cancelled';
          }
        }
      }
    }
    return [...rows.values()].map((row) => ({
      ...row,
      queueMs: row.startedAt == null ? null : row.startedAt - row.scheduledAt,
      executionMs:
        row.finishedAt == null || row.startedAt == null ? null : row.finishedAt - row.startedAt,
    }));
  });
  const blobs = files(registration.artifactRoot),
    source = files(join(packageRoot, 'src')).filter((path) => path.endsWith('.ts'));
  const inventory = source.map((path) => {
    const bytes = readFileSync(path),
      relative = path.slice(join(packageRoot, 'src').length + 1);
    const category = /^(contracts|policy)\//u.test(relative)
      ? 'contracts-policy'
      : relative.startsWith('workflows/')
        ? 'workflows'
        : relative.startsWith('adapters/codex/')
          ? 'codex'
          : relative.startsWith('adapters/artifacts/') ||
              relative.startsWith('adapters/project/') ||
              relative.startsWith('activities/')
            ? 'external-effects'
            : 'host-client';
    return {
      path: relative,
      category,
      sha256: digest(bytes),
      lines: bytes.toString().split('\n').length - 1,
      bytes: bytes.length,
    };
  });
  const latest = new Map();
  for (const event of usage) latest.set(event.threadId, event.tokenUsage.total);
  const totals = [...latest.values()].reduce(
    (total, entry) => ({
      input: total.input + entry.inputTokens,
      cached: total.cached + entry.cachedInputTokens,
      output: total.output + entry.outputTokens,
      total: total.total + entry.totalTokens,
    }),
    { input: 0, cached: 0, output: 0, total: 0 },
  );
  assert.ok(totals.cached <= totals.input);
  save('measurements.json', {
    schemaVersion: 1,
    wallMs: Date.now() - started,
    modelTurns: modelTurns.map((turn) => ({
      ...turn,
      executionMs: turn.completedAt == null ? null : turn.completedAt - turn.startedAt,
    })),
    rpcCounts,
    activities,
    tokens: native
      ? {
          ...totals,
          uncached: totals.input - totals.cached,
          accountedSessions: latest.size,
          rawEvents: usage.length,
        }
      : null,
    storage: {
      artifactBytes: blobs.reduce((n, path) => n + statSync(path).size, 0),
      artifactFiles: blobs.length,
      historyBytes: histories.reduce(
        (n, item) => n + Buffer.byteLength(JSON.stringify(item.history)),
        0,
      ),
      historyEvents: histories.reduce((n, item) => n + item.history.events.length, 0),
      backupBytes: null,
    },
    source: {
      base: (() => {
        const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd: packageRoot,
          encoding: 'utf8',
        });
        return revision.status === 0 ? revision.stdout.trim() : null;
      })(),
      inventory,
    },
    cost: null,
    comparison: null,
  });
} catch (error) {
  save('failure.json', {
    status: 'FAIL',
    error: String(error),
    stack: error.stack,
    starts,
    nativeModelStarts: native ? starts + auditStarts : 0,
    ...(supervised ? { mainStarts: starts, auditStarts } : {}),
    usage,
    modelTurns,
    rpcCounts,
  });
  throw error;
} finally {
  if (continuation || finalization) {
    const after = sourceInventory();
    save('source-after.json', after);
    assert.deepEqual(after, before);
  }
  if (supervised) {
    const after = sourceInventory();
    save('source-after.json', after);
    assert.deepEqual(after, before);
    save('audit-accounting.json', { native, mainStarts: starts, auditStarts, usage });
    if (environment) {
      const executions = await environment.client.connection.workflowService.listWorkflowExecutions(
        { namespace: 'default', query: "ExecutionStatus != 'Running'", pageSize: 100 },
      );
      for (const info of executions.executions) {
        const id = info.execution.workflowId,
          history = await environment.client.workflow.getHandle(id).fetchHistory();
        save(digest(id) + '-history.json', history);
      }
    }
  }
  const processes = new NativeWriterProcesses(),
    owned = await processes.descendants(ports.map((port) => port.pid));
  for (const port of ports) port.close();
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await environment?.teardown();
  for (let i = 0; i < 100 && (await processes.alive(owned)).length; i++) await processes.wait(50);
  const alive = await processes.alive(owned);
  if (alive.length) await processes.terminate(alive);
  assert.equal(
    (await processes.alive(owned)).length,
    0,
    'Owned native runtimes must be gone after teardown',
  );
  if (controlledStop) {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(join(artifactRoot, 'copies'), { recursive: true, force: true });
  }
  cpSync(artifactRoot, join(evidence, 'artifacts'), { recursive: true });
  if (controlledStop) rmSync(artifactRoot, { recursive: true, force: true });
  save('cleanup.json', {
    controlledStop,
    workspaceRemoved: !existsSync(workspace),
    copyRemoved: !existsSync(join(artifactRoot, 'copies')),
    artifactRootRemoved: !existsSync(artifactRoot),
    hostOwnerReleased:
      !existsSync(join(evidence, 'host/host-owner')) &&
      (!arbitration || !existsSync(join(evidence, 'arbiter-host/host-owner'))) &&
      (!supervised || !existsSync(join(evidence, 'audit-host/host-owner'))),
    ownedProcesses: owned,
    alive: await processes.alive(owned),
  });
}
save('report.json', {
  status: 'PASS',
  fault,
  route: progressSupervised
    ? 'progress-' + progressKind
    : stageSupervised
      ? 'supervised-writing'
      : supervised
        ? 'supervised-planning'
        : initial
          ? 'initial-conflict'
          : arbitration
            ? 'arbitration'
            : correction
              ? 'correction'
              : substantial
                ? 'substantial'
                : mechanical
                  ? 'M1'
                  : 'B1',
  nativeModelStarts: native ? starts + auditStarts : 0,
  ...(supervised ? { mainStarts: starts, auditStarts } : {}),
  simulatedStarts: native ? 0 : starts + auditStarts,
  replayed: histories.length,
  elapsedMs: Date.now() - started,
  usage,
});
console.log(
  JSON.stringify({
    status: 'PASS',
    evidence,
    nativeModelStarts: native ? starts + auditStarts : 0,
    ...(supervised ? { mainStarts: starts, auditStarts } : {}),
    simulatedStarts: native ? 0 : starts + auditStarts,
    replayed: histories.length,
  }),
);
