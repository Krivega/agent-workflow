// Storage facts are immutable; mutable working containers remain independent.
export function copyState<T>(value: T): T {
  const frozen = new WeakSet<object>();
  const freeze = (value: object): object => {
    if (!frozen.has(value)) {
      frozen.add(value);
      for (const child of Object.values(value as Record<string, unknown>))
        if (child !== null && typeof child === 'object') freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Object.isFrozen(value)) return freeze(value);
    return Array.isArray(value)
      ? value.map(copy)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
  };
  return copy(value) as T;
}

// JSON storage may reorder object keys; order in an array remains significant.
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

// Stable event identity survives canonical storage and a new process's object-key order.
export function stableJson(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === 'object') {
      const object = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, sorted(object[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sorted(value));
}
