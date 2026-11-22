export interface ProjectManifestReader {
  read(root: string): Promise<unknown>;
}
