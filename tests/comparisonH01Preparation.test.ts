import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import type * as CommonModule from './comparisonH01.js';
import type { InputRef } from '../core/localRun.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  h01ReadJson,
  h01RequestHash,
  h01GrantText,
  parseH01Request,
} from './comparisonH01Contract.js';
import { object } from '../core/connection.js';
import {
  h01PreparationMain,
  parseH01OperatorSpec,
  planH01Preparation,
  prepareH01Drafts,
  type H01OperatorSpec,
  type H01PreparationInput,
} from './comparisonH01Preparation.js';
import { h02OperatorMain } from './comparisonH02Operator.js';
import { h03OperatorMain, issueH03Recovery } from './comparisonH03Operator.js';
import { h04OperatorMain } from './comparisonH04Operator.js';
import { h05OperatorMain } from './comparisonH05Operator.js';
import { h03NativeSource } from './comparisonH03Contract.js';
import type { H01ExecutionRequest, H01VerifiedAuthorization } from './comparisonH01Contract.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.js';

const sources = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('./comparisonH01.js', async (original) => ({
  ...(await original<typeof CommonModule>()),
  captureH01RuntimeInventory: sources.capture,
}));
vi.mock('node:os', async (original) => ({ ...(await original<typeof os>()) }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const repo = resolve(import.meta.dirname, '..');
const node = {
  locator: fs.realpathSync(process.execPath),
  hash: digest(fs.readFileSync(process.execPath)),
};
let root: string, metadata: string, input: H01PreparationInput;
const write = (path: string, value: unknown): InputRef => {
  fs.mkdirSync(dirname(path), { recursive: true });
  const bytes = typeof value === 'string' ? value : canonical(value) + '\n';
  fs.writeFileSync(path, bytes);
  return { locator: path, hash: digest(bytes) };
};
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'h01-draft-')));
  fs.mkdirSync(resolve(repo, 'tmp'), { recursive: true });
  metadata = fs.realpathSync(fs.mkdtempSync(resolve(repo, 'tmp/h01-preparation-test-')));
  const primaryRoot = resolve(root, 'primary');
  fs.mkdirSync(primaryRoot);
  vi.stubEnv('CODEX_HOME', resolve(root, 'home'));
  vi.stubEnv('CODEX_THREAD_ID', 'primary');
  write(
    resolve(root, 'home/sessions/day/own-primary.jsonl'),
    [
      {
        type: 'session_meta',
        payload: {
          id: 'primary',
          session_id: 'primary',
          cli_version: '0.164.0-alpha.11.1',
          cwd: primaryRoot,
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'observed-turn' },
      },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'observed-turn',
          cwd: primaryRoot,
          model: 'fixture-model',
          effort: 'high',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Preparation only. This is not a native grant.',
            },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  write(
    resolve(root, 'home/sessions/day/other-foreign.jsonl'),
    'INVALID JSON: MUST NEVER BE READ\n',
  );
  const rules = write(resolve(root, 'rules.md'), 'fixture rules'),
    binary = write(resolve(root, 'codex.bin'), 'not executed');
  const entry = write(
    resolve(metadata, 'compiled/workflows/localTask.js'),
    'export async function LocalTaskWorkflow() {}\n',
  );
  const second = write(
    resolve(metadata, 'compiled/workflows/review.js'),
    'export async function ReviewWorkflow() {}\n',
  );
  const build = write(resolve(metadata, 'build.json'), {
    kind: 'h01-workflow-build-artifacts',
    qualification: false,
    canonical: repo,
    actualWorkflowsPath: entry.locator,
    actualRuntimeJavaScript: [entry, second].map((pin) => ({
      ...pin,
      bytes: fs.statSync(pin.locator).size,
    })),
  });
  input = {
    kind: 'comparison-h01-preparation',
    schemaVersion: 1,
    runtimeRoot: repo,
    primaryRoot,
    outputRoot: resolve(metadata, 'drafts'),
    node: { ...node },
    profile: {
      model: 'fixture-model',
      effort: 'high',
      clientVersion: '0.154.0',
      binary,
      rules,
      executor: rules,
      reviewer: rules,
    },
    identity: { taskId: 'H01-task', owner: 'explicit-owner', generation: 1 },
    budget: {
      maxManagedStarts: 7,
      maxElapsedMs: 90000,
      maxInputUncached: 5000,
      maxOutput: 500,
      reserveMs: 10000,
    },
    attempts: {
      baseline: { opId: 'H01-baseline', runBase: resolve(root, 'baseline') },
      candidate: { opId: 'H01-candidate', runBase: resolve(root, 'candidate') },
    },
    temporal: {
      binary,
      address: '127.0.0.1:47001',
      httpAddress: '127.0.0.1:47002',
      metricsAddress: '127.0.0.1:47003',
      namespace: 'default',
      taskQueue: 'h01',
      build,
    },
  };
  const common = resolve(repo, 'tests/comparisonH01.ts');
  sources.capture.mockResolvedValue([{ locator: common, hash: digest(fs.readFileSync(common)) }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(metadata, { recursive: true, force: true });
});

function sealH03Request(value: H01ExecutionRequest) {
  const request = structuredClone(value);
  request.authorization.anchor.turn_id = 'observed-turn';
  request.authorization.requestHash = h01RequestHash(request);
  const lines = fs.readFileSync(request.authorization.transcript, 'utf8').trimEnd().split('\n');
  const row = object(JSON.parse(lines[3]!) as unknown),
    payload = object(row.payload);
  payload.content = [{ type: 'input_text', text: h01GrantText(request) }];
  lines[3] = JSON.stringify(row);
  fs.writeFileSync(request.authorization.transcript, lines.join('\n') + '\n');
  request.authorization.source = {
    locator: request.authorization.transcript + '#L4',
    hash: digest(lines[3]! + '\n'),
  };
  const ref = write(resolve(metadata, 'h03-sealed-request.json'), request);
  return { request, ref };
}
async function h03CandidateDraft(prepare = false) {
  input.kind = 'comparison-h03-preparation';
  const entrypoint = resolve(repo, 'tests/comparisonH03Native.ts');
  sources.capture.mockResolvedValue([
    { locator: entrypoint, hash: digest(fs.readFileSync(entrypoint)) },
  ]);
  return (await (prepare ? prepareH01Drafts(input, 'H-03') : planH01Preparation(input, 'H-03')))
    .drafts[1]!.request;
}

it('prepares H03 without execution and preissues only exact native recovery notices from its primary grant', async () => {
  await h03CandidateDraft();
  const path = resolve(metadata, 'h03-input.json');
  write(path, input);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const plan = await planH01Preparation(input, 'H-03');
  await h03OperatorMain(['--plan-preparation', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  await h03OperatorMain(['--prepare', path]);
  const { request, ref: requestRef } = sealH03Request(plan.drafts[1]!.request);
  vi.spyOn(process, 'cwd').mockReturnValue(input.primaryRoot);
  const result = await issueH03Recovery(requestRef);
  expect(result).toMatchObject({
    allowedModelStarts: 0,
    qualification: false,
    commands: {
      pause: { action: 'pause', expectedRevision: 0, attempt: 0 },
      resume: { action: 'resume', expectedRevision: 1, attempt: 1 },
    },
  });
  expect(result.notices).toHaveLength(2);
  output.mockClear();
  await h03OperatorMain(['--issue-recovery', requestRef.locator]);
  expect(output.mock.calls.map(([text]) => String(text))).toContain(result.notices[0] + '\n');
  expect(fs.existsSync(request.roots.workspaceRoot)).toBe(false);
  const baseline = write(resolve(metadata, 'h03-baseline.json'), {
    ...request,
    variant: 'baseline',
  });
  await expect(issueH03Recovery(baseline)).rejects.toThrow('h03-recovery-candidate-required');
  await expect(h03OperatorMain(['--prepare'])).rejects.toThrow('h03-operator-preparation-usage');
});

it.each(['foreign-kind', 'missing-line', 'zero-line', 'foreign-transcript'])(
  'rejects an H03 %s source descriptor before deriving a recovery command',
  (mode) => {
    const proof = {
      kind:
        mode === 'foreign-kind'
          ? 'comparison-h02-authorization-observation'
          : 'comparison-h03-authorization-observation',
      transcript: '/primary/native.jsonl',
      source: {
        locator:
          mode === 'missing-line'
            ? '/primary/native.jsonl'
            : mode === 'zero-line'
              ? '/primary/native.jsonl#L0'
              : mode === 'foreign-transcript'
                ? '/foreign/native.jsonl#L4'
                : '/primary/native.jsonl#L4',
        hash: 'a'.repeat(64),
      },
      context: { threadId: 'primary', turnId: 'turn' },
    } as H01VerifiedAuthorization;
    expect(() => h03NativeSource(proof)).toThrow('h03-primary-source');
    expect(fs.existsSync(input.attempts.candidate.runBase)).toBe(false);
  },
);

it.each(['equal', 'parent', 'child'])(
  'refuses an H03 recovery store %s overlap before metadata or native execution',
  async (mode) => {
    const draft = await h03CandidateDraft(true);
    const directory = resolve(metadata, 'h03-human-' + digest(draft.opId).slice(0, 20));
    draft.roots.workspaceRoot =
      mode === 'equal' ? directory : mode === 'parent' ? metadata : resolve(directory, 'child');
    const { request, ref } = sealH03Request(draft);
    const before = fs.readFileSync(request.authorization.transcript);
    await expect(issueH03Recovery(ref)).rejects.toThrow('h03-recovery-root-overlap');
    expect(fs.existsSync(directory)).toBe(false);
    expect(fs.readFileSync(request.authorization.transcript)).toEqual(before);
    for (const path of (Object.values(request.roots) as string[]).filter(
      (path) => path !== metadata,
    ))
      expect(fs.existsSync(path)).toBe(false);
  },
);

it.each([
  ['cwd', 'reader-native-issuer-mismatch'],
  ['grant-body', 'h01-authority-body'],
  ['foreign-source', 'h01-native-primary-source'],
  ['malformed-source', 'h01-authority-source'],
  ['issuer-thread', 'h01-issuer-binding'],
])('does not issue H03 recovery notices across a %s boundary', async (mode, expected) => {
  const draft = await h03CandidateDraft(true);
  if (mode === 'foreign-source') {
    const foreign = resolve(root, 'foreign-primary.jsonl');
    fs.copyFileSync(draft.authorization.transcript, foreign);
    draft.authorization.transcript = foreign;
  }
  const { request, ref } = sealH03Request(draft);
  vi.spyOn(process, 'cwd').mockReturnValue(mode === 'cwd' ? root : input.primaryRoot);
  if (mode === 'grant-body') {
    const lines = fs.readFileSync(request.authorization.transcript, 'utf8').trimEnd().split('\n');
    const row = object(JSON.parse(lines[3]!) as unknown);
    object(row.payload).content = [
      { type: 'input_text', text: 'Preparation only; no H03 native grant.' },
    ];
    lines[3] = JSON.stringify(row);
    fs.writeFileSync(request.authorization.transcript, lines.join('\n') + '\n');
    request.authorization.source.hash = digest(lines[3]! + '\n');
    write(ref.locator, request);
  }
  if (mode === 'malformed-source') {
    request.authorization.source.locator = request.authorization.transcript + '#L0';
    write(ref.locator, request);
  }
  if (mode === 'issuer-thread') {
    const bootstrap = object(h01ReadJson(request.bootstrap));
    object(bootstrap.issuer).threadId = 'foreign';
    request.bootstrap = write(request.bootstrap.locator, bootstrap);
    sealH03Request(request);
  }
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const before = fs.readFileSync(request.authorization.transcript);
  await expect(h03OperatorMain(['--issue-recovery', ref.locator])).rejects.toThrow(expected);
  expect(output).not.toHaveBeenCalled();
  expect(fs.readFileSync(request.authorization.transcript)).toEqual(before);
  for (const path of Object.values(request.roots) as string[])
    expect(fs.existsSync(path)).toBe(false);
});

it.each(['missing', 'failed', 'foreign-turn', 'foreign-cwd', 'completed'])(
  'requires a real-owner completed H03 notice receipt: %s (unit transcript fixture)',
  async (mode) => {
    const { request, ref } = sealH03Request(await h03CandidateDraft(true));
    vi.spyOn(process, 'cwd').mockReturnValue(input.primaryRoot);
    const issued = await issueH03Recovery(ref);
    const directory = resolve(metadata, 'h03-human-' + digest(request.opId).slice(0, 20));
    const store = artifactStore(directory, { existingOnly: true });
    const bootstrap = object(h01ReadJson(request.bootstrap));
    const authority = nativeReaderAuthority(
      store,
      bootstrap.issuer as Parameters<typeof nativeReaderAuthority>[1],
    );
    await expect(authority.verify(issued.commands.resume)).rejects.toThrow(
      'reader-native-issuance-unconfirmed',
    );
    if (mode !== 'missing')
      fs.appendFileSync(
        request.authorization.transcript,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'primary',
            turn_id: mode === 'foreign-turn' ? 'foreign' : 'observed-turn',
            item: {
              type: 'CommandExecution',
              cwd: mode === 'foreign-cwd' ? root : input.primaryRoot,
              status: mode === 'failed' ? 'failed' : 'completed',
              exit_code: mode === 'failed' ? 1 : 0,
              aggregated_output: issued.notices.join('\n'),
            },
          },
        }) + '\n',
      );
    for (const command of [issued.commands.pause, issued.commands.resume]) {
      if (mode === 'completed')
        expect(await authority.verify(command)).toMatchObject({
          origin: 'human',
          author: command.author,
          hash: command.hash,
        });
      else
        await expect(authority.verify(command)).rejects.toThrow(
          'reader-native-issuance-unconfirmed',
        );
    }
    expect(fs.existsSync(request.roots.workspaceRoot)).toBe(false);
  },
);

it('runs an explicitly selected H03 planning entrypoint without native effects', async () => {
  const path = resolve(metadata, 'h03-entrypoint-input.json');
  await h03CandidateDraft();
  write(path, input);
  const previous = process.argv,
    output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    process.argv = [
      previous[0]!,
      resolve(repo, 'tests/comparisonH03Operator.ts'),
      '--plan-preparation',
      path,
    ];
    vi.resetModules();
    await import('./comparisonH03Operator.js');
    await vi.waitFor(() =>
      expect(
        output.mock.calls.some(([value]) =>
          String(value).includes('comparison-h03-preparation-plan'),
        ),
      ).toBe(true),
    );
    expect(fs.existsSync(input.outputRoot)).toBe(false);
    for (const attempt of Object.values(input.attempts))
      expect(fs.existsSync(attempt.runBase)).toBe(false);
  } finally {
    process.argv = previous;
  }
});

it('catches explicitly selected H03 operator failures without creating an execution', async () => {
  const previous = process.argv;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH03Operator.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH03Operator.ts'), '--invalid'];
    await import('./comparisonH03Operator.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h03-operator-failed\n'));
  } finally {
    process.argv = previous;
  }
});

it('prepares exact H04 draft metadata and CLI plans without granting or starting execution', async () => {
  input.kind = 'comparison-h04-preparation';
  const entrypoint = resolve(repo, 'tests/comparisonH04Native.ts');
  sources.capture.mockResolvedValue([
    { locator: entrypoint, hash: digest(fs.readFileSync(entrypoint)) },
  ]);
  await expect(planH01Preparation(input, 'H-03')).rejects.toThrow('h01-preparation-version');
  const path = resolve(metadata, 'h04-input.json');
  write(path, input);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h04OperatorMain(['--plan-preparation', path]);
  const plan = object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown);
  expect(plan).toMatchObject({
    kind: 'comparison-h04-preparation-plan',
    allowedModelStarts: 0,
    mayRun: false,
    authorizationIssued: false,
  });
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  const prepared = await prepareH01Drafts(input, 'H-04');
  for (const draft of prepared.drafts) {
    expect(draft.request.kind).toBe('comparison-h04-execution');
    const spec = parseH01OperatorSpec(h01ReadJson(draft.operatorSpec), 'H-04');
    expect(spec.kind).toBe('comparison-h04-operator');
    expect(spec.entrypoint.locator).toBe(entrypoint);
    expect(draft.expectedGrantText).toContain('comparison-h04-grant');
    expect(draft.request.authorization.source).toEqual({ locator: '', hash: '' });
    expect(fs.existsSync(draft.request.roots.workspaceRoot)).toBe(false);
  }
  input.outputRoot = resolve(metadata, 'h04-cli-drafts');
  write(path, input);
  await h04OperatorMain(['--prepare', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(true);
  await expect(h04OperatorMain(['--prepare'])).rejects.toThrow('h04-operator-preparation-usage');
});

it('catches only an explicitly selected H04 operator CLI failure and retains empty run roots', async () => {
  const previous = process.argv,
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH04Operator.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH04Operator.ts'), '--invalid'];
    await import('./comparisonH04Operator.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h04-operator-failed\n'));
    for (const attempt of Object.values(input.attempts))
      expect(fs.existsSync(attempt.runBase)).toBe(false);
  } finally {
    process.argv = previous;
  }
});

it('prepares exact H05 draft metadata and CLI plans without granting or starting execution', async () => {
  input.kind = 'comparison-h05-preparation';
  input.identity.generation = 2;
  const entrypoint = resolve(repo, 'tests/comparisonH05Native.ts');
  sources.capture.mockResolvedValue([
    { locator: entrypoint, hash: digest(fs.readFileSync(entrypoint)) },
  ]);
  await expect(planH01Preparation(input, 'H-03')).rejects.toThrow('h01-preparation-version');
  const path = resolve(metadata, 'h05-input.json');
  write(path, input);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h05OperatorMain(['--plan-preparation', path]);
  const plan = object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown);
  expect(plan).toMatchObject({
    kind: 'comparison-h05-preparation-plan',
    allowedModelStarts: 0,
    mayRun: false,
    authorizationIssued: false,
  });
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  const prepared = await prepareH01Drafts(input, 'H-05');
  for (const draft of prepared.drafts) {
    expect(draft.request.kind).toBe('comparison-h05-execution');
    const spec = parseH01OperatorSpec(h01ReadJson(draft.operatorSpec), 'H-05');
    expect(spec.kind).toBe('comparison-h05-operator');
    expect(spec.entrypoint.locator).toBe(entrypoint);
    expect(draft.expectedGrantText).toContain('comparison-h05-grant');
    expect(draft.request.authorization.source).toEqual({ locator: '', hash: '' });
    expect(fs.existsSync(draft.request.roots.workspaceRoot)).toBe(false);
  }
  input.outputRoot = resolve(metadata, 'h05-cli-drafts');
  write(path, input);
  await h05OperatorMain(['--prepare', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(true);
  await expect(h05OperatorMain(['--prepare'])).rejects.toThrow('h05-operator-preparation-usage');
});

it('catches only an explicitly selected H05 operator CLI failure and retains empty run roots', async () => {
  const previous = process.argv,
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH05Operator.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH05Operator.ts'), '--invalid'];
    await import('./comparisonH05Operator.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h05-operator-failed\n'));
    for (const attempt of Object.values(input.attempts))
      expect(fs.existsSync(attempt.runBase)).toBe(false);
  } finally {
    process.argv = previous;
  }
});

it('prepares H02 drafts with separate grants and shared complete runtime pins without starting effects', async () => {
  input.kind = 'comparison-h02-preparation';
  const entrypoint = resolve(repo, 'tests/comparisonH02Native.ts');
  sources.capture.mockResolvedValue([
    { locator: entrypoint, hash: digest(fs.readFileSync(entrypoint)) },
  ]);
  await expect(planH01Preparation(input)).rejects.toThrow('h01-preparation-version');
  const plan = await planH01Preparation(input, 'H-02');
  expect(plan.kind).toBe('comparison-h02-preparation-plan');
  for (const draft of plan.drafts) {
    expect(draft.request.kind).toBe('comparison-h02-execution');
    expect(draft.expectedGrantText).toContain('comparison-h02-grant');
    expect(() => parseH01Request(draft.request, 'plan')).toThrow('h01-version');
    expect(parseH01Request(draft.request, 'plan', 'H-02')).toEqual(draft.request);
  }
  const path = resolve(metadata, 'h02-input.json');
  write(path, input);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h02OperatorMain(['--plan-preparation', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  await h02OperatorMain(['--prepare', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(true);
  for (const draft of plan.drafts)
    expect(parseH01OperatorSpec(h01ReadJson(draft.operatorSpec), 'H-02').entrypoint.locator).toBe(
      entrypoint,
    );
  await expect(h02OperatorMain(['--prepare'])).rejects.toThrow('h02-operator-preparation-usage');
});
function spec(variant: 'baseline' | 'candidate' = 'baseline'): H01OperatorSpec {
  const base = input.attempts[variant].runBase;
  return {
    kind: 'comparison-h01-operator',
    schemaVersion: 1,
    opId: input.attempts[variant].opId,
    variant,
    budget: input.budget,
    runtimeRoot: repo,
    node: { ...node },
    entrypoint: {
      locator: resolve(repo, 'tests/comparisonH01.ts'),
      hash: 'a'.repeat(64),
    },
    evidenceRoot: resolve(base, 'operator-evidence'),
    roots: {
      workspaceRoot: resolve(base, 'writer/workspace'),
      stateRoot: resolve(base, 'state'),
      evidenceRoot: resolve(base, 'evidence'),
      artifactRoot: resolve(base, 'artifacts'),
      hostRoot: resolve(base, 'host'),
    },
    ...(variant === 'candidate'
      ? {
          temporal: {
            binary: input.temporal.binary,
            address: input.temporal.address,
            httpAddress: input.temporal.httpAddress,
            metricsAddress: input.temporal.metricsAddress,
            namespace: input.temporal.namespace,
            taskQueue: input.temporal.taskQueue,
            workflowsPath: resolve(metadata, 'compiled/workflows/localTask.js'),
            sqlitePath: resolve(base, 'operator-evidence/temporal.sqlite'),
          },
        }
      : {}),
  };
}
it('plans two concrete drafts with empty authority and no writes or reads of unrelated chats', async () => {
  const mkdir = vi.spyOn(fs, 'mkdirSync'),
    write = vi.spyOn(fs, 'writeFileSync');
  const plan = await planH01Preparation(input);
  expect(plan).toMatchObject({
    mayRun: false,
    qualification: false,
    authorizationIssued: false,
    allowedModelStarts: 0,
  });
  expect(plan.drafts.map((draft) => draft.variant)).toEqual(['baseline', 'candidate']);
  for (const draft of plan.drafts) {
    expect(draft.request.authorization).toMatchObject({
      source: { locator: '', hash: '' },
      requestHash: '',
      anchor: {
        turn_id: '',
        thread_id: 'primary',
        workspace: input.primaryRoot,
      },
    });
    expect(draft.request.budget).toEqual(input.budget);
    expect(draft.request.budget.maxManagedStarts).not.toBe(600);
    expect(draft.requestHash).toBe(h01RequestHash(draft.request));
    expect(() => parseH01Request(draft.request)).toThrow();
    expect(draft.expectedGrantText).toContain(draft.requestHash);
  }
  expect(mkdir).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  expect(JSON.stringify(plan)).not.toContain('Preparation only.');
});
it('writes only pinned draft JSON, binds static specs before runtime hashes and preserves all compiled modules', async () => {
  const result = await prepareH01Drafts(input);
  for (const draft of result.drafts) {
    expect(h01ReadJson(draft.requestFile)).toEqual(draft.request);
    const runtime = h01ReadJson(draft.request.runtime) as { files: InputRef[] };
    expect(runtime.files).toContainEqual(draft.operatorSpec);
    const operator = parseH01OperatorSpec(h01ReadJson(draft.operatorSpec));
    expect(operator.opId).toBe(draft.request.opId);
    expect(operator.budget).toEqual(input.budget);
    expect(operator).not.toHaveProperty('requestHash');
    expect(operator).not.toHaveProperty('request');
    for (const path of Object.values(operator.roots) as string[])
      expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(operator.evidenceRoot)).toBe(false);
    if (draft.variant === 'candidate')
      for (const pin of result.compiledInventory) expect(runtime.files).toContainEqual(pin);
    const changed = structuredClone(draft.request);
    changed.authorization.anchor.turn_id = 'new-human-turn';
    changed.authorization.source = {
      locator: 'new-delivery',
      hash: 'a'.repeat(64),
    };
    expect(h01RequestHash(changed)).toBe(draft.requestHash);
  }
  for (const path of fs.readdirSync(input.outputRoot)) expect(path.endsWith('.json')).toBe(true);
  expect(fs.readdirSync(input.outputRoot).some((name) => /grant|authorization/u.test(name))).toBe(
    false,
  );
  await expect(prepareH01Drafts(input)).rejects.toThrow('h01-preparation-output');
});
it('preserves declared MCP disable targets in both immutable profile drafts', async () => {
  input.profile.disabledMcpServers = ['disabled-one', 'disabled_two'];
  const before = await planH01Preparation({
    ...input,
    profile: { ...input.profile, disabledMcpServers: [] },
  });
  const result = await prepareH01Drafts(input);
  for (const draft of result.drafts) {
    expect(h01ReadJson(draft.request.profile)).toEqual(input.profile);
    expect(draft.requestHash).not.toBe(
      before.drafts.find((old) => old.variant === draft.variant)!.requestHash,
    );
  }
});
it.each([null, 'server', {}, [1], [''], ['duplicate', 'duplicate'], ['bad.name']])(
  'rejects malformed MCP disable targets before preparation writes %j',
  async (disabledMcpServers) => {
    await expect(
      planH01Preparation({
        ...input,
        profile: { ...input.profile, disabledMcpServers },
      }),
    ).rejects.toThrow('h01-mcp-disabled-targets');
    expect(fs.existsSync(input.outputRoot)).toBe(false);
  },
);
it.each(['baseline', 'candidate'] as const)(
  'strictly parses static %s without requiring delivery data',
  (variant) => {
    const data = spec(variant);
    expect(parseH01OperatorSpec(data)).toEqual(data);
  },
);
it.each([
  ['schemaVersion', 2],
  ['kind', 'other'],
  ['variant', 'other'],
  ['opId', ''],
  ['node.hash', 'wrong'],
  ['entrypoint.locator', 'relative'],
  ['budget.maxManagedStarts', 0],
  ['budget.reserveMs', 90000],
  ['budget.maxOutput', 1.5],
  ['roots.stateRoot', '/elsewhere'],
  ['roots.hostRoot', '/tmp/../alias'],
  ['evidenceRoot', '/outside/evidence'],
])('rejects static spec %s mismatch', (key, value) => {
  const data = spec() as unknown as Record<string, unknown>,
    parts = key.split('.');
  let parent = data;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = value;
  expect(() => parseH01OperatorSpec(data)).toThrow();
});
it.each([
  'namespace',
  'address',
  'sqlite',
  'workflow',
  'ports',
  'argv',
  'root-overlap',
  'writer-evidence',
])('rejects candidate static %s', (kind) => {
  const value = spec('candidate') as H01OperatorSpec & { argv?: string[] };
  if (kind === 'namespace')
    (value.temporal as unknown as Record<string, unknown>).namespace = 'foreign';
  if (kind === 'address') value.temporal!.address = 'remote:7233';
  if (kind === 'sqlite') value.temporal!.sqlitePath = resolve(root, 'foreign.sqlite');
  if (kind === 'workflow') value.temporal!.workflowsPath = '/outside/workflows.js';
  if (kind === 'ports') value.temporal!.httpAddress = value.temporal!.address;
  if (kind === 'argv') value.argv = ['-e', 'anything'];
  if (kind === 'root-overlap') value.roots.hostRoot = value.roots.stateRoot;
  if (kind === 'writer-evidence')
    value.roots.evidenceRoot = resolve(dirname(value.roots.workspaceRoot), 'evidence');
  expect(() => parseH01OperatorSpec(value)).toThrow();
});
it.each([
  'kind',
  'same-op',
  'output-existing',
  'output-outside',
  'runtime',
  'base-existing',
  'base-primary',
  'bases-overlap',
  'node',
  'profile',
  'build',
  'compiled',
  'entry',
  'extra-compiled',
  'source-after',
])(
  'fails closed preparation %s and retains partial metadata after an unknown write phase',
  async (kind) => {
    if (kind === 'kind') (input as unknown as Record<string, unknown>).kind = 'other';
    if (kind === 'same-op') input.attempts.candidate.opId = input.attempts.baseline.opId;
    if (kind === 'output-existing') fs.mkdirSync(input.outputRoot);
    if (kind === 'output-outside') input.outputRoot = resolve(root, 'output');
    if (kind === 'runtime') input.runtimeRoot = root;
    if (kind === 'base-existing') fs.mkdirSync(input.attempts.baseline.runBase);
    if (kind === 'base-primary')
      input.attempts.baseline.runBase = resolve(input.primaryRoot, 'run');
    if (kind === 'bases-overlap')
      input.attempts.candidate.runBase = resolve(input.attempts.baseline.runBase, 'child');
    if (kind === 'node') input.node = input.profile.binary;
    if (kind === 'profile') input.profile.model = '';
    const build = h01ReadJson(input.temporal.build) as Record<string, unknown>;
    if (kind === 'build')
      input.temporal.build = write(input.temporal.build.locator, {
        ...build,
        kind: 'foreign',
      });
    if (kind === 'compiled')
      input.temporal.build = write(input.temporal.build.locator, {
        ...build,
        actualRuntimeJavaScript: [],
      });
    if (kind === 'entry')
      input.temporal.build = write(input.temporal.build.locator, {
        ...build,
        actualWorkflowsPath: '/outside.js',
      });
    if (kind === 'extra-compiled')
      write(resolve(metadata, 'compiled/workflows/new.js'), 'unbound\n');
    if (kind === 'source-after')
      sources.capture.mockResolvedValueOnce(await sources.capture()).mockResolvedValueOnce([]);
    if (kind === 'source-after')
      await expect(prepareH01Drafts(input)).rejects.toThrow('h01-preparation-source-changed');
    else await expect(planH01Preparation(input)).rejects.toThrow();
    if (kind === 'source-after') expect(fs.readdirSync(input.outputRoot).length).toBeGreaterThan(0);
  },
);
it('rejects missing current native context rather than substituting another chat or a grant', async () => {
  vi.stubEnv('CODEX_THREAD_ID', 'missing');
  await expect(planH01Preparation(input)).rejects.toThrow('chat-transcript-not-unique');
  expect(fs.existsSync(input.outputRoot)).toBe(false);
});
it('offers only explicit read-only plan and draft prepare CLI routes', async () => {
  const path = resolve(metadata, 'input.json');
  write(path, input);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h01PreparationMain(['--plan', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(false);
  await h01PreparationMain(['--prepare', path]);
  expect(fs.existsSync(input.outputRoot)).toBe(true);
  await expect(h01PreparationMain([])).rejects.toThrow('h01-preparation-usage');
});

it('CLI import has no auto execution and the explicit entrypoint retains a read-only failure', async () => {
  vi.resetModules();
  const previous = [...process.argv];
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = [process.execPath, resolve(repo, 'tests/comparisonH01Preparation.ts')];
  await import('./comparisonH01Preparation.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  process.argv = previous;
});

it('uses the stock native sessions home when CODEX_HOME is absent', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  vi.spyOn(os, 'homedir').mockReturnValue(resolve(root, 'home'));
  fs.mkdirSync(resolve(root, 'home/.codex'));
  fs.renameSync(resolve(root, 'home/sessions'), resolve(root, 'home/.codex/sessions'));
  const plan = await planH01Preparation(input);
  expect(plan.drafts[0]!.request.authorization.transcript).toContain('/home/.codex/sessions/');
});

it('catches only an explicitly selected H02 operator CLI and never creates run roots on invalid input', async () => {
  const previous = process.argv;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH02Operator.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH02Operator.ts'), '--invalid'];
    await import('./comparisonH02Operator.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h02-operator-failed\n'));
    expect(fs.existsSync(input.attempts.baseline.runBase)).toBe(false);
  } finally {
    process.argv = previous;
  }
});
