import {
  adrMetadataValue,
  formatAdrValidationReport,
  requiredAdrSections,
  validateAdrJournal,
  type AdrSource,
} from './adrValidation.js';

type FixtureOptions = {
  readonly id?: string;
  readonly filename?: string;
  readonly status?: string;
  readonly date?: string;
  readonly owner?: string;
  readonly basis?: string;
  readonly relations?: string;
};

function makeAdr(options: FixtureOptions = {}): AdrSource {
  const id = options.id ?? '0003';
  const filename = options.filename ?? `${id}-decision.md`;
  const sectionBodies: Record<(typeof requiredAdrSections)[number], string> = {
    Проблема: 'Нужно выбрать устойчивую границу.',
    'Факторы и ограничения': 'Решение должно работать без сети.',
    'Рассмотренные варианты':
      '- **Выбрано:** использовать явный порт.\n- **Не выбрано:** связать домен с платформой.',
    Решение: 'Использовать явный порт.',
    Обоснование: 'Порт сохраняет независимость домена.',
    Последствия: 'Появляется один небольшой адаптер.',
    Проверка: '`yarn validate`.',
    'Связанные решения': options.relations ?? 'Связанных ADR нет.',
    'Условие пересмотра': 'Пересмотреть при втором несовместимом потребителе.',
  };
  const sections = requiredAdrSections
    .map((heading) => `## ${heading}\n\n${sectionBodies[heading]}`)
    .join('\n\n');
  return {
    filename,
    content: [
      `# ADR-${id}: использовать явный порт`,
      '',
      `- **Status:** \`${options.status ?? 'accepted'}\``,
      `- **Date:** \`${options.date ?? '2026-09-19'}\``,
      `- **Owner:** ${options.owner ?? 'domain team'}`,
      `- **Decision basis:** ${options.basis ?? '[approval](https://example.test/decision)'}`,
      '',
      sections,
      '',
    ].join('\n'),
  };
}

function makeIndex(records: readonly AdrSource[]): string {
  return records
    .map((record) => {
      const id = record.filename.slice(0, 4);
      const status = /^- \*\*Status:\*\* `([^`]+)`$/m.exec(record.content)?.[1] ?? 'accepted';
      return `| Area | [${id}](${record.filename}) | \`${status}\` |`;
    })
    .join('\n');
}

function codes(records: readonly AdrSource[], indexContent = makeIndex(records)): Set<string> {
  return new Set(validateAdrJournal({ records, indexContent }).map((issue) => issue.code));
}

describe('adrValidation', () => {
  it('accepts a complete journal and formats the success report', () => {
    const record = makeAdr();

    const issues = validateAdrJournal({ records: [record], indexContent: makeIndex([record]) });

    expect(issues).toEqual([]);
    expect(formatAdrValidationReport(issues)).toBe('ADR journal: valid');
  });

  it('reports malformed identity, metadata, date, and required sections', () => {
    const malformed = makeAdr({
      filename: 'decision.md',
      date: '2026-02-30',
      owner: '``',
      basis: '``',
    })
      .content.replace('# ADR-0003: использовать явный порт', '# Решение')
      .replace('- **Status:** `accepted`', '- **Status:** `принято`\n- **Status:** `accepted`')
      .replace('- **Date:** `2026-02-30`', '- **Date:** `2026-02-30`\n- **Date:** `2026-09-19`')
      .replace('## Проблема\n\nНужно выбрать устойчивую границу.\n\n', '')
      .replace('## Факторы и ограничения', '## Решение временно')
      .replace('## Решение\n\nИспользовать явный порт.', '## Решение\n\n');
    const source = { filename: 'decision.md', content: malformed };
    const result = codes([source], '');

    expect(result).toEqual(
      new Set([
        'filename-invalid',
        'heading-invalid',
        'metadata-duplicate',
        'status-invalid',
        'date-invalid',
        'owner-empty',
        'decision-basis-empty',
        'decision-basis-link-missing',
        'section-missing',
        'section-empty',
        'index-missing',
      ]),
    );
  });

  it('reports invalid scalar metadata and a heading number mismatch', () => {
    const invalid = makeAdr({ status: 'draft', date: 'yesterday' });
    const content = invalid.content
      .replace('# ADR-0003:', '# ADR-0004:')
      .replace('- **Status:** `draft`\n', '')
      .replace('- **Owner:** domain team\n', '')
      .replace('- **Decision basis:** [approval](https://example.test/decision)\n', '')
      .replace('## Связанные решения\n\nСвязанных ADR нет.\n\n', '');
    const result = codes([{ ...invalid, content }]);

    expect(result).toEqual(
      new Set(['heading-id-mismatch', 'metadata-missing', 'date-invalid', 'section-missing']),
    );
  });

  it('reports section order, a missing selected option, and an invalid relation block', () => {
    const record = makeAdr({
      relations: ['- **Unknown:** [ADR-0004](0004-other.md) — scope', '- malformed relation'].join(
        '\n',
      ),
    });
    const content = record.content
      .replace('## Факторы и ограничения', '## TEMP')
      .replace('## Решение', '## Факторы и ограничения')
      .replace('## TEMP', '## Решение')
      .replace('**Выбрано:**', '**Кандидат:**');
    const result = codes([{ ...record, content }]);

    expect(result).toEqual(
      new Set(['section-order', 'selected-option-missing', 'relation-invalid', 'relation-empty']),
    );
  });

  it('reports duplicate and skipped ADR numbers', () => {
    const first = makeAdr({ filename: '0003-one.md' });
    const duplicate = makeAdr({ filename: '0003-two.md' });
    const skipped = makeAdr({ id: '0005' });
    const result = codes([first, duplicate, skipped]);

    expect(result).toEqual(new Set(['number-duplicate', 'number-gap', 'index-order']));
  });

  it('reports incomplete and inconsistent index entries', () => {
    const first = makeAdr();
    const second = makeAdr({ id: '0004' });
    const third = makeAdr({ id: '0005' });
    const index = [
      '| Area | [0004](0004-decision.md) | `accepted` |',
      '| Area | [0004](0003-decision.md) | `accepted` |',
      '| Again | [0003](0003-decision.md) | `accepted` |',
      '| Area | [0006](0005-decision.md) | `accepted` |',
      '| Ghost | [0007](0007-ghost.md) | `accepted` |',
    ].join('\n');
    const result = codes([first, second, third], index);

    expect(result).toEqual(
      new Set(['index-duplicate', 'index-id-mismatch', 'index-unknown', 'index-order']),
    );
  });

  it('reports a missing index entry', () => {
    const result = codes([makeAdr()], 'No ADR rows.');

    expect(result).toEqual(new Set(['index-missing']));
  });

  it('accepts full replacement with reciprocal links and required statuses', () => {
    const oldRecord = makeAdr({
      status: 'superseded',
      relations: '- **Superseded by:** [ADR-0004](0004-new.md) — full decision',
    });
    const replacement = makeAdr({
      id: '0004',
      filename: '0004-new.md',
      relations: '- **Supersedes:** [ADR-0003](0003-decision.md) — full decision',
    });

    expect(codes([oldRecord, replacement])).toEqual(new Set());
  });

  it('accepts a proposed replacement while the old ADR remains accepted', () => {
    const oldRecord = makeAdr({
      relations: '- **Superseded by:** [ADR-0004](0004-new.md) — full decision',
    });
    const replacement = makeAdr({
      id: '0004',
      filename: '0004-new.md',
      status: 'proposed',
      relations: '- **Supersedes:** [ADR-0003](0003-decision.md) — full decision',
    });

    expect(codes([oldRecord, replacement])).toEqual(new Set());
  });

  it('accepts reciprocal partial and extension links plus a one-way related link', () => {
    const first = makeAdr({
      relations: [
        '- **Partially superseded by:** [ADR-0004](0004-decision.md) — route only',
        '- **Extended by:** [ADR-0004](0004-decision.md) — validation only',
      ].join('\n'),
    });
    const second = makeAdr({
      id: '0004',
      relations: [
        '- **Partially supersedes:** [ADR-0003](0003-decision.md) — route only',
        '- **Extends:** [ADR-0003](0003-decision.md) — validation only',
        '- **Related:** [ADR-0003](0003-decision.md) — shared owner',
      ].join('\n'),
    });

    expect(codes([first, second])).toEqual(new Set());
  });

  it('reports missing targets, path mismatches, backlinks, and replacement statuses', () => {
    const first = makeAdr({
      relations: [
        '- **Supersedes:** [ADR-0004](0004-wrong.md) — full decision',
        '- **Extends:** [ADR-0005](0005-missing.md) — validation only',
      ].join('\n'),
    });
    const second = makeAdr({ id: '0004' });
    const result = codes([first, second]);

    expect(result).toEqual(
      new Set([
        'relation-direction-invalid',
        'relation-path-mismatch',
        'relation-reverse-missing',
        'relation-status-invalid',
        'relation-target-missing',
      ]),
    );
  });

  it('requires a replacement link for every superseded ADR', () => {
    const record = makeAdr({ status: 'superseded' });
    const issues = validateAdrJournal({ records: [record], indexContent: makeIndex([record]) });

    expect(issues.map((issue) => issue.code)).toEqual(['superseded-without-replacement']);
    expect(formatAdrValidationReport(issues)).toContain(
      '- 0003-decision.md: Статус superseded требует связи Superseded by. [superseded-without-replacement]',
    );
  });

  it('parses multiline metadata and validates local targets plus duplicate heading anchors', () => {
    const record = {
      ...makeAdr({
        basis: [
          'явное решение сохранено в',
          '  [документе](../../approval.md)',
          '  и [повторном разделе](../../approval.md#решение-1),',
          '  а [локальный раздел](#проблема) подтверждает область.',
        ].join('\n'),
      }),
      path: 'docs/design/decisions/0003-decision.md',
    };
    const documents = [
      {
        path: 'docs/approval.md',
        content: ['# <span> **Решение!**', '', '# Решение'].join('\n'),
      },
    ];

    expect(
      validateAdrJournal({ records: [record], indexContent: makeIndex([record]), documents }),
    ).toEqual([]);
    expect(adrMetadataValue('- **Status:** proposed', 'Status')).toBe('proposed');
  });

  it('rejects missing, unsafe, malformed, and incorrectly anchored decision-basis links', () => {
    const record = makeAdr({
      basis: [
        '[invalid https](https://)',
        '[unsafe scheme](http://example.test/decision)',
        '[absolute path](/docs/approval.md)',
        '[missing target](../../missing.md)',
        '[missing anchor](../../approval.md#нет-такого-раздела)',
        '[bad encoding](../../%ZZ.md)',
      ].join(' '),
    });
    const documents = [{ path: 'docs/approval.md', content: '# Решение' }];

    expect(
      new Set(
        validateAdrJournal({ records: [record], indexContent: makeIndex([record]), documents }).map(
          (issue) => issue.code,
        ),
      ),
    ).toEqual(
      new Set([
        'decision-basis-link-invalid',
        'decision-basis-target-missing',
        'decision-basis-anchor-missing',
      ]),
    );
  });

  it('validates index status presence, vocabulary, and agreement with the ADR', () => {
    const record = makeAdr();

    expect(codes([record], '| Area | [0003](0003-decision.md) |')).toEqual(
      new Set(['index-status-invalid']),
    );
    expect(codes([record], '| Area | [0003](0003-decision.md) | `draft` |')).toEqual(
      new Set(['index-status-invalid']),
    );
    expect(codes([record], '| Area | [0003](0003-decision.md) | `proposed` |')).toEqual(
      new Set(['index-status-mismatch']),
    );
    expect(codes([record], 'entry [0003](0003-decision.md)')).toEqual(
      new Set(['index-status-invalid']),
    );
  });

  it('accepts wrapped reciprocal scopes after whitespace normalization', () => {
    const first = makeAdr({
      relations: '- **Extended by:** [ADR-0004](0004-decision.md) — validation\n  boundary.',
    });
    const second = makeAdr({
      id: '0004',
      relations: '- **Extends:** [ADR-0003](0003-decision.md) — validation boundary.',
    });

    expect(codes([first, second])).toEqual(new Set());
  });

  it('rejects stray relation text, duplicate relations, and self references', () => {
    const malformed = makeAdr({ relations: 'unexpected text' });
    const self = makeAdr({
      relations: [
        '- **Related:** [ADR-0003](0003-decision.md) — same record.',
        '- **Related:** [ADR-0003](0003-decision.md) — duplicate.',
      ].join('\n\n'),
    });

    expect(codes([malformed])).toEqual(new Set(['relation-invalid', 'relation-empty']));
    expect(codes([self])).toEqual(new Set(['relation-duplicate', 'relation-self']));
  });

  it('rejects different reciprocal scopes', () => {
    const first = makeAdr({
      relations: '- **Extended by:** [ADR-0004](0004-decision.md) — first scope.',
    });
    const second = makeAdr({
      id: '0004',
      relations: '- **Extends:** [ADR-0003](0003-decision.md) — second scope.',
    });

    expect(codes([first, second])).toEqual(new Set(['relation-scope-mismatch']));
  });

  it('allows only one full replacement target for an old ADR', () => {
    const oldRecord = makeAdr({
      relations: [
        '- **Superseded by:** [ADR-0004](0004-decision.md) — first replacement.',
        '- **Superseded by:** [ADR-0005](0005-decision.md) — second replacement.',
      ].join('\n'),
    });
    const first = makeAdr({
      id: '0004',
      status: 'proposed',
      relations: '- **Supersedes:** [ADR-0003](0003-decision.md) — first replacement.',
    });
    const second = makeAdr({
      id: '0005',
      status: 'proposed',
      relations: '- **Supersedes:** [ADR-0003](0003-decision.md) — second replacement.',
    });

    expect(codes([oldRecord, first, second])).toEqual(new Set(['relation-multiple-replacements']));
  });

  it('requires partial replacement and extension targets to remain accepted', () => {
    const oldRecord = makeAdr({
      status: 'superseded',
      relations: [
        '- **Partially superseded by:** [ADR-0004](0004-decision.md) — partial scope.',
        '- **Extended by:** [ADR-0004](0004-decision.md) — extension scope.',
        '- **Superseded by:** [ADR-0005](0005-decision.md) — full scope.',
      ].join('\n'),
    });
    const partial = makeAdr({
      id: '0004',
      relations: [
        '- **Partially supersedes:** [ADR-0003](0003-decision.md) — partial scope.',
        '- **Extends:** [ADR-0003](0003-decision.md) — extension scope.',
      ].join('\n'),
    });
    const replacement = makeAdr({
      id: '0005',
      relations: '- **Supersedes:** [ADR-0003](0003-decision.md) — full scope.',
    });

    expect(codes([oldRecord, partial, replacement])).toEqual(new Set(['relation-status-invalid']));
  });
});
