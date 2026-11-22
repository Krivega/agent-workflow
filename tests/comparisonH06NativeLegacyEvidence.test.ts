import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { userCommandNotice } from '../adapters/codex/userCommands.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { stableJson } from '../core/equality.js';
import { evidenceSchema } from '../core/evidence.js';
import { object } from '../src/contracts/project.js';
import { checkH06NativeLegacyEvidence } from './comparisonH06NativeLegacyEvidence.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Edit = (name: string, value: Record<string, unknown>) => void;

function fixture(edit: Edit = () => {}, authorized = false, deliveryTurn?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-evidence-'));
  roots.push(root);
  vi.stubEnv('CODEX_HOME', root);
  const evidence = join(root, 'attempt');
  const workspace = join(root, 'workspace');
  const sessionsRoot = join(root, 'sessions');
  for (const path of [evidence, workspace, sessionsRoot]) mkdirSync(path);
  const store = join(evidence, 'legacy-store');
  const transcript = join(sessionsRoot, 'session.jsonl');
  const records: string[] = [];
  function line(type: string, payload: Record<string, unknown>) {
    const value = { type, payload };
    edit('transcript', value);
    const bytes = JSON.stringify(value) + '\n';
    records.push(bytes);
    return { locator: transcript + '#L' + records.length, hash: digest(bytes) };
  }
  function write(name: string, value: Record<string, unknown>) {
    const body = structuredClone(value);
    edit(name, body);
    const bytes = JSON.stringify(body) + '\n';
    const path = join(evidence, name + '.json');
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes) };
  }
  const input = ({ path, sha256 }: ReturnType<typeof write>) => ({ locator: path, hash: sha256 });
  const context = {
    schema_version: evidenceSchema,
    project_id: 'project',
    task_id: 'attempt',
    run_id: 'run',
    actor_id: 'owner',
    subtask_id: null,
  };
  const generation = 1;
  const identity = { workspace, store, evidence, context, generation };
  const bootstrap = write('bootstrap', {
    kind: 'comparison-h06-native-legacy-bootstrap/2',
    projectId: 'project',
    runId: 'run',
    actorId: 'owner',
    generation,
    permissions: ['read', 'manage'],
  });
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { variant: 'legacy', operationId: 'attempt', workspaceRoot: workspace },
    budget: { maxElapsedMs: 180_000, reserveMs: 30_000 },
    stimulus: { initialLeaseMs: 10_000 },
    bootstrap,
    evidenceRoot: evidence,
  };
  const assets = {};
  const claim = write('attempt-claim', {
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash: digest(canonical({ request, assets })),
    grant: { sessionsRoot },
    startedAt: 10_000,
    workDeadlineMs: 160_000,
    stopDeadlineMs: 190_000,
  });
  const started = write('legacy-operator-start', {
    kind: 'h06-native-legacy-operator-start',
    claim,
    bootstrap,
    storeRoot: store,
    context,
    generation,
    revision: 4,
    oldDeadline: 20_000,
  });
  line('session_meta', {
    id: 'owner',
    session_id: 'owner',
    cwd: workspace,
    cli_version: '0.154.0',
  });
  const initialHost = { pid: 100, startedAt: 9_000 };
  const coldHost = { pid: 200, startedAt: 60_000 };
  const history: { id: string; payload: string }[] = [];
  let revision = 5;

  function command(
    phase: 'warm' | 'cold',
    action: 'pause' | 'resume',
    host: typeof initialHost,
    stoppedBy?: ReturnType<typeof write>,
    stopped?: ReturnType<typeof input>,
  ) {
    const id = phase + '-' + action;
    const turn_id = id + '-turn';
    const anchor = { host_id: 'local', thread_id: 'owner', turn_id, workspace };
    line('event_msg', { type: 'task_started', turn_id });
    const contextRef = line('turn_context', {
      turn_id,
      cwd: workspace,
      model: 'test',
      effort: 'medium',
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
    });
    const observed = { ...anchor, source: contextRef };
    const human = line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'message ' + id }],
    });
    const marker = 'load-' + id;
    const execution = (aggregated_output: string) =>
      line('event_msg', {
        type: 'item_completed',
        thread_id: 'owner',
        turn_id,
        item: {
          type: 'CommandExecution',
          cwd: workspace,
          exit_code: 0,
          status: 'completed',
          aggregated_output,
        },
      });
    let authorization: ReturnType<typeof input> | undefined;
    if (action === 'resume' && authorized) {
      authorization = input(
        write(id + '-authority', {
          schema_version: 1,
          action: 'RESUME',
          target: {
            project_id: context.project_id,
            task_id: context.task_id,
            run_id: context.run_id,
            thread_id: context.actor_id,
            generation,
            control_revision: history.length,
            requirements_revision: 2,
          },
          issuer: { transcript, anchor, source: human },
        }),
      );
      execution(JSON.stringify(userCommandNotice(authorization)));
    }
    const loadRef =
      action === 'resume'
        ? execution(
            JSON.stringify({
              chat_read: marker,
              locator: 'rules.md',
              content: 'rules',
              hash: digest('rules'),
            }),
          )
        : null;
    const event: Record<string, unknown> = {
      id,
      expected_revision: history.length,
      generation,
      thread_id: 'owner',
      source: authorization ?? human,
      ...(action === 'pause'
        ? { type: 'PAUSE', reason: 'hold' }
        : { type: 'RESUME', marker, stopped, ...(authorization ? { authorization } : {}) }),
    };
    edit(id + '-event', event);
    history.push({ id, payload: stableJson(event) });
    const operation = 'chat:control:' + id;
    const intent = write('legacy-' + id + '-intent', {
      kind: 'h06-native-legacy-control-intent',
      phase,
      identity,
      host,
      event,
      operation,
      storeRevision: revision,
      requirementsRevision: 2,
      ...(stoppedBy ? { stoppedBy } : {}),
    });
    const control = {
      schema_version: 1,
      status: action === 'pause' ? 'paused' : 'active',
      generation,
      observed,
      revision: history.length,
      reason: action === 'pause' ? 'hold' : null,
      unfinished: [],
      history: structuredClone(history),
    };
    const receipt = write('legacy-' + id, {
      kind: 'h06-native-legacy-' + action,
      phase,
      identity,
      host,
      intent,
      event,
      operation,
      controlRevision: history.length,
      control,
      load: loadRef && {
        run_id: 'run',
        session_id: 'owner',
        observed_read: JSON.stringify([loadRef]),
      },
      ack: {
        operation_id: operation,
        catalog_revision: ++revision,
        generation,
        evidence_id: null,
        revision: null,
        content_hash: digest(id),
        locator: store + '#operation=' + encodeURIComponent(operation),
      },
    });
    return { receipt, turn_id };
  }

  function phase(name: 'warm' | 'cold') {
    const pause = command(name, 'pause', initialHost);
    const thread = name + '-child';
    const turn = name + '-writer-turn';
    const coderId = name + '-coder';
    const copyRoot = join(workspace, name + '-copy');
    const copyReceipt = input(write(name + '-copy', { kind: 'copy' }));
    const sessionReceipt = input(write(name + '-session', { kind: 'session' }));
    const runtimeProcess = { pid: 300, parent: 1, started: 'runtime' };
    const policy = input(write(name + '-policy', { runtime: runtimeProcess }));
    const runtime = { process: runtimeProcess, policy };
    const process = { pid: 301, parent: runtimeProcess.pid, started: 'terminal' };
    const delivery = 'coder:' + coderId + ':implementation';
    const coder = {
      brief: {
        id: coderId,
        project_id: 'project',
        task_id: 'attempt',
        parent_run_id: 'run',
        parent_session_id: 'owner',
        generation,
        source_root: workspace,
        copy_root: copyRoot,
      },
      baseline: { source: { root: workspace } },
      copy: { binding: { root: copyRoot }, evidence: copyReceipt },
      session: { id: thread, workspace: copyRoot, project_id: 'project', receipt: sessionReceipt },
      status: 'running',
      delivery,
      turn,
    };
    const observation = {
      thread,
      turn,
      native: {
        active: { id: turn, status: 'inProgress' },
        loaded: { data: [thread], nextCursor: null },
      },
      delivery: {
        schema_version: 1,
        session: thread,
        delivery,
        outcome: 'accepted',
        attempts: 1,
        responses: 1,
        request_hash: digest('request'),
        response_hash: digest('response'),
      },
      runtime,
      processes: [process],
    };
    const liveness = { status: 'live', observedAt: name === 'warm' ? 30_000 : 50_000, observation };
    const raw = input(
      write(name + '-raw-stop', {
        kind: 'writers-stopped',
        thread,
        active_turn: false,
        remaining_terminals: 0,
        remaining_processes: 0,
        before_hash: digest('before'),
        after_hash: digest('before'),
        observation_ms: 250,
        owned: {
          thread,
          turn,
          complete: true,
          tree: copyRoot,
          runtime,
          markers: [copyReceipt.locator, sessionReceipt.locator],
        },
        processes: [process],
      }),
    );
    const common = {
      identity,
      phase: name,
      paused: pause.receipt,
      parentTurn: pause.turn_id,
      liveness,
    };
    const intent = write('legacy-' + name + '-writer-stop-intent', {
      ...common,
      kind: 'h06-native-legacy-writer-stop-intent',
      coder,
    });
    const stop = write('legacy-' + name + '-writer-stop', {
      ...common,
      kind: 'h06-native-legacy-writer-stop',
      coderId,
      stopped: raw,
      intent,
    });
    const resume = command(name, 'resume', name === 'warm' ? initialHost : coldHost, stop, raw);
    return { pause: pause.receipt, stop, resume: resume.receipt };
  }

  const warm = phase('warm');
  const cold = phase('cold');
  if (deliveryTurn)
    line('response_item', {
      type: 'function_call_output',
      namespace: 'codex_app',
      name: 'create_thread',
      internal_chat_message_metadata_passthrough: { turn_id: deliveryTurn },
    });
  writeFileSync(transcript, records.join(''), { mode: 0o600 });
  return { started, warm, cold };
}

test.each([false, true])(
  'verifies both phases and historical LOAD sources (delegated RESUME %s)',
  async (authorized) => {
    const refs = fixture(undefined, authorized);
    const prior = readFileSync(refs.cold.resume.path);
    await expect(checkH06NativeLegacyEvidence(refs)).resolves.toEqual({
      status: 'LEGACY_CONTROL_CHAIN_VERIFIED',
      qualification: false,
      operationId: 'attempt',
      warm: {
        pause: 'chat:control:warm-pause',
        resume: 'chat:control:warm-resume',
        before: { pid: 100, startedAt: 9_000 },
        after: { pid: 100, startedAt: 9_000 },
        observedAt: 30_000,
      },
      cold: {
        pause: 'chat:control:cold-pause',
        resume: 'chat:control:cold-resume',
        before: { pid: 100, startedAt: 9_000 },
        after: { pid: 200, startedAt: 60_000 },
        observedAt: 50_000,
      },
    });
    expect(readFileSync(refs.cold.resume.path)).toEqual(prior);
  },
);

test('rejects replacement bytes even if the receipt remains otherwise readable', async () => {
  const refs = fixture();
  writeFileSync(refs.warm.stop.path, '{}\n');
  await expect(checkH06NativeLegacyEvidence(refs)).rejects.toThrow('h04-pin-changed');
});

test.each(['same-root', 'foreign-root', 'delegated'])(
  'checks the .166 transcript for historical controls (%s)',
  async (kind) => {
    const refs = fixture(
      (name, record) => {
        if (name !== 'transcript' || record.type !== 'session_meta') return;
        const metadata = object(record.payload);
        Object.assign(metadata, {
          cli_version: '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
          ...(kind === 'foreign-root' ? { cwd: '/foreign' } : {}),
        });
      },
      false,
      kind === 'delegated' ? 'warm-pause-turn' : undefined,
    );
    const result = checkH06NativeLegacyEvidence(refs);
    if (kind === 'same-root')
      await expect(result).resolves.toMatchObject({ status: 'LEGACY_CONTROL_CHAIN_VERIFIED' });
    else if (kind === 'delegated')
      await expect(result).rejects.toThrow('h06-legacy-evidence-human-delegated');
    else await expect(result).rejects.toThrow('h06-legacy-evidence-transcript-identity');
  },
);

test('rejects a phase receipt from another phase', async () => {
  const refs = fixture();
  refs.warm.resume = refs.cold.resume;
  await expect(checkH06NativeLegacyEvidence(refs)).rejects.toThrow('h06-legacy-evidence-path');
});

function replace(path: string, value: unknown) {
  return (body: Record<string, unknown>) => {
    const parts = path.split('.');
    const key = parts.pop()!;
    const parent = parts.reduce(
      (row, part) => (Array.isArray(row) ? (row[Number(part)] as unknown) : object(row)[part]),
      body as unknown,
    );
    object(parent)[key] = value;
  };
}

test.each([
  ['legacy-operator-start', 'oldDeadline', 20_001, 'start'],
  ['attempt-claim', 'requestHash', 'wrong', 'start'],
  ['bootstrap', 'actorId', 'wrong', 'bootstrap'],
  ['legacy-warm-pause', 'host.pid', 1, 'integer'],
  ['legacy-warm-pause', 'ack.catalog_revision', 5, 'control'],
  ['legacy-warm-pause', 'control.history.0.payload', 'stale', 'control'],
  ['legacy-warm-pause', 'load', {}, 'pause'],
  ['legacy-warm-pause-intent', 'requirementsRevision', -1, 'integer'],
  ['legacy-warm-resume-intent', 'requirementsRevision', 3, 'control'],
  ['legacy-warm-resume-intent', 'stoppedBy', {}, 'handoff'],
  ['legacy-warm-resume', 'load.observed_read', '[]', 'load-source'],
  ['legacy-cold-pause', 'control.history.0.payload', 'crossed', 'control'],
  ['legacy-warm-writer-stop', 'paused', {}, 'stop-link'],
  ['legacy-warm-writer-stop', 'liveness.status', 'unknown', 'stop-link'],
  ['legacy-warm-writer-stop-intent', 'coder.session.id', 'owner', 'stop-link'],
  ['warm-raw-stop', 'remaining_processes', 1, 'writer-stop'],
  ['warm-raw-stop', 'observation_ms', 0, 'integer'],
  ['warm-raw-stop', 'after_hash', digest('changed'), 'writer-stop'],
  ['warm-raw-stop', 'owned.markers', [], 'writer-stop'],
  ['legacy-cold-resume', 'control.revision', 3, 'invalid-chat-control'],
] as const)('rejects incomplete %s %s', async (record, path, value, error) => {
  const refs = fixture((name, body) => {
    if (name === record) replace(path, value)(body);
  });
  await expect(checkH06NativeLegacyEvidence(refs)).rejects.toThrow(error);
});

test('rejects duplicated Writer delivery and a replaced cold host', async () => {
  const delivery = fixture((name, body) => {
    if (name.startsWith('legacy-cold-writer-stop'))
      replace('liveness.observation.delivery.attempts', 2)(body);
  });
  await expect(checkH06NativeLegacyEvidence(delivery)).rejects.toThrow(
    'h06-legacy-evidence-liveness',
  );
  const host = fixture((name, body) => {
    if (name.startsWith('legacy-cold-resume') && !name.endsWith('-event'))
      replace('host.pid', 100)(body);
  });
  await expect(checkH06NativeLegacyEvidence(host)).rejects.toThrow('h06-legacy-evidence-handoff');
});

test('accepts compact LOAD and rejects a command with the wrong marker', async () => {
  function refs(editOutput: (output: string) => string) {
    return fixture((name, body) => {
      if (name !== 'transcript' || body.type !== 'event_msg') return;
      const payload = object(body.payload);
      if (payload.type !== 'item_completed') return;
      const item = object(payload.item);
      item.aggregated_output = editOutput(String(item.aggregated_output));
    });
  }
  const compact = refs((output) => 'irrelevant\n' + output.replace('chat_read', 'chat_compact'));
  await expect(checkH06NativeLegacyEvidence(compact)).resolves.toMatchObject({
    status: 'LEGACY_CONTROL_CHAIN_VERIFIED',
  });
  await expect(
    checkH06NativeLegacyEvidence(refs((output) => output.replace('load-', 'foreign-'))),
  ).rejects.toThrow('h06-legacy-evidence-load-source');
});

test('rejects a cold process started before STOP and reversed phase observations', async () => {
  const earlyHost = fixture((name, body) => {
    if (name.startsWith('legacy-cold-resume') && !name.endsWith('-event'))
      replace('host.startedAt', 45_000)(body);
  });
  await expect(checkH06NativeLegacyEvidence(earlyHost)).rejects.toThrow(
    'h06-legacy-evidence-handoff',
  );
  const reversed = fixture((name, body) => {
    if (name.startsWith('legacy-cold-writer-stop')) replace('liveness.observedAt', 25_000)(body);
  });
  await expect(checkH06NativeLegacyEvidence(reversed)).rejects.toThrow(
    'h06-legacy-evidence-host-chain',
  );
});
