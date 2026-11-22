import { describe, expect, it } from 'vitest';
import { formatDocumentationReport, validateDocumentation } from './documentationValidation';
import type { DocumentationSource } from './documentationValidation';

const source = (path: string, content: string): DocumentationSource => ({ path, content });
const check = (documents: readonly DocumentationSource[], files: readonly string[] = []) =>
  validateDocumentation({
    documents,
    files: [...documents.map((document) => document.path), ...files],
    scripts: ['validate', 'lint:docs'],
  });

const historicalStart = '<!-- documentation-check: historical:start -->';
const historicalEnd = '<!-- documentation-check: historical:end -->';

describe('documentation validation', () => {
  it('checks relative targets, Unicode and duplicate anchors, explicit IDs, images and directories', () => {
    const report = check(
      [
        source(
          'docs/guide.md',
          '# Guide\n[local](#guide) [empty]() [section](../target.md?view=1#привет-api)\n[duplicate](../target.md#repeat-1) [collision](../target.md#repeat-1-1)\n[HTML](../target.md#custom) [named](../target.md#named)\n[setext](../target.md#underlined) [folder](../assets) ![image](../assets/image.png)\n[`code label`](../target.md) [angle](<../space%20file.md#space-file>) [encoded path](../hash%23file%3F.md#target)',
        ),
        source(
          'target.md',
          '# Привет, `API`!\n## Repeat\n## Repeat\n## Repeat-1\n<a id="custom"></a>\n<a name=\'named\'></a>\nUnderlined\n===\n## **Bold** [link](https://example.test) ###',
        ),
        source('space file.md', '# Space file'),
        source('hash#file?.md', '# Target'),
      ],
      ['assets/image.png'],
    );
    expect(report.issues).toEqual([]);
    expect(report.localLinks).toBe(13);
    expect(report.currentDocuments).toBe(4);
    expect(formatDocumentationReport(report)).toContain('Documentation: valid');
  });

  it('resolves full, collapsed and shortcut reference links including angle destinations', () => {
    const report = check(
      [
        source(
          'README.md',
          '[text][ ID ] [id][] [id] ![image][img]\n[id]: <target.md#target> "Title"\n[img]: image.png\n[ordinary](target.md) [not a reference]',
        ),
        source('target.md', '# Target'),
      ],
      ['image.png'],
    );
    expect(report.issues).toEqual([]);
    expect(report.localLinks).toBe(7);
  });

  it('reports broken targets and anchors with exact lines and rejects malformed URLs or repository escape', () => {
    const report = check(
      [
        source(
          'README.md',
          '[missing](missing.md)\n[anchor](target.md#absent)\n[escape](../outside.md)\n[malformed](bad%ZZ.md)\n[code](code.ts#L1)\n[encoded](target.md#%54arget)',
        ),
        source('target.md', '# Target'),
      ],
      ['code.ts', '../outside.md'],
    );
    expect(report.issues.map((issue) => [issue.file, issue.line, issue.message])).toEqual([
      ['README.md', 1, 'Не найдена локальная цель: missing.md'],
      ['README.md', 2, 'Не найден якорь: target.md#absent'],
      ['README.md', 3, 'Не найдена локальная цель: ../outside.md'],
      ['README.md', 4, 'Некорректное кодирование ссылки: bad%ZZ.md'],
      ['README.md', 6, 'Не найден якорь: target.md#%54arget'],
    ]);
    expect(formatDocumentationReport(report)).toContain('README.md:2: Не найден якорь');
  });

  it('does not read external URLs or absolute evidence locators and exempts only template placeholders', () => {
    const report = check([
      source(
        'README.md',
        '[web](https://example.test/missing#x) [mail](mailto:user@example.test) [primary](/Users/user/proof.json)\n[not-template](0000-example.md)',
      ),
      source('docs/design/decisions/_template.md', '[example](0000-example.md) [real](missing.md)'),
      source('examples/template.md', '[example]({{PATH}})'),
    ]);
    expect(report.externalLinks).toBe(3);
    expect(report.templateLinks).toBe(2);
    expect(report.issues.map((issue) => issue.file)).toEqual([
      'README.md',
      'docs/design/decisions/_template.md',
    ]);
  });

  it('ignores code and comments as links or headings while preserving inline code link labels', () => {
    const report = check([
      source(
        'README.md',
        [
          '# Actual',
          '`[quoted](missing.md)` \\[escaped](missing.md)',
          '<!-- [hidden](missing.md)',
          '# Comment heading',
          '-->',
          '```json',
          '# Fake',
          '[fake](missing.md)',
          '```',
          '```sh',
          '# Shell',
          '[fake](missing.md)',
          '```',
          '~~~',
          '# Also fake',
          '[fake](missing.md)',
          '~~~',
          '[`actual`](#actual)',
          '[missing](#fake)',
        ].join('\n'),
      ),
    ]);
    expect(report.issues).toEqual([
      { file: 'README.md', line: 19, message: 'Не найден якорь: #fake' },
    ]);
    expect(report.localLinks).toBe(2);
  });

  it('validates only documented inline and shell yarn commands, including flags, run and builtins', () => {
    const report = check([
      source(
        'README.md',
        [
          '`yarn validate` and `yarn --silent lint:docs`',
          '`yarn run validate` `yarn install --frozen-lockfile` `yarn node file.mjs` `yarn exec tool` `yarn pack` `yarn version` `yarn run`',
          'yarn prose-is-not-a-command <!-- `yarn hidden` -->',
          '```json',
          '{"command":"yarn not-a-command"}',
          '```',
          '```bash',
          'MODE=local yarn --offline --frozen-lockfile --ignore-scripts --non-interactive --verbose validate',
          'yarn missing:script && yarn lint:docs',
          '```',
          '`yarn also-missing`',
          '```console',
          '$ yarn validate',
          '```',
        ].join('\n'),
      ),
    ]);
    expect(report.issues).toEqual([
      {
        file: 'README.md',
        line: 9,
        message: 'Неизвестная команда package.json: yarn missing:script',
      },
      {
        file: 'README.md',
        line: 11,
        message: 'Неизвестная команда package.json: yarn also-missing',
      },
    ]);
  });

  it('checks links but not script names of explicitly identified project-consumer commands', () => {
    const report = check([
      source(
        'README.md',
        'Команда проекта-потребителя G `yarn agent-workflow:consumer:check` [guide](missing.md)\n`yarn actual:missing`',
      ),
    ]);
    expect(report.consumerCommands).toBe(1);
    expect(report.issues).toEqual([
      { file: 'README.md', line: 1, message: 'Не найдена локальная цель: missing.md' },
      {
        file: 'README.md',
        line: 2,
        message: 'Неизвестная команда package.json: yarn actual:missing',
      },
    ]);
  });

  it('separates immutable history but checks current indexes and links into historical sources', () => {
    const documents = [
      source(
        'docs/design/decisions/inherited/0001.md',
        '[old](missing.md) `yarn old`\n# Old anchor',
      ),
      source('docs/design/decisions/sources/basis.md', '`yarn old`'),
      source('tests/fixtures/qualification/v1/README.md', '[old](missing.md)'),
      source('docs/exec-plans/completed/old.md', '[old](missing.md)'),
      source('docs/exec-plans/cancelled/old.md', '`yarn old`'),
      source('docs/exec-plans/completed/README.md', '[missing](missing.md)'),
      source('README.md', '[history](docs/design/decisions/inherited/0001.md#old-anchor)'),
    ];
    const report = check(documents);
    expect(report.historicalDocuments).toBe(5);
    expect(report.currentDocuments).toBe(2);
    expect(report.issues).toEqual([
      {
        file: 'docs/exec-plans/completed/README.md',
        line: 1,
        message: 'Не найдена локальная цель: missing.md',
      },
    ]);
  });

  it('keeps historical command exclusions narrow and checks links inside historical command blocks', () => {
    const report = check([
      source(
        'README.md',
        [
          'историческая команда G `yarn validate:old`',
          historicalStart,
          '`yarn old` [broken](missing.md)',
          '```sh',
          'yarn old',
          '```',
          historicalEnd,
          '`yarn current:missing`',
        ].join('\n'),
      ),
    ]);
    expect(report.issues).toEqual([
      { file: 'README.md', line: 3, message: 'Не найдена локальная цель: missing.md' },
      {
        file: 'README.md',
        line: 8,
        message: 'Неизвестная команда package.json: yarn current:missing',
      },
    ]);
  });

  it('rejects unbalanced historical markers and ignores markers quoted in fenced examples', () => {
    const report = check([
      source(
        'README.md',
        [
          historicalEnd,
          historicalStart,
          historicalStart,
          historicalEnd,
          '```text',
          historicalStart,
          '```',
          '`yarn missing`',
          historicalStart,
        ].join('\n'),
      ),
    ]);
    expect(report.issues).toEqual([
      { file: 'README.md', line: 1, message: 'Исторический блок команд не был открыт.' },
      { file: 'README.md', line: 3, message: 'Вложенный исторический блок команд.' },
      { file: 'README.md', line: 9, message: 'Исторический блок команд не закрыт.' },
      { file: 'README.md', line: 8, message: 'Неизвестная команда package.json: yarn missing' },
    ]);
  });

  it('requires a matching fence character and length before ending shell examples', () => {
    const report = check([
      source(
        'README.md',
        '````shell\n```\nyarn validate\n~~~~\nyarn validate\n````not-a-close\nyarn missing\n````\n`yarn validate`',
      ),
    ]);
    expect(report.issues).toEqual([
      { file: 'README.md', line: 7, message: 'Неизвестная команда package.json: yarn missing' },
    ]);
  });
});
