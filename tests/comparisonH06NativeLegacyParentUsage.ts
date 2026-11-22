import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readComparisonUsage } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { ChatObservation } from '../core/currentChat.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { identifier, object, requireContract, text } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';

const name = 'legacy-parent-usage-start.json';
const terminalTypes = ['task_complete', 'task_aborted', 'turn_aborted'];

function record(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
}

function lines(bytes: Buffer) {
  const body = bytes.toString('utf8');
  requireContract(
    Buffer.from(body).equals(bytes) && body.endsWith('\n'),
    'h06-parent-usage-partial',
  );
  return body.slice(0, -1).split('\n');
}

function sourceLine(value: unknown, transcript: string, rows: string[]) {
  const source = object(value);
  const match = /^(.*)#L([1-9]\d*)$/u.exec(text(source.locator));
  requireContract(match?.[1] === transcript, 'h06-parent-usage-source');
  const index = Number(match[2]) - 1;
  requireContract(
    rows[index] !== undefined && digest(rows[index] + '\n') === source.hash,
    'h06-parent-usage-source',
  );
  return index;
}

/** Record the immutable prefix immediately before the already authorized Legacy actor starts work. */
export function captureH06NativeLegacyParentStart(
  claim: H04Pin,
  transcript: string,
  observed: ChatObservation,
) {
  const evidenceRoot = dirname(claim.path);
  const bytes = h01RawFile(transcript);
  const rows = lines(bytes);
  sourceLine(observed.source, transcript, rows);
  const body = Buffer.from(
    JSON.stringify({
      kind: 'h06-native-legacy-parent-usage-start',
      claim,
      transcript,
      actor: observed.thread_id,
      workspace: observed.workspace,
      context: observed.source,
      prefix: { lines: rows.length, sha256: digest(bytes) },
    }),
  );
  const path = join(evidenceRoot, name);
  publishFile(path, body);
  return { path, sha256: digest(body) };
}

/** Account for the parent prefix ending at the retained cold RESUME's native terminal boundary. */
export function checkH06NativeLegacyParentUsage(input: {
  started: H04Pin;
  parent: H04Pin;
  coldResume: H04Pin;
}) {
  const start = record(input.started);
  const parent = record(input.parent);
  const cold = record(input.coldResume);
  const root = dirname(input.started.path);
  const claim = h04Pin(start.claim);
  const claimed = record(claim);
  const { workspaceRoot } = object(object(claimed.request).binding);
  const context = object(start.context);
  const actor = identifier(context.actor_id);
  const transcript = text(parent.transcript);
  const sessionsRoot = text(object(claimed.grant).sessionsRoot);
  const final = object(object(cold.control).observed);
  requireContract(
    input.started.path === join(root, 'legacy-operator-start.json') &&
      claim.path === join(root, 'attempt-claim.json') &&
      input.parent.path === join(root, name) &&
      input.coldResume.path === join(root, 'legacy-cold-resume.json') &&
      start.kind === 'h06-native-legacy-operator-start' &&
      claimed.kind === 'h06-native-attempt-claim' &&
      parent.kind === 'h06-native-legacy-parent-usage-start' &&
      cold.kind === 'h06-native-legacy-resume' &&
      cold.phase === 'cold' &&
      same(parent.claim, claim) &&
      parent.actor === actor &&
      parent.workspace === workspaceRoot &&
      transcript.startsWith(sessionsRoot + sep) &&
      same(cold.identity, {
        workspace: workspaceRoot,
        store: start.storeRoot,
        evidence: root,
        context,
        generation: start.generation,
      }) &&
      final.thread_id === actor &&
      final.workspace === workspaceRoot,
    'h06-parent-usage-binding',
  );
  const bytes = h01RawFile(transcript);
  const rows = lines(bytes);
  const prefix = object(parent.prefix);
  const count = prefix.lines;
  requireContract(
    typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      count < rows.length &&
      digest(rows.slice(0, count).join('\n') + '\n') === prefix.sha256 &&
      sourceLine(parent.context, transcript, rows) < count,
    'h06-parent-usage-prefix',
  );
  const lastContext = sourceLine(final.source, transcript, rows);
  const turn = identifier(final.turn_id);
  const finalRow = object(JSON.parse(rows[lastContext]!));
  requireContract(
    lastContext >= count &&
      finalRow.type === 'turn_context' &&
      object(finalRow.payload).turn_id === turn,
    'h06-parent-usage-terminal-binding',
  );
  let through = rows.length - 1;
  let terminal = false;
  for (let index = lastContext + 1; index < rows.length; index++) {
    const row = object(JSON.parse(rows[index]!));
    const payload = object(row.payload);
    if (row.type === 'event_msg' && payload.type === 'task_started') {
      through = index - 1;
      break;
    }
    if (
      row.type === 'event_msg' &&
      terminalTypes.includes(String(payload.type)) &&
      payload.turn_id === turn
    ) {
      requireContract(!terminal, 'h06-parent-usage-terminal-binding');
      terminal = true;
    }
  }
  const receiptBoundary = {
    locator: transcript + '#L' + (through + 1),
    hash: digest(rows[through]! + '\n'),
  };
  const receipts = readComparisonUsage({
    session: actor,
    transcript,
    run: identifier(context.task_id),
    stage: 'execution',
    through: receiptBoundary,
  }).filter(({ source }) => sourceLine(source, transcript, rows) >= count);
  requireContract(h01RawFile(transcript).equals(bytes), 'h06-parent-usage-transcript-changed');
  const subtotal = (key: 'responses' | 'input_uncached' | 'input_cached' | 'output') => {
    const total = receipts.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    requireContract(Number.isSafeInteger(total), 'h06-parent-usage-overflow');
    return total;
  };
  return {
    status:
      terminal &&
      receipts.length > 0 &&
      receipts.every((row) =>
        [row.responses, row.input_uncached, row.input_cached, row.output].every(
          (value) => value !== null,
        ),
      )
        ? 'RECORDED'
        : 'UNKNOWN',
    knownSubtotal: {
      responses: subtotal('responses'),
      inputUncached: subtotal('input_uncached'),
      inputCached: subtotal('input_cached'),
      output: subtotal('output'),
    },
    receipts,
    through: receiptBoundary,
    qualification: false,
  } as const;
}
