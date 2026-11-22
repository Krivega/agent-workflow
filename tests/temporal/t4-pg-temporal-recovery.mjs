import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import {
  parseConfig,
  preflight,
  selfTest,
  stage,
  temporaryServicePlan,
  freshServicePlan,
  temporalAcquisition,
} from './t4-pg-temporal-plan.mjs';
export * from './t4-pg-temporal-plan.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    selfTest();
    const { fakeExecSelfTest, resumePendingSelfTest } = await import('./t4-pg-temporal-runner.mjs');
    await fakeExecSelfTest();
    await resumePendingSelfTest();
    const { safetySelfTest } = await import('./t4-pg-temporal-safety.mjs');
    await safetySelfTest();
    await import('./t4-pg-temporal-retention.test.mjs');
  } else if (process.argv.length === 6 && process.argv[2] === '--extract-archive') {
    const config = parseConfig(JSON.parse(readFileSync(process.argv[3], 'utf8')));
    assert.ok(
      typeof config.authorization.evidence === 'string' &&
        config.authorization.evidence.length > 20 &&
        !config.authorization.evidence.includes('REPLACE'),
      'new direct acquisition authorization required',
    );
    const { extractPinnedTemporalArchive } = await import('./t4-pg-temporal-binaries.mjs');
    console.log(
      JSON.stringify(
        extractPinnedTemporalArchive(process.argv[4], process.argv[5], temporalAcquisition.sha256),
      ),
    );
  } else if (process.argv.length === 4 && process.argv[2] === '--observe-installed-pins') {
    const config = parseConfig(JSON.parse(readFileSync(process.argv[3], 'utf8'))),
      { observeExecutablePins, postgresTools, observerTools } =
        await import('./t4-pg-temporal-binaries.mjs');
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        observationOnly: true,
        executablePins: observeExecutablePins(
          postgresTools
            .map((name) => config.executables.postgresDirectory + '/' + name)
            .concat(observerTools),
        ),
      }),
    );
  } else if (process.argv.length === 4 && process.argv[2] === '--preflight')
    console.log(JSON.stringify(await preflight(JSON.parse(readFileSync(process.argv[3], 'utf8')))));
  else if (process.argv.length === 5 && process.argv[2] === '--stage')
    console.log(
      JSON.stringify(
        await stage(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.argv[4]),
      ),
    );
  else if (process.argv.length === 5 && process.argv[2] === '--show-restore-plan') {
    const { savedRecoveryServicePlan } = await import('./t4-pg-temporal-restore-plan.mjs');
    console.log(
      JSON.stringify(
        await savedRecoveryServicePlan(
          JSON.parse(readFileSync(process.argv[3], 'utf8')),
          process.argv[4],
        ),
      ),
    );
  } else if (process.argv.length === 5 && process.argv[2] === '--show-fresh-plan')
    console.log(
      JSON.stringify(
        await freshServicePlan(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.argv[4]),
      ),
    );
  else if (process.argv.length === 6 && process.argv[2] === '--show-plan')
    console.log(
      JSON.stringify(
        temporaryServicePlan(
          JSON.parse(readFileSync(process.argv[3], 'utf8')),
          process.argv[4],
          process.argv[5],
        ),
      ),
    );
  else if (process.argv.length === 4 && process.argv[2] === '--run') {
    const { runPgTemporal } = await import('./t4-pg-temporal-runner.mjs');
    await runPgTemporal(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  } else {
    console.error(
      'Usage: t4-pg-temporal-recovery.mjs --self-test | --observe-installed-pins CONFIG.json | --extract-archive CONFIG.json PINNED_ARCHIVE NEW_DESTINATION | --preflight CONFIG.json | --show-plan CONFIG.json PROPOSED_ROOT TOOLS_ROOT | --show-fresh-plan CONFIG.json PROPOSED_ROOT | --show-restore-plan CONFIG.json NEW_ROOT | --stage CONFIG.json NEW_DESTINATION | --run CONFIG.json (NEW direct service authorization required)',
    );
    process.exitCode = 2;
  }
}
