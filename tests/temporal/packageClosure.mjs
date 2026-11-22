import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import ts from 'typescript';
import { checkPackageFiles } from './pinned-consumers.mjs';

const limit = 8 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const variants = ['additionalRoots', 'trustedAssets'];
const sourcePath = fileURLToPath(import.meta.url);
const tarPath = realpathSync('/usr/bin/tar');
const parserPath = createRequire(import.meta.url).resolve('typescript');
const literal = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
function urlAsset(node) {
  if (
    !node ||
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'URL'
  )
    return null;
  const base = node.arguments?.[1],
    specifier = literal(node.arguments?.[0]);
  return specifier?.startsWith('.') &&
    base &&
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'url' &&
    ts.isMetaProperty(base.expression) &&
    base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ? specifier
    : null;
}
function fields(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'manifest fields');
  return value;
}
function archivePath(value) {
  assert.equal(typeof value, 'string');
  assert.ok(
    value.startsWith('package/') && posix.normalize(value) === value && !/[\\\s?#%:]/u.test(value),
    'canonical archive path required',
  );
  return value;
}
function regularPin(path) {
  assert.ok(
    isAbsolute(path) && resolve(path) === path && realpathSync(path) === path,
    'canonical file required',
  );
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1, 'regular single-link file required');
  const bytes = readFileSync(path);
  return { path, sha256: digest(bytes), bytes: bytes.length };
}
function archiveInventory(path, npmArchive) {
  const run = (args) => {
    const result = spawnSync(tarPath, args, {
      timeout: 2000,
      maxBuffer: limit,
      env: { ...process.env, LC_ALL: 'C' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'tar read failed');
    assert.equal(result.stderr.length, 0, 'tar diagnostics rejected');
    return result.stdout;
  };
  const names = run(['-tzf', path]).toString('utf8').trimEnd().split('\n');
  checkPackageFiles(names, { npmArchive });
  const rows = run(['-tvzf', path]).toString('utf8').trimEnd().split('\n');
  assert.equal(rows.length, names.length, 'unrecognized tar inventory');
  const members = new Map();
  for (let index = 0; index < names.length; index++) {
    const name = names[index],
      key = name.replace(/\/$/u, ''),
      row = rows[index];
    assert.ok(!key.endsWith('/'), 'noncanonical directory spelling');
    assert.ok(key === 'package' || archivePath(key));
    assert.ok(!members.has(key), 'duplicate archive entry');
    assert.ok(
      row.endsWith(' ' + name) && ['-', 'd'].includes(row[0]),
      'nonregular or unrecognized tar member',
    );
    assert.ok(row[0] === 'd' || !name.endsWith('/'), 'regular file has directory spelling');
    members.set(key, { name, regular: row[0] === '-', bytes: null });
  }
  const directories = new Set();
  for (const [name, member] of members) {
    if (!member.regular) directories.add(name);
    for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent)) {
      assert.ok(!members.get(parent)?.regular, 'archive parent must be a directory');
      directories.add(parent);
    }
  }
  let total = 0;
  return {
    members,
    directories,
    read(name) {
      const entry = members.get(archivePath(name));
      assert.ok(entry?.regular, 'archive target must be regular: ' + name);
      if (entry.bytes === null) {
        entry.bytes = run(['-xOf', path, entry.name]);
        total += entry.bytes.length;
        assert.ok(total <= limit, 'archive read budget exceeded');
      }
      return entry.bytes;
    },
  };
}
function sourceTargets(source, path) {
  const found = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'installedModule' && literal(node.arguments[0])?.endsWith('.js'))
        found.add('package/dist/' + literal(node.arguments[0]));
      if (
        node.expression.text === 'join' &&
        node.arguments[0] &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'installed'
      ) {
        const parts = node.arguments.slice(1).map(literal);
        if (
          parts.length > 0 &&
          parts.every((part) => part !== null) &&
          parts[0].startsWith('dist/')
        )
          found.add('package/' + parts.join('/'));
      }
    }
    ts.forEachChild(node, visit);
  }
  assert.ok(path.endsWith('.js') || path.endsWith('.mjs'), 'JS consumer source required');
  assert.equal(source.parseDiagnostics.length, 0, 'consumer parse failure');
  visit(source);
  return found;
}

export function packageClosurePlan() {
  return {
    schemaVersion: 1,
    kind: 'package-closure-plan',
    status: 'PLAN',
    qualification: false,
    manifest: {
      schemaVersion: 1,
      archive: { path: null, sha256: null, bytes: null },
      additionalRoots: [],
      trustedAssets: [],
    },
  };
}
export function checkPackageClosure(value) {
  const npmArchive = Object.hasOwn(value ?? {}, 'npmIntegrity');
  const manifest = fields(value, [
    'schemaVersion',
    'archive',
    ...variants,
    ...(npmArchive ? ['npmIntegrity'] : []),
  ]);
  assert.equal(manifest.schemaVersion, 1);
  fields(manifest.archive, ['path', 'sha256', 'bytes']);
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    Number.isSafeInteger(manifest.archive.bytes) &&
      manifest.archive.bytes > 0 &&
      manifest.archive.bytes <= limit,
    'archive size bound',
  );
  for (const name of variants) assert.ok(Array.isArray(manifest[name]));
  assert.equal(
    lstatSync(manifest.archive.path).size,
    manifest.archive.bytes,
    'archive byte pin mismatch',
  );
  const pins = [
    regularPin(manifest.archive.path),
    regularPin(tarPath),
    regularPin(sourcePath),
    regularPin(parserPath),
  ];
  assert.deepEqual(pins[0], manifest.archive, 'archive pin mismatch');
  if (npmArchive) {
    const integrity =
      'sha512-' + createHash('sha512').update(readFileSync(manifest.archive.path)).digest('base64');
    assert.equal(manifest.npmIntegrity, integrity, 'npm integrity mismatch');
  }
  const archive = archiveInventory(manifest.archive.path, npmArchive);
  const metadata = JSON.parse(archive.read('package/package.json').toString('utf8'));
  assert.ok(typeof metadata.name === 'string' && metadata.name.trim().length > 0);
  assert.ok(
    metadata.exports &&
      typeof metadata.exports === 'object' &&
      !Array.isArray(metadata.exports) &&
      Object.keys(metadata.exports).length > 0,
    'public exports required',
  );
  const graph = [],
    errors = [],
    unknown = [],
    roots = [],
    queue = [],
    visited = new Set();
  const fault = (from, line, specifier, code) => errors.push({ from, line, specifier, code });
  const unresolved = (from, line, kind) => unknown.push({ from, line, kind });
  function target(from, specifier, kind, line) {
    let resolved;
    try {
      const path = fileURLToPath(new URL(specifier, 'file:///archive/' + from));
      assert.ok(path.startsWith('/archive/package/'));
      resolved = path.slice('/archive/'.length);
      if (kind === 'literal-url-asset') resolved = resolved.replace(/\/$/u, '');
      if (resolved !== 'package' || kind !== 'literal-url-asset') archivePath(resolved);
    } catch {
      fault(from, line, specifier, 'archive-escape-or-invalid-path');
      return;
    }
    if (kind === 'literal-url-asset' && archive.directories.has(resolved)) {
      graph.push({ from, line, kind: 'literal-url-directory', specifier, target: resolved });
      return;
    }
    if (
      !archive.members.has(resolved) &&
      /\.tsx?$/u.test(from) &&
      resolved.endsWith('.js') &&
      metadata.dependencies?.tsx
    ) {
      const typed = resolved.slice(0, -3) + '.ts';
      if (archive.members.get(typed)?.regular) resolved = typed;
    }
    if (!archive.members.has(resolved) && ['require', 'require.resolve'].includes(kind)) {
      const found = ['.js', '.json', '.node', '/index.js', '/index.json']
        .map((suffix) => resolved + suffix)
        .find((path) => archive.members.get(path)?.regular);
      if (found) resolved = found;
    }
    if (
      archive.members.has(resolved) &&
      !archive.members.get(resolved).regular &&
      ['require', 'require.resolve'].includes(kind)
    ) {
      unresolved(from, line, 'require-directory-resolution');
      return;
    }
    if (!archive.members.get(resolved)?.regular) {
      fault(from, line, specifier, 'missing-or-nonregular-relative');
      return;
    }
    const bytes = archive.read(resolved);
    graph.push({
      from,
      line,
      kind,
      specifier,
      target: resolved,
      sha256: digest(bytes),
    });
    if (/\.(?:js|mjs|cjs|ts|mts|cts)$/u.test(resolved)) queue.push(resolved);
  }
  function reference(from, specifier, kind, line) {
    if (specifier.startsWith('.')) {
      target(from, specifier, kind, line);
      return;
    }
    if (isBuiltin(specifier)) {
      graph.push({ from, line, kind, specifier, boundary: 'node-builtin' });
      return;
    }
    if (specifier === metadata.name || specifier.startsWith(metadata.name + '/')) {
      const key = specifier === metadata.name ? '.' : '.' + specifier.slice(metadata.name.length);
      const exported = metadata.exports?.[key];
      if (typeof exported !== 'string' || !exported.startsWith('./'))
        fault(from, line, specifier, 'self-export-unresolved');
      else target('package/package.json', exported, 'self-export', line);
      return;
    }
    const dependency = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (Object.hasOwn(metadata.dependencies ?? {}, dependency))
      graph.push({
        from,
        line,
        kind,
        specifier,
        boundary: 'declared-direct-dependency',
      });
    else fault(from, line, specifier, 'undeclared-bare');
  }
  const hostEntry = 'package/examples/temporal-host/worker.mjs';
  if (archive.members.has(hostEntry)) roots.push({ target: hostEntry, kind: 'host-entry' });
  for (const [key, exported] of Object.entries(metadata.exports ?? {})) {
    if (typeof exported !== 'string' || !exported.startsWith('./'))
      fault('package/package.json', null, key, 'export-target-unresolved');
    else
      roots.push({
        target: 'package/' + exported.slice(2),
        kind: 'public-export',
      });
  }
  for (const bin of Object.values(
    typeof metadata.bin === 'string' ? { default: metadata.bin } : (metadata.bin ?? {}),
  )) {
    if (typeof bin !== 'string' || bin.startsWith('/') || bin.split('/').includes('..'))
      fault('package/package.json', null, bin, 'bin-target-unresolved');
    else
      roots.push({
        target: 'package/' + bin.replace(/^\.\//u, ''),
        kind: 'package-bin',
      });
  }
  for (const command of Object.values(metadata.scripts ?? {})) {
    const match = typeof command === 'string' && command.match(/^node (dist\/[^\s]+\.js)(?: |$)/u);
    if (match) roots.push({ target: 'package/' + match[1], kind: 'package-script' });
  }
  function boundSource(raw) {
    const source = fields(raw, ['path', 'sha256']);
    assert.match(source.sha256, /^[a-f0-9]{64}$/u);
    const bytes = archive.read(source.path);
    assert.equal(digest(bytes), source.sha256, 'source binding mismatch');
    return {
      source,
      ast: ts.createSourceFile(
        source.path,
        bytes.toString('utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
    };
  }
  for (const raw of manifest.additionalRoots) {
    const root = fields(raw, ['target', 'source']),
      bound = boundSource(root.source);
    archivePath(root.target);
    assert.ok(
      sourceTargets(bound.ast, bound.source.path).has(root.target),
      'additional root has no supported literal declaration',
    );
    roots.push({ target: root.target, kind: 'bound-consumer-root' });
  }
  const assetBindings = manifest.trustedAssets.map((raw) => {
    const binding = fields(raw, ['source', 'paths']),
      bound = boundSource(binding.source);
    assert.ok(
      Array.isArray(binding.paths) &&
        binding.paths.length > 0 &&
        new Set(binding.paths).size === binding.paths.length,
    );
    return {
      source: bound.source,
      paths: binding.paths.map((path) => ({
        path: archivePath(path),
        sha256: digest(archive.read(path)),
      })),
    };
  });
  for (const root of roots)
    target('package/package.json', './' + root.target.slice(8), root.kind, null);
  while (queue.length) {
    const from = queue.shift();
    if (visited.has(from)) continue;
    visited.add(from);
    const source = ts.createSourceFile(
      from,
      archive.read(from).toString('utf8'),
      ts.ScriptTarget.Latest,
      true,
      /\.tsx?$/u.test(from) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    if (source['parseDiagnostics'].length) fault(from, null, null, 'js-parse-failure');
    const readers = new Set(),
      namespaces = new Set(),
      requireNames = new Set(['require']),
      makers = new Set(['createRequire']);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = literal(statement.moduleSpecifier),
        bindings = statement.importClause?.namedBindings;
      const fs = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].includes(specifier);
      if (fs && statement.importClause?.name) namespaces.add(statement.importClause.name.text);
      if (fs && bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements) {
          const original = item.propertyName?.text ?? item.name.text;
          if (
            fs &&
            ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream'].includes(original)
          )
            readers.add(item.name.text);
          if (['node:module', 'module'].includes(specifier) && original === 'createRequire')
            makers.add(item.name.text);
        }
    }
    function aliases(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        makers.has(node.initializer.expression.text)
      )
        requireNames.add(node.name.text);
      ts.forEachChild(node, aliases);
    }
    aliases(source);
    function visit(node) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        reference(from, literal(node.moduleSpecifier), 'import-or-export', line);
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const kind =
          expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'dynamic-import'
            : ts.isIdentifier(expression) && requireNames.has(expression.text)
              ? 'require'
              : ts.isPropertyAccessExpression(expression) &&
                  ts.isIdentifier(expression.expression) &&
                  requireNames.has(expression.expression.text) &&
                  expression.name.text === 'resolve'
                ? 'require.resolve'
                : null;
        const reader =
          (ts.isIdentifier(expression) && readers.has(expression.text)) ||
          (ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            namespaces.has(expression.expression.text) &&
            ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream'].includes(
              expression.name.text,
            ));
        if (reader) {
          const asset = urlAsset(node.arguments[0]);
          if (asset === null) unresolved(from, line, 'external-or-computed-filesystem-input');
          else target(from, asset, 'literal-file-read', line);
        }
        if (kind) {
          const specifier = literal(node.arguments[0]);
          if (specifier === null) unresolved(from, line, 'computed-' + kind);
          else reference(from, specifier, kind, line);
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'URL'
      ) {
        const specifier = urlAsset(node);
        if (specifier !== null) target(from, specifier, 'literal-url-asset', line);
        else unresolved(from, line, 'computed-or-external-url');
      }
      if (
        (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
        ['workflowsPath', 'workflowBundle'].includes(node.name.getText(source))
      )
        unresolved(from, line, 'caller-workflow-module');
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.equal(realpathSync('/usr/bin/tar'), tarPath, 'tar observer alias changed');
  for (const pin of pins)
    assert.deepEqual(regularPin(pin.path), pin, 'observer/archive/parser/source changed');
  return {
    schemaVersion: 1,
    kind: 'package-closure-report',
    status: errors.length
      ? 'FAIL'
      : unknown.length
        ? 'STATIC_CLOSURE_WITH_UNKNOWNS'
        : 'STATIC_CLOSURE_PASS',
    complete: errors.length === 0 && unknown.length === 0,
    qualification: false,
    archive: pins[0],
    pins,
    hashesStable: true,
    observerAlias: { path: '/usr/bin/tar', target: tarPath },
    roots,
    assetBindings,
    reachable: [...visited].sort(),
    graph,
    errors,
    unknown,
    limits: [
      'declared dependency contents and subpaths not inspected',
      'external project/artifact inputs not qualified',
      'computed imports/assets and caller workflows remain unresolved',
      'trusted asset declarations do not establish exhaustive runtime dataflow',
      'static closure does not qualify installed execution',
    ],
  };
}
export function packageClosureCli(args) {
  try {
    if (args.length === 1 && args[0] === '--plan')
      return { exitCode: 0, report: packageClosurePlan() };
    assert.ok(args.length === 2 && args[0] === '--check');
    const input = regularPin(args[1]);
    const report = checkPackageClosure(JSON.parse(readFileSync(input.path, 'utf8')));
    assert.deepEqual(regularPin(input.path), input);
    return {
      exitCode: report.errors.length ? 1 : 0,
      report: { ...report, manifest: input },
    };
  } catch {
    return {
      exitCode: 1,
      report: {
        schemaVersion: 1,
        kind: 'package-closure-report',
        status: 'FAIL',
        complete: false,
        qualification: false,
        reason: 'invalid-manifest-or-archive',
      },
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = packageClosureCli(process.argv.slice(2));
  console.log(JSON.stringify(result.report));
  process.exitCode = result.exitCode;
}
