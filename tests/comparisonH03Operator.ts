import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.js';
import {
  h01RawFile,
  h01ReadJson,
  observeH01Authorization,
  parseH01Bootstrap,
  parseH01Request,
} from './comparisonH01Contract.js';
import { planH01 } from './comparisonH01.js';
import { h01OperatorMain } from './comparisonH01Operator.js';
import { planH01Preparation, prepareH01Drafts } from './comparisonH01Preparation.js';
import { h03NativeCommands, h03NativeSource } from './comparisonH03Contract.js';

/** Prints notices for the real completed root-chat tool; never writes a transcript or starts a reader. */
export async function issueH03Recovery(requestRef: InputRef) {
  const request = parseH01Request(h01ReadJson(requestRef), 'run', 'H-03');
  requireWorkflow(request.variant === 'candidate', 'h03-recovery-candidate-required');
  planH01(request, 'H-03');
  const bootstrap = parseH01Bootstrap(request.bootstrap, request.variant);
  requireWorkflow(bootstrap.engine === 'temporal', 'h03-recovery-engine');
  const observed = await observeH01Authorization(request);
  safeDirectory(dirname(requestRef.locator));
  const directory = join(
    dirname(requestRef.locator),
    'h03-human-' + digest(request.opId).slice(0, 20),
  );
  requireWorkflow(
    Object.keys(request.roots).every((name) => {
      const root = request.roots[name as keyof typeof request.roots];
      return (
        directory !== root && !directory.startsWith(root + '/') && !root.startsWith(directory + '/')
      );
    }),
    'h03-recovery-root-overlap',
  );
  const store = artifactStore(directory);
  const source = store.publish(Buffer.from(JSON.stringify(h03NativeSource(observed))));
  const commands = h03NativeCommands(request, source);
  const authority = nativeReaderAuthority(store, bootstrap.issuer);
  const notices = [await authority.issue(commands.pause), await authority.issue(commands.resume)];
  return {
    kind: 'comparison-h03-recovery-notices',
    request: requestRef,
    source,
    commands,
    notices,
    mayRun: false,
    allowedModelStarts: 0,
    qualification: false,
  };
}

export async function h03OperatorMain(args: string[]) {
  if (['--prepare', '--plan-preparation', '--issue-recovery'].includes(args[0]!)) {
    requireWorkflow(args.length === 2, 'h03-operator-preparation-usage');
    const path = resolve(args[1]!);
    if (args[0] === '--issue-recovery') {
      const result = await issueH03Recovery({ locator: path, hash: digest(h01RawFile(path)) });
      for (const notice of result.notices) process.stdout.write(notice + '\n');
      process.stdout.write(canonical(result) + '\n');
      return;
    }
    const value: unknown = JSON.parse(h01RawFile(path).toString('utf8'));
    const result =
      args[0] === '--prepare'
        ? await prepareH01Drafts(value, 'H-03')
        : await planH01Preparation(value, 'H-03');
    process.stdout.write(canonical(result) + '\n');
    return;
  }
  return h01OperatorMain(args, 'H-03');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h03OperatorMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('h03-operator-failed\n');
    process.exitCode = 1;
  });
