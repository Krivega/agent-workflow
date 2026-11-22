import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { H04Pin } from './comparisonH04Contract.js';
import type { H06DelegatedPhase } from './comparisonH06DelegatedAuthority.js';
import type * as authority from './comparisonH06DelegatedAuthority.js';
import type * as coder from '../core/coder.js';
import {
  verifyH06RetainedWarmContinuation,
  type H06RetainedWarmContinuationProof,
} from './comparisonH06RetainedWarmContinuation.js';

const fake = vi.hoisted(() => ({
  claim: vi.fn(),
  inspect: vi.fn(),
  stop: vi.fn(),
  delivery: vi.fn(),
  coder: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedAuthority.js', async (original) => ({
  ...(await original<typeof authority>()),
  readH06DelegatedAuthority: fake.claim,
  openH06DelegatedPhaseLedger: () => ({ inspect: fake.inspect }),
}));
vi.mock('./comparisonH06DelegatedDelivery.js', () => ({
  verifyH06DelegatedDelivery: fake.delivery,
}));
vi.mock('./comparisonH06NativeLegacyControl.js', () => ({ verifyCoderStop: fake.stop }));
vi.mock('../core/coder.js', async (original) => ({
  ...(await original<typeof coder>()),
  validateCoderRun: fake.coder,
}));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Row = { timestamp?: string; type: string; payload: Record<string, unknown> };
const shellquote = (value: string) =>
  /^[a-zA-Z0-9_./:=+-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
function fixture(quoted = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-retained-warm-'));
  temporary.push(root);
  const workspace = join(root, 'workspace'),
    sessions = join(root, 'sessions');
  mkdirSync(workspace);
  mkdirSync(sessions);
  mkdirSync(join(root, 'f01'));
  const pin = (name: string, value: unknown = {}): H04Pin => {
    const path = join(root, name),
      body = canonical(value) + '\n';
    writeFileSync(path, body);
    return { path, sha256: digest(body) };
  };
  const claimPin = pin('claim.json'),
    node = pin('node'),
    loader = pin(quoted ? "loader's file.mjs" : 'loader.mjs'),
    runner = pin(quoted ? 'warm runner.mjs' : 'runner.mjs');
  const prep = {
    kind: 'comparison-h06-native-legacy-preparation/2',
    descriptor: 'workflow.toml',
    planningFile: 'plan.md',
    marker: 'load-marker',
    spec: { run_id: 'run' },
  };
  const preparation = pin('preparation.json', prep),
    warm = pin('warm.json'),
    cold = pin('cold.json'),
    final = pin('final.json'),
    config = pin('config.json', { preparation, warm, cold, final });
  const claim = {
    actorId: 'actor',
    generation: 1,
    requestHash: 'a'.repeat(64),
    grant: { sessionsRoot: sessions },
    source: {
      turnId: 'root-approval',
      source: { locator: '/fixture/root#L1', hash: 'b'.repeat(64) },
    },
    request: {
      chat: { threadId: 'root', workspace: '/fixture/root' },
      binding: { node, workspaceRoot: workspace },
      evidenceRoot: root,
      runtime: [loader, runner, config, preparation, warm, cold, final],
    },
  };
  const intentPins = [pin('load-intent.json'), pin('pause-intent.json'), pin('resume-intent.json')];
  const phases: { phase: H06DelegatedPhase; intent: H04Pin; outcome: H04Pin | null }[] = [
    'load',
    'warm-pause',
    'warm-resume',
  ].map((stage, index) => ({
    phase: {
      stage: stage as H06DelegatedPhase['stage'],
      nonce: 'nonce-' + stage,
      rootThread: 'root',
      actorThread: 'actor',
      requestHash: claim.requestHash,
      generation: 1,
      storeRevision: 10 + index,
      controlRevision: index === 2 ? 1 : 0,
      requirementsRevision: 1,
      predecessor: null,
    },
    intent: intentPins[index]!,
    outcome: null,
  }));
  const transcript = join(sessions, 'rollout-actor.jsonl');
  const delivery = (index: number) =>
    pin(['load-delivery.json', 'pause-delivery.json', 'resume-delivery.json'][index]!, {
      input: {
        sessionsRoot: sessions,
        root: {
          threadId: 'root',
          workspace: '/fixture/root',
          turnId: 'root-approval',
          user: claim.source.source,
        },
        actor: { threadId: 'actor', workspace },
        command: {
          nonce: phases[index]!.phase.nonce,
          requestHash: claim.requestHash,
          action: index === 0 ? 'LOAD' : index === 1 ? 'PAUSE' : 'RESUME',
          target: {
            claim: claimPin,
            intent: intentPins[index],
            stage: phases[index]!.phase.stage,
            generation: 1,
            storeRevision: 10 + index,
            controlRevision: index === 2 ? 1 : 0,
            requirementsRevision: 1,
          },
        },
      },
      actorTurnId: 'actor-load',
      inbound: { locator: transcript + '#L1', hash: 'c'.repeat(64) },
    });
  const deliveries = [delivery(0), delivery(1), delivery(2)];
  const host = {
    pid: 34567,
    startedAt: 1000,
    execPath: node.path,
    execArgv: ['--import', loader.path],
    argv: [node.path, runner.path, 'warm', join(root, 'load-packet.json')],
  };
  const failure = pin('f01/receipt.json'),
    packet = pin('load-packet.json', {
      claim: claimPin,
      phase: intentPins[0],
      config,
      initialFailure: failure,
      deliveryInput: (JSON.parse(readFileSync(deliveries[0]!.path, 'utf8')) as { input: unknown })
        .input,
    });
  const loadBody = {
    kind: 'h06-delegated-load-result/1',
    claim: claimPin,
    phase: intentPins[0],
    delivery: deliveries[0],
    prepared: {
      request: {
        descriptor: prep.descriptor,
        planning_file: prep.planningFile,
        marker: prep.marker,
        spec: prep.spec,
        anchor: { thread_id: 'actor', turn_id: 'actor-load', workspace },
      },
      ready: { run: { status: 'ready' } },
    },
  };
  const stopPin = pin('stopped.json'),
    pauseBody = {
      kind: 'h06-delegated-control-result/1',
      claim: claimPin,
      phase: intentPins[1],
      delivery: deliveries[1],
      host: { pid: host.pid, startedAt: host.startedAt },
      event: { type: 'PAUSE', id: phases[1]!.phase.nonce },
      control: { status: 'paused', revision: 1 },
      writer: {
        coder: {
          status: 'running',
          brief: { parent_session_id: 'actor', source_root: workspace, generation: 1 },
        },
        stopped: { locator: stopPin.path, hash: stopPin.sha256 },
      },
    };
  const command = [host.execPath, ...host.execArgv, ...host.argv.slice(1)]
    .map(shellquote)
    .join(' ');
  const call: Row = {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'own-call',
      input:
        'text(await tools.exec_command({cmd:' +
        JSON.stringify(command) +
        ',tty:true,yield_time_ms:1000}));',
    },
  };
  const output: Row = {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'own-call',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 1s' },
        { type: 'input_text', text: JSON.stringify({ session_id: 45678, output: '' }) },
      ],
    },
  };
  const boundary: Row = {
    timestamp: '2026-11-05T11:01:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'actor-load' },
  };
  const rows: Row[] = [
    { type: 'session_meta', payload: { id: 'actor' } },
    {
      timestamp: '2026-11-05T11:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'actor-load' },
    },
    call,
    output,
    boundary,
  ];
  const empty = { locator: '', hash: '' };
  const proof: H06RetainedWarmContinuationProof = {
    kind: 'h06-delegated-retained-host-continuation/1',
    claim: claimPin,
    phase: intentPins[2]!,
    delivery: deliveries[2]!,
    load: {
      intent: intentPins[0]!,
      settlement: claimPin,
      result: claimPin,
      delivery: deliveries[0]!,
    },
    pause: {
      intent: intentPins[1]!,
      settlement: claimPin,
      result: claimPin,
      delivery: deliveries[1]!,
    },
    host,
    packet,
    transcript,
    nativePrefix: { bytes: 0, sha256: '' },
    launch: { call: empty, output: empty, session: '45678', command },
    boundary: empty,
    source: empty,
  };
  const bundles = () => {
    for (const [index, body] of [loadBody, pauseBody].entries()) {
      const result = pin(index === 0 ? 'load-result.json' : 'pause-result.json', body);
      const outcome = pin(index === 0 ? 'load-outcome.json' : 'pause-outcome.json', {
        kind: 'h06-delegated-phase-outcome/1',
        claim: claimPin,
        intent: intentPins[index],
        stage: phases[index]!.phase.stage,
        status: 'confirmed',
        result,
        delivery: deliveries[index],
      });
      const settlement = pin(index === 0 ? 'load-settlement.json' : 'pause-settlement.json', {
        kind: 'h06-delegated-phase-settlement/1',
        intent: intentPins[index],
        outcome,
      });
      phases[index]!.outcome = settlement;
      Object.assign(index === 0 ? proof.load : proof.pause, { result, settlement });
    }
    phases[1]!.phase.predecessor = phases[0]!.outcome;
    phases[2]!.phase.predecessor = phases[1]!.outcome;
  };
  const flush = () => {
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(transcript, bytes);
    proof.nativePrefix = { bytes: bytes.length, sha256: digest(bytes) };
    const ref = (row: Row) => ({
      locator: transcript + '#L' + (rows.indexOf(row) + 1),
      hash: digest(JSON.stringify(row) + '\n'),
    });
    proof.launch.call = ref(call);
    proof.launch.output = ref(output);
    proof.boundary = ref(boundary);
    proof.source = ref(boundary);
  };
  bundles();
  flush();
  fake.claim.mockReturnValue(claim);
  fake.inspect.mockReturnValue({ status: 'UNKNOWN', phases });
  fake.delivery.mockImplementation((value: unknown) => value);
  fake.stop.mockResolvedValue(false);
  const verify = () =>
    verifyH06RetainedWarmContinuation({ claim: claimPin, proof: pin('proof.json', proof) });
  return {
    root,
    workspace,
    pin,
    claim,
    claimPin,
    proof,
    host,
    rows,
    call,
    output,
    boundary,
    loadBody,
    pauseBody,
    bundles,
    flush,
    verify,
    phases,
    transcript,
    stopPin,
    deliveries,
    prep,
    preparation,
    config,
  };
}

it.each([false, true])(
  'verifies one retained own command preserving original refs (quoted=%s)',
  async (quoted) => {
    const f = fixture(quoted),
      kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('historicalPIDmustnotbequeried');
      });
    expect(await f.verify()).toEqual({
      source: f.proof.source,
      host: f.host,
      phase: f.proof.phase,
      delivery: f.proof.delivery,
    });
    expect(kill).not.toHaveBeenCalled();
  },
);
it('preserves historical verification after unrelated later actor events are appended', async () => {
  const f = fixture();
  appendFileSync(
    f.transcript,
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'another' } }) +
      '\n',
  );
  await expect(f.verify()).resolves.toBeDefined();
});
it('refuses an additional foreign pending command after projecting the retained own family', async () => {
  const f = fixture();
  f.rows.splice(
    4,
    0,
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'foreign',
        input: 'text(await tools.exec_command({cmd:"other"}));',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'foreign',
        output: [
          { text: 'Script completed\n' },
          { text: JSON.stringify({ session_id: 99999, output: '' }) },
        ],
      },
    },
  );
  f.flush();
  await expect(f.verify()).rejects.toThrow('chat-continuation-operation-pending');
});
it.each([
  'mixed-serial',
  'extra-output',
  'active-cell',
  'wrong-session',
  'wrong-call',
  'changed-command',
])('does not exempt a retained launch with %s', async (mutation) => {
  const f = fixture();
  const outputs = f.output.payload.output as { text: string }[];
  if (mutation === 'mixed-serial')
    f.call.payload.input =
      String(f.call.payload.input) + 'text(await tools.exec_command({cmd:"foreign terminal"}));';
  if (mutation === 'extra-output')
    outputs.push({ text: JSON.stringify({ exit_code: 0, output: '' }) });
  if (mutation === 'active-cell') outputs[0]!.text = 'Script running with cell ID foreign-cell';
  if (mutation === 'wrong-session')
    outputs[1]!.text = JSON.stringify({ session_id: 12345, output: '' });
  if (mutation === 'wrong-call') f.output.payload.call_id = 'other-call';
  if (mutation === 'changed-command')
    f.call.payload.input = 'text(await tools.exec_command({cmd:"other"}));';
  f.flush();
  await expect(f.verify()).rejects.toThrow();
});
it.each([
  'claim',
  'kind',
  'phase',
  'load-bundle',
  'pause-result',
  'host-pid',
  'host-time',
  'node',
  'argv',
  'runtime',
  'prefix',
  'source',
  'boundary',
])('rejects changed proof scope: %s', async (field) => {
  const f = fixture();
  if (field === 'claim') f.proof.claim = f.pin('other-claim.json');
  if (field === 'kind') Object.assign(f.proof, { kind: 'other-proof' });
  if (field === 'phase') f.proof.phase = f.pin('other-phase.json');
  if (field === 'load-bundle') f.proof.load.intent = f.pin('other-load.json');
  if (field === 'pause-result') f.proof.pause.result = f.pin('other-result.json');
  if (field === 'host-pid') f.host.pid++;
  if (field === 'host-time') f.host.startedAt++;
  if (field === 'node') f.host.execPath = '/different-node';
  if (field === 'argv') f.host.argv[2] = 'cold';
  if (field === 'runtime')
    f.claim.request.runtime = f.claim.request.runtime.filter((pin) => pin.path !== f.host.argv[1]);
  if (field === 'prefix') f.proof.nativePrefix.sha256 = '0'.repeat(64);
  if (field === 'source') f.proof.source = { ...f.proof.source, hash: '0'.repeat(64) };
  if (field === 'boundary') f.proof.boundary = { ...f.proof.boundary, hash: '0'.repeat(64) };
  await expect(f.verify()).rejects.toThrow();
});
it.each(['unsettled-load', 'wrong-stage', 'missing-resume'])(
  'rejects a phase chain with %s',
  async (mutation) => {
    const f = fixture();
    if (mutation === 'unsettled-load') f.phases[0]!.outcome = null;
    if (mutation === 'wrong-stage') f.phases[2]!.phase.stage = 'cold-resume';
    if (mutation === 'missing-resume') f.phases.pop();
    await expect(f.verify()).rejects.toThrow('h06-retained-phases');
  },
);
it('rejects rewritten source history', async () => {
  const f = fixture(),
    bytes = readFileSync(f.transcript);
  bytes[10] = bytes[10] === 32 ? 33 : 32;
  writeFileSync(f.transcript, bytes);
  await expect(f.verify()).rejects.toThrow('h06-retained-prefix');
});
it('rechecks immutable evidence after asynchronous STOP validation', async () => {
  const f = fixture();
  fake.stop.mockImplementation(() => {
    writeFileSync(f.stopPin.path, 'changed');
    return Promise.resolve(false);
  });
  await expect(f.verify()).rejects.toThrow();
});
it('rejects changed prepared LOAD or STOP scope', async () => {
  const f = fixture();
  f.loadBody.prepared.request.anchor.turn_id = 'other-turn';
  f.bundles();
  await expect(f.verify()).rejects.toThrow('h06-retained-load');
  f.loadBody.prepared.request.anchor.turn_id = 'actor-load';
  f.pauseBody.writer.coder.status = 'cancelled';
  f.bundles();
  await expect(f.verify()).rejects.toThrow('h06-retained-stop');
});
