// Emit a launchd job for the existing checkout; installation is an operator action.
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const [worker, host, port] = process.argv.slice(2);
if (!worker || !isAbsolute(worker) || !host || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
  throw Error('Укажите абсолютный путь worker.json, SSH_HOST и SSH_PORT');
}
const script = fileURLToPath(new URL('sync.sh', import.meta.url));
const config = {
  Label: 'com.krivega.agent-workflow.mobile-catalog',
  ProgramArguments: ['/bin/sh', script, worker, host, port],
  EnvironmentVariables: { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' },
  StartInterval: 60,
  RunAtLoad: true,
  StandardErrorPath: dirname(worker) + '/mobile-catalog.stderr.log',
};
process.stdout.write(
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], {
    input: JSON.stringify(config),
  }),
);
