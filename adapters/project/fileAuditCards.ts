import { requireWorkflow, localLocator } from '../../core/connection.js';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { Connection } from '../../core/connection.js';
import { auditBrief } from '../../core/supervision.js';
import type { AuditCard, StageAuditCard, ProgressAuditCard } from '../../core/supervision.js';
import type { InputRef } from '../../core/localRun.js';
import type { AuditCards } from '../../ports/auditCards.js';
import { contentHash, projectText } from './projectFiles.js';
import { adoptCardMarkdown, readCardMarkdown } from './cardMarkdown.js';
import { FileProjectCards } from './fileProjectCards.js';

const marker = '<!-- agent-workflow:audit-v1 -->';
const progressMarker = '<!-- agent-workflow:progress-audit-v1 -->';
export class FileAuditCards implements AuditCards {
  private readonly cards: FileProjectCards;
  private readonly snapshots: string;
  constructor(
    private readonly root: string,
    private readonly connection: Connection,
    journal: string,
  ) {
    this.cards = new FileProjectCards(root, connection, journal);
    this.snapshots = localLocator(relative(root, journal));
  }
  async prepare(
    locator: string,
    task: string,
    operation: string,
    data: Omit<StageAuditCard, 'ref'>,
    expected: InputRef | null,
  ): Promise<StageAuditCard>;
  async prepare(
    locator: string,
    task: string,
    operation: string,
    data: Omit<ProgressAuditCard, 'ref'>,
    expected: InputRef | null,
  ): Promise<ProgressAuditCard>;
  async prepare(
    locator: string,
    task: string,
    operation: string,
    data: Omit<StageAuditCard, 'ref'> | Omit<ProgressAuditCard, 'ref'>,
    expected: InputRef | null,
  ): Promise<AuditCard> {
    localLocator(locator);
    requireWorkflow(
      locator.startsWith(this.connection.plans.active + '/') && locator.endsWith('.md'),
      'audit-card-outside-plans',
    );
    let before: string | null = null;
    if (expected !== null) {
      requireWorkflow(expected.locator === locator, 'audit-card-locator-mismatch');
      before = await projectText(this.root, locator);
      requireWorkflow(contentHash(before) === expected.hash, 'audit-card-conflict');
    }
    let content = before ?? '# Аудит задания\n\n- **Статус:** `active`\n';
    const previous = readCardMarkdown(locator, content);
    if (previous.notes_version === null)
      content = adoptCardMarkdown(previous, this.connection.project_id, task);
    else
      requireWorkflow(
        (previous.notes_version === 1 || previous.notes_version === 2) &&
          previous.task_id === task &&
          previous.project_id === this.connection.project_id,
        'audit-card-identity-mismatch',
      );
    auditBrief({ ...data, ref: { locator, hash: 'pending' } });
    content += `\n${data.timing === null ? progressMarker : marker}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
    const projection = {
      operation_id: operation,
      task_id: task,
      from: locator,
      to: locator,
      changes: [{ locator, before, after: content }],
    };
    const result = await this.cards.apply(projection);
    requireWorkflow(result.status === 'confirmed', 'audit-card-reconciliation-pending');
    const snapshot = `Снимок карточки ${locator}; цель и статус принадлежат исходной карточке.\n\n${content}`;
    const hash = contentHash(snapshot);
    const snapshotLocator = `${this.snapshots}/card-${hash}.md`;
    const path = resolve(this.root, snapshotLocator);
    await writeFile(path, snapshot, { flag: 'wx' }).catch(async (error: unknown) => {
      requireWorkflow(
        (error as { code: string }).code === 'EEXIST' &&
          (await readFile(path, 'utf8')) === snapshot,
        'audit-snapshot-conflict',
      );
    });
    return this.read({ locator: snapshotLocator, hash });
  }
  async read(ref: InputRef): Promise<AuditCard> {
    const content = await projectText(this.root, ref.locator);
    requireWorkflow(contentHash(content) === ref.hash, 'audit-card-conflict');
    const currentMarker =
      content.lastIndexOf(progressMarker) > content.lastIndexOf(marker) ? progressMarker : marker;
    const parts = content.split(currentMarker);
    requireWorkflow(parts.length >= 2, 'audit-card-payload-missing');
    const block = /^\n```json\n([\s\S]*?)\n```\n$/u.exec(parts.at(-1)!);
    requireWorkflow(block !== null, 'audit-card-payload-invalid');
    const card = {
      ...(JSON.parse(block[1]!) as Omit<StageAuditCard, 'ref'> | Omit<ProgressAuditCard, 'ref'>),
      ref,
    };
    requireWorkflow(
      (card.timing === null) === (currentMarker === progressMarker),
      'audit-card-variant-mismatch',
    );
    auditBrief(card);
    return card;
  }
}
