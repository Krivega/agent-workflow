import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { canonical } from '../adapters/storage/storeCodec.js';
import { requireWorkflow } from '../core/connection.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h01OperatorMain } from './comparisonH01Operator.js';
import { planH01Preparation, prepareH01Drafts } from './comparisonH01Preparation.js';

export async function h04OperatorMain(args: string[]) {
  if (args[0] === '--prepare' || args[0] === '--plan-preparation') {
    requireWorkflow(args.length === 2, 'h04-operator-preparation-usage');
    const value: unknown = JSON.parse(h01RawFile(resolve(args[1]!)).toString('utf8'));
    const result =
      args[0] === '--prepare'
        ? await prepareH01Drafts(value, 'H-04')
        : await planH01Preparation(value, 'H-04');
    process.stdout.write(canonical(result) + '\n');
    return;
  }
  return h01OperatorMain(args, 'H-04');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h04OperatorMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('h04-operator-failed\n');
    process.exitCode = 1;
  });
