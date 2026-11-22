import type { AdrChangeValidationIssue } from './adrChangeValidation.js';

export interface AdrRepositoryReport {
  readonly issues: readonly AdrChangeValidationIssue[];
  readonly stdout: string;
  readonly stderr: string;
}

export function validateAdrRepository(
  root: string,
  args?: readonly string[],
  environment?: Readonly<Record<string, string | undefined>>,
): Promise<AdrRepositoryReport>;
