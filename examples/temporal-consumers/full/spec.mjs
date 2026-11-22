import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gameOwner = 'apps/player/src/application/story/playerStoryProfileScores.ts';
export const gameConsumers = [
  'apps/player/src/application/story/playerStoryProfileScores.test.ts',
  'apps/player/src/application/story/playerStoryLibraryProgress.test.ts',
  'apps/player/src/ui/story/PlayerStoryFlow.ts',
  'apps/player/src/application/godot/playerStoryHost.ts',
  'apps/player/src/infrastructure/storage/godot/playerNativeGameRuntime.ts',
];
export const gameDependencies = [
  'packages/domain/src/caseScoring.ts',
  'apps/player/src/application/story/playerStoryLibraryProgress.ts',
];
export const gameBaseline = [
  'test:vitest',
  '--project',
  'unit',
  '--maxWorkers=1',
  'apps/player/src/application/story/playerStoryLibraryProgress.test.ts',
];
export const gameValidation = ['validate:brief'];
export const neutralApproved =
  'export const total = values => values.reduce((sum, value) => sum + value, 0);\n';
export const neutralBefore = 'export const total = values => 0;\n';

export function injectGameDefect(source) {
  const accepted = 'caseResults: results.flatMap((result) => result.caseResults),';
  assert.equal(source.split(accepted).length, 2, 'game fixture no longer matches its pinned owner');
  return source.replace(accepted, 'caseResults: [],');
}
export function simulatedReadItems(ref, content) {
  assert.equal(digest(content), ref.sha256);
  if (content.length === 0)
    return [
      {
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: JSON.stringify({ ...ref, content }) + '\n',
      },
    ];
  const items = [];
  for (let offset = 0; offset < content.length; offset += 2000) {
    const line =
      JSON.stringify({
        ...ref,
        format: 'aw-native-read-parts/1',
        offset,
        length: content.length,
        content: content.slice(offset, offset + 2000),
      }) + '\n';
    assert.ok(Buffer.byteLength(line) <= 24000);
    items.push({
      type: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: line,
    });
  }
  return items;
}
export function validateCheckRequest(value, configuration) {
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'kind', 'sha256']);
  assert.ok(['baseline', 'validate'].includes(value.kind));
  assert.equal(typeof value.bytes, 'string');
  const bytes = Buffer.from(value.bytes, 'base64');
  assert.equal(bytes.toString('base64'), value.bytes);
  assert.equal(digest(bytes), value.sha256, 'candidate hash mismatch');
  assert.ok(
    (value.kind === 'baseline'
      ? [configuration.before, configuration.approved]
      : [configuration.approved]
    ).includes(value.sha256),
  );
  return bytes;
}
export function fullRunPlan() {
  return {
    schemaVersion: 2,
    kind: 'installed-full-consumers-plan',
    consumers: ['game', 'neutral'],
    offlineInstalls: 3,
    sdkExecutions: 2,
    models: 0,
    services: {
      temporal: 'two sequential temporary CLI v1.9.1 instances',
      checker: 'two sequential temporary Unix socket services with fixed process queries',
    },
    game: {
      sourceSnapshot:
        'required installed-game-source/1 manifest of exact Git working-tree files, including dirty files',
      runtimeArchive:
        'same pinned archive as both drivers; unchanged package version; existing locked dependency graph; no new resolutions',
      consumerCheck: ['agent-workflow:consumer:check'],
      owner: gameOwner,
      consumers: gameConsumers,
      dependencies: gameDependencies,
      baseline: gameBaseline,
      validate: gameValidation,
      executions: 2,
    },
    neutral: {
      owner: 'total.mjs',
      baseline: ['--test', 'baseline.test.mjs'],
      validate: ['--test', 'total.test.mjs'],
    },
    bounds: {
      gameValidateRuns: 2,
      commandTimeoutMs: 1200000,
      deadlineMinutes: 60,
      maxWorkers: 2,
      approximateMemoryGiB: '3–6',
    },
    recovery: [
      'new Worker and client read the same completed result',
      'replay every captured workflow history',
    ],
    pendingRecovery: 'not qualified by this completed-result recovery scenario',
    isolation:
      'runtime/driver/workers cannot read source checkouts or trusted checker copies; checker reads its own full game snapshot',
    qualification: false,
  };
}
