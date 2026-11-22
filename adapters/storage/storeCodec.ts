import { createHash } from 'node:crypto';
import {
  StoreFault,
  type StoreErrorCode,
  type StoreReply,
  type StoreRequest,
} from '../../core/evidence.js';

function writeCanonical(value: unknown, emit: (chunk: string) => void) {
  let chunk = '';
  const append = (text: string) => {
    if (chunk.length + text.length > 65536) {
      emit(chunk);
      chunk = text;
    } else chunk += text;
  };
  const write = (value: unknown) => {
    if (Array.isArray(value)) {
      append('[');
      for (let index = 0; index < value.length; index++) {
        if (index > 0) append(',');
        write(value[index]);
      }
      append(']');
    } else if (value !== null && typeof value === 'object') {
      append('{');
      let separator = '';
      for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
        append(separator + JSON.stringify(key) + ':');
        separator = ',';
        write((value as Record<string, unknown>)[key]);
      }
      append('}');
    } else {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new StoreFault('invalid-context');
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new StoreFault('invalid-context');
      append(encoded);
    }
  };
  write(value);
  emit(chunk);
}

export function canonical(value: unknown): string {
  const chunks: string[] = [];
  writeCanonical(value, (chunk) => chunks.push(chunk));
  return chunks.join('');
}

export function canonicalHash(value: unknown): string {
  const hash = createHash('sha256');
  writeCanonical(value, (chunk) => hash.update(chunk));
  return hash.digest('hex');
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestHash(request: StoreRequest): string {
  if (request.command.type !== 'mutate') return canonicalHash(request);
  return canonicalHash({
    ...request,
    command: { ...request.command, mutation: { ...request.command.mutation, payload_hash: '' } },
  });
}

export function failure(
  error: unknown,
  request: StoreRequest,
  locator: string,
  uncertain = false,
): StoreReply {
  let code: StoreErrorCode = uncertain ? 'unknown-outcome' : 'unavailable';
  let observed: number | null = null;
  if (error instanceof StoreFault) {
    code = error.code;
    observed = error.observed_revision;
  } else if (!uncertain && error !== null && typeof error === 'object') {
    const native = error as { code?: string; errcode?: number };
    if ([11, 26].includes(Number(native.errcode))) code = 'corrupt';
    if (['EACCES', 'EPERM', 'ELOOP'].includes(String(native.code))) code = 'permission-denied';
  }
  return {
    ok: false,
    error: {
      code,
      operation_id:
        request?.command?.type === 'mutate' &&
        typeof request.command.mutation?.operation_id === 'string'
          ? request.command.mutation.operation_id
          : null,
      observed_revision: observed,
      retryable: code === 'unavailable',
      recovery_locator: locator,
    },
  };
}
