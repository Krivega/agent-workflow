import type { Connection, Procedure } from '../core/connection.js';

export interface LoadedConnection {
  descriptor: Connection;
  revision: string;
  rules: { locator: string; hash: string; content: string }[];
  procedures: (Procedure & { content: string })[];
}
export interface ProjectConnectionReader {
  load(root: string, locator: string): Promise<LoadedConnection>;
}
