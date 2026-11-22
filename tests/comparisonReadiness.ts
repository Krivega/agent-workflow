import console from 'node:console';
import process from 'node:process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import materialsSource from '../comparison/materials.json' with { type: 'json' };
import {
  comparisonDuration,
  comparisonReport,
  comparisonSchedule,
  parseComparisonMaterials,
  parseComparisonSuite,
  type ComparisonReceipt,
  type ComparisonResult,
  type ComparisonTiming,
} from '../core/comparison.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readPrivateFile, safeDirectory } from '../adapters/storage/storeFiles.js';
import {
  readComparisonUsage,
  type ComparisonParticipant,
} from '../adapters/codex/comparisonUsage.js';

const suite = parseComparisonSuite(suiteSource);
const materials = parseComparisonMaterials(materialsSource, suite);
const variants = ['baseline', 'candidate'] as const;
const suitePath = resolve(import.meta.dirname, '../comparison/suite.json');
const materialsPath = resolve(import.meta.dirname, '../comparison/materials.json');
const forbidden = {
  mayRun: false,
  qualification: false,
  allowedModelStarts: 0,
  authorization: null,
};
const profileText = ['model', 'effort', 'clientVersion'] as const;
const profilePins = ['client', 'rules', 'permissions'] as const;
const environmentText = [
  'node',
  'yarn',
  'os',
  'architecture',
  'cachePolicy',
  'sdk',
  'server',
] as const;
const environmentPins = ['lock', 'hardware', 'background', 'network'] as const;

// The existing installed-consumer inventory format, read without following file-location pointers.
type SourceEntry =
  | { path: string; mode: number; kind: 'directory' }
  | { path: string; mode: number; kind: 'file'; sha256: string; bytes: number };
function physicalIdentity(stat: Stats) {
  return canonical([
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
}
function physicalBytes(path: string) {
  safeDirectory(dirname(path));
  const before = lstatSync(path);
  requireWorkflow(before.isFile(), 'readiness-source-file-unsafe');
  requireWorkflow(before.nlink === 1, 'readiness-source-file-linked');
  const identity = physicalIdentity(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireWorkflow(physicalIdentity(fstatSync(fd)) === identity, 'readiness-source-file-changed');
    safeDirectory(dirname(path));
    requireWorkflow(
      physicalIdentity(lstatSync(path)) === identity,
      'readiness-source-file-changed',
    );
    const bytes = readFileSync(fd);
    requireWorkflow(bytes.length === before.size, 'readiness-source-file-changed');
    requireWorkflow(physicalIdentity(fstatSync(fd)) === identity, 'readiness-source-file-changed');
    safeDirectory(dirname(path));
    requireWorkflow(
      physicalIdentity(lstatSync(path)) === identity,
      'readiness-source-file-changed',
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function sourceTree(root: string) {
  const entries: SourceEntry[] = [];
  function visit(path: string) {
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      safeDirectory(absolute);
      const names = readdirSync(absolute).sort();
      entries.push({ path, mode: stat.mode & 0o777, kind: 'directory' });
      for (const name of names) visit(path ? path + '/' + name : name);
      safeDirectory(absolute);
      requireWorkflow(
        physicalIdentity(lstatSync(absolute)) === physicalIdentity(stat) &&
          canonical(readdirSync(absolute).sort()) === canonical(names),
        'readiness-source-directory-changed',
      );
    } else {
      const bytes = physicalBytes(absolute);
      requireWorkflow(
        physicalIdentity(lstatSync(absolute)) === physicalIdentity(stat),
        'readiness-source-file-changed',
      );
      entries.push({
        path,
        mode: stat.mode & 0o777,
        kind: 'file',
        sha256: digest(bytes),
        bytes: bytes.length,
      });
    }
  }
  safeDirectory(root);
  const binding = lstatSync(root);
  visit('');
  requireWorkflow(
    entries.some((entry) => entry.kind === 'file'),
    'readiness-source-empty',
  );
  return { binding: canonical([binding.dev, binding.ino]), entries };
}
function sourceEquality(value: unknown) {
  const source = fields(value, ['inventory', 'roots']);
  const roots = fields(source.roots, ['source', 'baseline', 'candidate']);
  const paths = Object.values(roots).map((value) => {
    const root = textField(value);
    requireWorkflow(
      isAbsolute(root) && resolve(root) === root && dirname(root) !== root,
      'readiness-source-root-invalid',
    );
    safeDirectory(root);
    return root;
  });
  for (const root of paths)
    requireWorkflow(
      paths.filter((other) => root === other || root.startsWith(other + sep)).length === 1,
      'readiness-source-roots-overlap',
    );
  const input = fields(source.inventory, ['locator', 'hash']);
  const locator = textField(input.locator),
    hash = textField(input.hash);
  requireWorkflow(isAbsolute(locator) && resolve(locator) === locator, 'readiness-path-invalid');
  requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'readiness-hash-invalid');
  requireWorkflow(
    paths.every((root) => locator !== root && !locator.startsWith(root + sep)),
    'readiness-source-inventory-inside',
  );
  const bytes = physicalBytes(locator);
  requireWorkflow(digest(bytes) === hash, 'readiness-pin-changed');
  const expected: unknown = JSON.parse(bytes.toString('utf8'));
  requireWorkflow(Array.isArray(expected), 'readiness-source-inventory-invalid');
  const first = paths.map(sourceTree);
  requireWorkflow(
    new Set(first.map((tree) => tree.binding)).size === 3,
    'readiness-source-roots-alias',
  );
  requireWorkflow(
    first.every((tree) => canonical(tree.entries) === canonical(expected)),
    'readiness-source-tree-mismatch',
  );
  const second = paths.map(sourceTree);
  requireWorkflow(canonical(first) === canonical(second), 'readiness-source-changed');
  requireWorkflow(physicalBytes(locator).equals(bytes), 'readiness-source-inventory-changed');
  return {
    inventory: { locator, hash },
    roots,
    treeHash: digest(canonical(expected)),
    observedEquality: true,
  };
}

function fields(value: unknown, expected: readonly string[]) {
  const record = object(value);
  requireWorkflow(
    canonical(Object.keys(record).sort()) === canonical([...expected].sort()),
    'readiness-fields-invalid',
  );
  return record;
}
function knownText(value: unknown) {
  const text = textField(value);
  requireWorkflow(!/^(unknown|todo|tbd|\?)$/iu.test(text.trim()), 'readiness-value-unknown');
  return text;
}
function pin(value: unknown) {
  const input = fields(value, ['locator', 'hash']);
  const locator = textField(input.locator),
    hash = textField(input.hash);
  requireWorkflow(isAbsolute(locator) && resolve(locator) === locator, 'readiness-path-invalid');
  requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'readiness-hash-invalid');
  safeDirectory(dirname(locator));
  const bytes = readPrivateFile(locator);
  requireWorkflow(digest(bytes) === hash, 'readiness-pin-changed');
  return { ref: { locator, hash }, bytes };
}
function sourcePin(path: string) {
  return { locator: path, hash: digest(readPrivateFile(path)) };
}
function order() {
  return comparisonSchedule(
    suite,
    Object.fromEntries(
      materials.map((material) => [
        material.id,
        {
          material_hash: digest(canonical(material)),
          profile_hash: '0'.repeat(64),
        },
      ]),
    ),
  ).map(({ id, scenario, pair, variant }) => ({ id, scenario, pair, variant }));
}

export function comparisonReadinessPlan() {
  return {
    schema_version: 1,
    kind: 'temporal-comparison-readiness-report',
    status: 'PLAN',
    ...forbidden,
    manifest: {
      schema_version: 1,
      kind: 'temporal-comparison-readiness',
      seriesId: null,
      allowedModelStarts: 0,
      authorization: null,
      variants: Object.fromEntries(
        variants.map((variant) => [
          variant,
          {
            runtime: { engine: variant === 'baseline' ? 'legacy' : 'temporal', artifact: null },
            taskSource: sourcePin(materialsPath),
            sourceRevision: null,
            criteria: sourcePin(suitePath),
            profile: {
              ...Object.fromEntries([...profileText, ...profilePins].map((key) => [key, null])),
              roles: [],
            },
            environment: {
              ...Object.fromEntries(
                [...environmentText, ...environmentPins].map((key) => [key, null]),
              ),
              workerSlots: null,
            },
          },
        ]),
      ),
      order: order(),
    },
  };
}

export function checkComparisonReadiness(value: unknown) {
  const sourceVersion = object(value).schema_version === 2;
  const manifest = fields(value, [
    'schema_version',
    'kind',
    'seriesId',
    'allowedModelStarts',
    'authorization',
    'variants',
    'order',
    ...(sourceVersion ? ['sourceSnapshot'] : []),
  ]);
  requireWorkflow(
    (manifest.schema_version === 1 || manifest.schema_version === 2) &&
      manifest.kind === 'temporal-comparison-readiness',
    'readiness-version-invalid',
  );
  knownText(manifest.seriesId);
  requireWorkflow(
    manifest.allowedModelStarts === 0 && manifest.authorization === null,
    'readiness-budget-forbidden',
  );
  const inputs = fields(manifest.variants, variants);
  const checked = variants.map((variant) => {
    const input = fields(inputs[variant], [
      'runtime',
      'taskSource',
      'sourceRevision',
      'criteria',
      'profile',
      'environment',
    ]);
    const runtimeInput = fields(input.runtime, ['engine', 'artifact']);
    requireWorkflow(
      runtimeInput.engine === (variant === 'baseline' ? 'legacy' : 'temporal'),
      'readiness-engine-mismatch',
    );
    const runtime = { engine: runtimeInput.engine, artifact: pin(runtimeInput.artifact).ref };
    const task = pin(input.taskSource),
      criteria = pin(input.criteria);
    requireWorkflow(
      task.ref.hash === sourcePin(materialsPath).hash &&
        criteria.ref.hash === sourcePin(suitePath).hash,
      'readiness-case-inputs-changed',
    );
    parseComparisonMaterials(
      JSON.parse(task.bytes.toString('utf8')),
      parseComparisonSuite(JSON.parse(criteria.bytes.toString('utf8'))),
    );
    requireWorkflow(
      input.sourceRevision === null || /^[a-f0-9]{40}$/u.test(textField(input.sourceRevision)),
      'readiness-revision-invalid',
    );
    const profile = fields(input.profile, [...profileText, ...profilePins, 'roles']);
    profileText.forEach((key) => knownText(profile[key]));
    requireWorkflow(
      Array.isArray(profile.roles) && profile.roles.length > 0,
      'readiness-roles-missing',
    );
    const roles = profile.roles.map(knownText);
    requireWorkflow(new Set(roles).size === roles.length, 'readiness-roles-duplicate');
    const profileRefs = Object.fromEntries(profilePins.map((key) => [key, pin(profile[key]).ref]));
    const profileHash = digest(
      canonical({
        ...Object.fromEntries(profileText.map((key) => [key, profile[key]])),
        roles,
        ...Object.fromEntries(profilePins.map((key) => [key, profileRefs[key]!.hash])),
      }),
    );
    const environment = fields(input.environment, [
      ...environmentText,
      ...environmentPins,
      'workerSlots',
    ]);
    environmentText.forEach((key) => knownText(environment[key]));
    requireWorkflow(
      Number.isSafeInteger(environment.workerSlots) && Number(environment.workerSlots) > 0,
      'readiness-workers-invalid',
    );
    requireWorkflow(
      ['cold', 'warm'].includes(String(environment.cachePolicy)),
      'readiness-cache-invalid',
    );
    const environmentRefs = Object.fromEntries(
      environmentPins.map((key) => [key, pin(environment[key]).ref]),
    );
    const environmentHash = digest(
      canonical({
        ...Object.fromEntries(environmentText.map((key) => [key, environment[key]])),
        workerSlots: environment.workerSlots,
        ...Object.fromEntries(environmentPins.map((key) => [key, environmentRefs[key]!.hash])),
      }),
    );
    return {
      runtime,
      taskSource: task.ref,
      declaredSourceRevision: input.sourceRevision,
      criteria: criteria.ref,
      profileHash,
      profileRefs,
      environmentHash,
      environmentRefs,
    };
  });
  const baseline = checked[0]!,
    candidate = checked[1]!;
  requireWorkflow(
    baseline.declaredSourceRevision === candidate.declaredSourceRevision,
    'readiness-revision-mismatch',
  );
  requireWorkflow(baseline.profileHash === candidate.profileHash, 'readiness-profile-mismatch');
  requireWorkflow(
    baseline.environmentHash === candidate.environmentHash,
    'readiness-environment-mismatch',
  );
  requireWorkflow(canonical(manifest.order) === canonical(order()), 'readiness-order-mismatch');
  return {
    schema_version: sourceVersion ? 2 : 1,
    kind: 'temporal-comparison-readiness-report',
    status: 'PASS',
    ...forbidden,
    canonicalManifestHash: digest(canonical(manifest)),
    ...(sourceVersion ? { sourceSnapshot: sourceEquality(manifest.sourceSnapshot) } : {}),
    variants: { baseline, candidate },
    schedule: comparisonSchedule(
      suite,
      Object.fromEntries(
        materials.map((material) => [
          material.id,
          {
            material_hash: digest(canonical(material)),
            profile_hash: baseline.profileHash,
          },
        ]),
      ),
    ),
    unproven: [
      'future-isolated-copies',
      'effective-client-profile-and-environment',
      'actual-stop',
      'native-accounting',
      'full-game-source',
      'git-revision',
    ],
  };
}

function seriesTiming(value: unknown): ComparisonTiming | undefined {
  if (value === null) return undefined;
  const timing = fields(value, ['start', 'end']);
  fields(timing.start, ['wall_ms', 'monotonic_ms', 'clock_id']);
  fields(timing.end, ['wall_ms', 'monotonic_ms', 'clock_id']);
  return timing as unknown as ComparisonTiming;
}

function seriesLine(value: unknown, transcript: string) {
  const input = fields(value, ['locator', 'hash']);
  const locator = textField(input.locator),
    hash = textField(input.hash);
  const prefix = transcript + '#L';
  requireWorkflow(
    locator.startsWith(prefix) &&
      /^[1-9][0-9]*$/u.test(locator.slice(prefix.length)) &&
      /^[a-f0-9]{64}$/u.test(hash),
    'series-usage-line-invalid',
  );
  return { locator, hash };
}

function seriesUsage(
  value: unknown,
  run: string | null,
  participants: string[],
  transcripts: Map<string, string>,
) {
  requireWorkflow(Array.isArray(value), 'series-usage-sources-invalid');
  const sources = value.map((value) => {
    const source = fields(value, [
      'session',
      'transcript',
      'run',
      'stage',
      'through',
      ...(Object.hasOwn(object(value), 'after') ? ['after'] : []),
    ]);
    const session = knownText(source.session),
      stage = textField(source.stage);
    requireWorkflow(
      source.run === run && participants.includes(session),
      'series-usage-source-unbound',
    );
    const declared = fields(source.transcript, ['locator', 'hash']);
    const transcriptBinding = canonical(declared),
      previous = transcripts.get(session);
    requireWorkflow(
      previous === undefined || previous === transcriptBinding,
      'series-usage-session-source-conflict',
    );
    transcripts.set(session, transcriptBinding);
    const transcript = pin(declared);
    const participant = {
      session,
      transcript: transcript.ref.locator,
      run,
      stage,
      through: seriesLine(source.through, transcript.ref.locator),
      ...(Object.hasOwn(source, 'after')
        ? { after: seriesLine(source.after, transcript.ref.locator) }
        : {}),
    } as ComparisonParticipant;
    const receipts = readComparisonUsage(participant, false);
    pin(source.transcript);
    return { session, receipts };
  });
  requireWorkflow(
    participants.every((participant) => sources.some((source) => source.session === participant)),
    'series-usage-participant-unaccounted',
  );
  return sources.flatMap((source) => source.receipts);
}

function seriesBlock(
  value: unknown,
  run: string | null,
  attempt: boolean,
  verifyUsage: boolean,
  transcripts: Map<string, string>,
) {
  const block = fields(value, [
    'participants',
    'receipts',
    'stopConfirmed',
    ...(verifyUsage ? ['usageSources'] : []),
    ...(attempt ? ['result'] : ['timing']),
  ]);
  requireWorkflow(Array.isArray(block.participants), 'series-participants-invalid');
  const participants = block.participants.map(knownText);
  requireWorkflow(
    new Set(participants).size === participants.length && (!attempt || participants.length > 0),
    'series-participants-invalid',
  );
  requireWorkflow(Array.isArray(block.receipts), 'series-receipts-invalid');
  const receipts = block.receipts.map((value) => {
    const receipt = fields(value, [
      'id',
      'run',
      'participant',
      'stage',
      'responses',
      'input_uncached',
      'input_cached',
      'output',
      ...(verifyUsage ? ['source'] : []),
    ]);
    requireWorkflow(
      receipt.run === run && participants.includes(textField(receipt.participant)),
      'series-receipt-unbound',
    );
    return receipt as unknown as ComparisonReceipt;
  });
  requireWorkflow(
    participants.every((participant) =>
      receipts.some((receipt) => receipt.participant === participant),
    ),
    'series-participant-unaccounted',
  );
  requireWorkflow(typeof block.stopConfirmed === 'boolean', 'series-stop-invalid');
  if (verifyUsage) {
    const observed = seriesUsage(block.usageSources, run, participants, transcripts);
    const ordered = (entries: ComparisonReceipt[]) =>
      [...entries].sort((left, right) => left.id.localeCompare(right.id));
    requireWorkflow(
      canonical(ordered(observed)) === canonical(ordered(receipts)),
      'series-usage-receipts-mismatch',
    );
  }
  return { block, receipts, stopped: block.stopConfirmed };
}

// This reads declared observations only. Even a complete record cannot authorize execution.
export function checkComparisonTemporalSeries(value: unknown) {
  const record = fields(value, [
    'schema_version',
    'kind',
    'allowedModelStarts',
    'authorization',
    'readiness',
    'canonicalManifestHash',
    'elapsed_ms',
    'preparation',
    'attempts',
  ]);
  requireWorkflow(
    (record.schema_version === 1 || record.schema_version === 2) &&
      record.kind === 'temporal-comparison-series-record',
    'series-version-invalid',
  );
  requireWorkflow(
    record.allowedModelStarts === 0 && record.authorization === null,
    'series-budget-forbidden',
  );
  const input = pin(record.readiness);
  const readiness = checkComparisonReadiness(JSON.parse(input.bytes.toString('utf8')));
  requireWorkflow(
    record.canonicalManifestHash === readiness.canonicalManifestHash,
    'series-manifest-changed',
  );
  const verifyUsage = record.schema_version === 2;
  const transcripts = new Map<string, string>();
  const preparation = seriesBlock(record.preparation, null, false, verifyUsage, transcripts);
  const receipts = [...preparation.receipts];
  const results: ComparisonResult[] = [];
  const preparationTiming = seriesTiming(preparation.block.timing);
  let lastTiming = preparationTiming;
  let timingKnown =
    lastTiming !== undefined && comparisonDuration(lastTiming.start, lastTiming.end) !== null;
  let stopped = preparation.stopped;
  let cursor = 0;
  const observedElapsed = () =>
    preparationTiming !== undefined && lastTiming !== undefined
      ? comparisonDuration(preparationTiming.start, lastTiming.end)
      : null;
  const account = () =>
    comparisonReport(
      suite,
      readiness.schedule,
      receipts,
      results,
      Math.ceil(observedElapsed() ?? 0),
    );
  let accounting = account();
  requireWorkflow(Array.isArray(record.attempts), 'series-attempts-invalid');
  for (const value of record.attempts) {
    const raw = object(value);
    const result = fields(raw.result, [
      'run',
      'attempt',
      'outcome',
      'checks',
      'evidence',
      'timing',
      ...(Object.hasOwn(object(raw.result), 'reconciles') ? ['reconciles'] : []),
    ]);
    const previous = results.at(-1);
    const reconciliation = result.reconciles !== undefined;
    const timing = seriesTiming(result.timing);
    const startElapsed =
      timing !== undefined && preparationTiming !== undefined
        ? comparisonDuration(preparationTiming.start, timing.start)
        : null;
    requireWorkflow(
      result.run === readiness.schedule[cursor]?.id &&
        (reconciliation
          ? previous?.outcome === 'unknown' && result.run === previous.run
          : accounting.stop === null &&
            stopped &&
            timingKnown &&
            (startElapsed === null ||
              comparisonReport(
                suite,
                readiness.schedule,
                receipts,
                results,
                Math.ceil(startElapsed),
              ).stop === null) &&
            (previous === undefined ||
              (previous.outcome === 'accepted' && Object.values(previous.checks).every(Boolean)))),
      'series-order-blocked',
    );
    const block = seriesBlock(raw, textField(result.run), true, verifyUsage, transcripts);
    requireWorkflow(Array.isArray(result.evidence), 'series-evidence-invalid');
    requireWorkflow(
      !reconciliation ||
        result.evidence.some((entry) => !previous!.evidence.includes(textField(entry))),
      'series-reconciliation-evidence-reused',
    );
    const current = {
      ...result,
      ...(timing === undefined ? { timing: undefined } : { timing }),
    } as unknown as ComparisonResult;
    object(current.checks);
    receipts.push(...block.receipts);
    results.push(current);
    const continuous =
      timing !== undefined &&
      lastTiming !== undefined &&
      (reconciliation
        ? canonical(timing.start) === canonical(lastTiming.start) &&
          comparisonDuration(lastTiming.end, timing.end) !== null
        : comparisonDuration(lastTiming.end, timing.start) !== null);
    timingKnown =
      timingKnown && continuous && comparisonDuration(timing!.start, timing!.end) !== null;
    lastTiming = timing;
    stopped = block.stopped;
    accounting = account();
    if (current.outcome === 'accepted' && Object.values(current.checks).every(Boolean)) cursor++;
  }
  timingKnown =
    timingKnown &&
    preparationTiming !== undefined &&
    lastTiming !== undefined &&
    observedElapsed() !== null &&
    observedElapsed()! <= Number(record.elapsed_ms);
  accounting = comparisonReport(
    suite,
    readiness.schedule,
    receipts,
    results,
    record.elapsed_ms as number,
  );
  const last = results.at(-1);
  const action =
    accounting.stop ??
    (!stopped
      ? 'confirm-stop'
      : !timingKnown
        ? 'supply-timing'
        : last !== undefined &&
            (last.outcome !== 'accepted' || Object.values(last.checks).some((passed) => !passed))
          ? 'review-failure'
          : cursor === readiness.schedule.length
            ? 'review-complete'
            : 'prepare-run');
  return {
    schema_version: verifyUsage ? 2 : 1,
    kind: 'temporal-comparison-series-report',
    status: 'PASS',
    ...forbidden,
    readiness: input.ref,
    canonicalManifestHash: readiness.canonicalManifestHash,
    canonicalRecordHash: digest(canonical(record)),
    observedRuns: cursor,
    observationsComplete: cursor === readiness.schedule.length && action === 'review-complete',
    totals: accounting.totals,
    ...(verifyUsage ? { primaryUsageVerified: true, usageVerificationScope: 'listed-ranges' } : {}),
    next: {
      action,
      run: cursor < readiness.schedule.length ? readiness.schedule[cursor]!.id : null,
    },
    unproven: [
      ...readiness.unproven,
      'declared-participant-completeness',
      'primary-stop-evidence',
      'series-authorization',
    ],
  };
}

export function comparisonReadinessCli(args: string[]) {
  try {
    if (args.length === 1 && args[0] === '--plan')
      return { exitCode: 0, report: comparisonReadinessPlan() };
    requireWorkflow(
      args.length === 2 && ['--check', '--series-check'].includes(args[0]!),
      'readiness-usage',
    );
    const path = textField(args[1]);
    requireWorkflow(isAbsolute(path) && resolve(path) === path, 'readiness-path-invalid');
    safeDirectory(dirname(path));
    const bytes = readPrivateFile(path);
    return {
      exitCode: 0,
      report: {
        ...(args[0] === '--series-check'
          ? checkComparisonTemporalSeries
          : checkComparisonReadiness)(JSON.parse(bytes.toString('utf8'))),
        manifest: { locator: path, hash: digest(bytes) },
      },
    };
  } catch {
    // File contents and native exception snippets never enter the public report.
    return {
      exitCode: 1,
      report: {
        schema_version: 1,
        kind:
          args[0] === '--series-check'
            ? 'temporal-comparison-series-report'
            : 'temporal-comparison-readiness-report',
        status: 'FAIL',
        ...forbidden,
        reason: 'invalid-or-incomparable-manifest',
      },
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = comparisonReadinessCli(process.argv.slice(2));
  console.log(JSON.stringify(result.report));
  process.exitCode = result.exitCode;
}
