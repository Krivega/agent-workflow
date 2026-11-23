"""Offline switch regression. No launchd job, server or model is started."""
import contextlib
import hashlib
import io
import json
import plistlib
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import update


class WorkerUpdateTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.host = self.home / 'host'
        self.package = self.host / 'release/package'
        self.worker = self.package / 'examples/temporal-host/worker.mjs'
        self.worker.parent.mkdir(parents=True)
        self.worker.write_text('old')
        (self.package / 'package.json').write_text('{"name":"@krivega/agent-workflow"}')
        (self.package / 'node_modules').mkdir()
        lock = self.package / 'yarn.lock'
        lock.write_text('locked')
        plist = self.home / 'Library/LaunchAgents' / (update.LABEL + '.plist')
        plist.parent.mkdir(parents=True)
        plist.write_bytes(plistlib.dumps(dict(Label=update.LABEL, ProgramArguments=[
            'node', str(self.worker), '--run', str(self.host)])))
        (self.host / 'state').mkdir()
        self.owner = self.host / 'state/host-owner'
        self.owner.write_text('{"pid":1}')
        (self.host / 'worker.json').write_text(json.dumps(dict(projects=[],
            codexHome=str(self.home), codexBinary='/bin/false')))
        self.args = SimpleNamespace(archive=self.home / 'candidate.tgz', lockfile=lock,
                                    host=self.host, apply=True, receipt=self.home / 'result',
                                    artifacts=self.host / 'artifacts')
        new = self.home / 'worker.mjs'
        new.write_text('updated')
        with tarfile.open(self.args.archive, 'w:gz') as tar:
            tar.add(new, 'package/examples/temporal-host/worker.mjs')
            tar.add(self.package / 'package.json', 'package/package.json')
        self.args.sha256 = hashlib.sha256(self.args.archive.read_bytes()).hexdigest()

    def switch(self, busy=False):
        commands = []
        real_run = update.subprocess.run

        def run(argv, **kwargs):
            commands.append(argv)
            if argv[0] == 'rsync':
                return real_run(argv, **kwargs)
            if update.TOOLS / 'verify-temporal.mjs' in argv and busy:
                raise RuntimeError('active workflow')
            if 'bootout' in argv:
                self.owner.unlink()
            if 'bootstrap' in argv:
                self.owner.write_text('{"pid":2}')

        def output(*argv):
            if 'state' in argv:
                return '{"state":{},"registrations":{}}'
            return '{"projects":1}'

        with tempfile.TemporaryDirectory(dir=self.home) as scratch, \
                patch.object(Path, 'home', return_value=self.home), \
                patch.object(update, 'job_pid', side_effect=lambda label: json.loads(self.owner.read_text())['pid']), \
                patch.object(update, 'output', side_effect=output), \
                patch.object(update.os, 'kill', side_effect=ProcessLookupError), \
                patch.object(update.subprocess, 'run', side_effect=run):
            update.update(self.args, Path(scratch))
        return commands

    def test_switch_and_repeat(self):
        commands = self.switch()
        self.assertTrue(any('bootstrap' in c for c in commands))
        self.assertEqual(self.worker.read_text(), 'updated')
        self.assertFalse(any('bootout' in c for c in self.switch()))

    def test_apply_requires_target_run_inputs_before_opening_host(self):
        arguments = ['update.py', 'candidate.tgz', '0' * 64, '--apply']
        for options in [[], ['--receipt', 'result.json'], ['--artifacts', 'artifacts']]:
            with self.subTest(options=options), \
                    patch.object(update.sys, 'argv', arguments + options), \
                    patch.object(update.os, 'open') as open_host, \
                    contextlib.redirect_stderr(io.StringIO()) as error, \
                    self.assertRaises(SystemExit) as exit_result:
                update.main()
            self.assertEqual(exit_result.exception.code, 2)
            self.assertIn('--apply requires --receipt and --artifacts', error.getvalue())
            open_host.assert_not_called()

    def test_preflight_refusals_leave_worker_and_package_intact(self):
        with self.assertRaisesRegex(RuntimeError, 'active workflow'):
            self.switch(busy=True)
        self.args.sha256 = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            self.switch()
        self.assertEqual(self.worker.read_text(), 'old')
        self.assertEqual(self.owner.read_text(), '{"pid":1}')


if __name__ == '__main__':
    unittest.main()
