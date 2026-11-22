import type {
  ReaderControlState,
  ReaderDiagnostic,
  ReaderPhase,
  ReaderStatus,
} from '../contracts/readerControl.js';
import type { ReaderInput } from '../contracts/reader.js';
import { readerOperationKey } from './readerControl.js';

export function readerOperation(
  input: ReaderInput,
  phase: ReaderPhase,
  attempt: number,
  stopping: boolean,
): ReaderStatus['operation'] {
  const name = stopping
    ? 'stop'
    : (
        {
          registering: 'register',
          preparing: 'prepare',
          creating: 'create',
          loading: 'load',
          answering: 'answer',
        } as const
      )[phase];
  const key = ['create', 'load', 'answer'].includes(name)
    ? readerOperationKey(input, name === 'create' ? 0 : attempt)
    : null;
  return { name, key };
}

export function readerDiagnostic(
  state: ReaderControlState,
  error: string,
  stopping: boolean,
): ReaderDiagnostic {
  const evidenceHash = /:([a-f0-9]{64})(?:\s|$)/u.exec(error)?.[1] ?? null;
  if (state.mode === 'cancelled' || state.mode === 'answered')
    return {
      kind: 'terminal',
      reason: state.mode,
      nextAction: 'Действий не требуется.',
      evidenceHash,
    };
  if (state.mode === 'paused')
    return {
      kind: 'waiting-human',
      reason: 'Поручение приостановлено, остановка подтверждена.',
      nextAction: 'Передать подтверждённый RESUME в прежних границах.',
      evidenceHash,
    };
  if (error.includes('reader-model-budget-exhausted'))
    return {
      kind: 'waiting-human',
      reason: error,
      nextAction: 'Уточнить бюджет; новые модельные действия запрещены.',
      evidenceHash,
    };
  if (error.includes('reader-context-compacted:'))
    return {
      kind: 'waiting-human',
      reason: error,
      nextAction: 'Подтвердить новое полное LOAD в прежнем сеансе с новой попыткой.',
      evidenceHash,
    };
  if (stopping || state.mode === 'pausing' || state.mode === 'cancelling')
    return {
      kind: error ? 'unknown-effect' : 'stopping',
      reason: error || 'Проверяется остановка внешнего исполнителя.',
      nextAction: error
        ? 'Восстановить квитанции и сверить прежний сеанс; не передавать scope.'
        : 'Дождаться первичного подтверждения остановки.',
      evidenceHash,
    };
  if (state.mode === 'blocked') {
    const unknown = /unknown|unconfirmed|journal-incomplete|dispatch-corrupted/u.test(error);
    return {
      kind: unknown ? 'unknown-effect' : 'technical-error',
      reason: error || 'Причина блокировки не подтверждена.',
      nextAction: unknown
        ? 'Сверить прежнюю логическую операцию; не повторять create/send.'
        : 'Устранить техническую причину и запросить первичную сверку.',
      evidenceHash,
    };
  }
  return {
    kind: 'running',
    reason: 'Выполняется разрешённый шаг.',
    nextAction: 'Ожидать результата; Query не вызывает модель.',
    evidenceHash,
  };
}
