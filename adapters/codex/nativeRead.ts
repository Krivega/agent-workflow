import { readFragmentFits } from '../../core/readFragments.js';
import { object, requireWorkflow } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';
import { contentHash } from '../project/projectFiles.js';

export function confirmNativeRead(turn: Record<string, unknown>, refs: InputRef[]): void {
  requireWorkflow(
    turn.status === 'completed' && Array.isArray(turn.items),
    'procedure-load-failed',
  );
  const observed = new Map<string, string>();
  const fragments = new Map<string, { content: string; length: unknown }>();
  for (const raw of turn.items) {
    const item = object(raw);
    if (
      item.type !== 'commandExecution' ||
      item.exitCode !== 0 ||
      typeof item.aggregatedOutput !== 'string'
    )
      continue;
    const commandBytes =
      Buffer.byteLength(item.aggregatedOutput) + (item.aggregatedOutput.endsWith('\n') ? 0 : 1);
    for (const line of item.aggregatedOutput.split('\n')) {
      let entry: Record<string, unknown>;
      try {
        entry = object(JSON.parse(line) as unknown);
      } catch {
        continue;
      }
      if (typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;
      if (entry.format !== undefined || entry.offset !== undefined || entry.length !== undefined) {
        if (!refs.some((ref) => ref.locator === entry.path)) continue;
        const before = fragments.get(entry.path);
        requireWorkflow(
          entry.format === 'aw-native-read-parts/1' &&
            commandBytes <= 24000 &&
            Buffer.byteLength(line + '\n') <= 24000 &&
            item.status === 'completed' &&
            !observed.has(entry.path) &&
            refs.some((ref) => ref.locator === entry.path && ref.hash === entry.sha256) &&
            (before === undefined || before.length === entry.length) &&
            readFragmentFits(before?.content ?? '', entry.content, entry.offset, entry.length),
          'procedure-read-fragment-invalid',
        );
        const content = (before?.content ?? '') + entry.content;
        fragments.set(entry.path, { content, length: entry.length });
        if (content.length === entry.length) {
          const hash = contentHash(content);
          requireWorkflow(hash === entry.sha256, 'procedure-read-fragment-invalid');
          observed.set(entry.path, hash);
        }
      } else {
        requireWorkflow(!fragments.has(entry.path), 'procedure-read-format-mixed');
        const hash = contentHash(entry.content);
        if (hash === entry.sha256) observed.set(entry.path, hash);
      }
    }
  }
  requireWorkflow(
    refs.every((ref) => observed.get(ref.locator) === ref.hash),
    'procedure-read-unconfirmed',
  );
}
