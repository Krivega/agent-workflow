import { join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06DelegatedAuthority } from './comparisonH06DelegatedAuthority.js';
import { enforceH06LegacyBudget } from './comparisonH06NativeLegacyBudget.js';

export interface H06DelegatedUsageInput {
  claim: H04Pin;
  threads: [H04Pin, H04Pin, H04Pin];
}

type Budget = ReturnType<typeof enforceH06LegacyBudget>;
export interface H06DelegatedUsageResult extends Awaited<ReturnType<Budget['readUsage']>> {
  kind: 'h06-delegated-managed-usage/1';
  claim: H04Pin;
  threads: H06DelegatedUsageInput['threads'];
  caps: ReturnType<typeof readH06DelegatedAuthority>['request']['budget'];
  ledger: ReturnType<Budget['inspect']>;
  nativeSources: { session: string; transcript: string }[];
  qualification: false;
}

/** Final managed Writer accounting; native root and actor usage remain outside this inventory. */
export async function observeH06DelegatedUsage(
  input: H06DelegatedUsageInput,
): Promise<H06DelegatedUsageResult> {
  const claim = readH06DelegatedAuthority(input.claim);
  const budget = enforceH06LegacyBudget(claim, 'reopen', claim.grant.sessionsRoot, 'append-only');
  const ledger = budget.inspect();
  const snapshots = new Map<string, Record<string, unknown>>();
  let inventoryComplete = ledger.status === 'RECORDED' && ledger.used === 9;
  const labels = ['warm', 'cold', 'completion'];
  requireContract(input.threads.length === labels.length, 'h06-delegated-usage-inventory');
  for (const [index, pin] of input.threads.entries()) {
    requireContract(
      pin.path ===
        join(claim.request.evidenceRoot, `delegated-${labels[index]}-writer-thread.json`),
      'h06-delegated-usage-snapshot',
    );
    const response = object(JSON.parse(readH04Pin(pin).toString())),
      thread = object(response.thread);
    const id = identifier(thread.id);
    const rows = ledger.admissions.filter(({ scope }) => scope.session === id);
    requireContract(!snapshots.has(id) && rows.length > 0, 'h06-delegated-usage-session');
    const operation = rows[0]!.scope.operation;
    requireContract(typeof operation === 'string', 'h06-delegated-usage-operation');
    const match = /^coder:([a-zA-Z0-9_-]+):(?:profile|load|implementation)$/u.exec(operation);
    requireContract(match !== null, 'h06-delegated-usage-operation');
    const root = join(claim.request.evidenceRoot, 'coder-workspaces', match[1]!);
    const journal = join(claim.request.evidenceRoot, 'coders', match[1]!, 'transport.jsonl');
    requireContract(
      thread.cwd === root &&
        typeof thread.path === 'string' &&
        thread.path.startsWith(claim.grant.sessionsRoot + sep) &&
        rows.every(
          ({ scope }) =>
            scope.role === 'legacy-writer' && scope.root === root && scope.journal === journal,
        ),
      'h06-delegated-usage-scope',
    );
    requireContract(
      Array.isArray(thread.turns) && thread.turns.length === 3,
      'h06-delegated-usage-turns',
    );
    const turns = thread.turns.map((turn) => identifier(object(turn).id));
    const known = rows.flatMap(({ response }) => (response === null ? [] : [response.turnId]));
    requireContract(
      new Set(turns).size === 3 && known.every((turn) => turns.includes(turn)),
      'h06-delegated-usage-turns',
    );
    inventoryComplete =
      inventoryComplete &&
      same(
        rows.map(({ scope }) => scope.operation),
        ['profile', 'load', 'implementation'].map((stage) => `coder:${match[1]}:${stage}`),
      ) &&
      same(known, turns);
    snapshots.set(id, response);
  }
  requireContract(
    ledger.admissions.every(({ scope }) => snapshots.has(scope.session)),
    'h06-delegated-usage-inventory',
  );
  const usage = await budget.readUsage(ledger, (scope) => snapshots.get(scope.session));
  for (const pin of input.threads) readH04Pin(pin);
  readH06DelegatedAuthority(input.claim);
  requireContract(same(ledger, budget.inspect()), 'h06-delegated-usage-ledger-changed');
  const nativeSources = [...snapshots.values()].map((response) => {
    const thread = object(response.thread);
    return { session: identifier(thread.id), transcript: thread.path as string };
  });
  return {
    ...usage,
    status:
      usage.status === 'OVER_BUDGET' || inventoryComplete ? usage.status : ('UNKNOWN' as const),
    kind: 'h06-delegated-managed-usage/1' as const,
    claim: input.claim,
    threads: input.threads,
    caps: { ...claim.request.budget },
    ledger,
    nativeSources,
    qualification: false as const,
  };
}
