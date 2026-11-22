export interface ProcessIdentity {
  pid: number;
  parent: number;
  started: string;
}
export interface WriterProcesses {
  descendants(roots: number[]): Promise<ProcessIdentity[]>;
  alive(identities: ProcessIdentity[]): Promise<ProcessIdentity[]>;
  // Quiesce the owned tree before killing it; include descendants born during observation.
  // Missing/reused identities or an unconfirmed stop must fail without a stop receipt.
  terminate(identities: ProcessIdentity[]): Promise<ProcessIdentity[]>;
  wait(milliseconds: number): Promise<void>;
}
