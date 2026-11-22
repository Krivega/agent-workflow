import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { formatDocumentationReport, validateDocumentation } from './documentationValidation.ts';

const root = resolve(import.meta.dirname, '..');
const { stdout } = await promisify(execFile)(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, maxBuffer: 10 * 1024 * 1024 },
);
const candidates = [...new Set(stdout.split('\0').filter(Boolean))].filter(
  (file) => !/^(?:tmp|node_modules|dist|coverage)\//.test(file),
);
const files = (
  await Promise.all(
    candidates.map(async (path) => {
      try {
        await access(resolve(root, path));
        return path;
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    }),
  )
).filter(Boolean);
const documents = (
  await Promise.all(
    files
      .filter((file) => /\.mdc?$/.test(file))
      .map(async (path) => {
        try {
          return { path, content: await readFile(resolve(root, path), 'utf8') };
        } catch (error) {
          if (error?.code === 'ENOENT') return undefined;
          throw error;
        }
      }),
  )
).filter(Boolean);
const { scripts } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const report = validateDocumentation({ documents, files, scripts: Object.keys(scripts) });
console.log(formatDocumentationReport(report));
if (report.issues.length) process.exitCode = 1;
