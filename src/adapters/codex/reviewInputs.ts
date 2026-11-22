import { resolve } from 'node:path';
import type { PreparationResult } from '../../contracts/preparation.js';
import type { ScopedReaderInput } from '../../contracts/reader.js';
import { object, requireContract } from '../../contracts/project.js';
import { parseReviewSnapshot } from '../../policy/review.js';
import { checkRegistration } from '../../policy/preparation.js';
import { artifactStore, digest, readProjectFile } from '../artifacts/files.js';
import type { LocalProjectRegistration } from '../../activities/preparation.js';

export function scopedReviewInputs(
  registration: LocalProjectRegistration,
  input: ScopedReaderInput,
) {
  checkRegistration(input.preparation, registration);
  const store = artifactStore(registration.artifactRoot);
  const snapshot = parseReviewSnapshot(
    JSON.parse(store.read(input.review).toString('utf8')) as unknown,
    input,
  );
  const profile = input.preparation.project.roles.find((r) => r.id === input.roleId)!;
  const expected = [
    ...new Set([
      ...input.preparation.project.rules,
      profile.profile,
      input.preparation.card,
      ...snapshot.sharedPaths,
      ...snapshot.selection.paths,
    ]),
  ];
  requireContract(
    expected.every((p) => snapshot.files.some((f) => f.path === p)),
    'review-required-input-missing',
  );
  const refs = snapshot.files.map((file) => {
    const bytes = readProjectFile(registration.workspaceRoot, file.path);
    requireContract(
      digest(bytes) === file.sha256 && bytes.length === file.bytes,
      'review-input-changed',
    );
    return { path: resolve(registration.workspaceRoot, file.path), sha256: file.sha256 };
  });
  if (snapshot.schemaVersion !== 1)
    for (const ref of snapshot.evidence) refs.push({ path: store.path(ref), sha256: ref.sha256 });
  return { snapshot, refs };
}
export function prepareScopedReview(
  registration: LocalProjectRegistration,
  input: ScopedReaderInput,
): PreparationResult {
  const { snapshot } = scopedReviewInputs(registration, input),
    store = artifactStore(registration.artifactRoot);
  checkReviewCommands(registration, input);
  return {
    status: 'prepared',
    manifest: store.publish(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          kind: 'reader-preparation',
          input,
          inputs: snapshot.files,
        }),
      ),
    ),
  };
}
export function checkReviewCommands(
  registration: LocalProjectRegistration,
  input: { preparation: ScopedReaderInput['preparation'] },
) {
  for (const id of input.preparation.project.checks) {
    const command = registration.commands[id];
    requireContract(
      Object.hasOwn(registration.commands, id) &&
        command !== undefined &&
        command.executable.length > 0 &&
        Array.isArray(command.args),
      'review-check-unregistered',
    );
  }
}
export function confirmScopedPreparation(
  registration: LocalProjectRegistration,
  input: ScopedReaderInput,
  prepared: PreparationResult,
) {
  const result = scopedReviewInputs(registration, input),
    store = artifactStore(registration.artifactRoot);
  const manifest = object(JSON.parse(store.read(prepared.manifest).toString('utf8')) as unknown);
  requireContract(
    manifest.schemaVersion === 2 &&
      manifest.kind === 'reader-preparation' &&
      JSON.stringify(manifest.input) === JSON.stringify(input) &&
      JSON.stringify(manifest.inputs) === JSON.stringify(result.snapshot.files),
    'review-preparation-mismatch',
  );
  return result;
}
