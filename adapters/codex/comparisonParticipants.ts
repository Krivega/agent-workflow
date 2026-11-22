import { readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { AppServerRpc } from './appServerTransport.js';
import type { ComparisonParticipant } from './comparisonUsage.js';

export async function comparisonParticipants(
  rpc: Pick<AppServerRpc, 'request'>,
  roots: string[],
  run: string,
  register: (participant: ComparisonParticipant) => void,
) {
  const directories: string[] = [];
  const walk = async (root: string) => {
    requireWorkflow((await realpath(root)) === root, 'comparison-workspace-alias');
    directories.push(root);
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git')
        await walk(resolve(root, entry.name));
  };
  for (const root of roots) await walk(root);
  const sourceKinds = [
    'cli',
    'vscode',
    'exec',
    'appServer',
    'subAgent',
    'subAgentReview',
    'subAgentCompact',
    'subAgentThreadSpawn',
    'subAgentOther',
    'unknown',
  ];
  for (let index = 0; index < directories.length; index += 100) {
    const cwd = directories.slice(index, index + 100);
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = object(
          await rpc.request('thread/list', { cwd, archived, sourceKinds, limit: 100, cursor }),
        );
        requireWorkflow(Array.isArray(page.data), 'comparison-participants-incomplete');
        for (const raw of page.data) {
          const thread = object(raw);
          requireWorkflow(
            cwd.includes(String(thread.cwd)),
            'comparison-participant-scope-mismatch',
          );
          register({
            session: textField(thread.id),
            transcript: textField(thread.path),
            run,
            stage: 'helper',
          });
        }
        cursor =
          page.nextCursor === null || page.nextCursor === undefined
            ? null
            : textField(page.nextCursor);
        requireWorkflow(
          cursor === null || !seen.has(cursor),
          'comparison-participants-pagination-loop',
        );
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
    }
  }
}
