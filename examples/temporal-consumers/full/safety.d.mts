import type { ChildProcess } from 'node:child_process';

export interface OwnedProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  identity: string;
}
export interface OwnedProcessReceipt {
  stopped: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  pids: number[];
  identities: OwnedProcessIdentity[];
  groups: number[];
  retired: (OwnedProcessIdentity & { observation: number; atMs: number })[];
  retiredGroups: { pgid: number; observation: number; atMs: number }[];
  reason?: string | null;
  killed?: boolean;
  deadlineReached: boolean;
}
export function ownProcess(
  child: ChildProcess,
  options: {
    deadline: number;
    listenerPaths?: string[];
    now?: () => number;
    snapshot?: (timeout: number) => OwnedProcessIdentity[];
    listeners?: (pids: number[], paths: string[], timeout: number) => boolean;
    signal?: (pid: number, name: 'SIGTERM' | 'SIGKILL') => void;
    pause?: (milliseconds: number) => Promise<unknown>;
    stopMs?: number;
    /** Monotonic fallback boundary; defaults to deadline - stopMs. Does not move deadline. */
    automaticStopAt?: number;
    /** Positive safe integer; capped at half stopMs and remaining budget at first TERM. */
    termGraceMs?: number;
  },
): {
  child: ChildProcess;
  done: Promise<OwnedProcessReceipt>;
  stop(): Promise<OwnedProcessReceipt>;
};
export function verifyPinnedBinary(path: string, expected: string): Buffer;
export function copyPinnedBinary(path: string, expected: string, destination: string): string;
export function mayRemoveFullRun(report: {
  status: string;
  actualInstalls: number;
  consumers: { name: string; evidenceComplete: boolean }[];
  stops: { stopped: boolean }[];
  cleanupErrors: unknown[];
  listenerStopUnknown?: boolean;
}): boolean;
