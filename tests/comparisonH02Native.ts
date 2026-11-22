import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { h01Main } from './comparisonH01.js';

/** Closed H02 entrypoint; H01 requests and grants are rejected by the shared owner. */
export async function h02NativeMain(args: string[]) {
  return h01Main(args, 'H-02');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h02NativeMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('h02-native-failed\n');
    process.exitCode = 1;
  });
