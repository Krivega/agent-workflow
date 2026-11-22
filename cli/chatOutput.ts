import { object, textField, requireWorkflow } from '../core/connection.js';
import type { ChatContext } from '../ports/chatContext.js';
import { saveChatArtifact } from './chatContinuation.js';
import { councilBlockers } from '../core/council.js';
import type { Council } from '../core/council.js';
import { executionBlockers } from '../core/execution.js';
import type { Execution } from '../core/execution.js';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { noStorageProbe } from '../adapters/storage/storeFiles.js';
import type { EvidenceGrant } from '../core/evidence.js';
import { authorize } from '../adapters/storage/sqliteEvidenceStore.js';
import { expandArchive } from '../adapters/storage/archiveJson.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { resolve } from 'node:path';
import type { CoderRun } from '../core/coder.js';

function withArchiveSource<T>(
  request: Record<string, unknown>,
  action: (read: (hash: string) => string) => T,
): T {
  const storage = request.storage === undefined ? null : object(request.storage);
  const grant = storage?.grant as EvidenceGrant | undefined;
  const database =
    storage === null
      ? null
      : new StoreDatabase(textField(storage.root), grant!.context, noStorageProbe);
  try {
    return action((hash) => {
      if (database === null) {
        requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'chat-artifact-conflict');
        const bytes = readPrivateFile(
          resolve(textField(request.evidence_root), 'shared-json', hash),
        );
        requireWorkflow(digest(bytes) === hash, 'chat-artifact-conflict');
        return bytes.toString('utf8');
      }
      authorize({ context: grant!.context, command: { type: 'archive', hash } }, grant!);
      return database.files.readBlob(hash);
    });
  } finally {
    database?.close();
  }
}
export { chatFailureGuidance } from './chatFailureGuidance.js';
function nextChatAction(status: unknown, blockers: string[]) {
  if (
    blockers.some(
      (b) => !b.endsWith(':not-passed') && /unknown|pending|unconfirmed|audit-reservation/u.test(b),
    )
  )
    return 'Проверить исходную операцию и её квитанцию; не запускать повтор с новым ID.';
  if (blockers.length > 0) return `Устранить условие: ${blockers[0]}`;
  if (status === 'paused') return 'Ожидать явного продолжения.';
  if (status === 'stopping') return 'Подтвердить остановку принадлежащих задаче исполнителей.';
  if (status === 'done' || status === 'completed' || status === 'cancelled')
    return 'Дополнительное действие не требуется.';
  return 'Выполнить ближайший проверяемый шаг текущей карточки.';
}
export function fullChatResult(result: unknown, request: Record<string, unknown>) {
  return withArchiveSource(request, (read) => expandArchive(result, read));
}

export function briefChatResult(
  command: string,
  result: unknown,
  request: Record<string, unknown>,
) {
  if (command === 'checks-chat' || command === 'preflight-checks-chat')
    return { command, ...object(result) };
  if (command === 'coder-chat') {
    const run = result as CoderRun;
    let refusal: string | null = null;
    if (run.status === 'not-started') {
      requireWorkflow(run.receipt !== null, 'coder-refusal-unconfirmed');
      const bytes = readPrivateFile(run.receipt.locator);
      requireWorkflow(digest(bytes) === run.receipt.hash, 'coder-refusal-unconfirmed');
      refusal = textField(object(JSON.parse(bytes.toString('utf8')) as unknown).reason);
    }
    return {
      command,
      id: run.brief.id,
      status: run.status,
      scope: run.brief.paths,
      session: run.session?.id ?? null,
      outcome: run.result?.outcome ?? null,
      errors: run.result?.errors ?? [],
      limitations: run.result?.limitations ?? [],
      receipt: run.receipt,
      stop_receipt: run.stopped,
      operation: ['creating', 'not-started'].includes(run.status)
        ? `coder:${run.brief.id}:create`
        : run.status === 'integrating'
          ? `coder:${run.brief.id}:integrate`
          : run.delivery,
      reason:
        refusal ??
        (['cancelled', 'integrated'].includes(run.status)
          ? null
          : (run.result?.errors[0] ?? `coder:${run.status}`)),
      next_action:
        run.status === 'not-started'
          ? 'Поручение завершено без создания сеанса; резервирование снято. Сохранить причину отказа и квитанцию.'
          : ['creating', 'sending'].includes(run.status)
            ? 'Восстановить исходную операцию через run прежнего ID без assignment; новый ID не разрешает повтор.'
            : run.status === 'released'
              ? run.result?.outcome === 'PASS'
                ? 'Проверить кандидата и выполнить интеграцию либо отмену.'
                : 'Сохранить отказ и отменить кандидата.'
              : run.status === 'integrating'
                ? 'Восстановить прежний перенос; не менять ID и не перезаписывать конфликт.'
                : run.status === 'integrated'
                  ? 'Выполнить общие проверки и независимую приёмку.'
                  : nextChatAction(run.status, []),
      details: {
        locator: textField(object(request.storage).root) + '#workflow.coders.' + run.brief.id,
        native_journal: resolve(
          textField(request.evidence_root),
          'coders',
          run.brief.id,
          'transport.jsonl',
        ),
      },
    };
  }
  if (command === 'status-chat') {
    const status = object(result);
    const local = status.local as ChatContext['run'];
    const execution = object(status.execution);
    const control = status.control === null ? null : object(status.control).status;
    const stopped = ['paused', 'stopping', 'cancelled'].includes(String(control));
    return {
      command,
      reason: stopped ? control : ((execution.blockers as string[])[0] ?? null),
      next_action: stopped
        ? nextChatAction(control, [])
        : nextChatAction(execution.status, execution.blockers as string[]),
      details: {
        locator:
          request.storage === undefined
            ? resolve(textField(request.evidence_root))
            : textField(object(request.storage).root) + '#state',
      },
      run_id: local.spec.run_id,
      generation: local.generation,
      local_status: local.status,
      execution_status: execution.status,
      checkpoint: status.checkpoint ?? null,
      requirements_revision:
        status.messages == null ? null : object(status.messages).requirements_revision,
      last_result: execution.result ?? null,
      pending_operations: status.pending_operations ?? [],
      blockers: execution.blockers,
      control: status.control === null ? null : object(status.control).status,
      ownership: status.ownership,
      resume_required: status.resume_required,
      projection: local.projection,
      coordination:
        status.coordination === null
          ? null
          : {
              status: object(status.coordination).status,
              revision: object(status.coordination).revision,
            },
      ...(status.coders === undefined ? {} : { coders: status.coders }),
    };
  }
  let summary: Record<string, unknown>;
  if (command === 'continue-chat') {
    const context = result as ChatContext;
    summary = {
      command,
      run_id: context.run.spec.run_id,
      generation: context.run.generation,
      status: context.run.status,
      control: context.control!.status,
    };
  } else if (command === 'observe-audit-chat') {
    const observation = object(result);
    summary = {
      command,
      ...observation,
      reason: observation.outcome === 'unknown' ? 'audit-attempt-outcome-unknown' : null,
      next_action:
        observation.outcome === 'unknown'
          ? nextChatAction(null, ['audit-attempt-outcome-unknown'])
          : 'Сверить карточку и сохранить связывание аудита либо завершение устаревшего резервирования.',
    };
  } else if (command === 'check-chat') {
    const check = object(object(result).check);
    summary = {
      command,
      verdict: check.verdict,
      reason: check.reason,
      reused_from: object(result).reused_from ?? null,
    };
  } else if (command === 'council-chat' || command === 'council-run-chat') {
    const details = withArchiveSource(request, (source) =>
      saveChatArtifact(
        textField(request.evidence_root),
        'council-state',
        result,
        'minimal',
        source,
      ),
    );
    const blockers = councilBlockers(result as Council);
    return {
      command,
      blockers,
      reason: blockers[0] ?? null,
      next_action: nextChatAction(null, blockers),
      details,
    };
  } else if (command === 'execution-chat') {
    const execution = result as Execution;
    const blockers = executionBlockers(execution);
    summary = {
      command,
      status: execution.status,
      blockers,
      reason: blockers[0] ?? null,
      next_action: nextChatAction(execution.status, blockers),
    };
  } else {
    const raw = object(result);
    const control = raw.control === undefined || raw.control === null ? null : object(raw.control);
    summary = { command, completed: true, status: control?.status ?? raw.status ?? null };
  }
  if (summary.next_action === undefined) {
    summary.reason ??= null;
    summary.next_action = nextChatAction(
      summary.status,
      summary.verdict === 'FAIL' || summary.verdict === 'NOT RUN' ? [String(summary.reason)] : [],
    );
  }
  if (command === 'check-chat') {
    const proof = object(result);
    const locator = resolve(
      textField(request.evidence_root),
      textField(proof.operation_id) + '.json',
    );
    return { ...summary, details: { locator, hash: digest(readPrivateFile(locator)) } };
  }
  const storage = request.storage === undefined ? null : object(request.storage);
  const event = request.event === undefined ? null : object(request.event);
  const message = request.message === undefined ? null : object(request.message);
  const operation = request.operation ?? event?.id ?? message?.id ?? null;
  const receipt = {
    schema_version: 2,
    purpose: 'operation-result',
    operation,
    outcome: summary,
    state:
      storage === null
        ? null
        : {
            locator: textField(storage.root) + '#state',
            context: (storage.grant as EvidenceGrant).context,
          },
  };
  const details = saveChatArtifact(textField(request.evidence_root), `receipt-${command}`, receipt);
  return { ...summary, details };
}
