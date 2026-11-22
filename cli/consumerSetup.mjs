import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProject } from '../dist/contracts/project.js';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const skill = '.agents/skills/agent-workflow/SKILL.md';
const descriptor = 'tools/agent-workflow/project/temporal.json';
const reviewer = 'tools/agent-workflow/roles/architect.md';
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));

function projectPath(root, relative, kind, create = false) {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const directory = index < parts.length - 1 || kind === 'directory';
    if (directory && create) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && !directory && create) return current;
    if (!(directory ? stat?.isDirectory() : stat?.isFile()))
      throw Error('Проверьте путь проекта: ' + current);
  }
  return current;
}

function seed(root, path, content) {
  const target = projectPath(root, path, 'file', true);
  try {
    writeFileSync(target, content, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export function setupConsumer(action, cwd) {
  const root = realpathSync(cwd);
  const metadata = load(projectPath(root, 'package.json', 'file'));
  const installed = createRequire(join(root, 'package.json')).resolve(
    '@krivega/agent-workflow/contracts',
  );
  if (realpathSync(installed) !== realpathSync(join(runtime, 'dist/contracts/project.js')))
    throw Error('Запустите CLI версии @krivega/agent-workflow, установленной в проекте.');
  const shared = readFileSync(join(runtime, skill), 'utf8');
  const profile = readFileSync(join(runtime, 'roles/architect.md'), 'utf8');
  for (const procedure of load(join(runtime, 'project/workflow.json')).procedures) {
    const bytes = readFileSync(join(runtime, procedure.locator));
    if (createHash('sha256').update(bytes).digest('hex') !== procedure.hash)
      throw Error('Изменилась процедура пакета: ' + procedure.locator);
  }
  const standardDescriptor = 'project/temporal.json';
  const local = [descriptor, standardDescriptor].filter((path) =>
    lstatSync(join(root, path), { throwIfNoEntry: false }),
  );
  if (local.length > 1) throw Error('Найдены два дескриптора Temporal: ' + local.join(', '));
  const path = local[0] ?? descriptor;
  if (action === 'init' && !local.length) {
    const check = ['validate', 'test'].find(
      (key) => typeof metadata.scripts?.[key] === 'string' && metadata.scripts[key].trim(),
    );
    if (!check)
      throw Error('Добавьте команду validate или test либо собственный дескриптор Temporal.');
    const id = (metadata.name || basename(root)).split('/').pop();
    const project = parseProject({
      schemaVersion: 1,
      projectId: id,
      workspaceId: 'main',
      rules: ['AGENTS.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'architecture', profile: reviewer }],
      checks: [check],
    });
    seed(
      root,
      'AGENTS.md',
      '# Правила проекта\n\nВыполняй проверки, указанные в дескрипторе проекта.\n',
    );
    seed(root, reviewer, profile);
    projectPath(root, project.cardRoot, 'directory', true);
    seed(root, path, JSON.stringify(project, null, 2) + '\n');
  }
  const config = parseProject(load(projectPath(root, path, 'file')));
  projectPath(root, config.cardRoot, 'directory');
  for (const file of [...config.rules, ...config.roles.map((role) => role.profile)])
    projectPath(root, file, 'file');
  for (const check of config.checks)
    if (typeof metadata.scripts?.[check] !== 'string' || !metadata.scripts[check].trim())
      throw Error('В package.json отсутствует команда: ' + check);
  if (action === 'init') {
    const frontmatter = /^---\n[\s\S]*?\n---\n/u.exec(shared);
    if (!frontmatter) throw Error('Недействительный общий навык agent-workflow');
    seed(
      root,
      skill,
      frontmatter[0] +
        '\nСледуй общему навыку из пакета `@krivega/agent-workflow` (' +
        skill +
        ') и его `CURRENT-CHAT.md`. Корень пакета найди по установленной зависимости проекта. ' +
        'Рабочий дескриптор проекта — `' +
        path +
        '`.\n',
    );
  }
  const entry = readFileSync(projectPath(root, skill, 'file'), 'utf8');
  if (!/^---\r?\n[\s\S]*?^name:\s*agent-workflow\s*$[\s\S]*?^---\s*$/mu.test(entry))
    throw Error('Проверьте имя навыка в ' + skill);
  if (entry.includes('@agent-workflow/runtime') && !entry.includes('@krivega/agent-workflow'))
    throw Error('Обновите ссылку на пакет в ' + skill + ': @krivega/agent-workflow');
  return {
    version: load(join(runtime, 'package.json')).version,
    descriptor: path,
    skill,
    projectId: config.projectId,
  };
}
