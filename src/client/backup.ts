import { readFileSync } from 'node:fs';
import { createBackup, stageRestore, verifyBackup } from '../adapters/artifacts/backup.js';
import { retentionReport } from '../adapters/artifacts/retention.js';

export function backupCommand(args: string[]) {
  const [action, file] = args;
  if (
    args.length !== 2 ||
    !['save', 'restore', 'verify', 'retention'].includes(action ?? '') ||
    !file
  )
    throw new Error('Usage: backup save|restore|verify|retention INPUT.json');
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  switch (action) {
    case 'save':
      return createBackup(input);
    case 'restore':
      return stageRestore(input);
    case 'verify':
      return verifyBackup(input);
    default:
      return retentionReport(input);
  }
}
