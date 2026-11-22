import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

import { formatAdrValidationReport, validateAdrJournal } from './adrValidation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decisionsDirectory = path.join(root, 'docs/design/decisions');
const execFileAsync = promisify(execFile);
const filenames = (await readdir(decisionsDirectory))
  .filter((filename) => /^\d{4}-.+\.md$/.test(filename))
  .sort();
const records = await Promise.all(
  filenames.map(async (filename) => ({
    filename,
    path: `docs/design/decisions/${filename}`,
    content: await readFile(path.join(decisionsDirectory, filename), 'utf8'),
  })),
);
const indexContent = await readFile(path.join(decisionsDirectory, 'README.md'), 'utf8');
const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md', '*.mdc'],
  { cwd: root, maxBuffer: 10 * 1024 * 1024 },
);
const documents = (
  await Promise.all(
    stdout
      .split('\n')
      .filter(Boolean)
      .map(async (documentPath) => {
        try {
          return {
            path: documentPath,
            content: await readFile(path.join(root, documentPath), 'utf8'),
          };
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return undefined;
          }
          throw error;
        }
      }),
  )
).filter(Boolean);
const issues = validateAdrJournal({ records, indexContent, documents });

console.log(formatAdrValidationReport(issues));
if (issues.length > 0) process.exitCode = 1;
