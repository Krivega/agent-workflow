export function requireWorkflow(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export function object(value: unknown): Record<string, unknown> {
  requireWorkflow(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'invalid-object',
  );
  return value as Record<string, unknown>;
}
export function textField(value: unknown): string {
  requireWorkflow(typeof value === 'string' && value.trim().length > 0, 'missing-text');
  return value;
}
export function localLocator(value: unknown): string {
  const text = textField(value);
  requireWorkflow(
    !/[\\:#?%\s]/u.test(text) &&
      !text.startsWith('/') &&
      text.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'unsafe-locator',
  );
  return text;
}
