import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(body: string | Buffer = '{"first":true}\n') {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'h06-native-journal-'));
  temporary.push(root);
  const path = join(root, 'native.jsonl');
  fs.writeFileSync(path, body, { mode: 0o600 });
  return { root, path };
}
function afterRead(action: (index: number) => void) {
  const actual = fs.readSync;
  let index = 0;
  return vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, options) => {
    const result = actual(fd, buffer, options);
    action(++index);
    return result;
  });
}

it.each(['', '{"unfinished":', '{"value":"π 🕵️"}\n', '{"one":1}\n{"unfinished":'])(
  'returns only the complete initial prefix of %j',
  (body) => {
    const f = fixture(body),
      before = fs.readFileSync(f.path);
    expect(readH06NativeJournal(f.path)).toEqual(before.subarray(0, before.lastIndexOf(10) + 1));
    expect(fs.readFileSync(f.path)).toEqual(before);
  },
);

it('ignores an unfinished Unicode code point in the uncommitted last line', () => {
  const complete = Buffer.from('{"first":"готово"}\n');
  const f = fixture(Buffer.concat([complete, Buffer.from('{"text":"'), Buffer.from([0xf0, 0x9f])]));
  expect(readH06NativeJournal(f.path)).toEqual(complete);
});

it('rejects invalid UTF8 inside a complete line', () => {
  const f = fixture(Buffer.from([0xc0, 0xaf, 10]));
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-encoding');
});

it('reads exactly the initial size twice while another process appends complete and partial events', () => {
  const f = fixture(),
    original = fs.readFileSync(f.path);
  const closed = vi.spyOn(fs, 'closeSync');
  const read = afterRead((index) => {
    if (index !== 1) return;
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        'require("node:fs").appendFileSync(process.argv[1],"{\\"appended\\":true}\\n{\\"partial\\":");',
        f.path,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  });
  expect(readH06NativeJournal(f.path)).toEqual(original);
  expect(read).toHaveBeenCalledTimes(2);
  expect(fs.statSync(f.path).size).toBeGreaterThan(original.length);
  expect(closed).toHaveBeenCalledOnce();
});

it('collects short positive fd reads without reading past the initial snapshot', () => {
  const f = fixture(),
    actual = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, options) =>
    actual(fd, buffer, {
      ...options,
      length: Math.min(options!.length!, 2),
    }),
  );
  expect(readH06NativeJournal(f.path).toString()).toBe('{"first":true}\n');
});

it.each(['overwrite', 'overwrite-and-append', 'unfinished-tail'])(
  'rejects %s mutation between the two reads',
  (mutation) => {
    const f = fixture(mutation === 'unfinished-tail' ? '{"one":1}\npartial' : '{"first":true}\n');
    afterRead((index) => {
      if (index !== 1) return;
      if (mutation === 'unfinished-tail') fs.writeFileSync(f.path, '{"one":1}\nCHANGED');
      else
        fs.writeFileSync(
          f.path,
          '{"other":true}\n' + (mutation === 'overwrite-and-append' ? '{"extra":true}\n' : ''),
        );
    });
    const close = vi.spyOn(fs, 'closeSync');
    expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-changed');
    expect(close).toHaveBeenCalledOnce();
  },
);

it('rejects truncation during the second snapshot instead of treating a short read as a new prefix', () => {
  const f = fixture();
  afterRead((index) => {
    if (index === 1) fs.truncateSync(f.path, 3);
  });
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-short-read');
});

it.each(['truncate', 'replace', 'mode', 'hardlink'])(
  'rechecks file identity and size after both snapshots: %s',
  (mutation) => {
    const f = fixture();
    afterRead((index) => {
      if (index !== 2) return;
      if (mutation === 'truncate') fs.truncateSync(f.path, 0);
      if (mutation === 'replace') {
        fs.renameSync(f.path, f.path + '.old');
        fs.writeFileSync(f.path, '{"new":true}\n');
      }
      if (mutation === 'mode') fs.chmodSync(f.path, 0o640);
      if (mutation === 'hardlink') fs.linkSync(f.path, f.path + '.link');
    });
    expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-changed');
  },
);

it('rejects path replacement during open before reading any payload', () => {
  const f = fixture(),
    actual = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementationOnce((path, flags, mode) => {
    const fd = actual(path, flags, mode);
    fs.renameSync(f.path, f.path + '.old');
    fs.writeFileSync(f.path, '{"outside":true}\n');
    return fd;
  });
  const read = vi.spyOn(fs, 'readSync'),
    close = vi.spyOn(fs, 'closeSync');
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-changed');
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('accepts growth between the first path observation and the initial fd snapshot', () => {
  const f = fixture(),
    actual = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementationOnce((path, flags, mode) => {
    fs.appendFileSync(f.path, '{"beforeFd":true}\n');
    return actual(path, flags, mode);
  });
  expect(readH06NativeJournal(f.path)).toEqual(fs.readFileSync(f.path));
});

it('rejects shrinkage between the first path observation and open', () => {
  const f = fixture(),
    actual = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementationOnce((path, flags, mode) => {
    fs.truncateSync(f.path, 0);
    return actual(path, flags, mode);
  });
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-changed');
});

it('rejects a nonregular opened object and still closes its descriptor', () => {
  const f = fixture(),
    actual = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementationOnce((_path, flags, mode) =>
    actual(f.root, flags, mode),
  );
  const close = vi.spyOn(fs, 'closeSync');
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-kind');
  expect(close).toHaveBeenCalledOnce();
});

it('rejects unsafe snapshot sizes before allocation', () => {
  const f = fixture(),
    actual = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) =>
    Object.assign(actual(fd), { size: Number.NaN }),
  );
  expect(() => readH06NativeJournal(f.path)).toThrow('h06-native-journal-size');
});

it('propagates read failures, closes the fd and never retries the reader or writer', () => {
  const f = fixture();
  const read = vi.spyOn(fs, 'readSync').mockImplementationOnce(() => {
    throw new Error('disk-read-error');
  });
  const close = vi.spyOn(fs, 'closeSync');
  expect(() => readH06NativeJournal(f.path)).toThrow('disk-read-error');
  expect(read).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it.each(['file-link', 'parent-link', 'hardlink', 'directory', 'relative', 'noncanonical'])(
  'rejects a native journal alias or file kind: %s',
  (mutation) => {
    const f = fixture();
    let path = f.path;
    if (mutation === 'file-link') {
      path = f.path + '.link';
      fs.symlinkSync(f.path, path);
    }
    if (mutation === 'parent-link') {
      fs.symlinkSync(f.root, f.root + '.link');
      temporary.push(f.root + '.link');
      path = join(f.root + '.link', 'native.jsonl');
    }
    if (mutation === 'hardlink') fs.linkSync(f.path, f.path + '.link');
    if (mutation === 'directory') path = f.root;
    if (mutation === 'relative') path = 'relative.jsonl';
    if (mutation === 'noncanonical')
      path = f.root + '/../' + f.root.split('/').at(-1)! + '/native.jsonl';
    expect(() => readH06NativeJournal(path)).toThrow();
  },
);
