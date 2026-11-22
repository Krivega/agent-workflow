import { resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import {
  readH06NativeReaderSource,
  resolveH06NativeGrant,
} from './comparisonH06NativeAuthority.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { planH06NativeLegacyOperator } from './comparisonH06NativeLegacyOperator.js';
import {
  planH06NativeTemporalOperator,
  planH06NativeTemporalServerSetup,
} from './comparisonH06NativeTemporalOperator.js';

function separate(roots: readonly string[]) {
  return roots.every((root, index) =>
    roots
      .slice(index + 1)
      .every(
        (other) => root !== other && !root.startsWith(other + sep) && !other.startsWith(root + sep),
      ),
  );
}

/** Read and compare both reviewed variant packages before presenting separate grants. */
export function planH06NativeStand(value: unknown) {
  const input = object(value);
  exactFields(input, ['kind', 'legacy', 'temporal']);
  requireContract(input.kind === 'comparison-h06-native-stand/2', 'h06-native-stand-kind');
  const legacyPin = h04Pin(input.legacy);
  const temporalPin = h04Pin(input.temporal);
  const legacy = planH06NativeLegacyOperator(JSON.parse(readH04Pin(legacyPin).toString()));
  const temporal = planH06NativeTemporalOperator(JSON.parse(readH04Pin(temporalPin).toString()));
  const l = legacy.request;
  const t = temporal.request;
  requireContract(
    l.binding.operationId !== t.binding.operationId &&
      separate([l.binding.workspaceRoot, l.evidenceRoot, t.binding.workspaceRoot, t.evidenceRoot]),
    'h06-native-stand-roots',
  );
  requireContract(
    same(l.chat, t.chat) &&
      same(legacy.assets, temporal.assets) &&
      same(l.binding.node, t.binding.node) &&
      same(l.appServer, t.appServer) &&
      l.binding.timeoutMs === t.binding.timeoutMs &&
      l.stimulus.longStageMs === t.stimulus.longStageMs,
    'h06-native-stand-common-inputs',
  );
  const packages = {
    legacy: {
      pin: legacyPin,
      requestHash: legacy.requestHash,
      expectedGrantText: legacy.expectedGrantText,
    },
    temporal: {
      pin: temporalPin,
      requestHash: temporal.requestHash,
      expectedGrantText: temporal.expectedGrantText,
    },
  };
  return {
    kind: 'comparison-h06-native-stand-plan/2',
    standHash: digest(canonical(packages)),
    packages,
    order: ['legacy', 'temporal'],
    mayRun: false,
    qualification: false,
  } as const;
}

export function h06NativeStandMain(args: readonly string[]) {
  const [command, path] = args;
  requireContract(
    args.length === 2 &&
      (command === '--plan' || command === '--plan-server') &&
      path !== undefined,
    'h06-native-stand-arguments',
  );
  const input: unknown = JSON.parse(h01RawFile(resolve(path)).toString());
  if (command === '--plan') return planH06NativeStand(input);
  const request = object(input);
  exactFields(request, ['kind', 'attempt', 'budget']);
  requireContract(
    request.kind === 'comparison-h06-native-server-setup/2',
    'h06-native-stand-server-kind',
  );
  return planH06NativeTemporalServerSetup(
    JSON.parse(readH04Pin(h04Pin(request.attempt)).toString()),
    request.budget,
  );
}

export async function h06NativeStandCli(args: readonly string[]) {
  const [command, path, variant] = args;
  if (command === '--resolve-attempt-grant' || command === '--phase-source') {
    requireContract(args.length === 2 && path !== undefined, 'h06-native-stand-arguments');
    const locator = resolve(path);
    const bytes = h01RawFile(locator);
    if (command === '--phase-source') {
      const { request } = readH06NativeAttemptForReopen({ path: locator, sha256: digest(bytes) });
      return readH06NativeReaderSource(request.chat);
    }
    const request = object(JSON.parse(bytes.toString()));
    const plan =
      object(request.binding).variant === 'legacy'
        ? planH06NativeLegacyOperator(request)
        : planH06NativeTemporalOperator(request);
    return resolveH06NativeGrant(plan);
  }
  if (command === '--resolve-server-grant') {
    const plan = h06NativeStandMain(['--plan-server', ...args.slice(1)]);
    requireContract('attempt' in plan, 'h06-native-stand-server-kind');
    return resolveH06NativeGrant({
      request: plan.attempt.request,
      expectedGrantText: plan.expectedGrantText,
    });
  }
  if (command === '--resolve-grant') {
    requireContract(
      args.length === 3 && path !== undefined && (variant === 'legacy' || variant === 'temporal'),
      'h06-native-stand-arguments',
    );
    const plan = planH06NativeStand(JSON.parse(h01RawFile(resolve(path)).toString()));
    const { pin, expectedGrantText } = plan.packages[variant];
    const request: unknown = JSON.parse(readH04Pin(pin).toString());
    const backend =
      variant === 'legacy' ? planH06NativeLegacyOperator : planH06NativeTemporalOperator;
    const current = backend(request);
    requireContract(
      current.requestHash === plan.packages[variant].requestHash,
      'h06-native-stand-package-changed',
    );
    return resolveH06NativeGrant({ request: current.request, expectedGrantText });
  }
  return h06NativeStandMain(args);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06NativeStandCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
