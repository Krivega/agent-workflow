"""Read historical Harness² reports. New model pilots are disabled."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

DISABLED = 'h2-new-model-runs-disabled'


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def manifest(root):
    files = sorted(Path(root).rglob('*'))
    if any(p.is_symlink() for p in files):
        raise ValueError('symlinks are forbidden')
    return {str(p.relative_to(root)): digest(p.read_bytes()) for p in files if p.is_file()}


def answer(text):
    value = json.loads(text)
    if set(value) != {'rows', 'unknowns'} or not isinstance(value['rows'], list) or not value['rows']:
        raise ValueError('invalid map')
    if not isinstance(value['unknowns'], list) or not all(isinstance(v, str) for v in value['unknowns']):
        raise ValueError('invalid unknowns')
    for row in value['rows']:
        if set(row) != {'path', 'symbol', 'role', 'line', 'explanation'}:
            raise ValueError('invalid row fields')
        if not all(isinstance(row[k], str) and row[k].strip() for k in ('path', 'symbol', 'explanation')):
            raise ValueError('empty row')
        if row['role'] not in ('contract', 'storage', 'reader', 'writer', 'platform', 'verification'):
            raise ValueError('invalid role')
        if type(row['line']) is not int or row['line'] < 1:
            raise ValueError('invalid line')
    return value


def evaluate(text, source, anchors):
    value = answer(text)
    valid, invalid, duplicate = set(), [], []
    source = Path(source).resolve()
    for row in value['rows']:
        key = (row['path'], row['symbol'], row['role'])
        path = (source / row['path']).resolve()
        if not path.is_relative_to(source) or not path.is_file():
            invalid.append(row)
            continue
        lines = path.read_text().splitlines()
        if row['line'] > len(lines) or row['symbol'] not in lines[row['line'] - 1]:
            invalid.append(row)
        elif key in valid:
            duplicate.append(row)
        else:
            valid.add(key)
    expected = {(a['path'], a['symbol'], a['role']) for a in anchors}
    return {'found': len(expected & valid), 'total': len(expected), 'invalid': invalid,
            'duplicates': duplicate, 'missing': sorted(expected - valid),
            'additional': sorted(valid - expected), 'semantic_review': 'required',
            'unknowns': value['unknowns']}


class Broker:
    """Keep old direct callers on an explicit refusal path without side effects."""

    def __init__(self, *args, **kwargs):
        raise RuntimeError(DISABLED)

    def invoke(self, command, output):
        raise RuntimeError(DISABLED)

    def call(self, context, prompt):
        raise RuntimeError(DISABLED)


def run(root, repo, upstream, binary, ref, oracle):
    raise RuntimeError(DISABLED)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('root', 'repo', 'upstream', 'oracle'):
        parser.add_argument('--' + flag, type=Path, required=True)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--ref', required=True)
    args = parser.parse_args()
    run(**vars(args))


if __name__ == '__main__':
    main()
