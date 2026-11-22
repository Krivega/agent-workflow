import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { LocalProjectRegistration } from '../../src/contracts/preparation.js';
import type { ProjectDescriptor } from '../../src/contracts/project.js';
import type { ReaderInput } from '../../src/contracts/reader.js';
import type { AuditCard, AuditInput } from '../../src/contracts/audit.js';
import { controlFixture } from './controlFixture.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { auditorActivities } from '../../src/activities/audit.js';
import { auditorRuntime } from './auditorRuntime.mjs';
import { auditParentProfile } from '../../src/adapters/codex/nativeAudit.js';

export function auditFixture(
  base?: Pick<
    ReturnType<typeof controlFixture>,
    'root' | 'workspace' | 'response' | 'store' | 'proof' | 'save' | 'authority'
  > & {
    registration: LocalProjectRegistration & {
      project: ProjectDescriptor;
    };
    input: ReaderInput;
  },
) {
  const f = base ?? controlFixture(),
    profile = { ...auditParentProfile };
  const profilePath = join(f.workspace, 'auditor.toml');
  const profileBytes = Buffer.from(`name = "auditor"
description = "Independent native auditor for a neutral test project."
model = "gpt-6.2-sol"
model_reasoning_effort = "xhigh"
developer_instructions = "Technical LOAD first, then audit only the sole immutable card. Never edit, delegate, waive checks or grant acceptance."
[features]
apps = false
plugins = false
memories = false
request_permissions_tool = false
`);
  writeFileSync(profilePath, profileBytes);
  f.registration.project.roles.push({ id: 'auditor', profile: 'auditor.toml' });
  const p = f.input.preparation;
  const source = (path: string) => {
    const bytes = readFileSync(join(f.workspace, path));
    return { path, sha256: digest(bytes), bytes: bytes.length };
  };
  const card: AuditCard = {
    schemaVersion: 1,
    kind: 'audit-card',
    preparation: p,
    goal: source(p.card),
    criteria: ['Проверки и техническая приёмка сохранены'],
    completed: [f.proof],
    openFindings: [],
    checkpoint: 'planning-completed',
    timing: {
      stage: 'planning',
      estimateMs: 1000,
      elapsedMs: 2000,
      externalWaitMs: 0,
      knownElapsedMs: 2000,
    },
    trigger: { kind: 'overrun' },
    sources: [source(p.card), source('RULES.md')],
    nextAction: 'Перейти к реализации только после полного совета',
  };
  const read = (ref: { sha256: string; bytes: number }) =>
    JSON.parse(f.store.read(ref).toString()) as Record<string, unknown>;
  const runtime = auditorRuntime(f, profile);
  const { parent, child, records, writeRecords, native, state, turns } = runtime;
  const rpc = { request: vi.fn(runtime.rpc.request), completed: vi.fn(runtime.rpc.completed) };
  let input: AuditInput;
  const consume = vi.fn(),
    gate = readerBoundary(
      join(f.root, 'audit-permissions'),
      f.store,
      f.workspace,
      readerExecution(profile),
      () => {},
      consume,
    );
  const directory = join(f.root, 'audits');
  const make = () =>
    auditorActivities(f.registration, rpc, profile, gate, directory, consume, f.authority);
  const service = make();
  const setup = async (pinned?: AuditInput) => {
    input = pinned ?? {
      schemaVersion: 1,
      preparation: p,
      auditId: 'planning',
      card: f.save(card),
      preflight: await service.activities.preflightAuditor(p),
    };
    runtime.bind(input);
    const permit = await service.activities.registerAuditor(input),
      epoch = { permit, revision: 0, attempt: 0 };
    return { input, permit, epoch };
  };
  return {
    ...f,
    profile,
    profilePath,
    card,
    read,
    parent,
    child,
    records,
    native,
    state,
    rpc,
    consume,
    gate,
    directory,
    service,
    make,
    setup,
    writeRecords,
    turns,
  };
}
