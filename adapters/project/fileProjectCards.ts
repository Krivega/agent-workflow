import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CardCompletion,
  CardProjection,
  CardSnapshot,
  FileChange,
  ProjectStatus,
} from '../../core/card.js';
import type { Connection } from '../../core/connection.js';
import { localLocator, requireWorkflow } from '../../core/connection.js';
import type { ProjectCards } from '../../ports/projectCards.js';
import { projectCardStatus, readCardMarkdown } from './cardMarkdown.js';
import { moveCardLinks } from './cardLinks.js';
import { contentHash, projectText } from './projectFiles.js';

export class FileProjectCards implements ProjectCards {
  constructor(
    private readonly root: string,
    private readonly connection: Connection,
    private readonly journalRoot: string,
    private readonly assertRuntime: () => void = () => {},
  ) {}
  async read(locator: string) {
    return readCardMarkdown(locator, await projectText(this.root, locator));
  }
  async prepare(
    card: CardSnapshot,
    status: ProjectStatus,
    operation: string,
    completion?: CardCompletion,
  ): Promise<CardProjection> {
    requireWorkflow(
      card.project_id === this.connection.project_id && card.task_id !== null,
      'card-identity-mismatch',
    );
    requireWorkflow(contentHash(card.content) === card.revision, 'invalid-card-revision');
    localLocator(operation);
    requireWorkflow(!operation.includes('/'), 'invalid-operation-id');
    const directory = this.connection.plans[status === 'blocked' ? 'active' : status];
    requireWorkflow(directory !== undefined, 'missing-cancelled-plan-root');
    requireWorkflow(
      Object.values(this.connection.plans).includes(dirname(card.locator)),
      'card-outside-plans',
    );
    const to = `${directory}/${basename(card.locator)}`;
    const after = moveCardLinks(
      projectCardStatus(card, status, completion),
      card.locator,
      to,
      card.locator,
      to,
    );
    const changes: FileChange[] = [];
    if (to === card.locator) changes.push({ locator: to, before: card.content, after });
    else {
      changes.push({ locator: to, before: null, after });
      const sourceIndex = `${dirname(card.locator)}/README.md`;
      const targetIndex = `${directory}/README.md`;
      const source = await projectText(this.root, sourceIndex);
      const target = await projectText(this.root, targetIndex);
      const lines = source.split('\n');
      const matching = lines.filter(
        (line) => moveCardLinks(line, sourceIndex, sourceIndex, card.locator, to) !== line,
      );
      requireWorkflow(matching.length === 1, 'card-index-not-unique');
      const row = matching[0]!;
      const index = lines.indexOf(row);
      lines.splice(index, 1);
      if (lines[index - 1] === '' && lines[index] === '') lines.splice(index, 1);
      const targetEnd = target.trimEnd();
      const lastLine = targetEnd.split('\n').at(-1)!;
      const separator =
        (lastLine.startsWith('|') && row.startsWith('|')) ||
        (/^[-*+] /u.test(lastLine) && /^[-*+] /u.test(row))
          ? '\n'
          : '\n\n';
      changes.push({
        locator: sourceIndex,
        before: source,
        after: `${lines.join('\n').trimEnd()}\n`,
      });
      changes.push({
        locator: targetIndex,
        before: target,
        after: `${targetEnd}${separator}${moveCardLinks(row, sourceIndex, targetIndex, card.locator, to)}\n`,
      });
      for (const locator of this.connection.mutable_links) {
        if ([sourceIndex, targetIndex, card.locator, to].includes(locator)) continue;
        const before = await projectText(this.root, locator);
        const updated = moveCardLinks(before, locator, locator, card.locator, to);
        if (before !== updated) changes.push({ locator, before, after: updated });
      }
      changes.push({ locator: card.locator, before: card.content, after: null });
    }
    return { operation_id: operation, task_id: card.task_id, from: card.locator, to, changes };
  }
  private async observed(locator: string): Promise<string | null> {
    try {
      return await projectText(this.root, locator);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  async apply(projection: CardProjection) {
    localLocator(projection.operation_id);
    requireWorkflow(!projection.operation_id.includes('/'), 'invalid-operation-id');
    const target = projection.changes.find((change) => change.locator === projection.to);
    requireWorkflow(target?.after != null, 'missing-projection-target');
    const proposed = readCardMarkdown(projection.to, target.after);
    requireWorkflow(
      proposed.task_id === projection.task_id &&
        proposed.project_id === this.connection.project_id &&
        (proposed.notes_version === 1 || proposed.notes_version === 2),
      'projection-identity-mismatch',
    );
    const base = await realpath(this.root);
    this.assertRuntime();
    await mkdir(this.journalRoot, { recursive: true });
    const journal = resolve(this.journalRoot, `${projection.operation_id}.json`);
    const serialized = JSON.stringify(projection);
    try {
      this.assertRuntime();
      await writeFile(journal, serialized, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        isDeepStrictEqual(JSON.parse(await readFile(journal, 'utf8')) as unknown, projection),
        'projection-operation-conflict',
      );
    }
    // Serialize this adapter's writers; an external editor still requires reconciliation.
    const lock = resolve(this.journalRoot, 'writer.lock');
    this.assertRuntime();
    await writeFile(lock, projection.operation_id, { flag: 'wx' });
    try {
      const receiptPath = resolve(this.journalRoot, `${projection.operation_id}.receipt.json`);
      try {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
          status: 'confirmed';
          locator: string;
          revision: string;
        };
        requireWorkflow(
          receipt.status === 'confirmed' &&
            receipt.locator === projection.to &&
            /^[a-f0-9]{64}$/u.test(receipt.revision),
          'invalid-projection-receipt',
        );
        return receipt;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      const conflicts: string[] = [];
      for (const change of projection.changes) {
        const current = await this.observed(change.locator);
        if (current !== change.before && current !== change.after) conflicts.push(change.locator);
      }
      if (conflicts.length) return { status: 'pending' as const, conflicts };
      for (const change of projection.changes) {
        const current = await this.observed(change.locator);
        if (current === change.after) continue;
        if (current !== change.before)
          return { status: 'pending' as const, conflicts: [change.locator] };
        const path = resolve(base, localLocator(change.locator));
        const parent = await realpath(dirname(path));
        requireWorkflow(
          parent === dirname(path) && (parent === base || parent.startsWith(base + sep)),
          'unsafe-project-path',
        );
        this.assertRuntime();
        if (change.after === null) await unlink(path);
        else {
          const temporary = `${path}.${projection.operation_id}.tmp`;
          await writeFile(temporary, change.after, { flag: 'wx' });
          this.assertRuntime();
          await rename(temporary, path);
        }
      }
      const card = await this.read(projection.to);
      const receipt = {
        status: 'confirmed' as const,
        locator: card.locator,
        revision: card.revision,
      };
      this.assertRuntime();
      await writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx' });
      return receipt;
    } finally {
      await unlink(lock);
    }
  }
}
