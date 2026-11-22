import { existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { TaskExecutionBudget } from '../contracts/taskExecution.js';
import { exactFields, object, requireContract } from '../contracts/project.js';
import type { artifactStore } from '../adapters/artifacts/files.js';
import { digest, readPrivateFile } from '../adapters/artifacts/files.js';

export interface TaskBudgetRecord {
  schemaVersion: 1;
  kind: 'task-model-budget';
  directory: string;
  binding: { dev: string; ino: string };
  limit: number;
  limitRef: ArtifactRef;
  credits: { index: number; key: string; hash: string; ref: ArtifactRef }[];
}

/** Validates one current ledger image and its retained prefix without publishing an artifact. */
export function inspectTaskBudget(
  directory: string,
  store: ReturnType<typeof artifactStore>,
  previous: ArtifactRef | null,
): TaskBudgetRecord {
  requireContract(
    realpathSync(directory) === directory && lstatSync(directory).isDirectory(),
    'task-budget-root-unknown',
  );
  requireContract(!existsSync(join(directory, 'lock')), 'task-budget-operation-pending');
  const limitBytes = readPrivateFile(join(directory, 'limit')),
    limit = object(JSON.parse(limitBytes.toString()));
  exactFields(limit, ['schemaVersion', 'limit']);
  requireContract(
    limit.schemaVersion === 1 && Number.isSafeInteger(limit.limit) && Number(limit.limit) >= 0,
    'task-budget-limit-unknown',
  );
  const names = readdirSync(directory).sort(),
    credits = [];
  for (const name of names) {
    if (name === 'limit') continue;
    requireContract(/^(?:0|[1-9][0-9]*)\.credit$/u.test(name), 'task-budget-inventory-unknown');
    const bytes = readPrivateFile(join(directory, name)),
      value = object(JSON.parse(bytes.toString()));
    exactFields(value, ['key', 'hash']);
    requireContract(
      typeof value.key === 'string' &&
        /^[a-f0-9]{64}$/u.test(value.key) &&
        typeof value.hash === 'string' &&
        /^[a-f0-9]{64}$/u.test(value.hash),
      'task-budget-credit-unknown',
    );
    credits.push({
      index: Number(name.slice(0, -'.credit'.length)),
      key: value.key,
      hash: value.hash,
      ref: { sha256: digest(bytes), bytes: bytes.length },
    });
  }
  credits.sort((a, b) => a.index - b.index);
  requireContract(
    credits.length <= Number(limit.limit) &&
      credits.every((credit, index) => credit.index === index) &&
      new Set(credits.map((c) => c.key)).size === credits.length,
    'task-budget-prefix-unknown',
  );
  const stat = lstatSync(directory),
    record: TaskBudgetRecord = {
      schemaVersion: 1,
      kind: 'task-model-budget',
      directory,
      binding: { dev: String(stat.dev), ino: String(stat.ino) },
      limit: Number(limit.limit),
      limitRef: { sha256: digest(limitBytes), bytes: limitBytes.length },
      credits,
    };
  if (previous !== null) {
    const before = object(JSON.parse(store.read(previous).toString()));
    requireContract(
      before.schemaVersion === 1 &&
        before.kind === record.kind &&
        before.directory === directory &&
        same(before.binding, record.binding) &&
        before.limit === record.limit &&
        same(before.limitRef, record.limitRef) &&
        Array.isArray(before.credits) &&
        before.credits.length <= credits.length &&
        same(before.credits, credits.slice(0, before.credits.length)),
      'task-budget-rewound',
    );
  }
  requireContract(
    !existsSync(join(directory, 'lock')) &&
      same(readdirSync(directory).sort(), names) &&
      readPrivateFile(join(directory, 'limit')).equals(limitBytes),
    'task-budget-inventory-changed',
  );
  for (const credit of credits) {
    const bytes = readPrivateFile(join(directory, credit.index + '.credit'));
    requireContract(
      digest(bytes) === credit.ref.sha256 && bytes.length === credit.ref.bytes,
      'task-budget-inventory-changed',
    );
  }
  requireContract(
    String(lstatSync(directory).dev) === record.binding.dev &&
      String(lstatSync(directory).ino) === record.binding.ino,
    'task-budget-root-unknown',
  );
  return record;
}

/** The immutable expected image must match the entire current ledger, including its bytes. */
export function verifyTaskBudget(
  directory: string,
  store: ReturnType<typeof artifactStore>,
  expected: TaskExecutionBudget,
): TaskBudgetRecord {
  const expectedBytes = store.read(expected.manifest),
    record = inspectTaskBudget(directory, store, expected.manifest);
  requireContract(
    record.limit === expected.limit &&
      record.credits.length === expected.used &&
      expectedBytes.equals(Buffer.from(JSON.stringify(record))),
    'task-budget-current-mismatch',
  );
  return record;
}

export function captureTaskBudget(
  directory: string,
  store: ReturnType<typeof artifactStore>,
  previous: ArtifactRef | null,
): TaskExecutionBudget {
  const record = inspectTaskBudget(directory, store, previous);
  return {
    limit: record.limit,
    used: record.credits.length,
    manifest: store.publish(Buffer.from(JSON.stringify(record))),
  };
}
