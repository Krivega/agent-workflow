import { confirmNativeRead } from '../adapters/codex/nativeRead.js';
import { contentHash } from '../adapters/project/projectFiles.js';
const content = 'Полный исходник 🦊 "\\\n'.repeat(2500);
const ref = { locator: 'large.md', hash: contentHash(content) };
const parts = (text = content) => {
  const result = [];
  for (let offset = 0; offset < text.length; offset += 5000)
    result.push({
      format: 'aw-native-read-parts/1',
      path: ref.locator,
      sha256: ref.hash,
      content: text.slice(offset, offset + 5000),
      offset,
      length: text.length,
    });
  return result;
};
const command = (rows: unknown[], status = 'completed') => ({
  type: 'commandExecution',
  status,
  exitCode: 0,
  aggregatedOutput: rows.map((row) => JSON.stringify(row)).join('\n'),
});
const turn = (rows: unknown[]) => ({ status: 'completed', items: rows });
it('confirms a large Unicode source across bounded commands and keeps old full/empty sources valid', () => {
  const rows = parts();
  expect(rows.every((row) => Buffer.byteLength(JSON.stringify(row) + '\n') <= 24000)).toBe(true);
  expect(() => confirmNativeRead(turn(rows.map((row) => command([row]))), [ref])).not.toThrow();
  expect(() =>
    confirmNativeRead(turn([command([{ path: ref.locator, sha256: ref.hash, content }])]), [ref]),
  ).not.toThrow();
  const empty = { locator: 'empty', hash: contentHash('') };
  expect(() =>
    confirmNativeRead(turn([command([{ path: empty.locator, sha256: empty.hash, content: '' }])]), [
      empty,
    ]),
  ).not.toThrow();
});
it('never confirms a missing final part or a truncated line', () => {
  const rows = parts();
  expect(() =>
    confirmNativeRead(turn(rows.slice(0, -1).map((row) => command([row]))), [ref]),
  ).toThrow('procedure-read-unconfirmed');
  expect(() =>
    confirmNativeRead(
      turn([
        {
          type: 'commandExecution',
          exitCode: 0,
          status: 'completed',
          aggregatedOutput: JSON.stringify(rows[0]).slice(0, -2),
        },
      ]),
      [ref],
    ),
  ).toThrow('procedure-read-unconfirmed');
});
it.each([
  'gap',
  'duplicate',
  'order',
  'negative',
  'fraction',
  'length',
  'hash',
  'format',
  'oversize',
  'empty',
  'overflow',
  'content',
  'status',
  'full-before',
  'full-after',
] as const)('refuses %s without giving a complete read', (kind) => {
  const rows = parts();
  const full = { path: ref.locator, sha256: ref.hash, content };
  let commands: unknown[];
  if (kind === 'gap') rows[1]!.offset++;
  if (kind === 'duplicate') rows.splice(1, 0, rows[0]!);
  if (kind === 'order') [rows[0], rows[1]] = [rows[1]!, rows[0]!];
  if (kind === 'negative') rows[0]!.offset = -1;
  if (kind === 'fraction') rows[0]!.offset = 0.5;
  if (kind === 'length') rows[1]!.length++;
  if (kind === 'hash') rows[1]!.sha256 = 'foreign';
  if (kind === 'format') rows[0]!.format = 'unknown';
  if (kind === 'oversize') rows[0]!.content = 'x'.repeat(8001);
  if (kind === 'empty') rows[0]!.content = '';
  if (kind === 'overflow') rows[0]!.length = 1;
  if (kind === 'content') rows.at(-1)!.content = rows.at(-1)!.content.replace(/./u, 'x');
  commands = rows.map((row) => command([row], kind === 'status' ? 'inProgress' : 'completed'));
  if (kind === 'full-before') commands.unshift(command([full]));
  if (kind === 'full-after') commands.splice(1, 0, command([full]));
  expect(() => confirmNativeRead(turn(commands), [ref])).toThrow();
});
it('ignores unrelated fragment rows and refuses non-integer or unknown total length', () => {
  const valid = { path: ref.locator, sha256: ref.hash, content };
  expect(() =>
    confirmNativeRead(turn([command([{ ...parts()[0], path: 'unrelated' }, valid])]), [ref]),
  ).not.toThrow();
  for (const length of [null, 'unknown', 1.5, -1]) {
    expect(() => confirmNativeRead(turn([command([{ ...parts()[0], length }])]), [ref])).toThrow(
      'procedure-read-fragment-invalid',
    );
  }
});

it('bounds escaped JSON bytes as well as code units before confirming a fragment', () => {
  const text = '\u0001'.repeat(5000);
  const expected = { locator: 'escaped', hash: contentHash(text) };
  const row = {
    format: 'aw-native-read-parts/1',
    path: expected.locator,
    sha256: expected.hash,
    content: text,
    offset: 0,
    length: text.length,
  };
  expect(() => confirmNativeRead(turn([command([row])]), [expected])).toThrow(
    'procedure-read-fragment-invalid',
  );
  expect(() =>
    confirmNativeRead(
      turn([
        command([{ ...row, content: text.slice(0, 2500) }]),
        command([{ ...row, content: text.slice(2500), offset: 2500 }]),
      ]),
      [expected],
    ),
  ).not.toThrow();
});

it('bounds the entire command containing parts while retaining legacy full output', () => {
  const text = 'x'.repeat(32000);
  const expected = { locator: ref.locator, hash: contentHash(text) };
  const rows = [0, 8000, 16000, 24000].map((offset) => ({
    format: 'aw-native-read-parts/1',
    path: expected.locator,
    sha256: expected.hash,
    content: text.slice(offset, offset + 8000),
    offset,
    length: text.length,
  }));
  expect(rows.every((row) => Buffer.byteLength(JSON.stringify(row) + '\n') <= 24000)).toBe(true);
  expect(() => confirmNativeRead(turn([command(rows)]), [expected])).toThrow(
    'procedure-read-fragment-invalid',
  );
  expect(() =>
    confirmNativeRead(turn(rows.map((row) => command([row]))), [expected]),
  ).not.toThrow();
  expect(() =>
    confirmNativeRead(
      turn(
        rows.map((row) => ({ ...command([row]), aggregatedOutput: JSON.stringify(row) + '\n' })),
      ),
      [expected],
    ),
  ).not.toThrow();
  expect(() =>
    confirmNativeRead(
      turn([command([{ path: expected.locator, sha256: expected.hash, content: text }])]),
      [expected],
    ),
  ).not.toThrow();
});
