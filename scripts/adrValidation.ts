import { posix as posixPath } from 'node:path';

export const requiredAdrSections = [
  'Проблема',
  'Факторы и ограничения',
  'Рассмотренные варианты',
  'Решение',
  'Обоснование',
  'Последствия',
  'Проверка',
  'Связанные решения',
  'Условие пересмотра',
] as const;

const requiredMetadata = ['Status', 'Date', 'Owner', 'Decision basis'] as const;
const validStatuses = new Set(['proposed', 'accepted', 'superseded']);
const directionalRelations = new Map([
  ['Supersedes', 'Superseded by'],
  ['Superseded by', 'Supersedes'],
  ['Partially supersedes', 'Partially superseded by'],
  ['Partially superseded by', 'Partially supersedes'],
  ['Extends', 'Extended by'],
  ['Extended by', 'Extends'],
]);
const validRelations = new Set([...directionalRelations.keys(), 'Related']);

export type AdrSource = {
  readonly filename: string;
  readonly content: string;
  readonly path?: string;
};

export type RepositoryDocument = {
  readonly path: string;
  readonly content: string;
};

export type AdrValidationInput = {
  readonly records: readonly AdrSource[];
  readonly indexContent: string;
  readonly documents?: readonly RepositoryDocument[];
};

export type AdrValidationIssue = {
  readonly code: string;
  readonly file: string;
  readonly message: string;
};

type ParsedRelation = {
  readonly kind: string;
  readonly targetId: string;
  readonly targetPath: string;
  readonly scope: string;
};

type ParsedAdr = {
  readonly source: AdrSource;
  readonly id: string | undefined;
  readonly status: string | undefined;
  readonly relations: readonly ParsedRelation[];
};

type IndexEntry = {
  readonly id: string;
  readonly path: string;
  readonly status: string | undefined;
};

function addIssue(issues: AdrValidationIssue[], file: string, code: string, message: string): void {
  issues.push({ code, file, message });
}

function unwrapCode(value: string): string {
  const match = /^`([^`]*)`$/.exec(value.trim());
  return match?.[1] ?? value.trim();
}

function parseMetadata(content: string): ReadonlyMap<string, readonly string[]> {
  const headerEnd = content.indexOf('\n## ');
  const header = content.slice(0, headerEnd < 0 ? undefined : headerEnd);
  const metadata = new Map<string, string[]>();
  let currentKey: string | undefined;

  for (const line of header.split('\n')) {
    const match = /^- \*\*([^*]+):\*\* (.*)$/.exec(line);
    if (match) {
      const [, key, rawValue] = match as RegExpExecArray & {
        readonly 1: string;
        readonly 2: string;
      };
      const values = metadata.get(key) ?? [];
      values.push(rawValue.trim());
      metadata.set(key, values);
      currentKey = key;
      continue;
    }
    if (currentKey && /^ {2,}\S/.test(line)) {
      const values = metadata.get(currentKey)!;
      const lastIndex = values.length - 1;
      values[lastIndex] = `${values[lastIndex]}\n${line.trim()}`;
      continue;
    }
    if (line.trim()) currentKey = undefined;
  }

  return metadata;
}

export function adrMetadataValue(content: string, key: string): string | undefined {
  return parseMetadata(content).get(key)?.[0];
}

export function adrSectionBody(content: string, heading: string): string | undefined {
  const marker = `## ${heading}\n`;
  const start = content.indexOf(marker);
  if (start < 0) return undefined;
  const bodyStart = start + marker.length;
  const next = content.indexOf('\n## ', bodyStart);
  return content.slice(bodyStart, next < 0 ? undefined : next).trim();
}

export function adrHeading(content: string): string | undefined {
  return /^# ADR-\d{4}: \S.+$/m.exec(content)?.[0];
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.toISOString().slice(0, 10) === value;
}

function markdownAnchor(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function documentAnchors(content: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of content.matchAll(/^#{1,6} +(.+)$/gm)) {
    const base = markdownAnchor(match[1]!);
    const count = counts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    counts.set(base, count + 1);
  }
  return anchors;
}

function documentMap(
  input: Pick<AdrValidationInput, 'records' | 'documents'>,
): ReadonlyMap<string, string> {
  const documents = new Map(
    (input.documents ?? []).map((document) => [
      posixPath.normalize(document.path),
      document.content,
    ]),
  );
  for (const record of input.records) {
    const recordPath = record.path ?? `docs/design/decisions/${record.filename}`;
    documents.set(posixPath.normalize(recordPath), record.content);
  }
  return documents;
}

function validateDecisionBasis(
  source: AdrSource,
  basis: string | undefined,
  documents: ReadonlyMap<string, string>,
  issues: AdrValidationIssue[],
): void {
  if (basis === undefined) return;
  if (unwrapCode(basis).length === 0) {
    addIssue(
      issues,
      source.filename,
      'decision-basis-empty',
      'Поле Decision basis не может быть пустым.',
    );
  }
  const links = [...basis.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
  if (links.length === 0) {
    addIssue(
      issues,
      source.filename,
      'decision-basis-link-missing',
      'Decision basis должен содержать Markdown-ссылку на источник решения.',
    );
    return;
  }

  const sourcePath = posixPath.normalize(source.path ?? `docs/design/decisions/${source.filename}`);
  for (const target of links) {
    if (target.startsWith('https://')) {
      try {
        new URL(target);
      } catch {
        addIssue(
          issues,
          source.filename,
          'decision-basis-link-invalid',
          `Некорректная внешняя ссылка Decision basis: ${target}.`,
        );
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) {
      addIssue(
        issues,
        source.filename,
        'decision-basis-link-invalid',
        `Decision basis допускает только относительную ссылку или https://: ${target}.`,
      );
      continue;
    }

    try {
      const hashIndex = target.indexOf('#');
      const rawPath = hashIndex < 0 ? target : target.slice(0, hashIndex);
      const rawAnchor = hashIndex < 0 ? undefined : target.slice(hashIndex + 1);
      const decodedPath = decodeURIComponent(rawPath);
      const targetPath = posixPath.normalize(
        decodedPath ? posixPath.join(posixPath.dirname(sourcePath), decodedPath) : sourcePath,
      );
      const targetContent = documents.get(targetPath);
      if (targetContent === undefined) {
        addIssue(
          issues,
          source.filename,
          'decision-basis-target-missing',
          `Локальная цель Decision basis не существует: ${targetPath}.`,
        );
        continue;
      }
      if (rawAnchor) {
        const anchor = decodeURIComponent(rawAnchor).toLocaleLowerCase();
        if (!documentAnchors(targetContent).has(anchor)) {
          addIssue(
            issues,
            source.filename,
            'decision-basis-anchor-missing',
            `Якорь Decision basis не существует в ${targetPath}: #${rawAnchor}.`,
          );
        }
      }
    } catch {
      addIssue(
        issues,
        source.filename,
        'decision-basis-link-invalid',
        `Некорректная локальная ссылка Decision basis: ${target}.`,
      );
    }
  }
}

export function validateAdrDecisionBasis(
  source: AdrSource,
  documents: readonly RepositoryDocument[] = [],
): readonly AdrValidationIssue[] {
  const issues: AdrValidationIssue[] = [];
  const basis = adrMetadataValue(source.content, 'Decision basis');
  if (basis === undefined) {
    addIssue(issues, source.filename, 'metadata-missing', 'Отсутствует поле Decision basis.');
  }
  validateDecisionBasis(source, basis, documentMap({ records: [source], documents }), issues);
  return issues;
}

function logicalRelationLines(
  source: AdrSource,
  body: string,
  issues: AdrValidationIssue[],
): readonly string[] {
  const blocks: string[] = [];
  let current: string | undefined;
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) {
      if (current) blocks.push(current);
      current = line;
      continue;
    }
    if (current && /^ {2,}\S/.test(line)) {
      current += ` ${line.trim()}`;
      continue;
    }
    if (line.trim()) {
      addIssue(issues, source.filename, 'relation-invalid', `Некорректная связь: ${line}`);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseRelations(
  source: AdrSource,
  body: string | undefined,
  issues: AdrValidationIssue[],
): readonly ParsedRelation[] {
  if (!body || body === 'Связанных ADR нет.') return [];
  const relations: ParsedRelation[] = [];
  const seen = new Set<string>();
  for (const line of logicalRelationLines(source, body, issues)) {
    const match =
      /^- \*\*([^*]+):\*\* \[ADR-(\d{4})\]\((\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\) — (\S.+)$/.exec(
        line,
      );
    if (!match) {
      addIssue(issues, source.filename, 'relation-invalid', `Некорректная связь: ${line}`);
      continue;
    }
    const [, kind, targetId, targetPath, rawScope] = match as RegExpExecArray & {
      readonly 1: string;
      readonly 2: string;
      readonly 3: string;
      readonly 4: string;
    };
    if (!validRelations.has(kind)) {
      addIssue(issues, source.filename, 'relation-invalid', `Некорректная связь: ${line}`);
      continue;
    }
    const key = `${kind}:${targetId}`;
    if (seen.has(key)) {
      addIssue(
        issues,
        source.filename,
        'relation-duplicate',
        `Связь ${kind} с ADR-${targetId} повторяется.`,
      );
      continue;
    }
    seen.add(key);
    relations.push({
      kind,
      targetId,
      targetPath,
      scope: rawScope.replace(/\s+/g, ' ').trim(),
    });
  }
  if (relations.length === 0) {
    addIssue(
      issues,
      source.filename,
      'relation-empty',
      'Раздел связей должен содержать договорную связь или точную фразу об их отсутствии.',
    );
  }
  return relations;
}

function validateRecord(
  source: AdrSource,
  documents: ReadonlyMap<string, string>,
  issues: AdrValidationIssue[],
): ParsedAdr {
  const filenameMatch = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(source.filename);
  if (!filenameMatch) {
    addIssue(
      issues,
      source.filename,
      'filename-invalid',
      'Имя ADR не соответствует NNNN-short-name.md.',
    );
  }
  const id = filenameMatch?.[1];
  const headingMatch = /^# ADR-(\d{4}): (\S.+)$/m.exec(source.content);
  if (!headingMatch) {
    addIssue(issues, source.filename, 'heading-invalid', 'Нет заголовка # ADR-NNNN: решение.');
  } else if (id && headingMatch[1] !== id) {
    addIssue(
      issues,
      source.filename,
      'heading-id-mismatch',
      'Номер заголовка не совпадает с файлом.',
    );
  }

  const metadata = parseMetadata(source.content);
  for (const key of requiredMetadata) {
    const values = metadata.get(key) ?? [];
    if (values.length === 0) {
      addIssue(issues, source.filename, 'metadata-missing', `Отсутствует поле ${key}.`);
    } else if (values.length > 1) {
      addIssue(issues, source.filename, 'metadata-duplicate', `Поле ${key} повторяется.`);
    }
  }

  const status = metadata.get('Status')?.[0];
  const normalizedStatus = status ? unwrapCode(status) : undefined;
  if (normalizedStatus && !validStatuses.has(normalizedStatus)) {
    addIssue(issues, source.filename, 'status-invalid', `Недопустимый статус ${normalizedStatus}.`);
  }
  const date = metadata.get('Date')?.[0];
  if (date && !isRealDate(unwrapCode(date))) {
    addIssue(issues, source.filename, 'date-invalid', `Недопустимая дата ${unwrapCode(date)}.`);
  }
  const owner = metadata.get('Owner')?.[0];
  if (owner !== undefined && unwrapCode(owner).length === 0) {
    addIssue(issues, source.filename, 'owner-empty', 'Поле Owner не может быть пустым.');
  }
  const basis = metadata.get('Decision basis')?.[0];
  validateDecisionBasis(source, basis, documents, issues);

  const headings = [...source.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  let previousIndex = -1;
  for (const heading of requiredAdrSections) {
    const index = headings.indexOf(heading);
    if (index < 0) {
      addIssue(issues, source.filename, 'section-missing', `Отсутствует раздел ${heading}.`);
      continue;
    }
    if (index < previousIndex) {
      addIssue(
        issues,
        source.filename,
        'section-order',
        `Раздел ${heading} расположен не по шаблону.`,
      );
    }
    previousIndex = index;
    if (!adrSectionBody(source.content, heading)) {
      addIssue(issues, source.filename, 'section-empty', `Раздел ${heading} пуст.`);
    }
  }
  const options = adrSectionBody(source.content, 'Рассмотренные варианты');
  if (options && !options.includes('**Выбрано:**')) {
    addIssue(
      issues,
      source.filename,
      'selected-option-missing',
      'В рассмотренных вариантах не отмечен выбранный путь.',
    );
  }

  const relations = parseRelations(
    source,
    adrSectionBody(source.content, 'Связанные решения'),
    issues,
  );
  return { source, id, status: normalizedStatus, relations };
}

function validateNumbers(records: readonly ParsedAdr[], issues: AdrValidationIssue[]): void {
  const byId = new Map<string, ParsedAdr[]>();
  for (const record of records) {
    if (!record.id) continue;
    const sameId = byId.get(record.id) ?? [];
    sameId.push(record);
    byId.set(record.id, sameId);
  }
  for (const [id, matches] of byId) {
    if (matches.length > 1) {
      for (const match of matches) {
        addIssue(issues, match.source.filename, 'number-duplicate', `Номер ADR-${id} повторяется.`);
      }
    }
  }
  const numbers = [...byId.keys()].map(Number).sort((left, right) => left - right);
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1]!;
    if (numbers[index]! !== previous + 1) {
      addIssue(
        issues,
        'docs/design/decisions',
        'number-gap',
        `После ADR-${String(previous).padStart(4, '0')} ожидается следующий номер.`,
      );
    }
  }
}

function parseIndexEntries(
  indexContent: string,
  issues: AdrValidationIssue[],
): readonly IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const line of indexContent.split('\n')) {
    const link = /\[(\d{4})\]\((\d{4}-[^)]+\.md)\)/.exec(line);
    if (!link) continue;
    const [, id, entryPath] = link as RegExpExecArray & {
      readonly 1: string;
      readonly 2: string;
    };
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const linkCell = cells.findIndex((cell) => cell.includes(link[0]));
    const status = linkCell < 0 ? undefined : unwrapCode(cells[linkCell + 1] ?? '');
    if (!status || !validStatuses.has(status)) {
      addIssue(
        issues,
        'README.md',
        'index-status-invalid',
        `${entryPath} должен иметь статус proposed, accepted или superseded в указателе.`,
      );
    }
    entries.push({ id, path: entryPath, status });
  }
  return entries;
}

function validateIndex(
  records: readonly ParsedAdr[],
  indexContent: string,
  issues: AdrValidationIssue[],
): void {
  const entries = parseIndexEntries(indexContent, issues);
  const recordPaths = new Set(records.map((record) => record.source.filename));
  for (const record of records) {
    const matches = entries.filter((entry) => entry.path === record.source.filename);
    if (matches.length === 0) {
      addIssue(
        issues,
        'README.md',
        'index-missing',
        `${record.source.filename} отсутствует в указателе.`,
      );
    } else if (matches.length > 1) {
      addIssue(
        issues,
        'README.md',
        'index-duplicate',
        `${record.source.filename} повторяется в указателе.`,
      );
    } else {
      const [entry] = matches;
      if (record.id && entry!.id !== record.id) {
        addIssue(
          issues,
          'README.md',
          'index-id-mismatch',
          `${record.source.filename} имеет неверную подпись.`,
        );
      }
      if (
        entry!.status &&
        validStatuses.has(entry!.status) &&
        record.status &&
        entry!.status !== record.status
      ) {
        addIssue(
          issues,
          'README.md',
          'index-status-mismatch',
          `${record.source.filename} имеет статус ${entry!.status} вместо ${record.status}.`,
        );
      }
    }
  }
  for (const entry of entries) {
    if (!recordPaths.has(entry.path)) {
      addIssue(
        issues,
        'README.md',
        'index-unknown',
        `${entry.path} не соответствует существующему ADR.`,
      );
    }
  }
  const ids = entries.map((entry) => Number(entry.id));
  if (ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
    addIssue(issues, 'README.md', 'index-order', 'Указатель ADR должен быть упорядочен по номеру.');
  }
}

function validateRelations(records: readonly ParsedAdr[], issues: AdrValidationIssue[]): void {
  const byId = new Map(records.filter((record) => record.id).map((record) => [record.id!, record]));
  const comparedScopes = new Set<string>();
  for (const record of records) {
    for (const relation of record.relations) {
      if (relation.targetId === record.id) {
        addIssue(
          issues,
          record.source.filename,
          'relation-self',
          `ADR-${relation.targetId} не может ссылаться на себя через ${relation.kind}.`,
        );
        continue;
      }
      const target = byId.get(relation.targetId);
      if (!target) {
        addIssue(
          issues,
          record.source.filename,
          'relation-target-missing',
          `Связь указывает на отсутствующий ADR-${relation.targetId}.`,
        );
        continue;
      }
      if (relation.targetPath !== target.source.filename) {
        addIssue(
          issues,
          record.source.filename,
          'relation-path-mismatch',
          `Путь связи с ADR-${relation.targetId} не совпадает с именем файла.`,
        );
      }
      const reverseKind = directionalRelations.get(relation.kind);
      const reverse = reverseKind
        ? target.relations.find(
            (candidate) => candidate.kind === reverseKind && candidate.targetId === record.id,
          )
        : undefined;
      if (reverseKind && !reverse) {
        addIssue(
          issues,
          record.source.filename,
          'relation-reverse-missing',
          `Для ${relation.kind} с ADR-${relation.targetId} нет обратной связи ${reverseKind}.`,
        );
      }
      if (reverse) {
        const scopeKey = [record.id, relation.targetId, relation.kind, reverse.kind]
          .sort()
          .join(':');
        if (!comparedScopes.has(scopeKey) && relation.scope !== reverse.scope) {
          addIssue(
            issues,
            record.source.filename,
            'relation-scope-mismatch',
            `Область ${relation.kind} с ADR-${relation.targetId} не совпадает с обратной связью.`,
          );
        }
        comparedScopes.add(scopeKey);
      }
      if (relation.kind === 'Supersedes') {
        if (record.id && Number(record.id) <= Number(relation.targetId)) {
          addIssue(
            issues,
            record.source.filename,
            'relation-direction-invalid',
            `Supersedes должен указывать на ADR с меньшим номером, чем ADR-${record.id}.`,
          );
        }
        const expected = record.status === 'proposed' ? 'accepted' : 'superseded';
        if (target.status !== expected) {
          addIssue(
            issues,
            record.source.filename,
            'relation-status-invalid',
            `ADR-${relation.targetId} должен иметь статус ${expected}.`,
          );
        }
      }
      if (
        (relation.kind === 'Partially supersedes' || relation.kind === 'Extends') &&
        target.status !== 'accepted'
      ) {
        addIssue(
          issues,
          record.source.filename,
          'relation-status-invalid',
          `ADR-${relation.targetId} должен оставаться accepted для связи ${relation.kind}.`,
        );
      }
    }

    const replacements = record.relations.filter((relation) => relation.kind === 'Superseded by');
    if (replacements.length > 1) {
      addIssue(
        issues,
        record.source.filename,
        'relation-multiple-replacements',
        'ADR может иметь только одну связь Superseded by.',
      );
    }
    if (record.status === 'superseded' && replacements.length === 0) {
      addIssue(
        issues,
        record.source.filename,
        'superseded-without-replacement',
        'Статус superseded требует связи Superseded by.',
      );
    }
  }
}

export function validateAdrJournal(input: AdrValidationInput): readonly AdrValidationIssue[] {
  const issues: AdrValidationIssue[] = [];
  const documents = documentMap(input);
  const records = input.records.map((source) => validateRecord(source, documents, issues));
  validateNumbers(records, issues);
  validateIndex(records, input.indexContent, issues);
  validateRelations(records, issues);
  return issues;
}

export function formatAdrValidationReport(issues: readonly AdrValidationIssue[]): string {
  if (issues.length === 0) return 'ADR journal: valid';
  return [
    'ADR journal: invalid',
    ...issues.map((issue) => `- ${issue.file}: ${issue.message} [${issue.code}]`),
  ].join('\n');
}
