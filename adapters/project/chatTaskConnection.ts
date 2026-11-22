import metadata from '../../package.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { localLocator, object, requireWorkflow, textField } from '../../core/connection.js';
import { stableJson } from '../../core/equality.js';
import { contentHash, projectText } from './projectFiles.js';
import { fileConnectionReader } from './fileConnectionReader.js';
import { readCardMarkdown } from './cardMarkdown.js';
import { indexChatCard } from './chatCardIndex.js';
import { FileTaskConnection } from './taskConnection.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';
import {
  requireLegacyCardBackend,
  refuseUnroutedBackendConsumer,
} from '../../src/adapters/project/taskBackend.js';

export interface ChatTaskRequest {
  descriptor: string;
  journal: string;
  cards: string[];
  create: { title: string; goal: string; scope: string[]; criteria: string[] } | null;
}
interface Selection {
  schema_version: 1;
  request_hash: string;
  runtime_package_version?: string;
  task_id: string;
  card: string;
  content: string | null;
}
async function existing(path: string): Promise<string | null> {
  try {
    return readPrivateFile(path).toString('utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}
export async function connectChatTask(root: string, request: ChatTaskRequest) {
  requireWorkflow(
    request.cards.length === (request.create === null ? 1 : 0),
    'chat-task-ambiguous',
  );
  const base = await realpath(root),
    journal = resolve(request.journal);
  safeDirectory(dirname(journal));
  requireWorkflow(
    journal !== base && !journal.startsWith(base + '/'),
    'connection-journal-must-be-external',
  );
  const loaded = await fileConnectionReader.load(root, request.descriptor);
  if (request.create === null)
    requireLegacyCardBackend(root, loaded.descriptor.project_id, localLocator(request.cards[0]));
  else refuseUnroutedBackendConsumer(root);
  const service = new FileTaskConnection(root);
  if (request.create !== null) {
    const { title, goal, scope, criteria } = request.create;
    [title, goal, ...scope, ...criteria].forEach((s) => {
      textField(s);
      requireWorkflow(!/[\r\n]/u.test(s), 'chat-card-multiline-field');
    });
    requireWorkflow(scope.length > 0 && criteria.length > 0, 'chat-card-incomplete');
  }
  await mkdir(journal, { recursive: true, mode: 0o700 });
  safeDirectory(journal);
  const path = resolve(journal, 'selection.json'),
    hash = contentHash(stableJson(request));
  let saved = await existing(path);
  if (saved === null) {
    const task = `chat-${randomUUID()}`;
    let selection: Selection;
    if (request.create !== null) {
      const { title, goal, scope, criteria } = request.create;
      selection = {
        schema_version: 1,
        request_hash: hash,
        runtime_package_version: metadata.version,
        task_id: task,
        card: `${loaded.descriptor.plans.active}/${task}.md`,
        content: `# ${title}\n\n- **Статус:** \`active\`\n\n## Цель\n\n${goal}\n\n## Границы\n\n${scope.map((s) => '- ' + s).join('\n')}\n\n## Критерии\n\n${criteria.map((s) => '- [ ] ' + s).join('\n')}\n`,
      };
    } else {
      const card = localLocator(request.cards[0]);
      const snapshot = readCardMarkdown(card, await projectText(root, card));
      requireWorkflow(
        [null, 1, 2].includes(snapshot.notes_version as null | number),
        'unsupported-task-notes-version',
      );
      selection = {
        schema_version: 1,
        request_hash: hash,
        runtime_package_version: metadata.version,
        task_id: snapshot.task_id ?? task,
        card,
        content: null,
      };
    }
    // Persist generated IDs before any project write. An unknown result recovers this selection.
    await writeFile(path, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    saved = JSON.stringify(selection);
  }
  const selection = object(JSON.parse(saved) as unknown) as unknown as Selection;
  requireWorkflow(
    selection.schema_version === 1 && selection.request_hash === hash,
    'chat-selection-conflict',
  );
  localLocator(selection.card);
  textField(selection.task_id);
  if ((await existing(resolve(journal, 'state.json'))) !== null) {
    const recovered = await service.read(journal);
    requireWorkflow(
      ['prepared', 'enabled'].includes(recovered.receipt.phase),
      'chat-connection-disabled',
    );
    requireWorkflow(
      recovered.plan.card === selection.card && recovered.plan.task_id === selection.task_id,
      'chat-selection-conflict',
    );
    // apply verifies current bytes and descriptor, and recovers an effect before its receipt.
    const result = await service.apply(recovered.plan, journal);
    if (selection.content !== null)
      await indexChatCard(root, loaded.descriptor, result.plan, journal);
    return result;
  }
  if (selection.content !== null) {
    const cardPath = resolve(base, selection.card);
    safeDirectory(dirname(cardPath));
    try {
      await writeFile(cardPath, selection.content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        (await projectText(root, selection.card)) === selection.content,
        'chat-created-card-conflict',
      );
    }
  }
  const plan = await service.preview(request.descriptor, selection.card, selection.task_id);
  // Verify the persisted intent is unchanged before the external effect.
  requireWorkflow(readPrivateFile(path).toString('utf8') === saved, 'chat-selection-conflict');
  const result = await service.apply(plan, journal);
  if (selection.content !== null)
    await indexChatCard(root, loaded.descriptor, result.plan, journal);
  return result;
}
