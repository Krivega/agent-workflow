import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import type { Connection } from '../../core/connection.js';
import type { CardProjection } from '../../core/card.js';
import type { TaskConnectionPlan } from '../../core/taskConnection.js';
import { projectText } from './projectFiles.js';
import { FileProjectCards } from './fileProjectCards.js';
import { readPrivateFile } from '../storage/storeFiles.js';

export async function indexChatCard(
  root: string,
  connection: Connection,
  plan: TaskConnectionPlan,
  journal: string,
) {
  const intent = resolve(journal, 'index-intent.json');
  const index = `${dirname(plan.card)}/README.md`;
  const before = await projectText(root, index);
  const projection: CardProjection = {
    operation_id: 'chat-card-index',
    task_id: plan.task_id,
    from: plan.card,
    to: plan.card,
    changes: [
      { locator: plan.card, before: plan.after, after: plan.after },
      {
        locator: index,
        before,
        after: `${before.trimEnd()}\n\n- [${plan.task_id}](${basename(plan.card)})\n`,
      },
    ],
  };
  try {
    await writeFile(intent, JSON.stringify(projection), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const saved = JSON.parse(readPrivateFile(intent).toString('utf8')) as CardProjection;
  requireWorkflow(
    saved.task_id === plan.task_id && saved.to === plan.card && saved.from === plan.card,
    'chat-index-identity-mismatch',
  );
  const result = await new FileProjectCards(root, connection, resolve(journal, 'index')).apply(
    saved,
  );
  requireWorkflow(result.status === 'confirmed', 'chat-index-conflict');
  return result;
}
