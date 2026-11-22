import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { h01Main } from './comparisonH01.js';

export async function h03NativeMain(args: string[]) {
  return h01Main(args, 'H-03');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h03NativeMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('h03-native-failed\n');
    process.exitCode = 1;
  });
