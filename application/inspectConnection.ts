import type { ProjectConnectionReader } from '../ports/projectConnection.js';

export async function inspectConnection(
  root: string,
  locator: string,
  reader: ProjectConnectionReader,
) {
  const loaded = await reader.load(root, locator);
  return {
    scope: 'connection-only' as const,
    project_id: loaded.descriptor.project_id,
    revision: loaded.revision,
    commands: loaded.descriptor.commands,
    procedures: loaded.procedures.map(({ content: _content, ...procedure }) => procedure),
  };
}
