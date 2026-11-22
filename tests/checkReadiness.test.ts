import { resolve } from 'node:path';
import { checkReadiness } from '../adapters/project/checkReadiness.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { localFixture } from './localFixtures.js';
import { runChatCheck } from '../adapters/project/chatChecks.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  await f.dispose();
});
it('requires a current successful receipt and its exact log in the acceptance package', async () => {
  await f.file('plan.md', '# Plan\n## Критерии\n- [ ] C1: сценарий\n');
  const check = {
    id: 'C1',
    command: { file: process.execPath, args: ['-e', 'console.log("proof")'] },
    discovery: { files: ['plan.md', 'source.txt'], directories: [] },
    attested_by: 'owner',
  };
  await runChatCheck(f.root, f.root, check);
  const inputs = new FileWorkflowInputs(f.root, f.root);
  const receipt = await inputs.ref(resolve(f.root, 'C1.json'));
  const log = await inputs.ref(resolve(f.root, 'C1.log'));
  const plan = {
    criterion: 'C1',
    implementation: ['source.txt'],
    verification: ['plan.md'],
    check: { ...check, reuse: receipt },
  };
  const target = await inputs.capture({ files: [receipt.locator], directories: [] }, 'owner');
  expect(await checkReadiness(f.root, f.root, 'plan.md', [plan], target)).toMatchObject({
    ready: false,
    checks: [
      { criterion: 'C1', status: 'missing-evidence', missing: [log] },
      { criterion: 'validate', status: 'missing' },
    ],
  });
  const complete = await inputs.capture(
    { files: [receipt.locator, log.locator], directories: [] },
    'owner',
  );
  expect(await checkReadiness(f.root, f.root, 'plan.md', [plan], complete)).toMatchObject({
    checks: [
      { criterion: 'C1', status: 'covered' },
      { criterion: 'validate', status: 'missing' },
    ],
  });
  expect(
    await checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, check }], complete),
  ).toMatchObject({ checks: [{ status: 'missing-evidence' }, { status: 'missing' }] });
  await f.file('source.txt', 'changed');
  expect(await checkReadiness(f.root, f.root, 'plan.md', [plan], complete)).toMatchObject({
    checks: [{ status: 'missing-evidence' }, { status: 'missing' }],
  });
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [plan], { ...complete, complete: false }),
  ).rejects.toThrow('readiness-acceptance-inputs-changed');
  await f.file('C1.log', 'changed');
  await expect(checkReadiness(f.root, f.root, 'plan.md', [plan], complete)).rejects.toThrow(
    'readiness-acceptance-inputs-changed',
  );
});
it('reports missing requirements before any expensive command and checks complete dependency maps', async () => {
  await f.file('plan.md', '# Plan\n## Критерии\n- [ ] C1: сценарий\n  и восстановление\n');
  const plan = {
    criterion: 'C1',
    implementation: ['source.txt'],
    verification: ['plan.md'],
    check: {
      id: 'first',
      criterion: 'C1',
      command: { file: process.execPath, args: ['-e', 'throw new Error("must not run")'] },
      discovery: { files: ['source.txt', 'plan.md'], directories: [] },
      attested_by: 'owner',
    },
  };
  expect(await checkReadiness(f.root, f.root, 'plan.md', [])).toMatchObject({
    ready: false,
    checks: [
      { criterion: 'C1', status: 'missing' },
      { criterion: 'validate', status: 'missing' },
    ],
  });
  const validation = {
    ...plan,
    criterion: 'validate',
    check: {
      ...plan.check,
      id: 'validate',
      criterion: 'validate',
      command: { file: 'yarn', args: ['validate:brief'] },
    },
  };
  expect(await checkReadiness(f.root, f.root, 'plan.md', [plan, validation])).toMatchObject({
    ready: true,
  });
  await expect(checkReadiness(f.root, f.root, 'plan.md', [plan, plan])).rejects.toThrow(
    'readiness-unknown-or-duplicate-plan',
  );
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, criterion: 'unknown' }]),
  ).rejects.toThrow();
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, implementation: [] }]),
  ).rejects.toThrow('readiness-map-incomplete');
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, verification: [] }]),
  ).rejects.toThrow();
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [
      { ...plan, check: { ...plan.check, criterion: 'other' } },
    ]),
  ).rejects.toThrow();
  await expect(
    checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, verification: ['absent'] }]),
  ).rejects.toThrow('readiness-dependencies-missing');
  await f.file(
    'input.json',
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      evidence_root: f.root,
      card: 'plan.md',
      checks: [plan, validation],
    }),
  );
  expect(
    await runChatCommand(
      ['preflight-chat', resolve(f.root, 'input.json')],
      () => {},
      () => {},
    ),
  ).toBe(0);
  await f.file('plan.md', '## Критерии\n- [ ] C1');
  const check = {
    command: plan.check.command,
    discovery: plan.check.discovery,
    attested_by: plan.check.attested_by,
  };
  expect(
    await checkReadiness(f.root, f.root, 'plan.md', [{ ...plan, check: { ...check, id: 'C1' } }]),
  ).toMatchObject({
    checks: [
      { criterion: 'C1', status: 'covered' },
      { criterion: 'validate', status: 'missing' },
    ],
  });
  await f.file('plan.md', '# Plan');
  await expect(checkReadiness(f.root, f.root, 'plan.md', [])).rejects.toThrow(
    'readiness-criteria-missing',
  );
  await f.file('plan.md', '## Критерии\n- [ ] C: first\n- [ ] C: second');
  await expect(checkReadiness(f.root, f.root, 'plan.md', [])).rejects.toThrow(
    'readiness-duplicate-criterion',
  );
});
