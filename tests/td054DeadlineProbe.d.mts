export const td054ProposedBounds: Readonly<Record<string, number>>;
export function prepareTD054DeadlineProbe(
  operationId: string,
  reference: unknown,
  bounds?: unknown,
  parent?: string,
): Record<string, unknown>;
export function checkTD054DeadlineProbe(packet: unknown): Record<string, unknown>;
export function planTD054DeadlineProbe(packet: unknown): Record<string, unknown>;
export function runTD054DeadlineProbe(
  packet: unknown,
  source: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>>;
export function readTD054Claim(receipt: unknown): Promise<Record<string, unknown>>;
export function readTD054SavedClaim(receipt: unknown): Promise<Record<string, unknown>>;
export function remainingTD054(deadline: number): number;
export function observeTD054Processes(
  identities: { pid: number; parent: number; started: string }[],
  deadline: number,
): { pid: number; parent: number; started: string }[];
export function checkTD054LiveResult(input: unknown): Promise<Record<string, unknown>>;
export function td054DeadlineProbeMain(args: string[]): Promise<Record<string, unknown>>;
export function prepareTD054Reference(binding: unknown): Promise<Record<string, unknown>>;
export function checkTD054Reference(reference: unknown): Promise<Record<string, unknown>>;
export function td054ReferenceSource(reference: unknown): Record<string, unknown>;
