import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import testConfig from '../tsconfig.test.json' with { type: 'json' };

const modules = new Map();
const options = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  baseUrl: resolve(import.meta.dirname, '..'),
  paths: testConfig.compilerOptions.paths,
};

export function usesExternalTools(file) {
  const pending = [file],
    visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const stat = statSync(path, { bigint: true });
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    let module = modules.get(path);
    if (module?.identity !== identity) {
      module = {
        identity,
        imports: ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles,
      };
      modules.set(path, module);
      if (modules.size > 4096) modules.delete(modules.keys().next().value);
    }
    for (const { fileName } of module.imports) {
      if (fileName === 'node:child_process' || fileName === 'child_process') return true;
      const target = ts.resolveModuleName(fileName, path, options, ts.sys).resolvedModule;
      if (
        target &&
        !target.isExternalLibraryImport &&
        !/\.d\.[cm]?ts$/.test(target.resolvedFileName) &&
        /\.[cm]?[jt]sx?$/.test(target.resolvedFileName)
      )
        pending.push(target.resolvedFileName);
    }
  }
  return false;
}

// Reserve one worker for suites without child processes.
export function externalToolSlots(workers) {
  return Math.max(1, workers - 1);
}
