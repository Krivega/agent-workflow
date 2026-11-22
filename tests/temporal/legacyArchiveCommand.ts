import { readFileSync } from 'node:fs';
import { exportLegacyArchive, readLegacyArchive } from './legacyArchive.js';

export function legacyArchiveCommand(args: string[]) {
  const [action, file] = args;
  if (args.length !== 2 || (action !== 'read' && action !== 'export') || !file)
    throw new Error('Usage: legacy-archive read|export INPUT.json');
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return action === 'read' ? readLegacyArchive(input) : exportLegacyArchive(input);
}
