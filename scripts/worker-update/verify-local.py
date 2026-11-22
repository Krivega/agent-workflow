import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
from pathlib import Path

mode, root_path, argument = sys.argv[1:4]
root = Path(root_path)
settings_path = root / 'worker.json'
settings = json.loads(settings_path.read_bytes())
reg_files = [Path(project['file']) for project in settings['projects']]
registrations = [json.loads(path.read_bytes())['registration'] for path in reg_files]

def metadata(path):
    info = path.lstat()
    entry = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode]
    if stat.S_ISREG(info.st_mode):
        entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
    else:
        assert stat.S_ISDIR(info.st_mode), path
    return entry

if mode == 'state':
    state = root / 'state'
    protected = [state, *sorted(state.rglob('*'))]
    preserved = {str(path.relative_to(root)): metadata(path)
                 for path in protected if path != state / 'host-owner'}
    receipt = {'registrations': {str(path): metadata(path) for path in [settings_path, *reg_files]},
               'state': preserved}
    print(json.dumps(receipt, sort_keys=True))
    sys.exit(0)

assert mode == 'processes'
worker_pid = int(argument)
tunnel_pid = int(sys.argv[4])
workspace_roots = [row['workspaceRoot'] for row in registrations]
artifact_roots = [row['artifactRoot'] for row in registrations]
for workspace in workspace_roots.copy():
    listing = subprocess.check_output(
        ['/usr/bin/git', '-C', workspace, 'worktree', 'list', '--porcelain', '-z']
    )
    for entry in listing.split(b'\0'):
        if entry.startswith(b'worktree '):
            workspace_roots.append(os.fsdecode(entry[len(b'worktree '):]))
roots = [str(root), *workspace_roots, *artifact_roots]

def in_scope(path):
    return any(path == directory or path.startswith(directory + '/') for directory in roots)

process_text = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,state=,command='], text=True)
processes = {}
for line in process_text.splitlines():
    pid, parent, status, command = line.strip().split(None, 3)
    processes[int(pid)] = (int(parent), status, command)
assert worker_pid in processes and 'worker.mjs --run ' + str(root) in processes[worker_pid][2]

def related(pid, ancestor):
    visited = set()
    while pid in processes and pid > 0 and pid not in visited:
        if pid == ancestor:
            return True
        visited.add(pid)
        pid = processes[pid][0]
    return False

current = set()
pid = os.getpid()
while pid in processes and pid not in current:
    current.add(pid)
    pid = processes[pid][0]
helpers = {pid for pid, (parent, status, cmd) in processes.items()
           if parent == worker_pid and ' app-server --stdio' in cmd and not status.startswith('Z')}
assert len(helpers) == len(registrations), 'Unexpected number of resident Worker app-servers'
errors = []
for pid, (parent, status, command) in processes.items():
    if pid in current or pid in helpers or pid in (worker_pid, tunnel_pid) or status.startswith('Z'):
        continue
    if related(pid, worker_pid):
        errors.append({'pid': pid, 'reason': 'unexpected Worker descendant', 'executable': command.split()[0]})
    elif re.search(r'\b(?:worker\.mjs|task-chat|task-relay|task-finalization|finalize-task|startLocalTask|writeLocalTask)\b', command) and (
            'agent-workflow' in command or any(directory in command for directory in roots)):
        errors.append({'pid': pid, 'reason': 'other task or Worker process', 'executable': command.split()[0]})

user = pwd.getpwuid(os.getuid()).pw_name
descriptors = subprocess.check_output(['/usr/sbin/lsof', '-nP', '-a', '-u', user, '-Fpcfatn'], text=True)
seen_worker = False
seen_tunnel = False
current_pid = None
for line in descriptors.splitlines():
    field, value = line[0], line[1:]
    if field == 'p':
        current_pid = int(value)
        seen_worker |= current_pid == worker_pid
        seen_tunnel |= current_pid == tunnel_pid
    elif field == 'c':
        executable = value
    elif field == 'f':
        fd, access = value, None
    elif field == 'a':
        access = value
    elif field == 'n' and access in ('w', 'u') and in_scope(value):
        log = (
            current_pid == worker_pid and value in {str(root / 'worker.stdout.log'), str(root / 'worker.stderr.log')}
        ) or (current_pid == tunnel_pid and value == str(root / 'tunnel.stderr.log'))
        if not log:
            errors.append({'pid': current_pid, 'reason': 'open writable descriptor',
                           'executable': executable, 'fd': fd, 'path': value})
assert seen_worker and seen_tunnel, 'Incomplete descriptor scan'
print(json.dumps({'workerPID': worker_pid, 'residentAppServerPIDs': sorted(helpers),
                  'workspacesChecked': len(set(workspace_roots)), 'writingProcesses': errors}), flush=True)
assert not errors, 'Task or writing process found'
