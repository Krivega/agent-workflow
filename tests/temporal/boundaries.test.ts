import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('standalone runtime import boundaries', () => {
  it('never imports the game or legacy runtime; contracts and Workflows stay pure', () => {
    const root = resolve(dirname(new URL(import.meta.url).pathname), '../../src');
    for (const file of sources(root)) {
      const path = relative(root, file);
      const code = readFileSync(file, 'utf8');
      const imports = [...code.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/gu)].map(
        (match) => match[1]!,
      );
      for (const specifier of imports) {
        if (specifier.startsWith('.')) {
          const target = relative(root, resolve(dirname(file), specifier));
          expect(target.startsWith('..'), `${path}: ${specifier}`).toBe(false);
          if (/^(contracts|policy)\//u.test(path)) expect(target).toMatch(/^(contracts|policy)\//u);
          if (path.startsWith('workflows/'))
            expect(target).toMatch(/^(contracts|policy|workflows)\//u);
        } else if (/^(contracts|policy)\//u.test(path)) {
          throw new Error(`Impure policy: ${path} imports ${specifier}`);
        } else if (path.startsWith('workflows/')) {
          expect(specifier).toBe('@temporalio/workflow');
        }
      }
    }
  });
});
