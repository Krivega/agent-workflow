import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { AuditInput } from '../../contracts/audit.js';
import type { PreparationInput } from '../../contracts/preparation.js';
import type { LocalProjectRegistration } from '../../activities/preparation.js';
import { preparationInputs, checkRegisteredCommands } from '../project/preparation.js';
import { object, requireContract } from '../../contracts/project.js';
import { artifactStore, digest, readProjectFile } from '../artifacts/files.js';
import { checkRegistration } from '../../policy/preparation.js';
import { parseAuditCard } from '../../policy/audit.js';
import { controlRef } from '../../policy/readerControl.js';
import { auditParentProfile, checkAuditorProfile } from './nativeAudit.js';

export function auditorRole(p: PreparationInput) {
  const selected = p.project.roles.find((r) => r.id === 'auditor');
  requireContract(selected !== undefined, 'auditor-role-required');
  return selected;
}
export function auditLoadFiles(
  registration: LocalProjectRegistration,
  preparation: PreparationInput,
) {
  const store = artifactStore(registration.artifactRoot),
    selected = auditorRole(preparation);
  const bytes = readProjectFile(registration.workspaceRoot, selected.profile);
  checkAuditorProfile(bytes);
  const procedures = ['audit', 'evidence'].map((name) =>
    store.publish(readFileSync(new URL(`../../../procedures/${name}.md`, import.meta.url))),
  );
  const refs = [...new Set([...preparation.project.rules, selected.profile])]
    .map((path) => ({
      path: resolve(registration.workspaceRoot, path),
      sha256: digest(readProjectFile(registration.workspaceRoot, path)),
    }))
    .concat(procedures.map((ref) => ({ path: store.path(ref), sha256: ref.sha256 })));
  return { role: { path: selected.profile, content: store.publish(bytes) }, procedures, refs };
}
export function confirmAuditorInputs(registration: LocalProjectRegistration, input: AuditInput) {
  checkRegistration(input.preparation, registration);
  const store = artifactStore(registration.artifactRoot),
    read = (ref: AuditInput['card']) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const before = read(input.preflight);
  requireContract(
    before.kind === 'auditor-preflight' &&
      same(before.preparation, input.preparation) &&
      same(before.profile, auditParentProfile),
    'auditor-preflight-binding',
  );
  const actual = auditLoadFiles(registration, input.preparation);
  requireContract(
    same(before.refs, actual.refs) && same(before.procedures, actual.procedures),
    'auditor-input-changed',
  );
  requireContract(same(before.role, actual.role), 'auditor-profile-changed');
  const prepared = object(before.prepared);
  checkRegisteredCommands(registration, input.preparation.project.checks);
  requireContract(
    prepared.status === 'prepared' &&
      same(read(controlRef(prepared.manifest)), {
        schemaVersion: 1,
        kind: 'preparation',
        input: input.preparation,
        inputs: preparationInputs(registration.workspaceRoot, input.preparation),
      }),
    'auditor-preparation-changed',
  );
  const card = parseAuditCard(read(input.card));
  requireContract(same(card.preparation, input.preparation), 'auditor-card-binding');
  return { before, card, refs: actual.refs };
}
