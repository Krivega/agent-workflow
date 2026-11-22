import { describe, expect, it } from 'vitest';
import { confirmObservedLoad } from '../../src/adapters/codex/observedLoad.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';
import { serialInvocations } from '../../adapters/codex/chatCommandSettlement.js';

const ref = { path: '/rules', sha256: digest('hello') };
const full = { ...ref, content: 'hello' };
function command(entries: unknown[], overrides = {}) {
  return {
    type: 'commandExecution',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    ...overrides,
  };
}
function turn(items: unknown[]) {
  return { status: 'completed', items };
}
const first = { ...ref, format: 'aw-native-read-parts/1', offset: 0, length: 5, content: 'he' };
const second = { ...first, offset: 2, content: 'llo' };

describe('primary LOAD evidence', () => {
  it('preserves historical prompts and requires direct literal structured LOAD calls in v3', () => {
    expect(digest(readerLoadPrompt([ref], 1))).toBe(
      'eb87e37ef5715befb4b31e85b2a827d7226d6f22acd304379513e6cf1527fbe8',
    );
    expect(digest(readerLoadPrompt([ref], 2))).toBe(
      '2e3a51f6da9f5388e73d7c65c90b90c6c995bea7b76be21350380db646e210a3',
    );
    expect(digest(readerLoadPrompt([ref], 3))).toBe(
      '0e08ef09f75ce93b46bc47091a40db66b5275aa8f244f4b8e35c65bc203f4032',
    );
    expect(digest(readerLoadPrompt([ref], 4))).toBe(
      '6581d24ef9cf1892e1117a6c39ccffa572727d9cbae06231a24f87ecdd7323b9',
    );
    const prompt = readerLoadPrompt([ref], 3);
    expect(readerLoadPrompt([ref])).toBe(readerLoadPrompt([ref], 2));
    const literal =
      'text(await tools.exec_command({cmd:"буквальная команда чтения одной части",max_output_tokens:12000}));';
    expect(prompt).toContain(literal);
    expect(serialInvocations(literal)).toEqual([
      { command: 'буквальная команда чтения одной части' },
    ]);
    expect(prompt).toContain('output, exit_code и session_id');
    expect(prompt).toContain('eval, load, store');
    expect(prompt).toContain('text(r.output)');
    expect(serialInvocations('await eval("(async()=>{"+load("next")+"})()");')).toBeNull();
    expect(
      serialInvocations('const r=await tools.exec_command({cmd:"read"});text(r.output);'),
    ).toBeNull();
  });

  it('advertises fragment bounds that reconstruct a large escaped Unicode source', () => {
    const content = 'Я😀"\\\n'.repeat(4000),
      file = { path: '/large-evidence', sha256: digest(content) },
      prompt = readerLoadPrompt([file]),
      limit = Number(/не длиннее (\d+) кодовых единиц UTF-16/u.exec(prompt)![1]),
      items: ReturnType<typeof command>[] = [];
    expect(limit).toBeGreaterThan(0);
    expect(readerLoadPrompt([file], 1)).not.toContain('не длиннее');
    for (let offset = 0; offset < content.length;) {
      let fragment = content.slice(offset, offset + limit);
      const entry = () => ({
        ...file,
        format: 'aw-native-read-parts/1',
        offset,
        length: content.length,
        content: fragment,
      });
      while (Buffer.byteLength(JSON.stringify(entry()) + '\n') > 24000)
        fragment = fragment.slice(0, Math.floor(fragment.length / 2));
      items.push(command([entry()]));
      offset += fragment.length;
    }
    expect(items.length).toBeGreaterThan(1);
    expect(() => confirmObservedLoad(turn(items), [file])).not.toThrow();
    const oversized = {
      ...file,
      format: 'aw-native-read-parts/1',
      offset: 0,
      length: content.length,
      content: content.slice(0, 10000),
    };
    expect(() => confirmObservedLoad(turn([command([oversized])]), [file])).toThrow(
      'reader-load-invalid-fragment',
    );
  });
  it('accepts exact full text and contiguous observed fragments', () => {
    expect(() => confirmObservedLoad(turn([command([full])]), [ref])).not.toThrow();
    expect(() =>
      confirmObservedLoad(turn([command([first]), command([second])]), [ref]),
    ).not.toThrow();
    expect(() =>
      confirmObservedLoad(
        turn([command([first]), command([second], { aggregatedOutput: JSON.stringify(second) })]),
        [ref],
      ),
    ).not.toThrow();
  });
  it.each([{ status: 'inProgress', items: [] }, { status: 'completed' }])(
    'rejects incomplete turns',
    (value) => {
      expect(() => confirmObservedLoad(value, [ref])).toThrow('reader-load-not-completed');
    },
  );
  it('ignores unrelated, failed, malformed and incomplete observations', () => {
    const items = [
      { type: 'agentMessage' },
      command([full], { exitCode: 1 }),
      command([full], { aggregatedOutput: null }),
      command([full], { aggregatedOutput: 'not JSON\nnull\n{}\n' }),
      command([
        { path: '/rules', content: 1 },
        { path: 1, content: 'x' },
        { path: '/other', content: 'hello' },
      ]),
      command([{ ...full, sha256: digest('wrong') }]),
      command([first]),
    ];
    expect(() => confirmObservedLoad(turn(items), [ref])).toThrow('reader-load-unconfirmed');
  });
  it.each([
    { ...first, format: 'bad' },
    { ...first, length: 1.1 },
    { ...first, length: -1 },
    { ...first, offset: 1 },
    { ...first, offset: 0.1 },
    { ...first, length: '5' },
    { ...first, content: '' },
    { ...first, content: 'longer' },
    { ...first, sha256: digest('wrong') },
  ])('rejects invalid fragment bindings', (entry) => {
    expect(() => confirmObservedLoad(turn([command([entry])]), [ref])).toThrow(
      'reader-load-invalid-fragment',
    );
  });
  it('rejects changed lengths, duplicate completion, wrong content and mixed formats', () => {
    for (const items of [
      [command([first]), command([{ ...second, length: 6 }])],
      [command([first]), command([second]), command([first])],
      [command([{ ...first, content: 'wrong' }])],
      [command([first], { status: 'inProgress' })],
      [command([{ ...first, content: 'x'.repeat(24000) }])],
      [command([{ ...first, content: 'x'.repeat(8001), length: 9000 }])],
      [command([first], { aggregatedOutput: JSON.stringify(first) + ' '.repeat(24000) })],
    ])
      expect(() => confirmObservedLoad(turn(items), [ref])).toThrow('reader-load-invalid-fragment');
    expect(() => confirmObservedLoad(turn([command([first]), command([full])]), [ref])).toThrow(
      'reader-load-mixed-formats',
    );
  });
});
