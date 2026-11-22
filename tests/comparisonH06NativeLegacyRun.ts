import { join, resolve } from 'node:path';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { evidenceSchema, type EvidenceGrant, type TechnicalState } from '../core/evidence.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { h06NativeChatRelay } from './comparisonH06NativeChatRelay.js';
import {
  runH06NativeLegacyCold,
  runH06NativeLegacyInitialAndWarm,
  type H06LegacyActorChat,
} from './comparisonH06NativeLegacyActor.js';
import { runH06NativeLegacyDriver } from './comparisonH06NativeLegacyDriver.js';
import { runH06NativeLegacyCompletion } from './comparisonH06NativeLegacyTransportPhase.js';

type LegacyActorResult = Awaited<ReturnType<Parameters<typeof runH06NativeLegacyDriver>[1]>>;
type Retained = Parameters<typeof runH06NativeLegacyCold>[0];

function read(value: unknown) {
  return object(JSON.parse(readH04Pin(h04Pin(value)).toString()));
}

async function actorStore(claim: H04Pin, started: H04Pin) {
  const { request, grant: authority } = readH06NativeAttemptForReopen(claim);
  const { binding, evidenceRoot } = request;
  const bootstrap = read(request.bootstrap);
  const actorId = identifier(bootstrap.actorId);
  const source = read(started);
  const permissions = bootstrap.permissions;
  const allowed = new Set<unknown>(['read', 'manage', 'produce', 'resolve']);
  requireContract(
    binding.variant === 'legacy' &&
      bootstrap.kind === 'comparison-h06-native-legacy-bootstrap/2' &&
      process.env.CODEX_THREAD_ID === actorId &&
      started.path === join(evidenceRoot, 'legacy-operator-start.json') &&
      source.kind === 'h06-native-legacy-operator-start' &&
      same(source.claim, claim) &&
      same(source.bootstrap, request.bootstrap) &&
      Array.isArray(permissions) &&
      permissions.every((permission): permission is EvidenceGrant['permissions'][number] =>
        allowed.has(permission),
      ) &&
      permissions.includes('manage') &&
      permissions.includes('read'),
    'h06-legacy-run-actor',
  );
  const context = {
    schema_version: evidenceSchema,
    project_id: identifier(bootstrap.projectId),
    task_id: binding.operationId,
    subtask_id: null,
    run_id: identifier(bootstrap.runId),
    actor_id: actorId,
  };
  const storeRoot = join(evidenceRoot, 'legacy-store');
  requireContract(
    source.storeRoot === storeRoot &&
      same(source.context, context) &&
      source.generation === bootstrap.generation,
    'h06-legacy-run-store',
  );
  const { transcript, anchor } = await discoverChat(
    binding.workspaceRoot,
    authority.sessionsRoot,
    actorId,
  );
  const store = new SqliteEvidenceStore(storeRoot, { context, permissions }, Date.now);
  function state() {
    const current = unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
    requireContract(
      current.owner === actorId &&
        current.generation === bootstrap.generation &&
        !current.frozen &&
        !current.released &&
        current.lease_until > Date.now(),
      'h06-legacy-run-store',
    );
    return current;
  }
  const initial = state();
  h01RawFile(join(storeRoot, 'chat-runtime.json'));
  const bound = bindChatEvidence(storeRoot, evidenceRoot, initial);
  function verify() {
    bound();
    readH04Pin(claim);
    readH04Pin(started);
    state();
  }
  verify();
  return { store, verify, evidenceRoot, runtime: request.runtime, actor: { transcript, anchor } };
}

export async function h06NativeLegacyRunMain(
  args: readonly string[],
  channel: { input: Readable; output: Writable; signal: AbortSignal },
) {
  const [command, path] = args;
  requireContract(
    args.length === 2 &&
      path !== undefined &&
      (command === '--run' || command === '--warm' || command === '--cold'),
    'h06-legacy-run-arguments',
  );
  const input: unknown = JSON.parse(h01RawFile(resolve(path)).toString());
  const relay = h06NativeChatRelay(channel.input, channel.output);
  const chat: H06LegacyActorChat = {
    async control(proposal, signal) {
      return object(
        await relay.exchange('h06-legacy-control', proposal, signal),
      ) as unknown as Awaited<ReturnType<H06LegacyActorChat['control']>>;
    },
  };
  try {
    if (command === '--run')
      return await runH06NativeLegacyDriver(
        input,
        async (stage, signal) =>
          object(
            await relay.exchange('h06-legacy-actor-stage', stage, signal),
          ) as unknown as LegacyActorResult,
        channel.signal,
      );
    if (command === '--warm') {
      const data = object(input);
      exactFields(data, [
        'claim',
        'started',
        'initialFailure',
        'preparation',
        'warmBrief',
        'coldBrief',
        'completionBrief',
      ]);
      const claim = h04Pin(data.claim),
        started = h04Pin(data.started);
      const { store, verify, evidenceRoot, actor, runtime } = await actorStore(claim, started);
      const warmBrief = h04Pin(data.warmBrief);
      const coldBrief = h04Pin(data.coldBrief);
      const completionBrief = h04Pin(data.completionBrief);
      const briefs = [warmBrief, coldBrief, completionBrief];
      requireContract(
        briefs.every((pin) => runtime.some((entry) => same(entry, pin))) &&
          new Set(briefs.map((pin) => identifier(read(pin).id))).size === briefs.length,
        'h06-legacy-run-writer-briefs',
      );
      const retained = await runH06NativeLegacyInitialAndWarm(
        {
          claim,
          started,
          actor,
          initialFailure: h04Pin(data.initialFailure),
          preparation: h04Pin(data.preparation),
          warmBrief,
          coldBrief,
        },
        store,
        chat,
        verify,
        channel.signal,
      );
      const locator = join(evidenceRoot, 'legacy-actor-retained.json');
      const bytes = Buffer.from(canonical({ stage: retained, completionBrief }) + '\n');
      publishFile(locator, bytes);
      return { retained: { path: locator, sha256: digest(bytes) } };
    }
    const retainedPin = h04Pin(input);
    const saved = read(retainedPin);
    exactFields(saved, ['stage', 'completionBrief']);
    const retained = object(saved.stage) as unknown as Retained;
    const { store, evidenceRoot, actor } = await actorStore(
      retained.attempt.claim,
      retained.attempt.started,
    );
    requireContract(
      retainedPin.path === join(evidenceRoot, 'legacy-actor-retained.json'),
      'h06-legacy-run-retained',
    );
    const cold = await runH06NativeLegacyCold(
      { ...retained, attempt: { ...retained.attempt, actor } },
      store,
      chat,
      channel.signal,
    );
    const completion = await runH06NativeLegacyCompletion(
      {
        claim: retained.attempt.claim,
        started: retained.attempt.started,
        brief: h04Pin(saved.completionBrief),
        coldResume: cold.receipt,
        warmThread: retained.warm.thread,
        coldThread: retained.cold.thread,
      },
      { store, signal: channel.signal },
    );
    return {
      warm: {
        pause: retained.warm.pause.receipt,
        stop: retained.warm.stop.link,
        resume: retained.warmResume.receipt,
        thread: retained.warm.thread,
      },
      cold: {
        pause: retained.cold.pause.receipt,
        stop: retained.cold.stop.link,
        resume: cold.receipt,
        thread: retained.cold.thread,
      },
      completion: { coder: completion.coder, thread: completion.thread },
      council: null,
    };
  } finally {
    relay.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('h06-legacy-run-interrupted'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  void h06NativeLegacyRunMain(process.argv.slice(2), {
    input: process.stdin,
    output: process.stdout,
    signal: abort.signal,
  })
    .then(
      (result) => process.stdout.write(JSON.stringify(result) + '\n'),
      (error: unknown) => {
        process.stderr.write(String(error) + '\n');
        process.exitCode = 1;
      },
    )
    .finally(() => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    });
}
