import { requireWorkflow, textField } from './connection.js';
import type { Procedure } from './connection.js';
import { sameValue } from './equality.js';

export interface NormativeRule {
  id: string;
  content: string;
}
export function normativeRules(procedure: Procedure, content: string): NormativeRule[] {
  requireWorkflow(
    procedure.fragments !== undefined && procedure.fragments.length > 0,
    'compact-rule-catalog-missing',
  );
  const rules: NormativeRule[] = [];
  let pending: { id: string; start: number } | null = null;
  const markers = /<!-- aw-rule ([a-z0-9.-]+) -->|<!-- \/aw-rule -->/gu;
  for (const match of content.matchAll(markers)) {
    if (match[1] !== undefined) {
      requireWorkflow(pending === null, 'compact-rule-nested');
      pending = { id: match[1], start: match.index + match[0].length };
    } else {
      requireWorkflow(pending !== null, 'compact-rule-unopened');
      rules.push({
        id: pending.id,
        content: textField(content.slice(pending.start, match.index).trim()),
      });
      pending = null;
    }
  }
  requireWorkflow(pending === null, 'compact-rule-unclosed');
  requireWorkflow(
    sameValue(
      rules.map((rule) => rule.id),
      procedure.fragments,
    ) && new Set(procedure.fragments).size === procedure.fragments.length,
    'compact-rule-catalog-mismatch',
  );
  return rules;
}
