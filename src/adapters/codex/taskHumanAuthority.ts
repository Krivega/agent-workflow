import { isDeepStrictEqual } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { HumanManagedTaskInput } from '../../contracts/localTask.js';
import type { VerifiedStartAdmission } from '../../contracts/taskStartAdmission.js';
import type {
  TaskHumanCommand,
  TaskHumanCommandContext,
  VerifiedTaskHumanCommand,
} from '../../contracts/taskHuman.js';
import { exactFields, identifier, object, requireContract, text } from '../../contracts/project.js';
import {
  checkTaskHumanCommand,
  parseTaskHumanCommand,
  taskHumanCanonical,
  taskHumanCommandText,
} from '../../policy/taskHuman.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest } from '../artifacts/files.js';
import type { artifactStore } from '../artifacts/files.js';
import {
  nativeHumanContext,
  nativeHumanQuestion,
  verifyNativeHumanChoice,
} from './nativeHumanChoice.js';
import type {
  NativeHumanContext,
  NativeHumanLinks,
  NativeHumanReferences,
} from './nativeHumanChoice.js';
import type { nativeTaskSource } from './nativeTaskSource.js';

type Store = ReturnType<typeof artifactStore>;
type Observer = ReturnType<typeof nativeTaskSource>;
type AskFields = { commandId: string; questionId: string; criterionId: string };
function same(a: unknown, b: unknown, reason: string) {
  requireContract(isDeepStrictEqual(a, b), 'task-human-authority-' + reason);
}
function frame(command: TaskHumanCommand) {
  const { hash: _hash, source: _source, ...body } = command;
  return body;
}
function complete(value: unknown, source: ArtifactRef): TaskHumanCommand {
  const parsed = parseTaskHumanCommand({ ...object(value), source, hash: '0'.repeat(64) });
  return { ...parsed, hash: digest(taskHumanCommandText(parsed)) };
}
/** Host-bound issuer; Worker verification only reads retained source proofs. */
export function nativeTaskHumanAuthority(
  store: Store,
  observer: Observer,
  verifyStart: (input: HumanManagedTaskInput) => Promise<VerifiedStartAdmission>,
) {
  async function bound(context: TaskHumanCommandContext) {
    const admitted = await verifyStart(context.input);
    await observer.verify(admitted.initial.admission.principal);
    same(context.state.current, admitted.manifest, 'manifest');
    same(context.technical.input, context.input, 'technical-input');
    requireContract(
      context.state.current.manifest.target.owner === observer.issuer.owner &&
        admitted.initial.admission.principal.owner === observer.issuer.owner &&
        admitted.initial.admission.principal.threadId === observer.issuer.threadId,
      'task-human-authority-owner',
    );
    store.read(context.technical.packet.request);
    store.read(context.technical.acceptance);
    return admitted;
  }
  function fields(context: TaskHumanCommandContext, value: AskFields) {
    return {
      schemaVersion: 1,
      commandId: identifier(value.commandId),
      target: context.state.current.manifest.target,
      manifest: context.state.current.ref,
      expectedRevision: context.state.revision,
      author: observer.issuer.owner,
      questionId: identifier(value.questionId),
      criterionId: value.criterionId,
    };
  }
  function prepared(context: TaskHumanCommandContext) {
    const { state, technical } = context,
      pending = state.pending;
    requireContract(
      !state.closed &&
        pending !== null &&
        pending.askedRevision === state.revision &&
        pending.requirementsRevision === state.current.manifest.target.requirementsRevision &&
        state.history.some(
          (row) =>
            row.kind === 'command' &&
            row.command.action === 'ASK' &&
            row.command.questionId === pending.questionId &&
            row.command.criterionId === pending.criterionId &&
            row.receipt.revision === pending.askedRevision,
        ),
      'task-human-question-not-durable',
    );
    const criterion = state.current.manifest.criteria.find(
      (row) => row.id === pending.criterionId && row.kind === 'human' && row.applicable,
    );
    requireContract(criterion !== undefined, 'task-human-question-criterion');
    const nativeContext: NativeHumanContext = {
      kind: 'task-human-choice-context/1',
      questionId: pending.questionId,
      criterion: { id: criterion.id, text: criterion.text },
      target: state.current.manifest.target,
      expectedHumanRevision: state.revision,
      manifest: state.current.ref,
      card: state.current.manifest.card,
      candidate: technical.packet.request,
      technicalAcceptance: technical.acceptance,
      chat: {
        threadId: observer.issuer.threadId,
        workspace: observer.issuer.chatWorkspace,
        hostId: 'local',
      },
      author: observer.issuer.owner,
    };
    const body = nativeHumanContext(nativeContext),
      contextRef = store.publish(Buffer.from(body.body));
    same(contextRef, body.ref, 'context-ref');
    const links: NativeHumanLinks = {
      context: { ...contextRef, path: store.path(contextRef) },
      result: { ...nativeContext.candidate, path: store.path(nativeContext.candidate) },
    };
    store.read(nativeContext.candidate);
    return { context: nativeContext, links, ...nativeHumanQuestion(nativeContext, links) };
  }
  function readChoice(source: Record<string, unknown>, question: ReturnType<typeof prepared>) {
    const transcript = text(source.transcript),
      prefixRef = controlRef(source.prefix),
      snapshot = observer.readPrefix(transcript, prefixRef);
    same(source.context, question.context, 'native-context');
    same(source.links, question.links, 'native-links');
    const rows = snapshot.rows.map(({ raw, ref }) => ({ raw, ref }));
    const refs = object(source.references);
    exactFields(refs, ['call', 'publication', 'reply', 'delivery']);
    const references = Object.fromEntries(
      Object.entries(refs).map(([key, value]) => {
        const ref = object(value);
        exactFields(ref, ['locator', 'hash']);
        return [
          key,
          { locator: text(ref.locator), hash: controlRef({ sha256: ref.hash, bytes: 0 }).sha256 },
        ];
      }),
    ) as NativeHumanReferences;
    return verifyNativeHumanChoice({
      context: question.context,
      links: question.links,
      transcript,
      rows,
      references,
    });
  }
  return {
    async prepareAsk(
      context: TaskHumanCommandContext,
      value: AskFields,
    ): Promise<TaskHumanCommand> {
      const admitted = await bound(context);
      observer.assertCurrentHost();
      const body = { ...fields(context, value), action: 'ASK' },
        parsed = complete(body, { sha256: '0'.repeat(64), bytes: 0 });
      checkTaskHumanCommand(context.state, parsed);
      const source = store.publish(
        Buffer.from(
          taskHumanCanonical({
            kind: 'task-human-controller-intent/1',
            startAdmission: context.input.startAdmission,
            principal: admitted.initial.admission.principal,
            frame: frame(parsed),
          }),
        ),
      );
      observer.assertCurrentHost();
      return complete(body, source);
    },
    async prepareQuestion(context: TaskHumanCommandContext) {
      await bound(context);
      observer.assertCurrentHost();
      return prepared(context);
    },
    async makeDecision(
      context: TaskHumanCommandContext,
      value: { commandId: string; transcript: string; references: NativeHumanReferences },
    ): Promise<TaskHumanCommand> {
      await bound(context);
      observer.assertCurrentHost();
      const question = prepared(context),
        snapshot = observer.read(value.transcript),
        delivery = snapshot.rows.findIndex((row) =>
          isDeepStrictEqual(row.ref, value.references.delivery),
        );
      requireContract(delivery >= 0, 'task-human-authority-native-delivery');
      // Fresh issuance checks the whole real snapshot; retained verification uses only its pinned prefix.
      const choice = verifyNativeHumanChoice({
        context: question.context,
        links: question.links,
        transcript: value.transcript,
        rows: snapshot.rows.map(({ raw, ref }) => ({ raw, ref })),
        references: value.references,
      });
      const body = {
          ...fields(context, {
            commandId: value.commandId,
            questionId: choice.questionId,
            criterionId: choice.criterionId,
          }),
          action: 'DECIDE',
          accepted: choice.accepted,
        },
        parsed = complete(body, { sha256: '0'.repeat(64), bytes: 0 });
      checkTaskHumanCommand(context.state, parsed);
      const prefixBytes = Buffer.from(
          snapshot.rows
            .slice(0, delivery + 1)
            .map((row) => row.raw)
            .join(''),
        ),
        prefix = { sha256: digest(prefixBytes), bytes: prefixBytes.length },
        source = store.publish(
          Buffer.from(
            taskHumanCanonical({
              kind: 'task-human-native-decision/1',
              startAdmission: context.input.startAdmission,
              context: question.context,
              links: question.links,
              frame: frame(parsed),
              transcript: value.transcript,
              prefix,
              references: value.references,
            }),
          ),
        );
      const after = observer.read(value.transcript);
      observer.assertCurrentHost();
      requireContract(after.bytes.equals(snapshot.bytes), 'task-human-authority-native-changed');
      return complete(body, source);
    },
    async verify(
      context: TaskHumanCommandContext,
      raw: TaskHumanCommand,
    ): Promise<VerifiedTaskHumanCommand> {
      const admitted = await bound(context),
        command = parseTaskHumanCommand(raw);
      requireContract(
        digest(taskHumanCommandText(command)) === command.hash,
        'task-human-authority-command-hash',
      );
      checkTaskHumanCommand(context.state, command);
      const source = object(JSON.parse(store.read(command.source).toString('utf8')) as unknown);
      same(source.startAdmission, context.input.startAdmission, 'start-admission');
      same(source.frame, frame(command), 'command-frame');
      if (command.action === 'ASK') {
        exactFields(source, ['kind', 'startAdmission', 'principal', 'frame']);
        requireContract(
          source.kind === 'task-human-controller-intent/1',
          'task-human-authority-ask-kind',
        );
        same(source.principal, admitted.initial.admission.principal, 'controller');
        const proof = store.publish(
          Buffer.from(
            taskHumanCanonical({
              kind: 'task-human-controller-verification/1',
              command,
              source: command.source,
              principal: source.principal,
            }),
          ),
        );
        return { kind: 'verified-task-human-command', command, proof, action: 'ASK' };
      }
      exactFields(source, [
        'kind',
        'startAdmission',
        'context',
        'links',
        'frame',
        'transcript',
        'prefix',
        'references',
      ]);
      requireContract(
        source.kind === 'task-human-native-decision/1',
        'task-human-authority-decision-kind',
      );
      const choice = readChoice(source, prepared(context));
      requireContract(choice.accepted === command.accepted, 'task-human-authority-answer-mismatch');
      const proof = store.publish(
        Buffer.from(
          taskHumanCanonical({
            kind: 'task-human-native-verification/1',
            command,
            source: command.source,
            choice,
          }),
        ),
      );
      return {
        kind: 'verified-task-human-command',
        command,
        proof,
        action: 'DECIDE',
        accepted: choice.accepted,
      };
    },
  };
}
