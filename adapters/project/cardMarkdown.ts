import { parseDocument, isScalar } from 'yaml';
import type { CardCompletion, CardSnapshot, ProjectStatus } from '../../core/card.js';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { contentHash } from './projectFiles.js';
import { cardCriteria, criteriaSection } from '../../src/adapters/project/cardCriteria.js';
export { cardCriteria } from '../../src/adapters/project/cardCriteria.js';

const notes = /<!-- agent-workflow:task-notes -->\r?\n```yaml\r?\n([\s\S]*?)\r?\n```/gu;
const statusLine = /^- \*\*Статус:\*\* `(active|blocked|verifying|completed|cancelled)`/mu;

export function readCardMarkdown(locator: string, content: string): CardSnapshot {
  const blocks = [...content.matchAll(notes)];
  requireWorkflow(blocks.length <= 1, 'duplicate-task-notes');
  const status = statusLine.exec(content);
  requireWorkflow(status !== null, 'missing-card-status');
  const card: CardSnapshot = {
    locator,
    revision: contentHash(content),
    content,
    task_id: null,
    project_id: null,
    notes_version: null,
    status: status[1] as ProjectStatus,
  };
  if (blocks[0]) {
    const doc = parseDocument(blocks[0][1]!);
    requireWorkflow(doc.errors.length === 0, 'invalid-task-notes');
    const value = object(doc.toJS({ maxAliasCount: 0 }) as unknown);
    card.notes_version = value.schema_version;
    if (value.schema_version === 1 || value.schema_version === 2) {
      card.task_id = textField(value.task_id);
      card.project_id = textField(value.project_id);
    }
  }
  return card;
}
export function adoptCardMarkdown(card: CardSnapshot, project: string, task: string): string {
  requireWorkflow(card.notes_version === null, 'card-already-has-notes');
  textField(project);
  textField(task);
  return `${card.content}\n<!-- agent-workflow:task-notes -->\n\`\`\`yaml\nschema_version: 1\nproject_id: ${JSON.stringify(project)}\ntask_id: ${JSON.stringify(task)}\n\`\`\`\n`;
}
export function projectCardStatus(
  card: CardSnapshot,
  status: ProjectStatus,
  completion?: CardCompletion,
): string {
  requireWorkflow(
    card.notes_version === 1 || card.notes_version === 2,
    'unsupported-task-notes-version',
  );
  let content = card.content.replace(statusLine, `- **Статус:** \`${status}\``);
  if (completion !== undefined) {
    requireWorkflow(status === 'completed', 'completion-status-mismatch');
    const ids = cardCriteria(card.content).map(
      (text) => /^([a-zA-Z0-9_-]+): /u.exec(text)?.[1] ?? text,
    );
    requireWorkflow(new Set(ids).size === ids.length, 'duplicate-criterion-id');
    content = content.replace(criteriaSection, (block: string) =>
      block.replace(/^- \[[ x]\] (.*(?:\r?\n[ \t]+.*)*)/gmu, (row: string, text: string) => {
        requireWorkflow(
          completion.criteria.includes(text.replace(/\s+/gu, ' ').trim()) ||
            completion.criteria.includes(text.split(/\r?\n/u)[0]!) ||
            completion.criteria.includes(/^([a-zA-Z0-9_-]+): /u.exec(text)?.[1] ?? text),
          'completion-criterion-unaccepted',
        );
        return row.replace(/^- \[[ x]\]/u, '- [x]');
      }),
    );
    const result =
      `## Принятый результат\n\n${completion.summary}\n\n` +
      completion.evidence
        .map((ref) => `- [Доказательство](${ref.locator}) — SHA-256: \`${ref.hash}\`.`)
        .join('\n') +
      `\n\nОграничения: ${completion.limitations.join('; ') || 'дополнительных ограничений не заявлено'}.\n`;
    content = content.replace(/^## Принятый результат\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/mu, '');
    const position = content.search(/^## /mu);
    content =
      position < 0
        ? content + '\n' + result
        : content.slice(0, position) + result + '\n' + content.slice(position);
  }
  return content;
}
export function connectCardMarkdown(card: CardSnapshot, project: string, task: string): string {
  requireWorkflow(
    [null, 1, 2].includes(card.notes_version as null | number),
    'unsupported-task-notes-version',
  );
  const content =
    card.notes_version === null ? adoptCardMarkdown(card, project, task) : card.content;
  if (card.notes_version === 2) return content;
  return content.replace(notes, (block: string, source: string) => {
    const document = parseDocument(source);
    const node = document.get('schema_version', true);
    requireWorkflow(isScalar(node), 'invalid-schema-node');
    const range = node.range;
    requireWorkflow(range, 'missing-schema-range');
    return block.replace(source, source.slice(0, range[0]) + '2' + source.slice(range[1]));
  });
}
