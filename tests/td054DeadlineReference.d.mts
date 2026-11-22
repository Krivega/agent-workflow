export const td054ReferenceKind: string;
export const td054ReferenceSourceKind: string;
export const td054ReferenceClaimKind: string;
export function readTD054ReferenceBinding(value: unknown): Record<string, unknown>;
export function planTD054ReferenceApproval(
  binding: unknown,
  packet: unknown,
): Record<string, unknown>;
export function verifyTD054ReferenceConsent(
  plan: unknown,
  packet: unknown,
  rows: { record: Record<string, unknown>; ref: { locator: string; hash: string } }[],
): Record<string, unknown>;
export function inspectTD054Reference(
  binding: unknown,
  packet: unknown,
  historical?: unknown,
): Promise<{
  nativeGrant: Record<string, unknown>;
  serverGrant: Record<string, unknown>;
  referenceApproval: Record<string, unknown>;
}>;
export function admitTD054Reference(
  binding: unknown,
  packet: unknown,
): ReturnType<typeof inspectTD054Reference>;
export function parseTD054ReferenceClaim(value: unknown): Record<string, unknown>;
