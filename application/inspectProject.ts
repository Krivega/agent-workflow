import { inspectProjectManifest } from '../core/projectInspection.js';
import type { ProjectInspection } from '../core/projectInspection.js';
import type { ProjectManifestReader } from '../ports/projectManifestReader.js';

export async function inspectProject(
  root: string,
  reader: ProjectManifestReader,
): Promise<ProjectInspection> {
  return inspectProjectManifest(await reader.read(root));
}
