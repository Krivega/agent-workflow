import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

// Only disposable unit-test files live here. Integration servers, the source
// tree and validation reports keep their ordinary storage.
export default function setup(project) {
  if (
    process.platform !== 'darwin' ||
    process.env.VITEST_WORKER_ID ||
    !project.vitest.config.coverage.enabled ||
    totalmem() < 16 * 1024 ** 3
  )
    return;
  const root = mkdtempSync('/private/tmp/aw-vitest-');
  const mount = join(root, 'volume');
  const run = (command, args, input) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const field = (args, key) =>
    run('/usr/bin/plutil', ['-extract', key, 'raw', '-'], run('/usr/sbin/diskutil', args));
  const previousEnv = project.config.env;
  let device;
  let mounted = false;
  function cleanup() {
    if (mounted) {
      run('/sbin/umount', [mount]);
      mounted = false;
    }
    if (device) {
      run('/usr/bin/hdiutil', ['detach', device]);
      device = undefined;
    }
    rmdirSync(mount);
    rmdirSync(root);
  }
  mkdirSync(mount);
  try {
    // Allow the 513 MiB file-size probe to overlap the 1 GiB free-space check.
    const sectors = (2 * 1024 ** 3) / 512;
    const attached = run('/usr/bin/hdiutil', ['attach', '-nomount', `ram://${sectors}`]);
    if (!/^\/dev\/disk\d+$/.test(attached))
      throw new Error('Unexpected RAM disk identifier: ' + attached);
    device = attached;
    run('/sbin/newfs_apfs', [
      '-U',
      String(process.getuid()),
      '-G',
      String(process.getgid()),
      '-v',
      'WorkflowTests',
      device,
    ]);
    const container = field(['info', '-plist', device], 'APFSContainerReference');
    const volume = field(
      ['apfs', 'list', '-plist', container],
      'Containers.0.Volumes.0.DeviceIdentifier',
    );
    run('/sbin/mount', ['-t', 'apfs', '-o', 'nobrowse,nodev,nosuid', '/dev/' + volume, mount]);
    mounted = true;
    writeFileSync(join(mount, '.metadata_never_index'), '');
    project.config.env = { ...project.config.env, TMPDIR: mount };
    console.log('Vitest: временные файлы unit-тестов в памяти (2 ГиБ).');
  } catch (error) {
    cleanup();
    console.warn('Vitest использует системный временный каталог:', error.message);
    return;
  }
  function onExit() {
    try {
      cleanup();
    } catch (error) {
      console.error(`Не удалось отключить временный том ${device} в ${mount}:`, error.message);
      process.exitCode = 1;
    }
  }
  process.once('exit', onExit);
  return () => {
    project.config.env = previousEnv;
    cleanup();
    process.off('exit', onExit);
  };
}
