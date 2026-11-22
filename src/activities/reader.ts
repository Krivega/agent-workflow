import { resolve } from 'node:path';
import type { ArtifactRef, PreparationResult } from '../contracts/preparation.js';
import type { ReaderActivities, ReaderInput, ReaderSession } from '../contracts/reader.js';
import { identifier, object, requireContract, text } from '../contracts/project.js';
import { parsePreparation, checkRegistration } from '../policy/preparation.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import { preparationActivities } from './preparation.js';
import type { LocalProjectRegistration } from './preparation.js';
import { artifactStore, digest, readProjectFile } from '../adapters/artifacts/files.js';
import { reviewProof } from '../adapters/codex/reviewProof.js';
import { effectJournal } from '../adapters/artifacts/effects.js';
import { confirmObservedLoad } from '../adapters/codex/observedLoad.js';
import {
  captureReaderLoadCommandOutputs,
  readerLoadObserved,
} from '../adapters/codex/readerLoadCommandOutputs.js';
import { recoverSentTurn } from '../adapters/codex/recoveredSend.js';
import { readerSession } from '../adapters/codex/readerSession.js';
import { readerContextCompacted } from '../adapters/codex/readerContext.js';
import type { ReaderBoundary } from '../adapters/codex/readerBoundary.js';
import type { ReaderEpoch } from '../contracts/readerControl.js';
import { scopedReader } from '../policy/readerControl.js';
import { readerExecution, supportedReaderClient } from '../policy/readerExecution.js';
import { confirmScopedPreparation } from '../adapters/codex/reviewInputs.js';
import {
  readerOperationId,
  readerLoadPrompt,
  readerReportSchema,
  readerAnswerPrompt,
  readerReport,
} from '../adapters/codex/readerMessages.js';

import type { CodexRpc } from '../contracts/codex.js';
export type { CodexRpc } from '../contracts/codex.js';

export function readerActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
  effectRoot: string,
  boundary?: ReaderBoundary,
): ReaderActivities {
  requireContract(supportedReaderClient(profile.clientVersion), 'unsupported-codex-client');
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const store = artifactStore(registration.artifactRoot);
  const journal = effectJournal(effectRoot);
  const freshSessions = new Set<string>();
  function save(value: unknown) {
    return store.publish(Buffer.from(JSON.stringify(value)));
  }
  function read(ref: ArtifactRef) {
    return object(JSON.parse(store.read(ref).toString('utf8')) as unknown);
  }
  function inputs(value: ReaderInput, prepared: PreparationResult) {
    if (scopedReader(value))
      return {
        input: value.preparation,
        ...confirmScopedPreparation(registration, value, prepared),
      };
    const input = parsePreparation(value.preparation);
    checkRegistration(input, registration);
    const role = input.project.roles.find((role) => role.id === identifier(value.roleId));
    requireContract(role !== undefined, 'reader-role-not-declared');
    const manifest = read(prepared.manifest);
    requireContract(
      manifest.kind === 'preparation' && JSON.stringify(manifest.input) === JSON.stringify(input),
      'reader-preparation-mismatch',
    );
    requireContract(Array.isArray(manifest.inputs), 'reader-preparation-incomplete');
    const refs = [...new Set([...input.project.rules, role.profile, input.card])].map((path) => {
      const bytes = readProjectFile(registration.workspaceRoot, path);
      const hash = digest(bytes);
      requireContract(
        (manifest.inputs as unknown[]).some((value) => {
          const ref = object(value);
          return ref.path === path && ref.sha256 === hash;
        }),
        'reader-input-changed',
      );
      return { path: resolve(registration.workspaceRoot, path), sha256: hash };
    });
    return { input, refs, snapshot: null };
  }
  function intent(value: ReaderInput, operation: string, request: unknown, attempt = 0) {
    const input = value.preparation;
    return {
      projectId: input.project.projectId,
      taskId: input.taskId,
      operationId: readerOperationId(value, operation, attempt),
      requestHash: digest(JSON.stringify(request)),
      hostId: input.hostId,
      workspaceId: input.project.workspaceId,
      owner: input.owner,
      generation: input.generation,
    };
  }
  function confirmSession(response: unknown, expectedId?: string) {
    const observed = readerSession(response, registration.workspaceRoot, profile, expectedId);
    const { thread } = observed;
    requireContract(
      (thread.turns as unknown[])
        .map(object)
        .every((turn) => ['completed', 'interrupted', 'failed'].includes(String(turn.status))),
      'reader-previous-turn-active',
    );
    return observed;
  }
  function checkBoundary(value: ReaderInput, epoch?: ReaderEpoch) {
    backend.require(
      value.preparation.project.projectId,
      value.preparation.taskId,
      'temporal',
      'worker',
      value.preparation.card,
    );
    if (boundary !== undefined) {
      requireContract(
        epoch !== undefined && Number.isSafeInteger(epoch.attempt) && epoch.attempt >= 0,
        'reader-epoch-required',
      );
      boundary.assert(value, epoch);
      requireContract(
        JSON.stringify(boundary.execution(value, epoch.permit)) ===
          JSON.stringify(readerExecution(profile)),
        'reader-execution-changed',
      );
    }
  }
  function dispatch(
    value: ReaderInput,
    epoch: ReaderEpoch | undefined,
    operation: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start',
    params: Record<string, unknown>,
  ) {
    const effect = () => {
      checkBoundary(value, epoch);
      return rpc.request(method, params);
    };
    return boundary === undefined
      ? effect()
      : boundary.dispatch(value, epoch!, operation, method, params, effect);
  }
  function creation(value: ReaderInput, prepared: PreparationResult, session: ReaderSession) {
    const proof = read(session.creation);
    requireContract(
      proof.kind === 'reader-session' &&
        JSON.stringify(proof.input) === JSON.stringify(value) &&
        JSON.stringify(proof.prepared) === JSON.stringify(prepared),
      'reader-creation-binding-mismatch',
    );
    return confirmSession(proof.response, session.id);
  }
  function context(primary: unknown, session: string, loadTurn: string) {
    if (readerContextCompacted(primary, session, loadTurn)) {
      const proof = save({ kind: 'reader-compacted-context', session, loadTurn, primary });
      throw new Error(`reader-context-compacted:${proof.sha256}`);
    }
  }
  async function restore(value: ReaderInput, prepared: PreparationResult, session: ReaderSession) {
    creation(value, prepared, session);
    if (freshSessions.has(session.id)) {
      const loaded = object(await rpc.request('thread/loaded/list', {}));
      requireContract(
        Array.isArray(loaded.data) && loaded.data.includes(session.id),
        'reader-fresh-session-unconfirmed',
      );
      freshSessions.delete(session.id);
      return;
    }
    confirmSession(
      await rpc.request('thread/resume', {
        threadId: session.id,
        cwd: registration.workspaceRoot,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        excludeTurns: false,
        model: profile.model,
        config: {
          model_reasoning_effort: profile.effort,
          sandbox_read_only: { network_access: false },
        },
      }),
      session.id,
    );
  }
  async function turn(session: ReaderSession, id: string) {
    await rpc.completed(session.id, id);
    const thread = object(
      object(await rpc.request('thread/read', { threadId: session.id, includeTurns: true })).thread,
    );
    const primary = save({ kind: 'reader-primary-turn', session: session.id, turnId: id, thread });
    requireContract(
      thread.id === session.id && Array.isArray(thread.turns),
      'reader-history-unknown',
    );
    const matches = thread.turns.map(object).filter((turn) => turn.id === id);
    requireContract(
      matches.length === 1 && matches[0]!.status === 'completed',
      `reader-turn-unconfirmed:${primary.sha256}`,
    );
    return { observed: matches[0]!, primary: thread };
  }
  async function send(
    value: ReaderInput,
    session: ReaderSession,
    operation: string,
    prompt: string,
    epoch?: ReaderEpoch,
    outputSchema?: Record<string, unknown>,
  ) {
    const request = {
      session: session.id,
      prompt,
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
    const operationIntent = intent(value, operation, request, epoch?.attempt);
    const message = `Workflow operation: ${operationIntent.operationId}\n${prompt}`;
    const receipt = await journal.execute(
      operationIntent,
      async () => {
        const response = object(
          await dispatch(value, epoch, operationIntent.operationId, 'turn/start', {
            threadId: session.id,
            ...(outputSchema === undefined ? {} : { outputSchema }),
            input: [
              {
                type: 'text',
                text: message,
              },
            ],
          }),
        );
        return save({ threadId: session.id, turnId: text(object(response.turn).id) });
      },
      async () => {
        const primary = await rpc.request('thread/read', {
          threadId: session.id,
          includeTurns: true,
        });
        save({
          kind: 'reader-send-reconciliation',
          session: session.id,
          operation: operationIntent,
          primary,
        });
        const id = recoverSentTurn(primary, session.id, message);
        return id === null ? null : save({ threadId: session.id, turnId: id });
      },
    );
    const accepted = read(receipt);
    requireContract(accepted.threadId === session.id, 'reader-send-mismatch');
    return text(accepted.turnId);
  }
  return {
    ...preparationActivities(registration),
    async createReader(value, prepared, epoch) {
      checkBoundary(value, epoch);
      const basis = inputs(value, prepared);
      if (basis.snapshot?.schemaVersion === 5 || basis.snapshot?.schemaVersion === 7)
        requireContract(
          JSON.stringify(basis.snapshot.arbitration.profile) === JSON.stringify(profile),
          'arbitration-profile-mismatch',
        );
      const predecessor =
        basis.snapshot?.schemaVersion === 4
          ? basis.snapshot.selection.history.answers.at(-1)
          : undefined;
      const previous =
        predecessor !== undefined && scopedReader(value)
          ? await reviewProof(registration, rpc)(predecessor, value)
          : null;
      if (predecessor !== undefined)
        requireContract(
          previous !== null &&
            previous.snapshot.phase === basis.snapshot!.phase &&
            previous.snapshot.scope === basis.snapshot!.scope &&
            JSON.stringify(previous.input.preparation) === JSON.stringify(value.preparation) &&
            JSON.stringify(previous.profile) === JSON.stringify(profile),
          'reader-retarget-unqualified',
        );
      const creationMethod = previous === null ? 'thread/start' : 'thread/resume';
      const models = object(await rpc.request('model/list', {}));
      requireContract(
        Array.isArray(models.data) &&
          models.data
            .map(object)
            .some(
              (model) =>
                model.model === profile.model &&
                Array.isArray(model.supportedReasoningEfforts) &&
                model.supportedReasoningEfforts
                  .map(object)
                  .some((effort) => effort.reasoningEffort === profile.effort),
            ),
        'reader-model-unavailable',
      );
      const creation = await journal.execute(
        intent(value, 'create', { profile, prepared, input: value }),
        async () => {
          const response = await dispatch(
            value,
            epoch,
            intent(value, 'create', { profile, prepared, input: value }).operationId,
            creationMethod,
            {
              ...(previous === null
                ? { projectId: null }
                : { threadId: previous.session, excludeTurns: false }),
              cwd: registration.workspaceRoot,
              sandbox: 'read-only',
              approvalPolicy: 'never',
              ...(previous === null ? { ephemeral: false, allowProviderModelFallback: false } : {}),
              model: profile.model,
              config: {
                model_reasoning_effort: profile.effort,
                sandbox_read_only: { network_access: false },
              },
            },
          );
          const session = confirmSession(response, previous?.session);
          requireContract(
            previous === null
              ? (session.thread.turns as unknown[]).length === 0
              : (session.thread.turns as Record<string, unknown>[]).at(-1)?.id ===
                  previous.answerTurn.id,
            'reader-session-not-fresh',
          );
          // Codex persists a fresh thread only after its first turn; another connection must not recreate it.
          freshSessions.add(session.id);
          return save({
            kind: 'reader-session',
            input: value,
            prepared,
            response,
            ...(predecessor === undefined ? {} : { resumedFrom: predecessor }),
          });
        },
        boundary === undefined
          ? undefined
          : async () => {
              const response = boundary.response(
                value,
                epoch!,
                intent(value, 'create', { profile, prepared, input: value }).operationId,
                creationMethod,
              );
              if (response === null) return null;
              confirmSession(response, previous?.session);
              return save({
                kind: 'reader-session',
                input: value,
                prepared,
                response,
                ...(predecessor === undefined ? {} : { resumedFrom: predecessor }),
              });
            },
      );
      const proof = read(creation);
      return { id: confirmSession(proof.response, previous?.session).id, creation };
    },
    async loadReader(value, prepared, session, epoch) {
      checkBoundary(value, epoch);
      const { refs } = inputs(value, prepared);
      await restore(value, prepared, session);
      const prompt = readerLoadPrompt(refs, 4);
      const id = await send(value, session, 'load', prompt, epoch);
      const { observed, primary } = await turn(session, id);
      context({ thread: { id: session.id, turns: [observed] } }, session.id, id);
      const commandOutputs = captureReaderLoadCommandOutputs(
        store,
        primary,
        observed,
        registration.workspaceRoot,
        profile,
      );
      confirmObservedLoad(
        readerLoadObserved(
          store,
          observed,
          commandOutputs,
          registration.workspaceRoot,
          profile,
          session.id,
        ),
        refs,
      );
      checkBoundary(value, epoch);
      if (scopedReader(value)) confirmScopedPreparation(registration, value, prepared);
      return save({
        kind: 'reader-load',
        promptVersion: 4,
        session: session.id,
        roleId: value.roleId,
        prepared,
        refs,
        observed,
        commandOutputs,
        ...(scopedReader(value) ? { attempt: epoch?.attempt ?? 0 } : {}),
      });
    },
    async answerReader(value, prepared, session, load, epoch) {
      checkBoundary(value, epoch);
      const basis = inputs(value, prepared),
        { refs } = basis;
      const proof = read(load);
      requireContract(
        proof.kind === 'reader-load' &&
          proof.session === session.id &&
          proof.roleId === value.roleId &&
          JSON.stringify(proof.prepared) === JSON.stringify(prepared) &&
          JSON.stringify(proof.refs) === JSON.stringify(refs),
        'reader-load-binding-mismatch',
      );
      const promptVersion = proof.promptVersion ?? 1;
      requireContract(
        promptVersion === 1 || promptVersion === 2 || promptVersion === 3 || promptVersion === 4,
        'reader-load-prompt-version',
      );
      confirmObservedLoad(
        promptVersion === 3 || promptVersion === 4
          ? readerLoadObserved(
              store,
              object(proof.observed),
              proof.commandOutputs,
              registration.workspaceRoot,
              profile,
              session.id,
            )
          : object(proof.observed),
        refs,
      );
      await restore(value, prepared, session);
      const currentContext = await rpc.request('thread/read', {
        threadId: session.id,
        includeTurns: true,
      });
      context(currentContext, session.id, text(object(proof.observed).id));
      const prompt = readerAnswerPrompt(value, basis.snapshot);
      const id = await send(
        value,
        session,
        'answer',
        prompt,
        epoch,
        scopedReader(value) && basis.snapshot!.schemaVersion >= 3
          ? readerReportSchema(value, basis.snapshot!)
          : undefined,
      );
      const { observed } = await turn(session, id);
      checkBoundary(value, epoch);
      requireContract(Array.isArray(observed.items), 'reader-answer-missing');
      context({ thread: { id: session.id, turns: [observed] } }, session.id, id);
      requireContract(
        observed.items
          .map(object)
          .some(
            (item) =>
              item.type === 'agentMessage' &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0,
          ),
        'reader-answer-missing',
      );
      const scoped = scopedReader(value)
        ? {
            input: value,
            creation: session.creation,
            profile,
            attempt: epoch?.attempt ?? 0,
            report: readerReport(
              observed,
              value,
              confirmScopedPreparation(registration, value, prepared).snapshot,
            ),
          }
        : {};
      return save({
        kind: 'reader-answer',
        session: session.id,
        roleId: value.roleId,
        prepared,
        load,
        observed,
        ...scoped,
      });
    },
  };
}
