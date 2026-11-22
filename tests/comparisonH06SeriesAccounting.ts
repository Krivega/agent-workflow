import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import {
  readComparisonUsage,
  type NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h01ReadJson } from './comparisonH01Contract.js';
import type { H06DelegatedDeliveryProof } from './comparisonH06DelegatedDelivery.js';
import { h06DelegatedStages } from './comparisonH06DelegatedAuthority.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';

export interface H06SeriesAccountingInput {
  operator: InputRef;
  opId: string;
  profile: { model: string; effort: string };
  root: {
    session: string;
    transcript: string;
    turnId: string;
    workspace: string;
    source: InputRef;
    startedAtMs: number;
  };
  actorDeliveries?: readonly H06DelegatedDeliveryProof[];
  managed: { receipts: readonly NativeComparisonReceipt[]; starts: number };
  execution: H06SeriesAccountingExecution;
}

export interface H06SeriesAccountingExecution {
  node: string;
  tsx: string;
  series: string;
  step: string;
  evidenceRoot: string;
  legacy?: {
    package: string;
    reader: string;
    packets: {
      load: string;
      warmPause: string;
      warmResume: string;
      coldPause: string;
      coldResume: string;
    };
  };
}

const terminalTypes = new Set(['task_complete', 'task_aborted', 'turn_aborted']);
const isTerminal = (row: Row) =>
  row.record.type === 'event_msg' && terminalTypes.has(String(row.payload.type));
const limitMetrics = ['responses', 'input_uncached', 'input_cached', 'output'] as const;
const turnKey = (session: string, turn: string) => canonical([session, turn]);
const event = (row: Row, name: string) =>
  row.record.type === 'event_msg' && row.payload.type === name;

interface Row {
  index: number;
  record: Record<string, unknown>;
  payload: Record<string, unknown>;
  source: InputRef;
}

function point(value: unknown): InputRef {
  const row = object(value);
  exactFields(row, ['locator', 'hash']);
  const hash = text(row.hash);
  requireContract(/^[a-f0-9]{64}$/u.test(hash), 'h06-series-accounting-hash');
  return { locator: text(row.locator), hash };
}

function pathOf(source: InputRef) {
  const match = /^(.*)#L[1-9][0-9]*$/u.exec(source.locator);
  requireContract(match !== null, 'h06-series-accounting-source');
  return match[1]!;
}

function rows(path: string, bytes: Buffer) {
  return bytes
    .toString('utf8')
    .split('\n')
    .slice(0, -1)
    .map((line, index): Row => {
      const record = object(JSON.parse(line));
      return {
        index,
        record,
        payload: object(record.payload),
        source: { locator: `${path}#L${index + 1}`, hash: digest(line + '\n') },
      };
    });
}

function time(row: Row) {
  const ms = Date.parse(text(row.record.timestamp));
  requireContract(Number.isSafeInteger(ms) && ms > 0, 'h06-series-accounting-time');
  return ms;
}

function one<T>(values: T[], reason: string): T {
  requireContract(values.length === 1, reason);
  return values[0]!;
}

const commandText = (parts: readonly string[]) =>
  parts.map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' ');

function externalCommands(execution: H06SeriesAccountingExecution, actor: boolean) {
  const { node, tsx, series, step, evidenceRoot, legacy } = execution;
  const launch = commandText([node, '--import', tsx, series, '--step', step]);
  const commands = new Set(actor ? [] : [launch]);
  let reader = '';
  if (legacy !== undefined) {
    const pkg = [node, '--import', tsx, legacy.package];
    if (actor) {
      for (const [action, packet] of [
        ['warm', legacy.packets.load],
        ['deliver', legacy.packets.warmPause],
        ['deliver', legacy.packets.warmResume],
        ['deliver', legacy.packets.coldPause],
        ['cold', legacy.packets.coldResume],
      ])
        commands.add(commandText([...pkg, action!, packet!]));
      reader = commandText([node, '--import', tsx, legacy.reader, 'read-chat']);
    } else {
      for (const action of ['--admit', '--settle'])
        for (const stage of h06DelegatedStages)
          commands.add(
            commandText([...pkg, action, join(evidenceRoot, 'delegated-claim.json'), stage]),
          );
    }
  }
  const localRead = /^'\/bin\/cat' '([^'\r\n]+)'$/u;
  const stageRead = /^ '([^'\r\n]+)' '--full'$/u;
  function allows(command: string) {
    if (commands.has(command)) return true;
    const path = localRead.exec(command)?.[1];
    if (path !== undefined) return isAbsolute(path) && path === resolve(path);
    if (reader === '' || !command.startsWith(reader)) return false;
    const load = stageRead.exec(command.slice(reader.length))?.[1];
    return (
      load !== undefined &&
      dirname(load) === evidenceRoot &&
      /^package-(?:load|warm-resume|cold-resume)-read-[1-9][0-9]*\.json$/u.test(
        load.slice(evidenceRoot.length + 1),
      ) &&
      resolve(load) === load
    );
  }
  return { allows, launch };
}

const passiveItems = new Set(['Reasoning', 'AgentMessage', 'UserMessage', 'FunctionCallOutput']);
const passiveResponses = new Set([
  'reasoning',
  'message',
  'agent_message',
  'additional_tools',
  'function_call_output',
  'custom_tool_call_output',
]);
const passiveRecord = (row: Row) =>
  ['turn_context', 'token_usage_record', 'compacted', 'world_state'].includes(
    String(row.record.type),
  ) ||
  event(row, 'token_count') ||
  event(row, 'thread_settings_applied');

function verifyExternalTools(
  window: Row[],
  workspace: string,
  actor: boolean,
  execution: H06SeriesAccountingExecution,
  sends: ReadonlyMap<string, Row>,
  turn: string,
  launchProof: string,
) {
  const { allows, launch } = externalCommands(execution, actor);
  const echoed = new Set<Row>();
  function verifySend(row: Row, args: unknown) {
    const sent = one(
      [...sends.values()].filter(
        (sent) =>
          sent.payload.turn_id === turn &&
          sent.index > row.index &&
          same(args, object(sent.payload.item).arguments),
      ),
      'h06-series-accounting-untracked-tool',
    );
    requireContract(!echoed.has(sent), 'h06-series-accounting-untracked-tool');
    echoed.add(sent);
  }
  let launched = false;
  for (const row of window) {
    if (event(row, 'item_started') || event(row, 'item_completed')) {
      requireContract(row.payload.turn_id === turn, 'h06-series-accounting-tool-turn');
      const item = object(row.payload.item);
      if (passiveItems.has(String(item.type))) continue;
      if (item.type === 'CommandExecution') {
        const argv = item.command;
        requireContract(
          Array.isArray(argv) &&
            argv.length === 3 &&
            argv[0] === '/bin/sh' &&
            argv[1] === '-c' &&
            typeof argv[2] === 'string' &&
            allows(argv[2]) &&
            item.cwd === pathToFileURL(workspace).href,
          'h06-series-accounting-command',
        );
        if (
          argv[2] === launch &&
          event(row, 'item_completed') &&
          item.exit_code === 1 &&
          item.status === 'failed' &&
          typeof item.aggregated_output === 'string' &&
          item.aggregated_output.split(/\r?\n/u).includes(launchProof)
        )
          launched = true;
        continue;
      }
      requireContract(
        item.type === 'McpToolCall' && item.server === 'codex_app',
        'h06-series-accounting-untracked-tool',
      );
      if (item.tool === 'wait_threads') continue;
      const sent = sends.get(String(item.id));
      requireContract(
        item.tool === 'send_message_to_thread' &&
          sent !== undefined &&
          sent.payload.turn_id === turn &&
          (event(row, 'item_started') ? row.index < sent.index : row === sent),
        'h06-series-accounting-untracked-tool',
      );
      continue;
    }
    if (row.record.type !== 'response_item') {
      requireContract(passiveRecord(row), 'h06-series-accounting-untracked-tool');
      continue;
    }
    const { payload } = row;
    if (passiveResponses.has(String(payload.type))) continue;
    if (payload.type === 'custom_tool_call') {
      requireContract(
        payload.name === 'exec' && payload.namespace === undefined,
        'h06-series-accounting-untracked-tool',
      );
      const wrapped =
        /^text\(await tools\.(exec_command|write_stdin|mcp__codex_app__send_message_to_thread|mcp__codex_app__wait_threads)\((\{[^\r\n]*\})\)\);\n?$/u.exec(
          text(payload.input),
        );
      requireContract(wrapped !== null, 'h06-series-accounting-exec-wrapper');
      const args = object(JSON.parse(wrapped[2]!));
      if (wrapped[1] === 'mcp__codex_app__wait_threads') continue;
      if (wrapped[1] === 'mcp__codex_app__send_message_to_thread') verifySend(row, args);
      else if (wrapped[1] === 'write_stdin') {
        exactFields(args, ['session_id', 'chars']);
        requireContract(
          Number.isSafeInteger(args.session_id) && args.chars === '',
          'h06-series-accounting-exec-wrapper',
        );
      } else {
        requireContract(
          Object.keys(args).every((key) =>
            [
              'cmd',
              'workdir',
              'shell',
              'login',
              'yield_time_ms',
              'max_output_tokens',
              'tty',
            ].includes(key),
          ) &&
            args.workdir === workspace &&
            args.shell === '/bin/sh' &&
            args.login === false &&
            allows(text(args.cmd)),
          'h06-series-accounting-command',
        );
      }
      continue;
    }
    requireContract(payload.type === 'function_call', 'h06-series-accounting-untracked-tool');
    if (
      (payload.name === 'wait' && payload.namespace === undefined) ||
      payload.name === 'mcp__codex_app__wait_threads'
    )
      continue;
    if (payload.name === 'wait_threads' && payload.namespace === 'codex_app') continue;
    requireContract(
      payload.name === 'mcp__codex_app__send_message_to_thread' ||
        (payload.name === 'send_message_to_thread' && payload.namespace === 'codex_app'),
      'h06-series-accounting-untracked-tool',
    );
    verifySend(row, JSON.parse(text(payload.arguments)));
  }
  return launched;
}

/** A closed H06 roster is derived from native authority and actual delegated deliveries. */
export function verifyH06SeriesAccounting(ref: InputRef, input: H06SeriesAccountingInput) {
  const packet = object(h01ReadJson(ref));
  exactFields(packet, ['kind', 'operator', 'through']);
  requireContract(
    packet.kind === 'comparison-h06-series-accounting/1' &&
      same(packet.operator, input.operator) &&
      Array.isArray(packet.through),
    'h06-series-accounting-binding',
  );
  const through = new Map<string, InputRef>();
  for (const raw of packet.through) {
    const row = object(raw);
    exactFields(row, ['session', 'turn', 'source']);
    const key = turnKey(identifier(row.session), identifier(row.turn));
    requireContract(!through.has(key), 'h06-series-accounting-window-duplicate');
    through.set(key, point(row.source));
  }
  const { root, profile, managed, execution } = input;
  const journals = new Map<string, { bytes: Buffer; rows: Row[]; byLocation: Map<string, Row> }>();
  function journal(path: string) {
    const previous = journals.get(path);
    if (previous !== undefined) return previous;
    const bytes = readH06NativeJournal(path);
    const entries = rows(path, bytes);
    const value = {
      bytes,
      rows: entries,
      byLocation: new Map(entries.map((row) => [row.source.locator, row])),
    };
    journals.set(path, value);
    return value;
  }
  function locate(path: string, source: InputRef) {
    const row = journal(path).byLocation.get(source.locator);
    requireContract(
      row !== undefined && row.source.hash === source.hash,
      'h06-series-accounting-source',
    );
    return row;
  }

  const { rows: rootRows } = journal(root.transcript);
  const rootStart = one(
    rootRows.filter((row) => event(row, 'task_started') && row.payload.turn_id === root.turnId),
    'h06-series-accounting-root',
  );
  const rootClosures = rootRows.filter(
    (row) =>
      event(row, 'task_complete') &&
      row.index > rootStart.index &&
      through.has(turnKey(root.session, identifier(row.payload.turn_id))),
  );
  const rootEnd = rootClosures.at(-1);
  requireContract(
    rootEnd !== undefined && rootEnd.payload.error == null,
    'h06-series-accounting-root',
  );
  const rootWindow = rootRows.slice(rootStart.index, rootEnd.index + 1);
  requireContract(
    verifyH06OperatorContinuation(
      rootRows.slice(0, rootEnd.index + 1).map(({ record }) => record),
      root.turnId,
      identifier(rootEnd.payload.turn_id),
      root.workspace,
    ),
    'h06-series-accounting-root',
  );
  const source = locate(root.transcript, root.source);
  requireContract(
    source.index > rootStart.index && source.index < rootClosures[0]!.index,
    'h06-series-accounting-root-source',
  );
  const startedAtMs = time(rootStart),
    endedAtMs = time(rootEnd);
  requireContract(
    startedAtMs <= root.startedAtMs && root.startedAtMs <= endedAtMs,
    'h06-series-accounting-root-time',
  );

  const deliveries = input.actorDeliveries ?? [];
  const allowedSends = new Map<string, Row>();
  const actorPaths = new Map<string, string>();
  const externalTurns = new Set<string>();
  const external: NativeComparisonReceipt[] = [];
  const responseIds = new Set<string>();
  let launched = false;

  function consume(session: string, path: string, start: Row, actorWorkspace?: string) {
    const turn = identifier(start.payload.turn_id),
      key = turnKey(session, turn);
    const terminal = through.get(key);
    requireContract(
      terminal !== undefined && !externalTurns.has(key),
      'h06-series-accounting-window',
    );
    const boundary = locate(path, terminal);
    const entries = journal(path).rows;
    const end = one(
      entries.filter((row) => isTerminal(row) && row.payload.turn_id === turn),
      'h06-series-accounting-terminal',
    );
    const window = entries.slice(start.index + 1, end.index);
    const started = time(start),
      stopped = time(end),
      duration = end.payload.duration_ms;
    requireContract(
      event(end, 'task_complete') &&
        end.payload.turn_id === turn &&
        end.index > start.index &&
        (end === boundary ||
          (boundary.record.type === 'token_usage_record' &&
            boundary.payload.turn_id === turn &&
            boundary.index > end.index)) &&
        typeof duration === 'number' &&
        Number.isSafeInteger(duration) &&
        duration >= 0 &&
        stopped >= started &&
        Math.abs(stopped - started - duration) <= 1000 &&
        startedAtMs <= started &&
        stopped <= endedAtMs,
      'h06-series-accounting-terminal',
    );
    requireContract(
      window.every((row) => !event(row, 'task_started') && !isTerminal(row)),
      'h06-series-accounting-window-overlap',
    );
    const context = one(
      window.filter((row) => row.record.type === 'turn_context' && row.payload.turn_id === turn),
      'h06-series-accounting-profile',
    );
    requireContract(
      context.payload.model === profile.model && context.payload.effort === profile.effort,
      'h06-series-accounting-profile',
    );
    const actor = actorWorkspace !== undefined;
    const stepLaunched = verifyExternalTools(
      window,
      actorWorkspace ?? root.workspace,
      actor,
      execution,
      actor ? new Map() : allowedSends,
      turn,
      `comparison-h06-step-record:${input.operator.hash}`,
    );
    launched ||= stepLaunched;
    requireContract(
      entries.every(
        (row) =>
          row.record.type !== 'token_usage_record' ||
          row.payload.turn_id !== turn ||
          (row.index > start.index && row.index <= boundary.index),
      ),
      'h06-series-accounting-unsealed-usage',
    );
    const tail = entries.slice(end.index + 1);
    const next = tail.findIndex((row) => event(row, 'task_started'));
    const betweenTurns = next < 0 ? tail : tail.slice(0, next);
    requireContract(
      betweenTurns.every(
        (row) =>
          passiveRecord(row) ||
          (row.record.type === 'response_item' && passiveResponses.has(String(row.payload.type))),
      ) &&
        tail.every(
          (row) =>
            row.payload.turn_id !== turn ||
            (!event(row, 'item_started') && !event(row, 'item_completed')),
        ),
      'h06-series-accounting-late-effect',
    );
    const receipts = readComparisonUsage({
      session,
      transcript: path,
      run: input.opId,
      stage: 'execution',
      through: terminal,
    }).filter((receipt) => {
      const row = locate(path, receipt.source);
      return row.index > start.index && (row.index <= end.index || row.payload.turn_id === turn);
    });
    requireContract(receipts.length > 0, 'h06-series-accounting-usage-missing');
    for (const receipt of receipts) {
      const row = locate(path, receipt.source);
      requireContract(
        row.record.type === 'token_usage_record' && row.payload.turn_id === turn,
        'h06-series-accounting-primary-usage',
      );
      const id = identifier(row.payload.response_id);
      requireContract(!responseIds.has(id), 'h06-series-accounting-response-reused');
      responseIds.add(id);
      external.push(receipt);
    }
    externalTurns.add(key);
    return end;
  }

  for (const proof of deliveries) {
    const { input: binding, actorTurnId } = proof;
    const outbound = locate(root.transcript, proof.outbound);
    const item = object(outbound.payload.item);
    const path = pathOf(proof.inbound),
      session = binding.actor.threadId;
    const previous = actorPaths.get(session);
    requireContract(
      binding.root.threadId === root.session &&
        binding.root.turnId === root.turnId &&
        same(binding.root.user, root.source) &&
        same(proof.user, root.source) &&
        outbound.index > source.index &&
        outbound.index < rootEnd.index &&
        !allowedSends.has(identifier(item.id)) &&
        session !== root.session &&
        path !== root.transcript &&
        (previous === undefined || previous === path),
      'h06-series-accounting-delivery',
    );
    allowedSends.set(identifier(item.id), outbound);
    actorPaths.set(session, path);
    const start = one(
      journal(path).rows.filter(
        (row) => event(row, 'task_started') && row.payload.turn_id === actorTurnId,
      ),
      'h06-series-accounting-actor',
    );
    const attribution = object(start.payload.turn_attribution);
    const inbound = locate(path, proof.inbound);
    const closed = consume(session, path, start, binding.actor.workspace);
    requireContract(
      attribution.turn_trigger === 'app_tool_send_message' &&
        attribution.parent_turn_id === outbound.payload.turn_id &&
        attribution.root_turn_id === outbound.payload.turn_id &&
        start.index < inbound.index &&
        inbound.index < closed.index &&
        closed.payload.error == null,
      'h06-series-accounting-actor',
    );
  }

  for (const [session, path] of actorPaths)
    for (const row of journal(path).rows)
      if (event(row, 'task_started') && time(row) >= startedAtMs && time(row) <= endedAtMs)
        requireContract(
          externalTurns.has(turnKey(session, identifier(row.payload.turn_id))),
          'h06-series-accounting-untracked-actor',
        );

  let previousEnd = rootStart;
  for (const start of rootWindow.filter((row) => event(row, 'task_started'))) {
    requireContract(time(start) >= time(previousEnd), 'h06-series-accounting-root-time');
    previousEnd = consume(root.session, root.transcript, start);
  }
  requireContract(previousEnd === rootEnd, 'h06-series-accounting-root');
  requireContract(launched, 'h06-series-accounting-launch-unproved');
  requireContract(through.size === externalTurns.size, 'h06-series-accounting-window-inventory');

  const total = { responses: 0, input_uncached: 0, input_cached: 0, output: 0 };
  const receiptIds = new Set<string>(),
    receiptSources = new Set<string>();
  const externalSessions = new Set([root.session, ...actorPaths.keys()]);
  requireContract(
    managed.receipts.length > 0 &&
      managed.receipts.every(({ participant }) => !externalSessions.has(participant)),
    'h06-series-accounting-managed-overlap',
  );
  for (const receipt of [...managed.receipts, ...external]) {
    requireContract(
      receipt.run === input.opId &&
        !receiptIds.has(receipt.id) &&
        !receiptSources.has(receipt.source.locator),
      'h06-series-accounting-receipt-conflict',
    );
    receiptIds.add(receipt.id);
    receiptSources.add(receipt.source.locator);
    for (const metric of limitMetrics) {
      const n = receipt[metric];
      requireContract(
        n !== null && Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(total[metric] + n),
        'h06-series-accounting-incomplete-usage',
      );
      total[metric] += n;
    }
  }
  const starts = managed.starts + externalTurns.size;
  requireContract(
    Number.isSafeInteger(managed.starts) && managed.starts > 0 && Number.isSafeInteger(starts),
    'h06-series-accounting-starts',
  );
  for (const [path, snapshot] of journals) {
    requireContract(
      readH06NativeJournal(path).equals(snapshot.bytes),
      'h06-series-accounting-prefix-changed',
    );
  }
  h01ReadJson(ref);
  return {
    totals: {
      reservedManagedStarts: starts,
      observedResponses: total.responses,
      inputUncached: total.input_uncached,
      inputCached: total.input_cached,
      output: total.output,
    },
    evidence: [ref],
    window: { startedAtMs, endedAtMs },
    externalTurns: [...externalTurns].sort(),
  };
}
