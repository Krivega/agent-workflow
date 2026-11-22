import { isDeepStrictEqual as same } from 'node:util';
import { join } from 'node:path';
import { observedLaunches, serialInvocations } from '../adapters/codex/chatCommandSettlement.js';
import { verifyChatContinuation, type RecordLine } from '../adapters/codex/currentChatHost.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import { validateCoderRun, type CoderRun } from '../core/coder.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  h06DelegatedPhaseAction,
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';
import { verifyCoderStop } from './comparisonH06NativeLegacyControl.js';

export interface H06RetainedHostIdentity {
  pid: number;
  startedAt: number;
  execPath: string;
  execArgv: string[];
  argv: string[];
}
interface Bundle {
  intent: H04Pin;
  settlement: H04Pin;
  result: H04Pin;
  delivery: H04Pin;
}
export interface H06RetainedWarmContinuationProof {
  kind: 'h06-delegated-retained-host-continuation/1';
  claim: H04Pin;
  phase: H04Pin;
  delivery: H04Pin;
  load: Bundle;
  pause: Bundle;
  host: H06RetainedHostIdentity;
  packet: H04Pin;
  transcript: string;
  nativePrefix: { bytes: number; sha256: string };
  launch: { call: InputRef; output: InputRef; session: string; command: string };
  boundary: InputRef;
  source: InputRef;
}

const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
function ref(value: unknown): InputRef {
  const source = object(value);
  exactFields(source, ['locator', 'hash']);
  requireContract(
    typeof source.locator === 'string' &&
      typeof source.hash === 'string' &&
      /^[a-f0-9]{64}$/u.test(source.hash),
    'h06-retained-source',
  );
  return { locator: source.locator, hash: source.hash };
}
const quote = (value: string) =>
  /^[a-zA-Z0-9_./:=+-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

/** Historical proof of one retained warm controller; no liveness or paid action is inferred. */
export async function verifyH06RetainedWarmContinuation(input: { claim: H04Pin; proof: H04Pin }) {
  const proofPin = h04Pin(input.proof),
    claimPin = h04Pin(input.claim),
    value = read(proofPin);
  exactFields(value, [
    'kind',
    'claim',
    'phase',
    'delivery',
    'load',
    'pause',
    'host',
    'packet',
    'transcript',
    'nativePrefix',
    'launch',
    'boundary',
    'source',
  ]);
  requireContract(
    value.kind === 'h06-delegated-retained-host-continuation/1' && same(value.claim, claimPin),
    'h06-retained-kind',
  );
  const proof = value as unknown as H06RetainedWarmContinuationProof;
  const claim = readH06DelegatedAuthority(claimPin),
    ledger = openH06DelegatedPhaseLedger(claimPin).inspect();
  const [load, pause, resume] = ledger.phases;
  requireContract(
    load?.phase.stage === 'load' &&
      pause?.phase.stage === 'warm-pause' &&
      resume?.phase.stage === 'warm-resume' &&
      load.outcome !== null &&
      pause.outcome !== null &&
      same(resume.intent, proof.phase) &&
      same(resume.phase.predecessor, pause.outcome),
    'h06-retained-phases',
  );
  const verifiedPins: H04Pin[] = [
    proofPin,
    claimPin,
    proof.phase,
    proof.delivery,
    proof.packet,
    claim.request.binding.node,
  ];
  function bundle(part: Bundle, entry: NonNullable<typeof load>) {
    exactFields(object(part), ['intent', 'settlement', 'result', 'delivery']);
    requireContract(
      same(part.intent, entry.intent) && same(part.settlement, entry.outcome),
      'h06-retained-bundle',
    );
    const settled = read(part.settlement),
      outcome = read(h04Pin(settled.outcome));
    requireContract(
      settled.kind === 'h06-delegated-phase-settlement/1' &&
        same(settled.intent, part.intent) &&
        outcome.kind === 'h06-delegated-phase-outcome/1' &&
        outcome.status === 'confirmed' &&
        same(outcome.claim, claimPin) &&
        same(outcome.intent, part.intent) &&
        outcome.stage === entry.phase.stage &&
        same(outcome.result, part.result) &&
        same(outcome.delivery, part.delivery),
      'h06-retained-outcome',
    );
    verifiedPins.push(
      part.intent,
      part.settlement,
      h04Pin(settled.outcome),
      part.result,
      part.delivery,
    );
    const result = read(part.result);
    requireContract(
      same(result.claim, claimPin) &&
        same(result.phase, part.intent) &&
        same(result.delivery, part.delivery),
      'h06-retained-result',
    );
    return result;
  }
  function delivery(pin: H04Pin, entry: NonNullable<typeof load>) {
    const observed = verifyH06DelegatedDelivery(read(pin)),
      source = observed.input;
    requireContract(
      source.sessionsRoot === claim.grant.sessionsRoot &&
        source.root.threadId === claim.request.chat.threadId &&
        source.root.workspace === claim.request.chat.workspace &&
        source.root.turnId === claim.source.turnId &&
        same(source.root.user, claim.source.source) &&
        source.actor.threadId === claim.actorId &&
        source.actor.workspace === claim.request.binding.workspaceRoot &&
        source.command.nonce === entry.phase.nonce &&
        source.command.requestHash === claim.requestHash &&
        source.command.action === h06DelegatedPhaseAction(entry.phase.stage) &&
        same(source.command.target, {
          claim: claimPin,
          intent: entry.intent,
          stage: entry.phase.stage,
          generation: entry.phase.generation,
          storeRevision: entry.phase.storeRevision,
          controlRevision: entry.phase.controlRevision,
          requirementsRevision: entry.phase.requirementsRevision,
        }),
      'h06-retained-delivery',
    );
    return observed;
  }
  const loaded = bundle(proof.load, load),
    paused = bundle(proof.pause, pause);
  const loadDelivery = delivery(proof.load.delivery, load);
  delivery(proof.pause.delivery, pause);
  delivery(proof.delivery, resume);
  const host = object(proof.host);
  exactFields(host, ['pid', 'startedAt', 'execPath', 'execArgv', 'argv']);
  requireContract(
    Number.isSafeInteger(host.pid) &&
      Number(host.pid) > 1 &&
      typeof host.startedAt === 'number' &&
      Number.isFinite(host.startedAt) &&
      host.startedAt > 0 &&
      host.execPath === claim.request.binding.node.path &&
      Array.isArray(host.execArgv) &&
      host.execArgv.length === 2 &&
      host.execArgv[0] === '--import' &&
      typeof host.execArgv[1] === 'string' &&
      Array.isArray(host.argv) &&
      host.argv.length === 4 &&
      host.argv.every((item) => typeof item === 'string') &&
      host.argv[0] === host.execPath &&
      host.argv[2] === 'warm' &&
      host.argv[3] === proof.packet.path &&
      same(paused.host, { pid: host.pid, startedAt: host.startedAt }),
    'h06-retained-host',
  );
  const runtimePin = (path: string) => {
    const pin = claim.request.runtime.find((candidate) => candidate.path === path);
    requireContract(pin !== undefined, 'h06-retained-runtime');
    readH04Pin(pin);
    verifiedPins.push(pin);
    return pin;
  };
  runtimePin(proof.host.execArgv[1]!);
  runtimePin(proof.host.argv[1]!);
  const command = [proof.host.execPath, ...proof.host.execArgv, ...proof.host.argv.slice(1)]
    .map(quote)
    .join(' ');
  requireContract(
    proof.launch.command === command && /^[1-9]\d*$/u.test(proof.launch.session),
    'h06-retained-command',
  );
  const packet = read(proof.packet);
  exactFields(packet, ['claim', 'config', 'deliveryInput', 'initialFailure', 'phase']);
  requireContract(
    same(packet.claim, claimPin) &&
      same(packet.phase, proof.load.intent) &&
      same(packet.deliveryInput, loadDelivery.input),
    'h06-retained-packet',
  );
  const configPin = h04Pin(packet.config),
    config = read(configPin);
  requireContract(same(runtimePin(configPin.path), configPin), 'h06-retained-runtime');
  exactFields(config, ['preparation', 'warm', 'cold', 'final']);
  for (const pin of Object.values(config).map(h04Pin))
    requireContract(same(runtimePin(pin.path), pin), 'h06-retained-runtime');
  const preparation = read(h04Pin(config.preparation)),
    prepared = object(loaded.prepared),
    request = object(prepared.request),
    anchor = object(request.anchor);
  requireContract(
    loaded.kind === 'h06-delegated-load-result/1' &&
      object(object(prepared.ready).run).status === 'ready' &&
      preparation.kind === 'comparison-h06-native-legacy-preparation/2' &&
      preparation.descriptor === request.descriptor &&
      preparation.planningFile === request.planning_file &&
      preparation.marker === request.marker &&
      same(preparation.spec, request.spec) &&
      anchor.thread_id === claim.actorId &&
      anchor.turn_id === loadDelivery.actorTurnId &&
      anchor.workspace === claim.request.binding.workspaceRoot,
    'h06-retained-load',
  );
  const failure = h04Pin(packet.initialFailure);
  requireContract(
    failure.path === join(claim.request.evidenceRoot, 'f01', 'receipt.json'),
    'h06-retained-initial-failure',
  );
  readH04Pin(failure);
  verifiedPins.push(failure, configPin);
  const stopped = object(paused.writer);
  const coder = object(stopped.coder) as unknown as CoderRun;
  validateCoderRun(coder);
  requireContract(
    paused.kind === 'h06-delegated-control-result/1' &&
      object(paused.event).type === 'PAUSE' &&
      object(paused.event).id === pause.phase.nonce &&
      object(paused.control).status === 'paused' &&
      object(paused.control).revision === resume.phase.controlRevision &&
      coder.status === 'running' &&
      coder.brief.parent_session_id === claim.actorId &&
      coder.brief.source_root === claim.request.binding.workspaceRoot &&
      coder.brief.generation === claim.generation,
    'h06-retained-stop',
  );
  const stop = object(stopped.stopped);
  const stopPin = h04Pin({ path: stop.locator, sha256: stop.hash });
  verifiedPins.push(stopPin);
  await verifyCoderStop(
    { locator: stopPin.path, hash: stopPin.sha256 },
    coder,
    claim.request.evidenceRoot,
  );
  const prefix = object(proof.nativePrefix),
    launch = object(proof.launch);
  exactFields(prefix, ['bytes', 'sha256']);
  exactFields(launch, ['call', 'output', 'session', 'command']);
  const journal = readH06NativeJournal(proof.transcript);
  requireContract(
    Number.isSafeInteger(prefix.bytes) &&
      Number(prefix.bytes) > 0 &&
      Number(prefix.bytes) <= journal.length &&
      typeof prefix.sha256 === 'string' &&
      digest(journal.subarray(0, Number(prefix.bytes))) === prefix.sha256 &&
      journal[Number(prefix.bytes) - 1] === 10 &&
      proof.transcript === loadDelivery.inbound.locator.replace(/#L[1-9]\d*$/u, ''),
    'h06-retained-prefix',
  );
  const records: RecordLine[] = journal
    .subarray(0, Number(prefix.bytes))
    .toString()
    .slice(0, -1)
    .split('\n')
    .map((line, index) => ({
      record: object(JSON.parse(line)),
      ref: { locator: proof.transcript + '#L' + (index + 1), hash: digest(line + '\n') },
    }));
  const locate = (source: InputRef) => {
    const reference = ref(source),
      matches = records.filter((row) => same(row.ref, reference));
    requireContract(matches.length === 1, 'h06-retained-source');
    return matches[0]!;
  };
  const call = locate(proof.launch.call),
    output = locate(proof.launch.output),
    boundary = locate(proof.boundary);
  locate(proof.source);
  const callPayload = object(call.record.payload),
    outputPayload = object(output.record.payload),
    end = object(boundary.record.payload);
  const start = records.findIndex(
    ({ record }) =>
      record.type === 'event_msg' &&
      object(record.payload).type === 'task_started' &&
      object(record.payload).turn_id === anchor.turn_id,
  );
  requireContract(
    start >= 0 &&
      records.indexOf(call) > start &&
      records.indexOf(output) > records.indexOf(call) &&
      records.indexOf(output) < records.indexOf(boundary) &&
      end.turn_id === anchor.turn_id &&
      boundary.record.type === 'event_msg' &&
      ['task_complete', 'task_aborted', 'turn_aborted'].includes(String(end.type)),
    'h06-retained-boundary',
  );
  const invocations = serialInvocations(String(callPayload.input)),
    launches = observedLaunches([call, output]);
  requireContract(
    call.record.type === 'response_item' &&
      callPayload.type === 'custom_tool_call' &&
      callPayload.name === 'exec' &&
      typeof callPayload.call_id === 'string' &&
      output.record.type === 'response_item' &&
      outputPayload.type === 'custom_tool_call_output' &&
      outputPayload.call_id === callPayload.call_id &&
      invocations?.length === 1 &&
      'command' in invocations[0]! &&
      invocations[0]!.command === command &&
      launches.size === 1 &&
      launches.get(proof.launch.session) === command &&
      Array.isArray(outputPayload.output) &&
      outputPayload.output.length === 2,
    'h06-retained-launch',
  );
  const blocks = outputPayload.output.map(object);
  requireContract(
    typeof blocks[0]!.text === 'string' &&
      blocks[0]!.text.startsWith('Script completed\n') &&
      typeof blocks[1]!.text === 'string',
    'h06-retained-launch-output',
  );
  const pending = object(JSON.parse(blocks[1]!.text));
  requireContract(
    typeof pending.output === 'string' &&
      pending.exit_code === undefined &&
      Number.isSafeInteger(pending.session_id) &&
      String(pending.session_id) === proof.launch.session,
    'h06-retained-launch-output',
  );
  const source = verifyChatContinuation(
    records.filter((row) => row !== call && row !== output),
    claim.actorId,
    String(anchor.turn_id),
    claim.request.binding.workspaceRoot,
    proof.boundary,
  );
  requireContract(same(source, proof.source), 'h06-retained-continuation-source');
  for (const pin of verifiedPins) readH04Pin(pin);
  readH06DelegatedAuthority(claimPin);
  requireContract(
    digest(readH06NativeJournal(proof.transcript).subarray(0, Number(prefix.bytes))) ===
      prefix.sha256,
    'h06-retained-prefix',
  );
  return { source, host: proof.host, phase: proof.phase, delivery: proof.delivery };
}
