import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import pilot

ROW = dict(path='a.ts', symbol='symbol', role='reader', line=1, explanation='reads state')
TEXT = json.dumps(dict(rows=[ROW], unknowns=['device']))


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.context = self.root / 'context'
        self.context.mkdir()
        (self.context / 'a.ts').write_text('export const symbol = 1;\n')

    def test_inputs_and_evaluation(self):
        self.assertEqual(pilot.answer(TEXT)['rows'], [ROW])
        original = pilot.manifest(self.context)
        self.assertEqual(len(original), 1)
        (self.context / 'link').symlink_to('a.ts')
        with self.assertRaises(ValueError): pilot.manifest(self.context)
        invalids = [{}, dict(rows=[],unknowns=[]),dict(rows=[ROW],unknowns='bad'),
                    dict(rows=[ROW],unknowns=[1]),dict(rows=[{}],unknowns=[])]
        for row in [dict(ROW,path=''),dict(ROW,symbol=3),dict(ROW,role='bad'),dict(ROW,line=True),dict(ROW,line=0)]:
            invalids.append(dict(rows=[row],unknowns=[]))
        for value in invalids:
            with self.subTest(value=value),self.assertRaises(ValueError):pilot.answer(json.dumps(value))
        with self.assertRaises(ValueError):pilot.answer('not json')
        rows = [ROW, ROW, dict(ROW,path='../secret'),dict(ROW,path='missing.ts'),
                dict(ROW,line=50),dict(ROW,symbol='not_here'),dict(ROW,role='writer')]
        report=pilot.evaluate(json.dumps(dict(rows=rows,unknowns=[])),self.context,[ROW,dict(ROW,symbol='missing')])
        self.assertEqual((report['found'],report['total']), (1,2))
        self.assertEqual(len(report['invalid']),4)
        self.assertEqual(len(report['duplicates']),1)
        self.assertEqual(len(report['additional']),1)

    def test_historical_artifacts_remain_readable(self):
        path = self.root / 'answer.json'
        pilot.dump(path, json.loads(TEXT))
        self.assertEqual(pilot.answer(path.read_text())['rows'], [ROW])
        self.assertEqual(len(pilot.digest(path.read_bytes())), 64)
        report = pilot.evaluate(path.read_text(), self.context, [ROW])
        self.assertEqual(report['found'], report['total'])
        self.assertEqual(report['semantic_review'], 'required')

    def test_direct_launchers_refuse_before_read_write_or_process(self):
        before = pilot.manifest(self.root)
        with patch('subprocess.Popen') as process:
            for action in [lambda: pilot.Broker(self.root, self.root / 'missing-repo', '/codex', [], []),
                           lambda: pilot.Broker.call(None, self.context, 'task'),
                           lambda: pilot.Broker.invoke(None, ['/codex'], self.root),
                           lambda: pilot.run(self.root / 'output', self.root, self.root / 'upstream',
                                             '/codex', 'HEAD', self.root / 'oracle.json')]:
                with self.assertRaisesRegex(RuntimeError, pilot.DISABLED):
                    action()
            process.assert_not_called()
        self.assertEqual(pilot.manifest(self.root), before)

    def test_main(self):
        args = ['pilot', '--root', 'output', '--repo', 'missing', '--upstream', 'missing',
                '--oracle', 'missing', '--ref', 'HEAD', '--binary', 'missing']
        with patch.object(sys, 'argv', args), self.assertRaisesRegex(RuntimeError, pilot.DISABLED):
            pilot.main()
        with patch.object(sys, 'argv', ['pilot', '--help']), self.assertRaises(SystemExit) as caught:
            runpy.run_path(str(Path(pilot.__file__)), run_name='__main__')
        self.assertEqual(caught.exception.code, 0)

    def test_command_refuses_without_touching_existing_evidence(self):
        (self.root / 'FAIL.json').write_text('{"outcome":"unknown"}')
        before = pilot.manifest(self.root)
        result = subprocess.run([sys.executable, str(Path(pilot.__file__).resolve()),
            '--root', str(self.root), '--repo', 'missing', '--upstream', 'missing',
            '--oracle', 'missing', '--ref', 'HEAD', '--binary', 'missing'],
            cwd=self.root, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(pilot.DISABLED, result.stderr)
        self.assertEqual(pilot.manifest(self.root), before)


if __name__ == '__main__':
    unittest.main()
