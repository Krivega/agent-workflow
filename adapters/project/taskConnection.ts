import { writeFile, rename, mkdir, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { requireTaskBackend } from '../../src/adapters/project/taskBackend.js';
import metadata from '../../package.json' with { type: 'json' };
import type {
  TaskConnectionPlan,
  ConnectionPhase,
  ConnectionAction,
} from '../../core/taskConnection.js';
import { connectionTransition, validateConnectionPlan } from '../../core/taskConnection.js';
import { localLocator, object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { fileConnectionReader } from './fileConnectionReader.js';
import { contentHash, projectText, projectPath } from './projectFiles.js';
import { connectCardMarkdown, readCardMarkdown } from './cardMarkdown.js';
import { safeDirectory, readPrivateFile } from '../storage/storeFiles.js';

export interface Receipt {
  schema_version: 1;
  phase: ConnectionPhase;
  plan_hash: string;
  history: ConnectionAction[];
}
export class FileTaskConnection {
  constructor(private readonly root: string) {}
  async preview(descriptor: string, card: string, task: string): Promise<TaskConnectionPlan> {
    const loaded = await fileConnectionReader.load(this.root, descriptor),
      snapshot = readCardMarkdown(card, await projectText(this.root, card));
    requireWorkflow(
      Object.values(loaded.descriptor.plans).includes(dirname(card)),
      'card-outside-plans',
    );
    requireWorkflow(
      snapshot.notes_version === null ||
        snapshot.notes_version === 1 ||
        snapshot.notes_version === 2,
      'unsupported-task-notes-version',
    );
    requireWorkflow(
      snapshot.notes_version === null ||
        (snapshot.project_id === loaded.descriptor.project_id && snapshot.task_id === task),
      'card-identity-mismatch',
    );
    const after = connectCardMarkdown(snapshot, loaded.descriptor.project_id, task);
    const plan: TaskConnectionPlan = {
      schema_version: 1,
      tool_version: 'aw-local/1',
      runtime_package_version: metadata.version,
      project_id: loaded.descriptor.project_id,
      task_id: task,
      card: localLocator(card),
      descriptor: { locator: localLocator(descriptor), hash: loaded.revision },
      procedures: loaded.procedures.map(({ content: _content, ...p }) => p),
      rules: loaded.rules.map(({ content: _content, ...p }) => p),
      before: snapshot.content,
      after,
      from_version: snapshot.notes_version,
      to_version: 2,
    };
    validateConnectionPlan(plan);
    return plan;
  }
  private async compatible(plan: TaskConnectionPlan) {
    validateConnectionPlan(plan);
    const loaded = await fileConnectionReader.load(this.root, plan.descriptor.locator);
    requireWorkflow(
      loaded.revision === plan.descriptor.hash &&
        loaded.descriptor.project_id === plan.project_id &&
        sameValue(
          loaded.procedures.map(({ content: _content, ...p }) => p),
          plan.procedures,
        ) &&
        sameValue(
          loaded.rules.map(({ content: _content, ...p }) => p),
          plan.rules,
        ),
      'connection-inputs-changed',
    );
    this.delta(plan);
    requireWorkflow(
      Object.values(loaded.descriptor.plans).includes(dirname(plan.card)),
      'card-outside-plans',
    );
  }
  private delta(plan: TaskConnectionPlan) {
    const before = readCardMarkdown(plan.card, plan.before),
      after = readCardMarkdown(plan.card, plan.after);
    requireWorkflow(
      before.notes_version === plan.from_version &&
        after.notes_version === 2 &&
        after.project_id === plan.project_id &&
        after.task_id === plan.task_id,
      'connection-card-mismatch',
    );
    const expected = connectCardMarkdown(before, plan.project_id, plan.task_id);
    requireWorkflow(plan.after === expected, 'connection-unexpected-delta');
  }
  private async atomic(path: string, content: string) {
    const temporary = path + '.pending';
    try {
      await writeFile(temporary, content, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        readPrivateFile(temporary).toString('utf8') === content,
        'connection-partial-conflict',
      );
    }
    await rename(temporary, path);
  }
  async read(journal: string) {
    await this.location(journal);
    const plan = JSON.parse(
      readPrivateFile(resolve(journal, 'backup.json')).toString('utf8'),
    ) as TaskConnectionPlan;
    validateConnectionPlan(plan);
    this.delta(plan);
    const receipt = object(
      JSON.parse(readPrivateFile(resolve(journal, 'state.json')).toString('utf8')) as unknown,
    ) as unknown as Receipt;
    requireWorkflow(
      receipt.schema_version === 1 &&
        receipt.plan_hash === contentHash(JSON.stringify(plan)) &&
        Array.isArray(receipt.history),
      'unsupported-connection-state',
    );
    const phase = receipt.history.reduce(connectionTransition, 'prepared' as ConnectionPhase);
    requireWorkflow(phase === receipt.phase, 'connection-history-mismatch');
    return { plan, receipt };
  }
  async apply(plan: TaskConnectionPlan, journal: string) {
    requireTaskBackend(this.root, plan.project_id, plan.task_id, 'legacy', 'legacy', plan.card);
    await this.compatible(plan);
    // The backup and mutation receipts are outside the card and survive a rollback.
    const directory = resolve(journal);
    await this.location(directory, true);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    safeDirectory(directory);
    const backup = resolve(directory, 'backup.json'),
      serialized = JSON.stringify(plan);
    try {
      await writeFile(backup, serialized, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        readPrivateFile(backup).toString('utf8') === serialized,
        'connection-backup-conflict',
      );
    }
    const path = resolve(directory, 'state.json');
    try {
      await writeFile(
        path,
        JSON.stringify({
          schema_version: 1,
          phase: 'prepared',
          plan_hash: contentHash(serialized),
          history: [],
        }),
        { flag: 'wx' },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    return this.change(directory, 'ENABLE');
  }
  async change(journal: string, action: ConnectionAction) {
    const directory = resolve(journal),
      lock = resolve(directory, 'writer.lock');
    await this.location(directory);
    const existing = await this.read(directory);
    requireTaskBackend(
      this.root,
      existing.plan.project_id,
      existing.plan.task_id,
      'legacy',
      'legacy',
      existing.plan.card,
    );
    await writeFile(lock, action, { flag: 'wx' });
    try {
      const { plan, receipt } = await this.read(directory);
      requireTaskBackend(this.root, plan.project_id, plan.task_id, 'legacy', 'legacy', plan.card);
      if (action === 'ENABLE') await this.compatible(plan);
      const desired =
        action === 'ENABLE' ? 'enabled' : action === 'DISABLE' ? 'disabled' : 'rolled-back';
      const current = await projectText(this.root, plan.card);
      requireWorkflow(
        current === plan.before || current === plan.after,
        'connection-manual-conflict',
      );
      if (receipt.phase === desired) {
        requireWorkflow(
          current === (desired === 'rolled-back' ? plan.before : plan.after),
          'connection-state-incomplete',
        );
        return { plan, receipt };
      }
      const phase = connectionTransition(receipt.phase, action);
      const next =
        phase === 'rolled-back' ? plan.before : phase === 'disabled' ? current : plan.after;
      if (current !== next) await this.atomic(await projectPath(this.root, plan.card), next);
      const updated: Receipt = { ...receipt, phase, history: [...receipt.history, action] };
      await this.atomic(resolve(directory, 'state.json'), JSON.stringify(updated));
      return { plan, receipt: updated };
    } finally {
      await unlink(lock);
    }
  }
  private async location(journal: string, creating = false) {
    const base = await realpath(this.root),
      directory = resolve(journal);
    requireWorkflow(
      directory !== base && !directory.startsWith(base + '/'),
      'connection-journal-must-be-external',
    );
    safeDirectory(creating ? dirname(directory) : directory);
  }
}
