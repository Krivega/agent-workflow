import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/adapters/artifacts/backup.js';
import { retentionReport } from '../../src/adapters/artifacts/retention.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { backupCommand } from '../../src/client/backup.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aw-retention-')));
  temporary.push(root);
  const files = ['log', 'fail', 'manifest', 'evidence', 'projection', 'workcopy'].map((kind) => {
    const bytes = Buffer.from(kind + ' original FAIL');
    fs.writeFileSync(join(root, kind), bytes);
    return {
      path: kind,
      kind,
      createdAt: '2026-01-01T00:00:00.000Z',
      content: { sha256: digest(bytes), bytes: bytes.length },
    };
  });
  return {
    root,
    files,
    input: {
      schemaVersion: 1,
      root,
      now: '2026-10-29T00:00:00.000Z',
      files,
      protected: [],
      backups: [],
    },
  };
}
describe('non-destructive retention report', () => {
  it('reports elapsed 30/180 day windows while protecting evidence, projections and workcopies', () => {
    const f = fixture(),
      result = retentionReport(f.input);
    expect(result).toMatchObject({
      status: 'report-only',
      deletionAuthorized: false,
      verifiedBackups: 0,
    });
    expect(result.entries.map((entry) => [entry.path, entry.minimumDays, entry.decision])).toEqual([
      ['log', 30, 'candidate'],
      ['fail', 180, 'candidate'],
      ['manifest', 180, 'candidate'],
      ['evidence', null, 'retain'],
      ['projection', null, 'retain'],
      ['workcopy', null, 'retain'],
    ]);
    for (const file of f.files)
      expect(digest(fs.readFileSync(join(f.root, file.path)))).toBe(file.content.sha256);
  });
  it('keeps young and referenced originals beyond their retention windows', () => {
    const f = fixture(),
      input = { ...f.input, now: '2026-01-30T00:00:00.000Z', protected: [f.files[0]!.content] },
      result = retentionReport(input);
    expect(result.entries[0]!.reason).toBe('referenced-evidence');
    expect(result.entries[1]!.reason).toBe('minimum-window');
    expect(result.entries.every((entry) => entry.decision === 'retain')).toBe(true);
  });
  it('verifies an independently pinned backup and protects every referenced blob', () => {
    const f = fixture(),
      source = join(f.root, 'source'),
      backup = join(f.root, 'backup');
    fs.mkdirSync(source);
    fs.copyFileSync(join(f.root, 'fail'), join(source, 'original'));
    const saved = createBackup({
        schemaVersion: 2,
        roots: { artifacts: source },
        destination: backup,
      }),
      reference = { schemaVersion: 1, backup, manifest: saved.manifest },
      input = { ...f.input, backups: [reference] };
    expect(retentionReport(input).entries.find((entry) => entry.path === 'fail')!.reason).toBe(
      'referenced-evidence',
    );
    fs.writeFileSync(join(backup, 'blobs', f.files[1]!.content.sha256), 'corrupt');
    expect(() => retentionReport(input)).toThrow('artifact-corrupted');
    expect(fs.readFileSync(join(f.root, 'fail'), 'utf8')).toContain('original FAIL');
  });
  it('refuses incomplete backup copies instead of treating them as retained evidence', () => {
    const f = fixture(),
      source = join(f.root, 'source'),
      backup = join(f.root, 'backup');
    fs.mkdirSync(source);
    const saved = createBackup({
      schemaVersion: 2,
      roots: { workspaces: source },
      destination: backup,
    });
    fs.writeFileSync(join(backup, '.backup-incomplete'), 'pending');
    expect(() =>
      retentionReport({
        ...f.input,
        backups: [{ schemaVersion: 1, backup, manifest: saved.manifest }],
      }),
    ).toThrow('backup-incomplete');
  });
  it.each(['corrupt', 'missing', 'size', 'hardlink', 'symlink'])(
    'refuses invalid retained originals: %s',
    (kind) => {
      const f = fixture(),
        path = join(f.root, 'log');
      if (kind === 'corrupt') fs.writeFileSync(path, 'changed');
      else if (kind === 'size') f.files[0]!.content.bytes++;
      else if (kind === 'hardlink') fs.linkSync(path, join(f.root, 'linked'));
      else {
        fs.unlinkSync(path);
        if (kind === 'symlink') fs.symlinkSync(join(f.root, 'fail'), path);
      }
      expect(() => retentionReport(f.input)).toThrow();
    },
  );
  it('validates kind, inventory identity, times, paths and version', () => {
    const f = fixture();
    for (const input of [
      { ...f.input, schemaVersion: 2 },
      { ...f.input, root: 'relative' },
      { ...f.input, files: null },
      { ...f.input, now: '2026-02-30T00:00:00.000Z' },
      { ...f.input, now: 'yesterday' },
      { ...f.input, files: [...f.files, f.files[0]] },
      { ...f.input, files: [{ ...f.files[0], kind: 'unknown' }] },
      { ...f.input, files: [{ ...f.files[0], createdAt: '2027-01-01T00:00:00.000Z' }] },
      { ...f.input, files: [{ ...f.files[0], path: '../escape' }] },
    ])
      expect(() => retentionReport(input)).toThrow();
  });
  it('uses the same report-only behavior through backup CLI', () => {
    const f = fixture(),
      input = join(f.root, 'retention.json');
    fs.writeFileSync(input, JSON.stringify(f.input));
    expect(backupCommand(['retention', input])).toEqual(retentionReport(f.input));
  });
});
