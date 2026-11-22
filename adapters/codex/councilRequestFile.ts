import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import { chatArtifactContent, encodeProofArtifact } from '../storage/sharedArtifacts.js';
import type { CouncilReviewRequest } from '../../core/council.js';
import type { InputRef } from '../../core/localRun.js';
import { contentHash, projectText } from '../project/projectFiles.js';

export function councilRequestFile(directory: string, request: CouncilReviewRequest) {
  const content = chatArtifactContent(request);
  const hash = contentHash(content);
  return { content, ref: { locator: resolve(directory, `request-${hash}.json`), hash } };
}

export function councilRoleView(request: CouncilReviewRequest, ref: InputRef) {
  const { target } = request;
  return {
    ...request,
    request_file: ref,
    target: {
      ...target,
      inputs: { request_file: ref, field: 'target.inputs', count: target.inputs.inputs.length },
      ...(target.evidence_inputs === undefined
        ? {}
        : {
            evidence_inputs: {
              request_file: ref,
              field: 'target.evidence_inputs',
              count: target.evidence_inputs.inputs.length,
            },
          }),
    },
  };
}

export async function saveCouncilRequestFile(directory: string, request: CouncilReviewRequest) {
  const { content, ref } = councilRequestFile(directory, request);
  try {
    requireWorkflow(
      encodeProofArtifact(directory, request) === content,
      'council-request-file-conflict',
    );
    await writeFile(ref.locator, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    requireWorkflow(
      (error as { code?: string }).code === 'EEXIST' &&
        (await projectText(directory, relative(directory, ref.locator))) === content,
      'council-request-file-conflict',
    );
  }
  for (const [suffix, value] of [
    ['.ref.json', ref],
    ['.role.ref.json', { ...ref, view: 'council-role' }],
  ] as const) {
    const reader = ref.locator + suffix;
    const reference = JSON.stringify(value);
    try {
      await writeFile(reader, reference, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      requireWorkflow(
        (error as { code?: string }).code === 'EEXIST' &&
          (await projectText(directory, relative(directory, reader))) === reference,
        'council-request-file-conflict',
      );
    }
  }
  return ref;
}
