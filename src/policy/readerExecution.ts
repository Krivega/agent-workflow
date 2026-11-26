import type { ReaderExecution } from '../contracts/readerControl.js';
import { exactFields, object, requireContract, text } from '../contracts/project.js';

export function isCodexAlpha13(version: unknown): boolean {
  return typeof version === 'string' && /^0\.171\.0-alpha\.13(?:\.(?:0|[1-9]\d*))?$/u.test(version);
}

export function supportedTaskClient(version: string): boolean {
  return version === '0.154.0' || version === '0.169.1' || isCodexAlpha13(version);
}

export function supportedReaderClient(version: string): boolean {
  return supportedTaskClient(version) || version === '0.165.0-alpha.1.2';
}

export function parseReaderExecution(value: unknown): ReaderExecution {
  const raw = object(value);
  exactFields(raw, ['schemaVersion', 'policyVersion', 'profile']);
  requireContract(raw.schemaVersion === 1 && raw.policyVersion === 1, 'reader-execution-version');
  const profile = object(raw.profile);
  exactFields(profile, ['model', 'effort', 'clientVersion']);
  return {
    schemaVersion: 1,
    policyVersion: 1,
    profile: {
      model: text(profile.model),
      effort: text(profile.effort),
      clientVersion: text(profile.clientVersion),
    },
  };
}

export function readerExecution(profile: ReaderExecution['profile']): ReaderExecution {
  return parseReaderExecution({ schemaVersion: 1, policyVersion: 1, profile });
}
