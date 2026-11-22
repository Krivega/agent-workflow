import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireWorkflow, textField } from '../../core/connection.js';
import { safeDirectory, readPrivateFile } from '../storage/storeFiles.js';
import type { ChatCheckRequest } from './chatChecks.js';

export interface NativeStartup {
  engine: string;
  project: string;
  driver: string;
  id: string;
}

export async function nativeStartupChecks(startup: NativeStartup): Promise<ChatCheckRequest[]> {
  const project = safeDirectory(startup.project);
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(startup.id), 'invalid-native-startup-id');
  textField(startup.engine);
  textField(startup.driver);
  const config = readPrivateFile(resolve(project, 'project.godot')).toString('utf8');
  const editor = /^\[editor\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/mu.exec(config)?.[1];
  requireWorkflow(
    editor !== undefined && /^import\/use_multiple_threads=false\r?$/mu.test(editor),
    'native-import-must-be-single-threaded',
  );
  const files = [startup.engine];
  const visit = async (directory: string) => {
    safeDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.godot') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  };
  await visit(project);
  return [
    { name: 'engine', args: ['--version'] },
    { name: 'import', args: ['--headless', '--path', project, '--import'] },
    {
      name: 'graphics',
      args: ['--path', project, '--rendering-driver', startup.driver, '--quit-after', '2'],
    },
  ].map(({ name, args }) => ({
    id: `${startup.id}-${name}`,
    criterion: `startup-${name}`,
    command: { file: startup.engine, args },
    discovery: { files, directories: [] },
    attested_by: 'Native startup prerequisites',
    reject_output: ['SCRIPT ERROR', 'ERROR:'],
  }));
}
