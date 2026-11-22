import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { exactFields, identifier, object, requireContract } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest, readPrivateFile } from '../artifacts/files.js';

export interface BudgetExtension {
  name: string;
  limit: number;
  runId: string;
  bytes: Buffer;
  previous: ReturnType<typeof controlRef>;
}

export function budgetExtensions(root: string): BudgetExtension[] {
  const names = new Set(readdirSync(root).filter((name) => name.startsWith('extension')));
  const chain: BudgetExtension[] = [];
  let name = 'extension.json';
  while (names.delete(name)) {
    const entry = readExtension(root, name, chain.at(-1));
    chain.push(entry);
    name = 'extension-' + entry.limit + '.json';
  }
  requireContract(names.size === 0, 'task-budget-extension-chain');
  return chain;
}

function readExtension(root: string, name: string, parent?: BudgetExtension): BudgetExtension {
  const path = join(root, name);
  const bytes = readPrivateFile(path);
  const extension = object(JSON.parse(bytes.toString()));
  exactFields(extension, ['schemaVersion', 'runId', 'limit', 'previous']);
  const previous = object(extension.previous);
  const stat = lstatSync(root);
  const original = parent?.bytes ?? readPrivateFile(join(root, 'limit'));
  const originalRef = controlRef(previous.limitRef);
  requireContract(
    extension.schemaVersion === 1 &&
      Number.isSafeInteger(extension.limit) &&
      Number(extension.limit) > Number(previous.limit) &&
      previous.schemaVersion === 1 &&
      previous.kind === 'task-model-budget' &&
      previous.directory === root &&
      object(previous.binding).dev === String(stat.dev) &&
      object(previous.binding).ino === String(stat.ino) &&
      (parent
        ? parent.limit === previous.limit && parent.runId === extension.runId
        : original.equals(
            Buffer.from(JSON.stringify({ schemaVersion: 1, limit: previous.limit })),
          )) &&
      originalRef.sha256 === digest(original) &&
      originalRef.bytes === original.length &&
      Array.isArray(previous.credits),
    'task-budget-extension-mismatch',
  );
  for (const [index, item] of previous.credits.entries()) {
    const credit = object(item),
      ref = controlRef(credit.ref);
    const data = readPrivateFile(join(root, index + '.credit'));
    requireContract(
      credit.index === index && ref.sha256 === digest(data) && ref.bytes === data.length,
      'task-budget-extension-prefix',
    );
  }
  const prior = Buffer.from(JSON.stringify(previous));
  return {
    name,
    runId: identifier(extension.runId),
    limit: Number(extension.limit),
    bytes,
    previous: { sha256: digest(prior), bytes: prior.length },
  };
}
