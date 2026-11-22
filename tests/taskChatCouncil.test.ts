import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { workflowFixture } from './workflowFixtures.js';
import { runTaskChatCouncil } from '../cli/taskChatCouncil.js';
import { refreshCouncilInputs } from '../cli/refreshCouncilInputs.js';
import type { CouncilSnapshot } from '../cli/councilProgress.js';
import { saveCouncilProgress } from '../cli/councilProgress.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import {
  answerCouncil,
  assignAdviser,
  selectedRole,
  councilBlockers,
  councilReviewRequest,
} from '../core/council.js';
import type { Council } from '../core/council.js';
import type { AgentSession } from '../core/dataRoute.js';
import type { inspectChatPeer } from '../adapters/codex/chatPeer.js';
import type { observeChatCouncil } from '../application/chatCouncil.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import * as diskSpace from '../adapters/project/workflowDiskSpace.js';
import type { CouncilWaitGuard, CouncilWaitBinding } from '../ports/councilWait.js';
const backend = vi.hoisted(() => ({
  create: vi.fn(),
  inspect: vi.fn(),
  load: vi.fn(),
  observeLoad: vi.fn(),
  reuseLoad: vi.fn(),
  send: vi.fn(),
  recoverSend: vi.fn(),
  request: vi.fn(),
  completed: vi.fn(),
  close: vi.fn(),
  initialize: vi.fn(),
  poll: vi.fn(),
  verifyReview: vi.fn(),
  peer: vi.fn<typeof inspectChatPeer>(),
  observe: vi.fn<typeof observeChatCouncil>(),
}));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    request = backend.request;
    completed = backend.completed;
    close = backend.close;
    initialize = backend.initialize;
  },
}));
vi.mock('../adapters/codex/appServerSessions.js', () => ({
  AppServerSessions: class {
    create = backend.create;
    inspect = backend.inspect;
    load = backend.load;
    observeLoad = backend.observeLoad;
    reuseLoad = backend.reuseLoad;
    send = backend.send;
    recoverSend = backend.recoverSend;
    poll = backend.poll;
    verifyReview = backend.verifyReview;
  },
}));
vi.mock('../adapters/codex/chatPeer.js', () => ({
  inspectChatPeer: (...args: Parameters<typeof inspectChatPeer>) => backend.peer(...args),
}));
vi.mock('../application/chatCouncil.js', () => ({
  observeChatCouncil: (...args: Parameters<typeof observeChatCouncil>) => backend.observe(...args),
}));
let f: Awaited<ReturnType<typeof workflowFixture>>,
  directory: string,
  stateDirectory: string,
  council: Council,
  session: AgentSession;
beforeEach(async () => {
  f = await workflowFixture();
  stateDirectory = await mkdtemp(resolve(dirname(f.root), 'managed-council-'));
  directory = resolve(stateDirectory, 'council');
  await mkdir(directory);
  council = structuredClone(f.council('planning'));
  council.advisers = {};
  council.history = [];
  session = {
    id: 'adviser',
    model: f.spec.requested.model,
    effort: f.spec.requested.effort,
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  backend.create.mockResolvedValue(session);
  backend.inspect.mockResolvedValue(session);
  backend.load.mockResolvedValue(f.proof);
  backend.observeLoad.mockResolvedValue(f.proof);
  backend.reuseLoad.mockResolvedValue(f.proof);
  backend.send.mockResolvedValue('review');
  backend.recoverSend.mockResolvedValue('review');
  backend.request.mockResolvedValue({
    thread: { path: '/native/path', turns: [{ id: 'review', status: 'completed' }] },
  });
  backend.initialize.mockResolvedValue(undefined);
  backend.completed.mockResolvedValue(undefined);
  backend.observe.mockImplementation(async (current, role, run, _turn, _principal, sessions) => {
    await sessions.inspect(run.spec.session_id);
    await sessions.poll(session, 'review');
    await sessions.verifyReview(
      session,
      councilReviewRequest(current, role, run),
      'review',
      f.proof,
    );
    return {
      ...current,
      advisers: {
        ...current.advisers,
        [role]: {
          run,
          status: 'answered',
          answer: f.answer(current),
          reviewed: selectedRole(current.selection, role),
        },
      },
    };
  });
});
afterEach(async () => {
  await f.dispose();
  await rm(stateDirectory, { recursive: true, force: true });
  vi.resetAllMocks();
});
async function run(guard?: CouncilWaitGuard) {
  return runTaskChatCouncil(
    council,
    f.spec,
    directory,
    'codex',
    (next) => {
      council = next;
    },
    () => {},
    stateDirectory,
    guard,
  );
}
it.each(['unchanged', 'new-turn', 'owner', 'generation', 'revision', 'control'])(
  'reconciles a saved wait only for the permitted %s continuation',
  async (change) => {
    const binding: CouncilWaitBinding = {
      run_id: 'run',
      owner: f.spec.session_id,
      generation: 1,
      requirements_revision: 0,
      control_revision: 0,
      turn_id: 'parent-turn',
      source: f.proof,
    };
    const guard: CouncilWaitGuard = { capture: async () => binding, verify: vi.fn(async () => {}) };
    backend.request.mockResolvedValue({
      thread: { path: '/native/path', turns: [{ id: 'review', status: 'inProgress' }] },
    });
    backend.completed.mockRejectedValueOnce(new Error('runtime lost'));
    await expect(run(guard)).rejects.toThrow('runtime lost');
    const [name] = (await readdir(directory)).filter((name) => name.startsWith('wait-'));
    expect(readManaged(resolve(directory, name!))).toMatchObject({ applied: null, binding });
    const sends = backend.send.mock.calls.length;
    if (change === 'new-turn') {
      binding.control_revision++;
      binding.turn_id = 'resumed';
    }
    if (change === 'owner') binding.owner = 'other';
    if (change === 'generation') binding.generation++;
    if (change === 'revision') binding.requirements_revision++;
    if (change === 'control') binding.control_revision--;
    if (['unchanged', 'new-turn'].includes(change)) {
      await run(guard);
      expect(readManaged(resolve(directory, name!))).toMatchObject({
        applied: f.proof,
        completion_binding: binding,
      });
      await run(guard);
      expect(backend.send).toHaveBeenCalledTimes(sends);
    } else {
      await expect(run(guard)).rejects.toThrow('council-wait-binding-conflict');
      expect(readManaged(resolve(directory, name!))).toMatchObject({ applied: null });
    }
    expect(backend.send).toHaveBeenCalledTimes(sends);
  },
);

it('refuses a late observed answer after its task authorization changes', async () => {
  const binding: CouncilWaitBinding = {
    run_id: 'run',
    owner: f.spec.session_id,
    generation: 1,
    requirements_revision: 0,
    control_revision: 0,
    turn_id: 'parent-turn',
    source: f.proof,
  };
  let revoked = false;
  const guard: CouncilWaitGuard = {
    capture: async () => binding,
    verify: async () => {
      if (revoked) throw new Error('revoked');
    },
  };
  const observe = backend.observe.getMockImplementation()!;
  backend.observe.mockImplementationOnce(async (...args) => {
    const result = await observe(...args);
    revoked = true;
    return result;
  });
  await expect(run(guard)).rejects.toThrow('revoked');
  expect(council.advisers.architect).toBeUndefined();
});
it('binds the native wait heartbeat to the current task authority', async () => {
  const binding: CouncilWaitBinding = {
    run_id: 'run',
    owner: f.spec.session_id,
    generation: 1,
    requirements_revision: 0,
    control_revision: 0,
    turn_id: 'parent-turn',
    source: f.proof,
  };
  const verify = vi.fn(async () => {});
  backend.request.mockResolvedValue({
    thread: { path: '/native/path', turns: [{ id: 'review', status: 'inProgress' }] },
  });
  backend.completed.mockImplementation(
    async (_thread: string, _turn: string, _signal: unknown, heartbeat: () => Promise<void>) => {
      await heartbeat();
    },
  );
  await run({ capture: async () => binding, verify });
  expect(backend.completed).toHaveBeenCalledWith(
    expect.any(String),
    'review',
    undefined,
    expect.any(Function),
  );
  expect(verify).toHaveBeenCalledWith(binding);
  expect(council.advisers.architect).toBeDefined();
});
it('keeps adviser full LOAD separate from the principal compact context mode', async () => {
  const result = await runTaskChatCouncil(
    council,
    { ...f.spec, role: null, parent_run_id: null, context_loading: 'fragments-v1' },
    directory,
    'codex',
    (next) => {
      council = next;
    },
    () => {},
    stateDirectory,
  );
  expect(result.advisers.architect!.run.spec.context_loading).toBeUndefined();
  expect(result.advisers.architect!.run.schema_version).toBe(1);
  expect(result.advisers.architect!.run.loaded!.native).toBeDefined();
});
it('records insufficient storage before initializing transport or dispatching any role', async () => {
  const guard = vi
    .spyOn(diskSpace, 'requireWorkflowDiskSpace')
    .mockRejectedValueOnce(new Error('workflow-disk-space-low:fixture'));
  try {
    await expect(run()).rejects.toThrow('workflow-disk-space-low:fixture');
    expect(backend.initialize).not.toHaveBeenCalled();
    expect(backend.create).not.toHaveBeenCalled();
    expect(readManaged<CouncilSnapshot>(resolve(directory, 'progress.json'))).toMatchObject({
      status: 'failed',
      error: 'workflow-disk-space-low:fixture',
    });
  } finally {
    guard.mockRestore();
  }
});
it('observes scoped snapshots inside the authorized state and rejects files outside it', async () => {
  const snapshot = resolve(stateDirectory, 'role-selection.json');
  await writeFile(snapshot, 'scoped snapshot');
  backend.observe.mockImplementationOnce(
    async (current, role, _run, _turn, _principal, _sessions, inputs) => {
      await inputs.verify([{ locator: snapshot, hash: contentHash('scoped snapshot') }]);
      return {
        ...current,
        advisers: {
          ...current.advisers,
          [role]: { ...current.advisers[role]!, status: 'answered', answer: f.answer(current) },
        },
      };
    },
  );
  await run();
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  backend.observe.mockImplementationOnce(
    async (_current, _role, _run, _turn, _principal, _sessions, inputs) => {
      await inputs.verify([{ locator: resolve(f.root, 'proof.txt'), hash: f.proof.hash }]);
      throw new Error('outside evidence accepted');
    },
  );
  await expect(run()).rejects.toThrow('unsafe-locator');
});
it('creates, names, LOADs and reviews a persistent adviser, then reuses the answer', async () => {
  await run();
  expect(backend.request).toHaveBeenCalledWith('thread/name/set', {
    threadId: 'adviser',
    name: 'Советник: Архитектор',
  });
  expect(backend.send).toHaveBeenCalledOnce();
  expect(backend.close).toHaveBeenCalledOnce();
  const prompt = String(backend.send.mock.calls[0]![1]);
  expect(prompt).toContain(`Предмет проверки: ${council.selection.architect.reason}.`);
  expect(prompt).toContain('Только чтение, без сети, записи и помощников.');
  expect(prompt).toContain('sources:request.requirements,coverage:"complete",content:');
  expect(prompt).not.toContain('design:{ui:DesignAssessment,ux:DesignAssessment}');
  expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
  const actualRun = council.advisers.architect!.run;
  expect(actualRun.loaded!.procedures.map((p) => p.id)).toContain('boundary-review');
  expect(() => assignAdviser({ ...council, advisers: {} }, 'architect', actualRun)).not.toThrow();
  await run();
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledOnce();
  expect(backend.initialize).toHaveBeenCalledOnce();
});
it.each([
  { verdict: 'FAIL', coverage: 'complete', legacy: false },
  { verdict: 'NOT RUN', coverage: 'complete', legacy: false },
  { verdict: 'PASS', coverage: 'partial', legacy: false },
  { verdict: 'NOT RUN', coverage: 'complete', legacy: true },
] as const)(
  'refreshes $verdict/$coverage with unchanged inputs and a new answer in the same session, legacy=$legacy',
  async ({ verdict, coverage, legacy }) => {
    council.phase = 'acceptance';
    council.review_turns = [];
    backend.send.mockResolvedValueOnce('review').mockResolvedValueOnce('review-repeat');
    backend.request.mockResolvedValue({
      thread: {
        path: '/native/path',
        turns: [
          { id: 'review', status: 'completed' },
          { id: 'review-repeat', status: 'completed' },
        ],
      },
    });
    backend.observe.mockImplementation(async (current, role, run, turn) => {
      const advisers = { ...current.advisers };
      delete advisers[role];
      const assigned = assignAdviser({ ...current, advisers }, role, run);
      const answer = f.answer(assigned);
      return answerCouncil(assigned, role, run.spec.session_id, {
        ...answer,
        verdict: turn === 'review' ? verdict : 'PASS',
        coverage: turn === 'review' ? coverage : 'complete',
        binding: { ...answer.binding!, answer_turn: turn },
      });
    });
    await run();
    const origin = council.advisers.architect!.run.loaded!.origin;
    const checkpoint = resolve(stateDirectory, 'review-checkpoint.json');
    saveManaged(checkpoint, council, true, 'minimal');
    council = readManaged<Council>(checkpoint)!;
    if (legacy) delete council.review_turns;
    const failures = council.history.filter((entry) => entry.answer.verdict === 'FAIL');
    council = await refreshCouncilInputs(council, council.target, f.inputs);
    expect(council.advisers.architect?.status).toBe('running');
    await run();
    expect(backend.create).toHaveBeenCalledOnce();
    expect(backend.load).toHaveBeenCalledOnce();
    expect(backend.reuseLoad).toHaveBeenCalledOnce();
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(backend.send.mock.calls.map(([agent]) => (agent as AgentSession).id)).toEqual([
      'adviser',
      'adviser',
    ]);
    expect(backend.send.mock.calls[1]![2]).not.toBe(backend.send.mock.calls[0]![2]);
    expect(backend.send.mock.calls[1]![2]).toMatch(/:1$/u);
    expect(council.advisers.architect!.run.loaded!.origin).toEqual(origin);
    expect(council.advisers.architect!.answer!.binding!.answer_turn).toBe('review-repeat');
    expect(council.review_turns).toContainEqual({
      role: 'architect',
      session: 'adviser',
      turn: 'review',
    });
    expect(council.history.filter((entry) => entry.answer.verdict === 'FAIL')).toEqual(failures);
    expect(councilBlockers(council)).toEqual([]);
    await run();
    expect(backend.send).toHaveBeenCalledTimes(2);
  },
);
it('continues a multi-role council from the compact checkpoint returned by its writer', async () => {
  council.selection.backend.trigger = true;
  backend.create.mockResolvedValueOnce({ ...session, id: 'architect-session' });
  backend.create.mockResolvedValueOnce({ ...session, id: 'backend-session' });
  const observe = backend.observe.getMockImplementation()!;
  backend.observe.mockImplementation(async (...args) => {
    const [current, role, run] = args;
    if (current.history.length > 0) expect(current.history[0]!.archive).toBeDefined();
    const next = await observe(...args);
    return {
      ...next,
      history: [...next.history, { role, session: run.spec.session_id, answer: f.answer(current) }],
    };
  });
  const path = resolve(stateDirectory, 'managed-council.json');
  const result = await runTaskChatCouncil(
    council,
    f.spec,
    directory,
    'codex',
    (next) => {
      saveManaged(path, next, true, true);
      return readManaged<Council>(path)!;
    },
    () => {},
    stateDirectory,
  );
  expect(result.history).toHaveLength(2);
  expect(result.history.every((entry) => entry.archive !== undefined)).toBe(true);
  expect(
    readManaged<Council>(path, { archive: true })!.history.every(
      (entry) => entry.archive === undefined,
    ),
  ).toBe(true);
});
it('does not start transport for an inapplicable council and blocks unknown applicability', async () => {
  council.selection.architect.trigger = false;
  expect(await run()).toEqual(council);
  expect(backend.initialize).not.toHaveBeenCalled();
  expect(backend.create).not.toHaveBeenCalled();
  council.selection.architect.trigger = null;
  await expect(run()).rejects.toThrow('architect:applicability-unknown');
  expect(backend.initialize).not.toHaveBeenCalled();
});
it('keeps an already accepted role while running only its remaining peer', async () => {
  await run();
  const accepted = council.advisers.architect;
  council.selection.backend.trigger = true;
  backend.create.mockResolvedValueOnce({ ...session, id: 'backend-session' });
  const output: string[] = [];
  await runTaskChatCouncil(
    council,
    f.spec,
    directory,
    'codex',
    () => {},
    (s) => output.push(s),
    stateDirectory,
  );
  expect((JSON.parse(output[0]!) as CouncilSnapshot).roles.architect).toEqual({
    status: 'accepted',
    verdict: 'PASS',
    reason: council.selection.architect.reason,
    review_basis: {
      phase: 'planning',
      scope: council.target.scope,
      previous: { verdict: 'PASS', coverage: 'complete', scope: council.target.scope },
      requirements: 'unchanged',
      rationale: 'unchanged',
      inputs: 'applicable',
    },
  });
  expect(council.advisers.architect).toEqual(accepted);
  expect(backend.send).toHaveBeenCalledTimes(2);
});
it('repairs a stale progress snapshot after the final answer was durably accepted', async () => {
  await run();
  const path = resolve(directory, 'progress.json');
  const { cursor: _cursor, ...snapshot } = readManaged<CouncilSnapshot>(path)!;
  saveCouncilProgress(directory, {
    ...snapshot,
    status: 'running',
    roles: { architect: { status: 'reviewing' } },
  });
  await run();
  expect(readManaged<CouncilSnapshot>(path)).toMatchObject({
    status: 'completed',
    roles: { architect: { status: 'accepted', verdict: 'PASS' } },
  });
  expect(backend.initialize).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledOnce();
});
it('publishes an unknown transport initialization failure and closes transport', async () => {
  backend.initialize.mockRejectedValueOnce('unknown transport');
  await expect(run()).rejects.toBe('unknown transport');
  expect(readManaged(resolve(directory, 'progress.json'))).toMatchObject({
    status: 'failed',
    error: 'unknown transport',
  });
  expect(backend.close).toHaveBeenCalledOnce();
});
it.each(['planning', 'acceptance'] as const)(
  'sends the %s designer contract with separate assessments and phase-specific proof',
  async (phase) => {
    council.phase = phase;
    council.selection.architect.trigger = false;
    council.selection['ui-ux-designer'].trigger = true;
    await run();
    expect(backend.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'adviser',
      name: 'Советник: Дизайнер UI/UX',
    });
    const prompt = String(backend.send.mock.calls[0]![1]);
    expect(prompt).toContain(`"phase":"${phase}"`);
    expect(prompt).toContain('design:{ui:DesignAssessment,ux:DesignAssessment}');
    expect(prompt).toContain('acceptance UI PASS требует screens');
    expect(prompt).toContain('UX PASS — interaction');
    expect(prompt).toContain('Planning PASS требует proposal');
    expect(prompt).toContain('sources:request.requirements,coverage:"complete",content:');
    expect(prompt).toContain('ReviewAnswer.coverage=partial');
    const roleRun = council.advisers['ui-ux-designer']!.run;
    expect(roleRun.spec.outcome).toContain(
      phase === 'planning' ? 'Проверить план' : 'Проверить результат',
    );
    expect(roleRun.spec.requested.permissions).toEqual(['read']);
  },
);
it('reloads the same adviser when changing phase even with the same target', async () => {
  await run();
  council.phase = 'acceptance';
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  await run();
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(String(backend.send.mock.calls[1]![1])).toContain('"phase":"acceptance"');
});

it('reuses a verified unchanged LOAD for a new target and still requests a fresh review', async () => {
  await run();
  council.target.base = 'new-target';
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  await run();
  expect(backend.load).toHaveBeenCalledOnce();
  expect(backend.reuseLoad).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
});

it('requires a fresh full LOAD after native compaction', async () => {
  await run();
  council.target.base = 'new-target';
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  backend.reuseLoad.mockResolvedValueOnce(null);
  await run();
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.send).toHaveBeenCalledTimes(2);
});
it('preserves a known malformed review and asks the same adviser once for a fresh exact response', async () => {
  backend.observe.mockRejectedValueOnce(new Error('chat-role-answer-unconfirmed'));
  backend.poll.mockResolvedValue({ status: 'completed', answer: { evidence: f.proof } });
  backend.verifyReview.mockResolvedValue({ native: f.proof });
  backend.send.mockResolvedValueOnce('review').mockResolvedValueOnce('corrected');
  backend.request.mockResolvedValue({
    thread: {
      path: '/native/path',
      turns: [
        { id: 'review', status: 'completed' },
        { id: 'corrected', status: 'completed' },
      ],
    },
  });
  await run();
  expect(readManaged(resolve(directory, 'rejected-answer-architect-review.json'))).toMatchObject({
    progress: { turn: 'review', attempt: 0 },
    answer: { evidence: f.proof },
    proof: { native: f.proof },
  });
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.load).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.send.mock.calls[1]![0]).toMatchObject({ id: 'adviser' });
  expect(backend.send.mock.calls[1]![1]).toContain('Скопируй scope и sources буквально');
  expect(backend.send.mock.calls[1]![2]).toMatch(/:1$/u);
});
it('does not loop on a second malformed review', async () => {
  backend.observe.mockRejectedValue(new Error('chat-role-answer-unconfirmed'));
  backend.poll.mockResolvedValue({ status: 'completed', answer: { evidence: f.proof } });
  backend.verifyReview.mockResolvedValue({ native: f.proof });
  await expect(run()).rejects.toThrow('chat-role-answer-unconfirmed');
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.create).toHaveBeenCalledOnce();
  await expect(run()).rejects.toThrow('chat-role-answer-retry-exhausted');
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.create).toHaveBeenCalledOnce();
});
it('does not retry a proven malformed answer after the principal authority changes', async () => {
  backend.observe.mockRejectedValue(new Error('chat-role-answer-unconfirmed'));
  backend.poll.mockResolvedValue({ status: 'completed', answer: { evidence: f.proof } });
  let revoked = false;
  backend.verifyReview.mockImplementation(async () => {
    revoked = true;
    return { native: f.proof };
  });
  const binding: CouncilWaitBinding = {
    run_id: 'run',
    owner: f.spec.session_id,
    generation: 1,
    requirements_revision: 0,
    control_revision: 0,
    turn_id: 'parent-turn',
    source: f.proof,
  };
  await expect(
    run({
      capture: async () => binding,
      verify: async () => {
        if (revoked) throw new Error('authority-changed');
      },
    }),
  ).rejects.toThrow('authority-changed');
  expect(backend.send).toHaveBeenCalledOnce();
  expect(readManaged(resolve(directory, 'architect.json'))).toMatchObject({
    turn: 'review',
    attempt: 0,
  });
});
it.each(['running', 'unconfirmed'])(
  'does not resend a malformed review when its native proof is %s',
  async (mode) => {
    backend.observe.mockRejectedValue(new Error('chat-role-answer-unconfirmed'));
    backend.poll.mockResolvedValue(
      mode === 'running'
        ? { status: 'running' }
        : { status: 'completed', answer: { evidence: f.proof } },
    );
    if (mode === 'unconfirmed')
      backend.verifyReview.mockRejectedValue(new Error('native-review-unconfirmed'));
    await expect(run()).rejects.toThrow(
      mode === 'running' ? 'chat-role-still-running' : 'native-review-unconfirmed',
    );
    expect(backend.send).toHaveBeenCalledOnce();
    expect(readManaged(resolve(directory, 'architect.json'))).toMatchObject({
      turn: 'review',
      attempt: 0,
    });
  },
);
it('preserves a compacted answer and automatically reloads only the same session', async () => {
  backend.observe.mockRejectedValueOnce(new Error('native-load-compacted'));
  await run();
  expect(readManaged(resolve(directory, 'compacted-architect-review.json'))).toMatchObject({
    turn: 'review',
  });
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.send.mock.calls[1]![2]).not.toBe(backend.send.mock.calls[0]![2]);
  expect(backend.send.mock.calls[1]![2]).toMatch(/:1$/u);
});
it('stops after one automatic compaction recovery and preserves every rejected answer', async () => {
  backend.observe.mockRejectedValue(new Error('native-load-compacted'));
  backend.send.mockResolvedValueOnce('review').mockResolvedValueOnce('review2');
  backend.request.mockResolvedValue({
    thread: {
      path: '/native/path',
      turns: [
        { id: 'review', status: 'completed' },
        { id: 'review2', status: 'completed' },
      ],
    },
  });
  await expect(run()).rejects.toThrow('native-load-compacted');
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.create).toHaveBeenCalledOnce();
  for (const turn of ['review', 'review2'])
    expect(readManaged(resolve(directory, `compacted-architect-${turn}.json`))).toMatchObject({
      turn,
    });
  expect(readManaged(resolve(directory, 'progress.json'))).toMatchObject({
    status: 'failed',
    roles: { architect: { status: 'failed', error: 'native-load-compacted' } },
  });
});
it('does not resend a completed peer when one adviser needs compaction recovery', async () => {
  council.selection.backend.trigger = true;
  backend.create.mockResolvedValueOnce({ ...session, id: 'architect-session' });
  backend.create.mockResolvedValueOnce({ ...session, id: 'backend-session' });
  const observe = backend.observe.getMockImplementation()!;
  let compacted = false;
  backend.observe.mockImplementation(async (...args) => {
    if (args[1] === 'architect' && !compacted) {
      compacted = true;
      throw new Error('native-load-compacted');
    }
    return observe(...args);
  });
  await run();
  expect(
    backend.send.mock.calls.filter(([s]) => (s as AgentSession).id === 'backend-session'),
  ).toHaveLength(1);
  expect(
    backend.send.mock.calls.filter(([s]) => (s as AgentSession).id === 'architect-session'),
  ).toHaveLength(2);
  expect(council.advisers.backend?.status).toBe('answered');
  expect(council.advisers.architect?.status).toBe('answered');
});
it('does not accept an unpersisted answer when the checkpoint writer fails', async () => {
  const save = vi.fn(() => {
    throw new Error('checkpoint failed');
  });
  await expect(
    runTaskChatCouncil(council, f.spec, directory, 'codex', save, () => {}, stateDirectory),
  ).rejects.toThrow('checkpoint failed');
  expect(council.advisers.architect).toBeUndefined();
  expect(backend.close).toHaveBeenCalledOnce();
});

it.each([new Error('unavailable'), 'unknown'])(
  'retains an unconfirmed observation %s without a new model call',
  async (error) => {
    backend.observe.mockRejectedValueOnce(error);
    await expect(run()).rejects.toMatchObject({ errors: [error] });
    expect(readManaged(resolve(directory, 'architect.json'))).toMatchObject({ turn: 'review' });
    await run();
    expect(backend.send).toHaveBeenCalledOnce();
  },
);
it('retains the transport until an issued review has finished', async () => {
  backend.request.mockImplementation(async (method: string) =>
    method === 'thread/read'
      ? { thread: { path: '/native/path', turns: [{ id: 'review', status: 'inProgress' }] } }
      : {},
  );
  let finish!: () => void;
  backend.completed.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run();
  await vi.waitFor(() => expect(backend.completed).toHaveBeenCalled());
  expect(backend.close).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(backend.close).toHaveBeenCalledOnce();
});
it('adopts a completed role before another role finishes', async () => {
  council.selection.backend.trigger = true;
  backend.create.mockResolvedValueOnce({ ...session, id: 'fast' });
  backend.create.mockResolvedValueOnce({ ...session, id: 'slow' });
  backend.request.mockImplementation(async (method: string, params: { threadId: string }) =>
    method === 'thread/read'
      ? {
          thread: {
            path: '/native/path',
            turns: [
              { id: 'review', status: params.threadId === 'slow' ? 'inProgress' : 'completed' },
            ],
          },
        }
      : {},
  );
  let finish!: () => void;
  backend.completed.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run();
  try {
    await vi.waitFor(() => expect(backend.completed).toHaveBeenCalled());
    await vi.waitFor(() => expect(council.advisers.architect?.status).toBe('answered'));
    expect(backend.close).not.toHaveBeenCalled();
  } finally {
    finish();
    await pending;
  }
});
it('keeps a later valid answer when an earlier observation fails', async () => {
  council.selection.backend.trigger = true;
  backend.create.mockResolvedValueOnce({ ...session, id: 'architect-session' });
  backend.create.mockResolvedValueOnce({ ...session, id: 'backend-session' });
  const observe = backend.observe.getMockImplementation()!;
  backend.observe.mockImplementation(async (...args) => {
    if (args[1] === 'architect') throw new Error('invalid native proof');
    return observe(...args);
  });
  await expect(run()).rejects.toThrow();
  expect(council.advisers.backend?.status).toBe('answered');
  expect(backend.send).toHaveBeenCalledTimes(2);
});
it('does not recreate a session after an unknown create result', async () => {
  backend.create.mockRejectedValueOnce(new Error('lost reply'));
  await expect(run()).rejects.toThrow('chat-council-incomplete');
  await expect(run()).rejects.toThrow('chat-council-incomplete');
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.close).toHaveBeenCalledTimes(2);
});
it('recovers a completed LOAD after a lost reply without starting another LOAD', async () => {
  backend.load.mockRejectedValueOnce(new Error('lost LOAD reply'));
  await expect(run()).rejects.toThrow();
  await run();
  expect(backend.inspect).toHaveBeenCalledWith('adviser');
  expect(backend.observeLoad).toHaveBeenCalledWith(session, expect.anything(), 'review');
  expect(backend.load).toHaveBeenCalledOnce();
});
it.each([{ turns: [] }, { turns: [{ id: 'load', status: 'inProgress' }] }])(
  'keeps incomplete LOAD unknown: %j',
  async ({ turns }) => {
    backend.load.mockRejectedValueOnce(new Error('lost reply'));
    await expect(run()).rejects.toThrow();
    backend.request.mockResolvedValue({ thread: { turns } });
    await expect(run()).rejects.toThrow();
    expect(backend.load).toHaveBeenCalledOnce();
  },
);
it('recovers delivery from its persistent marker and refuses an unconfirmed marker', async () => {
  backend.send.mockRejectedValueOnce(new Error('lost send reply'));
  await expect(run()).rejects.toThrow();
  backend.recoverSend.mockResolvedValueOnce(null);
  await expect(run()).rejects.toThrow();
  await run();
  expect(backend.send).toHaveBeenCalledOnce();
  expect(backend.recoverSend).toHaveBeenCalledTimes(2);
});

async function recordRejection() {
  const [native, , delivery] = backend.send.mock.calls[0] as [AgentSession, string, string];
  await writeFile(
    resolve(directory, 'transport.jsonl'),
    [
      {
        direction: 'send',
        data: {
          id: 1,
          method: 'turn/start',
          params: {
            threadId: native.id,
            input: [
              { type: 'text', text: `Workflow delivery id: ${JSON.stringify(delivery)}\nrequest` },
            ],
          },
        },
      },
      {
        direction: 'recv',
        data: { id: 1, error: { code: -32602, data: { input_error_code: 'input_too_large' } } },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
}

it('recovers the existing rejected delivery in the same session and retains its original proof', async () => {
  backend.send.mockRejectedValueOnce(new Error('previous explicit rejection'));
  await expect(run()).rejects.toThrow('chat-council-incomplete');
  await recordRejection();
  backend.recoverSend.mockResolvedValueOnce(null);
  await run();
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.send.mock.calls[1]![2]).toMatch(/:1$/u);
  expect(backend.send.mock.calls[1]![1]).toContain('Council review request file:');
  expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
  expect(readManaged(resolve(directory, 'architect.json'))).toMatchObject({ attempt: 1 });
});

it('persists an immediate explicit rejection before retrying, without an uncertain recovery send', async () => {
  backend.send.mockImplementationOnce(async () => {
    await recordRejection();
    throw new Error('explicit input rejection');
  });
  await expect(run()).rejects.toThrow('chat-council-incomplete');
  expect(readManaged(resolve(directory, 'architect.json'))).toMatchObject({
    delivery: null,
    attempt: 1,
  });
  await run();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.recoverSend).not.toHaveBeenCalled();
  expect(backend.create).toHaveBeenCalledOnce();
});
it.each([null, { ...({} as AgentSession), workspace: '/other' }])(
  'refuses a missing or displaced restored adviser %j',
  async (actual) => {
    backend.send.mockRejectedValueOnce(new Error('lost reply'));
    await expect(run()).rejects.toThrow();
    backend.inspect.mockResolvedValue(actual);
    await expect(run()).rejects.toThrow();
  },
);
it.each(['interrupted', 'failed'])(
  'retries a confirmed %s review once in the same session',
  async (status) => {
    backend.request.mockResolvedValue({
      thread: {
        path: '/native/path',
        turns: [
          { id: 'review', status },
          { id: 'review2', status: 'completed' },
        ],
      },
    });
    backend.send.mockResolvedValueOnce('review').mockResolvedValue('review2');
    await expect(run()).rejects.toThrow();
    await run();
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(backend.create).toHaveBeenCalledOnce();
    expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
  },
);
it('preserves origin and reviews changed requirements with a still-current LOAD', async () => {
  await run();
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  await f.file('new-assignment.txt', 'New requirements');
  f.spec = { ...f.spec, assignment: await f.ref('new-assignment.txt') };
  await run();
  expect(backend.create).toHaveBeenCalledOnce();
  expect(backend.load).toHaveBeenCalledOnce();
  expect(backend.reuseLoad).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
});

it('reloads changed procedure bytes in the same adviser even when the assignment and target are unchanged', async () => {
  await run();
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  const procedure = f.spec.procedures.find((p) => p.id === 'boundary-review')!;
  await f.file(procedure.locator, 'Updated procedure');
  const ref = await f.ref(procedure.locator);
  f.spec.procedures = f.spec.procedures.map((p) =>
    p.id === procedure.id ? { ...p, hash: ref.hash } : p,
  );
  await run();
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.create).toHaveBeenCalledOnce();
  expect(council.advisers.architect!.run.loaded!.origin).toEqual(f.proof);
});
it('invalidates cached LOAD when project rules change even if role inputs stay unchanged', async () => {
  await run();
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  const previous = f.spec.rules[0]!;
  await f.file(previous.locator, 'Updated project rules');
  f.spec.rules = f.spec.rules.map((ref, index) =>
    index === 0 ? { ...ref, hash: contentHash('Updated project rules') } : ref,
  );
  await run();
  expect(backend.load).toHaveBeenCalledTimes(2);
  expect(backend.reuseLoad).not.toHaveBeenCalled();
  expect(backend.send).toHaveBeenCalledTimes(2);
});
it('refuses malformed native history and missing review turns', async () => {
  backend.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ thread: {} });
  await expect(run()).rejects.toThrow();
  backend.request.mockResolvedValue({ thread: { turns: [] } });
  await expect(run()).rejects.toThrow();
});
it('retains completed role state even when another selected role fails', async () => {
  council.selection.product.trigger = true;
  backend.create.mockImplementation(async () => {
    if (backend.create.mock.calls.length > 1) throw new Error('unavailable');
    return session;
  });
  await expect(run()).rejects.toThrow();
  expect(council.advisers.architect!.status).toBe('answered');
  expect(backend.close).toHaveBeenCalledOnce();
});
it('rejects invalid persisted role state without creating another session', async () => {
  await run();
  council.advisers = {};
  const path = resolve(directory, 'architect.json');
  const progress = readManaged<Record<string, unknown>>(path)!;
  progress.run = null;
  progress.load_pending = true;
  saveManaged(path, progress);
  backend.request.mockResolvedValue({ thread: { turns: [{ status: 'completed' }] } });
  await expect(run()).rejects.toThrow();
  expect(backend.create).toHaveBeenCalledOnce();
});

it('recovers naming after its reply is lost without replacing the created adviser', async () => {
  backend.request.mockRejectedValueOnce(new Error('lost name reply'));
  await expect(run()).rejects.toThrow();
  await run();
  expect(backend.create).toHaveBeenCalledOnce();
  expect(
    backend.request.mock.calls.filter(([method]) => method === 'thread/name/set'),
  ).toHaveLength(2);
});

it('reopens the native review when target inputs change while the plan bytes stay the same', async () => {
  await run();
  council.advisers.architect!.status = 'running';
  council.advisers.architect!.answer = null;
  await f.file('source.txt', 'changed implementation');
  council.target.inputs.inputs = [await f.ref('source.txt')];
  await run();
  expect(backend.load).toHaveBeenCalledOnce();
  expect(backend.reuseLoad).toHaveBeenCalledOnce();
  expect(backend.send).toHaveBeenCalledTimes(2);
  expect(backend.create).toHaveBeenCalledOnce();
});

it('never resumes or sends a role instruction to the principal', async () => {
  backend.create.mockResolvedValueOnce({ ...session, id: f.spec.session_id });
  await expect(run()).rejects.toThrow();
  expect(backend.request).not.toHaveBeenCalled();
  expect(backend.inspect).not.toHaveBeenCalled();
});

it('refuses a persisted principal substitution before any resume', async () => {
  await run();
  council.advisers = {};
  const path = resolve(directory, 'architect.json');
  const progress = readManaged<{ session: AgentSession }>(path)!;
  progress.session.id = f.spec.session_id;
  saveManaged(path, progress);
  await expect(run()).rejects.toThrow();
  expect(backend.inspect).not.toHaveBeenCalled();
});

it('keeps an unknown review status blocked without retrying it', async () => {
  backend.request.mockResolvedValue({ thread: { turns: [{ id: 'review', status: 'unknown' }] } });
  await expect(run()).rejects.toThrow();
  await expect(run()).rejects.toThrow();
  expect(backend.send).toHaveBeenCalledOnce();
});
