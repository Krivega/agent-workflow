import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import type { CorrectionTaskInput } from '../../src/contracts/localTask.js';
import type { ReviewRequest } from '../../src/contracts/review.js';
export function correctionFixture(maxRounds: 1 | 2 = 1) {
  const f = substantialTaskFixture();
  writeFileSync(join(f.workspace, 'side.cjs'), 'module.exports = 7;\n');
  writeFileSync(
    join(f.workspace, 'side-check.cjs'),
    "require('node:assert/strict').equal(require('./side.cjs'),11);console.log('side PASS');\n",
  );
  writeFileSync(
    join(f.workspace, 'proposal.md'),
    'Proposal C1: trim surrounding whitespace in owner.cjs, retain ordinary names; side.cjs exports 11. No DEBUG_MARKER is allowed in either module. These modules are independent. Complete consumers: consumer.cjs, smoke.cjs, validate.cjs, side-check.cjs. Change only the two modules.\n',
  );
  writeFileSync(
    join(f.workspace, 'tasks/one.md'),
    '# Correction qualification\nGoal C1: implement the two independent modules; no DEBUG_MARKER may remain. Known consumers and explicit scopes are fixed by proposal.md.\n',
  );
  const ref = (locator: string) => ({
    locator,
    hash: digest(readFileSync(join(f.workspace, locator))),
  });
  f.registration.project.checks.push('side');
  Object.assign(f.registration.commands, {
    side: { executable: '/usr/bin/env', args: [process.execPath, 'side-check.cjs'] },
  });
  const proposal = {
    ...f.proposal,
    plan_id: 'C1',
    requirement: ref('tasks/one.md'),
    basis: [ref('accepted.md'), ref('proposal.md')],
    consumers: [...f.proposal.consumers, ref('side.cjs'), ref('side-check.cjs')],
    paths: ['owner.cjs', 'side.cjs'],
    checks: ['smoke', 'validate', 'side'],
    criterion: 'C1: owner trims names, side exports 11, neither has a DEBUG_MARKER',
  };
  const bytes = Buffer.from(JSON.stringify(proposal));
  writeFileSync(join(f.workspace, 'plan.json'), bytes);
  const request: ReviewRequest = {
    schemaVersion: 1,
    phase: 'acceptance',
    scope: 'C1',
    sharedPaths: ['plan.json', 'proposal.md', 'accepted.md'],
    roles: f.request.roles.map((role) => ({
      ...role,
      paths:
        role.roleId === 'reviewer'
          ? ['owner.cjs', 'consumer.cjs', 'smoke.cjs', 'validate.cjs']
          : ['side.cjs', 'side-check.cjs'],
    })),
  };
  const input: CorrectionTaskInput = {
    ...f.substantialInput,
    schemaVersion: 4,
    admission: {
      ...f.substantialInput.admission,
      plan: { path: 'plan.json', sha256: digest(bytes) },
      planning: f.save({ ...request, phase: 'planning' }),
      acceptance: f.save(request),
    },
    corrections: {
      maxRounds,
      checks: [
        { roleId: 'reviewer', commands: ['smoke', 'validate'] },
        { roleId: 'tester', commands: ['side'] },
      ],
    },
  };
  const fault = { repeat: false, inject: true };
  let writers = 0;
  const runtime = f.createRuntime;
  f.host.createRuntime = (root) => {
    const rpc = runtime(root),
      round = writers++;
    return {
      ...rpc,
      async request(method, params) {
        const response = await rpc.request(method, params);
        if (
          method === 'turn/start' &&
          (params.input as { text: string }[])[0]!.text.includes('Выполни локальный план')
        ) {
          if (round === 0) writeFileSync(join(root, 'side.cjs'), 'module.exports = 11;\n');
          if (fault.inject && (round === 0 || fault.repeat))
            appendFileSync(join(root, 'owner.cjs'), '// DEBUG_MARKER round ' + round + '\n');
        }
        return response;
      },
    };
  };
  const rpc = f.rpc.request;
  f.rpc.request = async (method, params) => {
    const message = method === 'turn/start' ? (params.input as { text: string }[])[0]!.text : '';
    const answer = message.includes('Markdown: '),
      front = message.includes('"roleId":"reviewer"'),
      acceptance = message.includes('"phase":"acceptance"');
    const before = f.state.verdict;
    f.state.verdict =
      answer &&
      front &&
      acceptance &&
      readFileSync(join(f.workspace, 'owner.cjs'), 'utf8').includes('DEBUG_MARKER')
        ? 'FAIL'
        : 'PASS';
    try {
      return await rpc(method, params);
    } finally {
      f.state.verdict = before;
    }
  };
  return {
    ...f,
    service: f.makeService(),
    correctionInput: input,
    correctionRequest: request,
    correctionPlan: proposal,
    fault,
  };
}
