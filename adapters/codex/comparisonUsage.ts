import { dirname } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import type { ComparisonReceipt } from '../../core/comparison.js';
import type { InputRef } from '../../core/localRun.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';
import { canonical, digest } from '../storage/storeCodec.js';

export interface ComparisonParticipant {
  session: string;
  transcript: string;
  run: string | null;
  stage: ComparisonReceipt['stage'];
  after?: InputRef;
  through?: InputRef;
}
export interface NativeComparisonReceipt extends ComparisonReceipt {
  source: InputRef;
}

function counters(raw: unknown) {
  const value = object(raw);
  const result = {
    input_tokens: value.input_tokens as number,
    cached_input_tokens: value.cached_input_tokens as number,
    output_tokens: value.output_tokens as number,
  };
  requireWorkflow(
    Object.values(result).every((n) => Number.isSafeInteger(n) && n >= 0) &&
      result.cached_input_tokens <= result.input_tokens,
    'comparison-usage-counters-invalid',
  );
  return result;
}

// Legacy cumulative events are used only when no response records exist in the sealed range.
export function readComparisonUsage(
  participant: ComparisonParticipant,
  pending = false,
): NativeComparisonReceipt[] {
  let text: string;
  try {
    safeDirectory(dirname(participant.transcript));
    text = readPrivateFile(participant.transcript).toString('utf8');
  } catch (error) {
    if (pending && (error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  requireWorkflow(
    pending || participant.through !== undefined || text.endsWith('\n'),
    'comparison-usage-history-partial',
  );
  if (pending || participant.through !== undefined)
    text = text.slice(0, text.lastIndexOf('\n') + 1);
  if (pending && text === '') return [];
  let lines = text.slice(0, -1).split('\n');
  if (participant.through !== undefined) {
    const index = lines.findIndex((line, index) =>
      sameValue(
        {
          locator: `${participant.transcript}#L${index + 1}`,
          hash: digest(line + '\n'),
        },
        participant.through,
      ),
    );
    requireWorkflow(index >= 0, 'comparison-usage-end-unconfirmed');
    lines = lines.slice(0, index + 1);
  }
  if (lines.some((line) => object(JSON.parse(line)).type === 'token_usage_record'))
    return readResponseUsage(participant, lines, pending);
  const receipts: NativeComparisonReceipt[] = [];
  let session: string | null = null;
  let previous = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let started = participant.after === undefined;
  let turnUsage = true;
  for (const [index, line] of lines.entries()) {
    const record = object(JSON.parse(line));
    const payload = object(record.payload);
    const source = {
      locator: `${participant.transcript}#L${index + 1}`,
      hash: digest(line + '\n'),
    };
    if (record.type === 'session_meta') {
      requireWorkflow(
        session === null && payload.id === participant.session,
        'comparison-usage-session-mismatch',
      );
      session = textField(payload.id);
    }
    const boundary = sameValue(source, participant.after);
    if (record.type === 'event_msg' && payload.type === 'task_started') turnUsage = false;
    if (
      started &&
      record.type === 'event_msg' &&
      ['task_complete', 'task_aborted', 'turn_aborted'].includes(String(payload.type)) &&
      !turnUsage
    )
      receipts.push({
        id: digest(canonical([participant.session, source, 'missing-turn-usage'])),
        run: participant.run,
        participant: participant.session,
        stage: participant.stage,
        responses: null,
        input_uncached: null,
        input_cached: null,
        output: null,
        source,
      });
    if (record.type !== 'event_msg' || payload.type !== 'token_count' || payload.info === null) {
      requireWorkflow(!boundary, 'comparison-usage-boundary-invalid');
      continue;
    }
    const info = object(payload.info);
    const total = counters(info.total_token_usage);
    const delta = {
      input_tokens: total.input_tokens - previous.input_tokens,
      cached_input_tokens: total.cached_input_tokens - previous.cached_input_tokens,
      output_tokens: total.output_tokens - previous.output_tokens,
    };
    requireWorkflow(
      Object.values(delta).every((n) => n >= 0) && delta.cached_input_tokens <= delta.input_tokens,
      'comparison-usage-counter-regressed',
    );
    if (started && !sameValue(total, previous)) {
      receipts.push({
        id: digest(canonical([participant.session, total])),
        run: participant.run,
        participant: participant.session,
        stage: participant.stage,
        responses: sameValue(delta, counters(info.last_token_usage)) ? 1 : null,
        input_uncached: delta.input_tokens - delta.cached_input_tokens,
        input_cached: delta.cached_input_tokens,
        output: delta.output_tokens,
        source,
      });
    }
    if (!sameValue(total, previous)) turnUsage = true;
    previous = total;
    if (boundary) started = true;
  }
  requireWorkflow(
    session === participant.session && started,
    'comparison-usage-boundary-unconfirmed',
  );
  if (!pending && receipts.length === 0)
    receipts.push({
      id: digest(canonical([participant.session, participant.after ?? null, 'missing-usage'])),
      run: participant.run,
      participant: participant.session,
      stage: participant.stage,
      responses: null,
      input_uncached: null,
      input_cached: null,
      output: null,
      source: participant.through ?? { locator: participant.transcript, hash: digest(text) },
    });
  return receipts;
}

// Seal only after the owned runtime and its writers have stopped.
export function sealComparisonUsage(participant: ComparisonParticipant): ComparisonParticipant {
  if (participant.through !== undefined) return participant;
  const text = readPrivateFile(participant.transcript).toString('utf8');
  requireWorkflow(text.length > 0 && text.endsWith('\n'), 'comparison-usage-history-partial');
  const lines = text.slice(0, -1).split('\n');
  return {
    ...participant,
    through: {
      locator: `${participant.transcript}#L${lines.length}`,
      hash: digest(lines.at(-1)! + '\n'),
    },
  };
}

function readResponseUsage(
  participant: ComparisonParticipant,
  lines: string[],
  pending: boolean,
): NativeComparisonReceipt[] {
  const receipts: NativeComparisonReceipt[] = [];
  const seen = new Map<string, ReturnType<typeof counters>>();
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let session = false;
  let started = participant.after === undefined;
  let turnUsage = true;
  let incomplete = false;
  const unknown = (source: InputRef) => {
    receipts.push({
      id: digest(canonical([participant.session, source, 'incomplete-response-usage'])),
      run: participant.run,
      participant: participant.session,
      stage: participant.stage,
      responses: null,
      input_uncached: null,
      input_cached: null,
      output: null,
      source,
    });
  };
  for (const [index, line] of lines.entries()) {
    const record = object(JSON.parse(line));
    const payload = object(record.payload);
    const source = {
      locator: `${participant.transcript}#L${index + 1}`,
      hash: digest(line + '\n'),
    };
    const boundary = sameValue(source, participant.after);
    if (record.type === 'session_meta') {
      requireWorkflow(
        !session && payload.id === participant.session,
        'comparison-usage-session-mismatch',
      );
      session = true;
    }
    if (record.type === 'token_usage_record') {
      requireWorkflow(
        payload.thread_id === participant.session && payload.session_id === participant.session,
        'comparison-usage-session-mismatch',
      );
      const id = textField(payload.response_id);
      textField(payload.turn_id);
      const usage = counters(payload.usage);
      const previous = seen.get(id);
      requireWorkflow(
        previous === undefined || sameValue(previous, usage),
        'comparison-usage-response-conflict',
      );
      if (previous === undefined) {
        seen.set(id, usage);
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += usage[key];
        if (started)
          receipts.push({
            id: digest(canonical([participant.session, id])),
            run: participant.run,
            participant: participant.session,
            stage: participant.stage,
            responses: 1,
            input_uncached: usage.input_tokens - usage.cached_input_tokens,
            input_cached: usage.cached_input_tokens,
            output: usage.output_tokens,
            source,
          });
        turnUsage = true;
      }
      // A mixed/partial transcript cannot be repaired with cumulative events or guessed deltas.
      if (
        previous === undefined &&
        (payload.thread_token_usage === undefined ||
          !sameValue(counters(payload.thread_token_usage), total))
      )
        incomplete = true;
    } else if (record.type === 'event_msg') {
      if (payload.type === 'task_started') turnUsage = false;
      if (
        ['task_complete', 'task_aborted', 'turn_aborted'].includes(String(payload.type)) &&
        started &&
        !turnUsage
      )
        unknown(source);
      if (payload.type === 'token_count' && payload.info !== null) {
        const eventTotal = counters(object(payload.info).total_token_usage);
        // Events may omit compaction usage; they may never account for responses absent here.
        if (
          Object.keys(total).some(
            (key) => eventTotal[key as keyof typeof total] > total[key as keyof typeof total],
          )
        )
          incomplete = true;
      } else requireWorkflow(!boundary, 'comparison-usage-boundary-invalid');
    } else requireWorkflow(!boundary, 'comparison-usage-boundary-invalid');
    if (boundary) started = true;
  }
  requireWorkflow(session && started, 'comparison-usage-boundary-unconfirmed');
  if (incomplete || (!pending && receipts.length === 0))
    unknown({
      locator: `${participant.transcript}#L${lines.length}`,
      hash: digest(lines.at(-1)! + '\n'),
    });
  return receipts;
}
