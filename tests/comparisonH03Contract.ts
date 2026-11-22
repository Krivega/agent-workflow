import suiteSource from '../comparison/suite.json' with { type: 'json' };
import materialSource from '../comparison/materials.json' with { type: 'json' };
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import { requireWorkflow } from '../core/connection.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import type { H01AttemptContext, H01VerifiedAuthorization } from './comparisonH01Contract.js';
import type { ReaderInput } from '../src/contracts/reader.js';
import type { ReaderCommand } from '../src/contracts/readerControl.js';
import type { NativeReaderSource } from '../src/adapters/codex/readerAuthority.js';
import { readerCommandText, readerKey, readerTarget } from '../src/policy/readerControl.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical } from '../adapters/storage/storeCodec.js';
import { safeDirectory, syncDirectory } from '../adapters/storage/storeFiles.js';
import { h01ReadPin } from './comparisonH01Contract.js';

const suite = parseComparisonSuite(suiteSource);
export const h03Scenario = Object.freeze(suite.scenarios.find((row) => row.id === 'H-03')!);
export const h03Material = parseComparisonMaterials(materialSource, suite).find(
  (row) => row.id === 'H-03',
)!;
Object.freeze(h03Material.files);
Object.freeze(h03Material.mutable);
Object.freeze(h03Material);
Object.freeze(h03Scenario.checks);
export const h03Procedures = [
  'bootstrap',
  'task',
  'evidence',
  'implementation',
  'boundary-review',
] as const;
export const h03ProbeNames = ['missing-rule', 'stale-source', 'wrong-role', 'new-action'] as const;
export const h03ContextPath = 'evidence/initial-context.json';

/** Both observed LOADs must contain these exact primary task facts. */
export function publishH03Context(
  ctx: Pick<H01AttemptContext, 'opId' | 'requestHash' | 'identity' | 'roots'>,
  failure: InputRef,
  pending: InputRef,
): InputRef {
  const content = Buffer.from(
    canonical({
      kind: 'comparison-h03-context',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      identity: ctx.identity,
      failure: { id: 'F-01', source: failure, text: h01ReadPin(failure).toString('utf8') },
      pending: { source: pending, text: h01ReadPin(pending).toString('utf8') },
    }) + '\n',
  );
  const locator = join(ctx.roots.workspaceRoot, h03ContextPath);
  safeDirectory(ctx.roots.workspaceRoot);
  mkdirSync(dirname(locator), { mode: 0o700, recursive: true });
  safeDirectory(dirname(locator));
  writeFileSync(locator, content, { flag: 'wx', mode: 0o600 });
  syncDirectory(dirname(locator));
  return { locator, hash: digest(content) };
}

export function h03PreparedMetadata(
  rules: string,
  executor: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    '.h03/rules.md': rules,
    '.h03/task.md': h03Material.instructions + '\n',
    '.h03/executor.md':
      'Read-only H03 executor. Preserve F-01 and the pending operation. No new authority or product dispatch across UNKNOWN.\n' +
      executor,
  });
}

type Identity = Pick<H01AttemptContext, 'opId' | 'identity'>;
export function h03ReaderInput(ctx: Identity): ReaderInput {
  return {
    preparation: {
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        projectId: 'h03-' + digest(ctx.opId).slice(0, 16),
        workspaceId: ctx.opId,
        rules: [
          '.h03/rules.md',
          ...h03Procedures.map((id) => `procedures/${id}.md`),
          h03ContextPath,
        ],
        cardRoot: '.h03',
        roles: [{ id: 'executor', profile: '.h03/executor.md' }],
        checks: ['syntax'],
      },
      taskId: ctx.identity.taskId,
      hostId: ctx.opId,
      owner: ctx.identity.owner,
      generation: ctx.identity.generation,
      revision: 1,
      card: '.h03/task.md',
    },
    roleId: 'executor',
  };
}

/** Copies the actual primary source descriptor; it never issues or fabricates a human notice. */
export function h03NativeSource(proof: H01VerifiedAuthorization): NativeReaderSource {
  const line = proof.source.locator.match(/^(.*)#L([1-9]\d*)$/u);
  requireWorkflow(
    proof.kind === 'comparison-h03-authorization-observation' && line?.[1] === proof.transcript,
    'h03-primary-source',
  );
  return {
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript: proof.transcript,
    threadId: proof.context.threadId,
    turnId: proof.context.turnId,
    user: { line: Number(line![2]), sha256: proof.source.hash },
  };
}

/** Exact commands whose notices must already exist in the real root chat before --run. */
export function h03NativeCommands(ctx: Identity, source: ReaderCommand['source']) {
  const input = h03ReaderInput(ctx),
    target = readerTarget(input, readerKey(input));
  const command = (
    action: 'pause' | 'resume',
    expectedRevision: number,
    attempt: number,
  ): ReaderCommand => {
    const value: ReaderCommand = {
      schemaVersion: 1,
      commandId: 'h03-' + digest(ctx.opId).slice(0, 20) + '-' + action,
      hash: '',
      target,
      expectedRevision,
      author: ctx.identity.owner,
      action,
      attempt,
      source,
    };
    value.hash = digest(readerCommandText(value));
    return value;
  };
  return { pause: command('pause', 0, 0), resume: command('resume', 1, 1) };
}

export interface H03Probe {
  basis: InputRef;
  observed: InputRef;
  error: string;
  refused: boolean;
}
export interface H03CaseReport {
  kind: 'comparison-h03-case';
  scenario: 'H-03';
  opId: string;
  engine: 'legacy' | 'temporal';
  session: string | null;
  context: InputRef | null;
  outcome: 'accepted' | 'failed' | 'unknown' | 'not-run';
  checks: Record<string, boolean>;
  blocking: string[];
  initial: { load: InputRef | null; state: InputRef | null };
  compaction: {
    before: InputRef | null;
    request: InputRef | null;
    boundary: InputRef | null;
    receipt: InputRef | null;
    usage: InputRef[];
  };
  probes: Partial<Record<(typeof h03ProbeNames)[number], H03Probe>>;
  recovered: { load: InputRef | null; state: InputRef | null };
  retained: {
    failure: InputRef | null;
    pending: InputRef | null;
    before: InputRef | null;
    after: InputRef | null;
  };
  stop: InputRef;
  evidence: InputRef[];
  nativeAcceptance: false;
  qualification: false;
  partialScope: true;
}
