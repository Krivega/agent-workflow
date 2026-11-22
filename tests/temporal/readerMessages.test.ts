import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { serialInvocations } from '../../adapters/codex/chatCommandSettlement.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { confirmObservedLoad } from '../../src/adapters/codex/observedLoad.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(content: string, name = 'source') {
  const root = mkdtempSync(join(tmpdir(), 'reader-load-command-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, content);
  return { root, ref: { path, sha256: digest(content) } };
}
function commands(refs: { path: string; sha256: string }[]) {
  const expressions = readerLoadPrompt(refs, 4)
    .split('\n')
    .filter((line) => line.startsWith('text(await tools.exec_command('));
  expect(expressions).toHaveLength(refs.length);
  return expressions.map((expression) => {
    const invocations = serialInvocations(expression);
    expect(invocations).toHaveLength(1);
    const invocation = invocations![0]!;
    if (!('command' in invocation)) throw new Error('expected exec_command');
    return invocation.command;
  });
}
function execute(command: string, root: string) {
  return spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
}

it.each([
  'x'.repeat(20001),
  'Я😀"\\\n\r\t\0'.repeat(2200),
  'x'.repeat(7999) + '😀tail',
  '',
  'hello',
])(
  'executes the supplied literal commands with bounded, contiguous, hash-verified LOAD output',
  (content) => {
    const { root, ref } = fixture(content, 'source\'"$(touch injected)`touch injected2`\n');
    const [initial] = commands([ref]);
    const items: Record<string, unknown>[] = [];
    let offset = 0;
    let combined = '';
    do {
      const command = initial!.replace(/ 0$/u, ` ${offset}`);
      const expression = `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:12000}));`;
      expect(serialInvocations(expression)).toEqual([{ command }]);
      const result = execute(command, root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10000);
      expect(result.stdout.split('\n')).toHaveLength(2);
      const entry = JSON.parse(result.stdout) as {
        path: string;
        sha256: string;
        format?: string;
        offset?: number;
        length?: number;
        content: string;
      };
      expect(entry.path).toBe(ref.path);
      expect(entry.sha256).toBe(ref.sha256);
      expect(entry.content.length).toBeLessThanOrEqual(8000);
      if (content.length === 0) expect(entry).toEqual({ ...ref, content: '' });
      else {
        expect(entry.format).toBe('aw-native-read-parts/1');
        expect(entry.offset).toBe(offset);
        expect(entry.length).toBe(content.length);
        expect(entry.content.length).toBeGreaterThan(0);
      }
      combined += entry.content;
      offset += entry.content.length;
      items.push({
        type: 'commandExecution',
        status: 'completed',
        exitCode: result.status,
        aggregatedOutput: result.stdout,
      });
    } while (offset < content.length);
    expect(combined).toBe(content);
    expect(() => confirmObservedLoad({ status: 'completed', items }, [ref])).not.toThrow();
    expect(existsSync(join(root, 'injected'))).toBe(false);
    expect(existsSync(join(root, 'injected2'))).toBe(false);
  },
);

it('supplies a separate first command for each ref, rejects a changed hash and invalid offsets without LOAD output', () => {
  const first = fixture('first');
  const second = fixture('second');
  const [one, two] = commands([first.ref, second.ref]);
  expect(execute(one!, first.root).status).toBe(0);
  expect(execute(two!, second.root).status).toBe(0);
  for (const offset of ['-1', '1.5', '5', 'NaN']) {
    const result = execute(one!.replace(/ 0$/u, ` ${offset}`), first.root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('offset');
  }
  const [wrongHash] = commands([{ ...first.ref, sha256: "'$(touch injected)" }]);
  const result = execute(wrongHash!, first.root);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('hash');
  expect(existsSync(join(first.root, 'injected'))).toBe(false);
});

it('still rejects the failed first full-file size probe instead of turning it into LOAD evidence', () => {
  const { root, ref } = fixture('x'.repeat(20001));
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs"),c=require("node:crypto"),[p,h]=process.argv.slice(1),b=fs.readFileSync(p),s=b.toString("utf8");if(c.createHash("sha256").update(b).digest("hex")!==h)throw Error("hash");const o=JSON.stringify({path:p,sha256:h,content:s})+"\\n";if(s.length>8000||Buffer.byteLength(o)>10000)throw Error("size");process.stdout.write(o);',
      ref.path,
      ref.sha256,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Error: size');
  expect(() =>
    confirmObservedLoad(
      {
        status: 'completed',
        items: [
          {
            type: 'commandExecution',
            status: 'completed',
            exitCode: result.status,
            aggregatedOutput: result.stdout + result.stderr,
          },
        ],
      },
      [ref],
    ),
  ).toThrow('reader-load-unconfirmed');
});
