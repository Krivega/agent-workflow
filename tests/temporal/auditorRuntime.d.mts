import type { AuditInput } from '../../src/contracts/audit.js';
import type { CodexRpc } from '../../src/contracts/codex.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';

export function auditorRuntime(
  fixture: {
    root: string;
    workspace: string;
    response: Record<string, unknown> & { thread: Record<string, unknown> };
    store: { read(ref: ArtifactRef): Buffer };
  },
  profile: { model: string; effort: string; clientVersion: string },
): {
  parent: Record<string, unknown>;
  child: Record<string, unknown>;
  records: Record<string, Record<string, unknown>[]>;
  writeRecords(): void;
  native: {
    cwd: string;
    model: string;
    reasoningEffort: string;
    approvalPolicy: string;
    sandbox: { type: string; networkAccess: boolean };
    thread: Record<string, unknown>;
  };
  state: {
    loadPending: boolean;
    answerPending: boolean;
    direction: string | null;
    coverage: string;
    starts: number;
  };
  rpc: CodexRpc;
  turns(thread: Record<string, unknown>): Record<string, unknown>[];
  bind(input: AuditInput): void;
};
