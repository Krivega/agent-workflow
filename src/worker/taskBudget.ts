import { mkdirSync, rmdirSync, existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { TaskExecutionBudget } from '../contracts/taskExecution.js';
import { exactFields, identifier, object, requireContract } from '../contracts/project.js';
import type { artifactStore } from '../adapters/artifacts/files.js';
import { budgetExtensions } from '../adapters/codex/budgetExtension.js';
import { digest, publishFile, readPrivateFile } from '../adapters/artifacts/files.js';

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
  return ledgerImage(directory, store, previous, false).record;
}

function ledgerImage(
  directory: string,
  store: ReturnType<typeof artifactStore>,
  previous: ArtifactRef | null,
  locked: boolean,
) {
  requireContract(
    realpathSync(directory) === directory && lstatSync(directory).isDirectory(),
    'task-budget-root-unknown',
  );
  requireContract(locked || !existsSync(join(directory, 'lock')), 'task-budget-operation-pending');
  const limitBytes = readPrivateFile(join(directory, 'limit')),
    limit = object(JSON.parse(limitBytes.toString()));
  exactFields(limit, ['schemaVersion', 'limit']);
  requireContract(
    limit.schemaVersion === 1 && Number.isSafeInteger(limit.limit) && Number(limit.limit) >= 0,
    'task-budget-limit-unknown',
  );
  const chain = budgetExtensions(directory);
  const extension = chain.at(-1);
  const effective = extension?.limit ?? Number(limit.limit);
  const effectiveBytes = extension?.bytes ?? limitBytes;
  const names = readdirSync(directory).sort(),
    credits = [];
  for (const name of names) {
    if (
      name === 'limit' ||
      chain.some((entry) => entry.name === name) ||
      (locked && name === 'lock')
    )
      continue;
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
    credits.length <= effective &&
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
      limit: effective,
      limitRef: { sha256: digest(effectiveBytes), bytes: effectiveBytes.length },
      credits,
    };
  if (previous !== null) {
    const before = object(JSON.parse(store.read(previous).toString()));
    requireContract(
      before.schemaVersion === 1 &&
        before.kind === record.kind &&
        before.directory === directory &&
        same(before.binding, record.binding) &&
        ((before.limit === record.limit && same(before.limitRef, record.limitRef)) ||
          same(previous, extension?.previous)) &&
        Array.isArray(before.credits) &&
        before.credits.length <= credits.length &&
        same(before.credits, credits.slice(0, before.credits.length)),
      'task-budget-rewound',
    );
  }
  requireContract(
    (locked || !existsSync(join(directory, 'lock'))) &&
      same(readdirSync(directory).sort(), names) &&
      same(budgetExtensions(directory), chain) &&
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
  return { record, chain };
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
  const { record, chain } = ledgerImage(directory, store, previous, false);
  const extension = chain.at(-1);
  return {
    ...(extension ? { extendedFrom: { ...extension.previous, runId: extension.runId } } : {}),
    limit: record.limit,
    used: record.credits.length,
    manifest: store.publish(Buffer.from(JSON.stringify(record))),
  };
}

/** Offline administrative operation for a stopped, dedicated host. Requires its exact held budget. */
export function extendTaskBudget(
  directory: string,
  store: ReturnType<typeof artifactStore>,
  expected: TaskExecutionBudget,
  limit: number,
  runId: string,
) {
  requireContract(
    Number.isSafeInteger(limit) && limit > expected.limit,
    'task-budget-extension-invalid',
  );
  identifier(runId);
  const lock = join(directory, 'lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    const retained = store.read(expected.manifest);
    const previous = object(JSON.parse(retained.toString()));
    requireContract(
      previous.limit === expected.limit &&
        Array.isArray(previous.credits) &&
        previous.credits.length === expected.used,
      'task-budget-current-mismatch',
    );
    const { record: current, chain } = ledgerImage(directory, store, null, true);
    const existing = chain.find((entry) => same(entry.previous, expected.manifest));
    if (existing) {
      requireContract(
        existing.limit === limit && existing.runId === runId,
        'task-budget-extension-conflict',
      );
      return;
    }
    const parent = chain.at(-1);
    requireContract(!parent || parent.runId === runId, 'task-budget-extension-conflict');
    requireContract(
      retained.equals(Buffer.from(JSON.stringify(current))),
      'task-budget-current-mismatch',
    );
    publishFile(
      join(directory, parent ? 'extension-' + parent.limit + '.json' : 'extension.json'),
      Buffer.from(JSON.stringify({ schemaVersion: 1, runId, limit, previous })),
    );
  } finally {
    rmdirSync(lock);
  }
}
