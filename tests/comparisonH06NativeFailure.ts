import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';

export interface H06NativeFailureBinding {
  operationId: string;
  variant: 'legacy' | 'temporal';
  workspaceRoot: string;
  node: H04Pin;
  timeoutMs: number;
}

function materialPins(workspaceRoot: string) {
  const materials = h06Assets().materials;
  const cases = JSON.parse(readH04Pin(materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  const material = cases.cases.find(({ id }) => id === 'H-06')!;
  return {
    materials,
    files: Object.entries(material.files).map(([name, bytes]) => ({
      path: join(workspaceRoot, name),
      sha256: digest(bytes),
    })),
    missingManifest: join(workspaceRoot, 'evidence', 'manifest.json'),
  };
}

function verifyMaterials(workspaceRoot: string) {
  requireContract(
    realpathSync(workspaceRoot) === workspaceRoot && lstatSync(workspaceRoot).isDirectory(),
    'h06-f01-workspace',
  );
  const before = materialPins(workspaceRoot);
  for (const file of before.files)
    requireContract(digest(h01RawFile(file.path)) === file.sha256, 'h06-f01-material');
  return before;
}

/** Capture before the checker or any actor starts in the fresh material workspace. */
export function observeH06NativeFailure(workspaceRoot: string) {
  const before = verifyMaterials(workspaceRoot);
  const parent = join(workspaceRoot, 'evidence');
  const info = lstatSync(parent, { throwIfNoEntry: false });
  requireContract(
    (info === undefined || info.isDirectory()) &&
      lstatSync(before.missingManifest, { throwIfNoEntry: false }) === undefined,
    'h06-f01-manifest-present',
  );
  return before;
}

export function validateH06NativeFailureBinding(binding: H06NativeFailureBinding) {
  identifier(binding.operationId);
  const node = h04Pin(binding.node);
  requireContract(
    (binding.variant === 'legacy' || binding.variant === 'temporal') &&
      isAbsolute(binding.workspaceRoot) &&
      resolve(binding.workspaceRoot) === binding.workspaceRoot &&
      Number.isSafeInteger(binding.timeoutMs) &&
      binding.timeoutMs > 0,
    'h06-f01-binding',
  );
  return node;
}

/** The receipt pin must come from the trusted operation recorder, not the workspace. */
export function checkH06NativeFailure(binding: H06NativeFailureBinding, pin: H04Pin) {
  const node = validateH06NativeFailureBinding(binding);
  const receipt = object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
  exactFields(receipt, ['kind', 'binding', 'before', 'after', 'outcome']);
  requireContract(
    receipt.kind === 'h06-native-f01' && same(receipt.binding, binding),
    'h06-f01-binding',
  );
  const expected = verifyMaterials(binding.workspaceRoot);
  requireContract(
    same(receipt.before, expected) && same(receipt.after, expected),
    'h06-f01-binding',
  );
  const outcome = object(receipt.outcome);
  const command = object(outcome.command);
  const stop = object(outcome.stop);
  requireContract(
    command.executable === node.path &&
      command.sha256 === node.sha256 &&
      same(command.args, ['checks.mjs']) &&
      command.timeoutMs === binding.timeoutMs,
    'h06-f01-command',
  );
  const missing = `Error: ENOENT: no such file or directory, open '${expected.missingManifest}'`;
  requireContract(
    Number.isSafeInteger(outcome.code) &&
      Number(outcome.code) > 0 &&
      outcome.signal === null &&
      outcome.error === null &&
      stop.confirmed === true &&
      Array.isArray(stop.processes) &&
      stop.processes.length > 0 &&
      typeof outcome.log === 'string' &&
      outcome.log.split('\n').includes(missing),
    'h06-f01-outcome',
  );
  return pin;
}
