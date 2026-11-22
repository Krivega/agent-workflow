import { object, requireContract } from '../../contracts/project.js';
import { digest } from '../artifacts/files.js';
import { readFragmentFits } from '../../policy/readFragments.js';

export interface ReaderFile {
  path: string;
  sha256: string;
}

export function confirmObservedLoad(turn: Record<string, unknown>, refs: ReaderFile[]): void {
  requireContract(
    turn.status === 'completed' && Array.isArray(turn.items),
    'reader-load-not-completed',
  );
  const observed = new Map<string, string>();
  const fragments = new Map<string, { content: string; length: number }>();
  for (const value of turn.items) {
    const item = object(value);
    if (
      item.type !== 'commandExecution' ||
      item.exitCode !== 0 ||
      typeof item.aggregatedOutput !== 'string'
    )
      continue;
    for (const line of item.aggregatedOutput.split('\n')) {
      let entry: Record<string, unknown>;
      try {
        entry = object(JSON.parse(line) as unknown);
      } catch {
        continue;
      }
      if (
        typeof entry.path !== 'string' ||
        typeof entry.content !== 'string' ||
        !refs.some((ref) => ref.path === entry.path)
      )
        continue;
      if (entry.format !== undefined || entry.offset !== undefined || entry.length !== undefined) {
        const before = fragments.get(entry.path);
        const content = before?.content ?? '';
        requireContract(
          entry.format === 'aw-native-read-parts/1' &&
            item.status === 'completed' &&
            Buffer.byteLength(
              item.aggregatedOutput + (item.aggregatedOutput.endsWith('\n') ? '' : '\n'),
            ) <= 24000 &&
            Buffer.byteLength(line + '\n') <= 24000 &&
            !observed.has(entry.path) &&
            readFragmentFits(content, entry.content, entry.offset, entry.length) &&
            (before === undefined || before.length === entry.length) &&
            refs.some((ref) => ref.path === entry.path && ref.sha256 === entry.sha256),
          'reader-load-invalid-fragment',
        );
        const combined = content + entry.content;
        fragments.set(entry.path, { content: combined, length: Number(entry.length) });
        if (combined.length === entry.length) {
          requireContract(digest(combined) === entry.sha256, 'reader-load-invalid-fragment');
          observed.set(entry.path, String(entry.sha256));
        }
      } else {
        requireContract(!fragments.has(entry.path), 'reader-load-mixed-formats');
        const hash = digest(entry.content);
        if (hash === entry.sha256) observed.set(entry.path, hash);
      }
    }
  }
  requireContract(
    refs.every((ref) => observed.get(ref.path) === ref.sha256),
    'reader-load-unconfirmed',
  );
}
