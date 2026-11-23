"""Update the existing macOS TNAS LaunchAgent in a drained maintenance window."""
import argparse
import fcntl
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent.parent
LABEL = 'com.krivega.agent-workflow.worker'
DOMAIN = f'gui/{os.getuid()}'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def job_pid(label):
    info = output('launchctl', 'print', f'{DOMAIN}/{label}')
    return int(re.search(r'^\s*pid = (\d+)$', info, re.MULTILINE)[1])


def prepare(archive, expected, stage, package, lockfile):
    # Hash and extract the same private snapshot, including when the input is replaced.
    snapshot = stage.parent / 'archive.tgz'
    shutil.copyfile(archive, snapshot)
    require(hashlib.sha256(snapshot.read_bytes()).hexdigest() == expected, 'Archive SHA-256 mismatch')
    with tarfile.open(snapshot) as tar:
        for member in tar:
            path = Path(member.name)
            require(path.parts[:1] == ('package',) and '..' not in path.parts
                    and (member.isfile() or member.isdir()), f'Unsafe archive member: {path}')
            require(path.parts[1:2] not in [('node_modules',), ('yarn.lock',)], f'Reserved path: {path}')
            tar.extract(member, stage.parent, filter='data')
    current = json.loads((package / 'package.json').read_bytes())
    candidate = json.loads((stage / 'package.json').read_bytes())
    require(current['name'] == candidate['name'] == '@krivega/agent-workflow', 'Unexpected package')
    for key in ('dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'):
        require(current.get(key) == candidate.get(key), f'Changed {key}: perform a fresh dependency install')
    require((package / 'yarn.lock').read_bytes() == lockfile.read_bytes(), 'Dependency lock differs')
    require((package / 'node_modules').is_dir(), 'Missing installed dependencies')
    (stage / 'node_modules').symlink_to((package / 'node_modules').resolve())


def payload(root):
    result = {}
    for parent, dirs, files in os.walk(root):
        if Path(parent) == root:
            dirs[:] = [name for name in dirs if name != 'node_modules']
            files = [name for name in files if name not in ('yarn.lock', 'node_modules')]
        for name in dirs + files:
            path = Path(parent) / name
            require(not path.is_symlink(), f'Unexpected payload symlink: {path}')
        for name in files:
            if name != '.DS_Store':
                path = Path(parent) / name
                require(path.is_file(), f'Unexpected payload entry: {path}')
                result[path.relative_to(root)] = (hashlib.sha256(path.read_bytes()).digest(),
                                                  bool(path.stat().st_mode & 0o100))
    return result


def update(args, scratch):
    host = args.host.resolve(strict=True)
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    config = plistlib.loads(plist.read_bytes())
    node, entry, action, root = config['ProgramArguments']
    script = Path(entry)
    package = script.parents[2]
    require(config['Label'] == LABEL and action == '--run' and Path(root) == host
            and package.name == 'package' and package.is_relative_to(host)
            and script.resolve(strict=True) == script
            and script == package / 'examples/temporal-host/worker.mjs', 'Unexpected LaunchAgent installation')
    stage = scratch / 'package'
    prepare(args.archive, args.sha256, stage, package, args.lockfile)
    route = output(node, stage / script.relative_to(package), '--check', host)
    def temporal(pid=None):
        subprocess.run([node, TOOLS / 'verify-temporal.mjs', package, route, args.receipt,
                        args.artifacts, *([] if pid is None else [str(pid)])], check=True)
    candidate = payload(stage)
    installed = payload(package)
    differences = sorted(p for p in candidate.keys() | installed.keys() if candidate.get(p) != installed.get(p))
    if not differences:
        if args.apply:
            pid = job_pid(LABEL)
            require(json.loads((host / 'state/host-owner').read_bytes())['pid'] == pid, 'Worker owner mismatch')
            temporal(pid)
        print('Installed package already matches the archive; no restart required.')
        return
    print('Changed payload paths:', *(str(p) for p in differences), sep='\n', flush=True)
    if not args.apply:
        print('Preview complete. Use --apply during a drained maintenance window.')
        return
    def state():
        return json.loads(output(sys.executable, '-I', TOOLS / 'verify-local.py', 'state', host, '-'))
    subprocess.run([node, stage / script.relative_to(package), '--check-writer', host], check=True)
    protected = [host / 'state', host / 'worker.json', args.artifacts, args.receipt]
    configuration = json.loads((host / 'worker.json').read_bytes())
    protected.extend(Path(configuration[key]) for key in ('codexHome', 'codexBinary'))
    for project in configuration['projects']:
        file = Path(project['file'])
        reg = json.loads(file.read_bytes())['registration']
        protected.extend([file, Path(reg['workspaceRoot']), Path(reg['artifactRoot'])])
    require(all(not p.resolve().is_relative_to(package) for p in protected),
            'Protected host or project data inside installation')
    old = job_pid(LABEL)
    owner = host / 'state/host-owner'
    require(json.loads(owner.read_bytes())['pid'] == old, 'Worker owner mismatch')
    temporal(old)
    tunnel = job_pid('com.krivega.agent-workflow.tnas-tunnel')
    subprocess.run([sys.executable, '-I', TOOLS / 'verify-local.py', 'processes', host, str(old), str(tunnel)], check=True)
    before = state()
    require(job_pid(LABEL) == old, 'Worker changed before stop')
    subprocess.run(['launchctl', 'bootout', DOMAIN, plist], check=True)
    for _ in range(30):
        try:
            os.kill(old, 0)
        except ProcessLookupError:
            if not owner.exists():
                break
        time.sleep(1)
    else:
        raise ValueError('Previous Worker stop is unconfirmed')
    require(state() == before, 'Host state changed during stop')
    temporal()
    subprocess.run(['rsync', '-ric', '--delete', '--exclude=/node_modules', '--exclude=/yarn.lock',
                    '--exclude=.DS_Store', str(stage) + '/', str(package) + '/'], check=True)
    for path in differences:
        if path in candidate:
            (package / path).chmod(0o700 if candidate[path][1] else 0o600)
    require(payload(package) == candidate, 'Installed package differs after rsync')
    subprocess.run([node, script, '--check', host], check=True)
    subprocess.run(['launchctl', 'bootstrap', DOMAIN, plist], check=True)
    for _ in range(30):
        if owner.is_file():
            pid = job_pid(LABEL)
            if pid != old and json.loads(owner.read_bytes())['pid'] == pid:
                try:
                    temporal(pid)
                    break
                except subprocess.CalledProcessError:
                    pass
        time.sleep(1)
    else:
        raise ValueError('Updated Worker readiness unconfirmed')
    after = state()
    require(after['registrations'] == before['registrations'] and
            all(after['state'].get(k) == v for k, v in before['state'].items()), 'Retained state changed')
    print(f'Updated Worker PID {old} -> {pid}.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--host', type=Path, default=Path.home() / 'Library/Application Support/agent-workflow/tnas')
    parser.add_argument('--lockfile', type=Path, default=REPO / 'yarn.lock')
    parser.add_argument('--receipt', type=Path, help='Receipt for a completed run on the target host')
    parser.add_argument('--artifacts', type=Path, help='Artifact directory for that run')
    args = parser.parse_args()
    if args.apply and (args.receipt is None or args.artifacts is None):
        parser.error('--apply requires --receipt and --artifacts')
    require(sys.platform == 'darwin', 'Requires macOS launchd')
    os.umask(0o077)
    # Lock the host directory inode; never create or remove a runtime ownership record.
    lock = os.open(args.host, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='aw-worker-update-') as tmp:
            update(args, Path(tmp))
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
