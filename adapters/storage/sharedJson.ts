import { requireStore } from '../../core/evidence.js';
import { parseStored } from './storeFiles.js';
import { stableJson } from '../../core/equality.js';

const prefix = 'AWJSON1\n';
export const retainedPrefix = 'AWRETAIN1\n';
const threshold = 4096;
type Node =
  | ['value', unknown]
  | ['string', Node]
  | ['array', Node[]]
  | ['object', [string, Node][]]
  | ['ref', string];

function isInputRefList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) =>
        item !== null &&
        typeof item === 'object' &&
        Object.keys(item).length === 2 &&
        typeof (item as Record<string, unknown>).locator === 'string' &&
        typeof (item as Record<string, unknown>).hash === 'string',
    )
  );
}

// References exist only inside a versioned envelope; user strings and objects stay literal.
export function encodeSharedJson(
  value: unknown,
  publish: (content: string) => string,
  inputLists = false,
): string {
  const strings = new Map<string, Node>();
  const objects = new WeakMap<object, { node: Node; length: number }>();
  const encode = (value: unknown): { node: Node; length: number } => {
    if (value !== null && typeof value === 'object') {
      const previous = objects.get(value);
      if (previous !== undefined) return previous;
      const result = encodeValue(value);
      objects.set(value, result);
      return result;
    }
    return encodeValue(value);
  };
  const encodeValue = (value: unknown): { node: Node; length: number } => {
    const external = inputLists && isInputRefList(value);
    let node: Node;
    let length: number;
    if (typeof value === 'string') {
      if (value.length < threshold) {
        length = stableJson(value).length;
        if (length < threshold) return { node: ['value', value], length };
      }
      const previous = strings.get(value);
      if (previous !== undefined) return { node: previous, length: threshold };
      length = threshold;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      node =
        parsed !== undefined && stableJson(parsed) === value
          ? ['string', encode(parsed).node]
          : ['value', value];
    } else if (Array.isArray(value)) {
      const items = value.map(encode);
      length = 2 + Math.max(0, items.length - 1) + items.reduce((n, item) => n + item.length, 0);
      node = ['array', items.map((item) => item.node)];
    } else if (value !== null && typeof value === 'object') {
      length = 2;
      const entries = Object.keys(value)
        .sort()
        .map((key): [string, Node] => {
          const item = encode((value as Record<string, unknown>)[key]);
          length += stableJson(key).length + 1 + item.length;
          return [key, item.node];
        });
      length += Math.max(0, entries.length - 1);
      node = ['object', entries];
    } else {
      requireStore(typeof value !== 'number' || Number.isFinite(value), 'invalid-context');
      const text = JSON.stringify(value);
      requireStore(text !== undefined, 'invalid-context');
      return { node: ['value', value], length: text.length };
    }
    if (length < threshold && !external) return { node: ['value', value], length };
    const content = stableJson(node);
    const result: Node = content.length < threshold && !external ? node : ['ref', publish(content)];
    if (typeof value === 'string') strings.set(value, result);
    return { node: result, length: external ? threshold : Math.min(length, threshold) };
  };
  return prefix + stableJson(encode(value).node);
}

export function decodeSharedJson(
  text: string,
  read: (hash: string) => string,
  immutableFacts = false,
): unknown {
  if (!text.startsWith(prefix)) return parseStored(text);
  const nodes = new Map<string, Node>();
  const facts = new Map<string, unknown>();
  const freeze = (value: unknown): unknown => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const fact = (value: unknown): boolean => {
    if (Array.isArray(value)) return isInputRefList(value);
    if (value === null || typeof value !== 'object') return false;
    const data = value as Record<string, unknown>;
    return (
      ('complete' in data &&
        'attested_by' in data &&
        'discovery_rule' in data &&
        Array.isArray(data.inputs)) ||
      ('scope' in data && 'base' in data && 'diff' in data && 'inputs' in data) ||
      (data.schema_version === 1 &&
        'session_id' in data &&
        'assignment' in data &&
        'target' in data &&
        'reads' in data)
    );
  };
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  };
  const decode = (node: Node): unknown => {
    requireStore(Array.isArray(node) && node.length === 2, 'corrupt');
    switch (node[0]) {
      case 'value':
        return copy(node[1]);
      case 'ref': {
        if (facts.has(node[1])) return facts.get(node[1]);
        let stored = nodes.get(node[1]);
        if (stored === undefined) {
          stored = parseStored<Node>(read(node[1]));
          nodes.set(node[1], stored);
        }
        const value = decode(stored);
        if (immutableFacts && fact(value)) facts.set(node[1], freeze(value));
        return value;
      }
      case 'string':
        return stableJson(decode(node[1]));
      case 'array':
        return node[1].map(decode);
      case 'object':
        return Object.fromEntries(node[1].map(([key, value]) => [key, decode(value)]));
      default:
        throw new Error('unsupported-shared-json');
    }
  };
  return decode(parseStored<Node>(text.slice(prefix.length)));
}
