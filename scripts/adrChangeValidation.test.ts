import {
  formatAdrChangeValidationReport,
  validateAdrChanges,
  type AdrChange,
} from './adrChangeValidation.js';
import { requiredAdrSections, type AdrSource } from './adrValidation.js';

type RecordOptions = {
  readonly filename?: string;
  readonly status?: string;
  readonly date?: string;
  readonly owner?: string;
  readonly basis?: string;
  readonly heading?: string;
  readonly relations?: string;
  readonly problem?: string;
};

function makeRecord(options: RecordOptions = {}): AdrSource {
  const filename = options.filename ?? '0017-decision.md';
  const sectionBodies: Record<(typeof requiredAdrSections)[number], string> = {
    Проблема: options.problem ?? 'Нужно сохранить решение.',
    'Факторы и ограничения': 'Есть проверяемые ограничения.',
    'Рассмотренные варианты': '- **Выбрано:** явная граница.',
    Решение: 'Использовать явную границу.',
    Обоснование: 'Она сохраняет контракт.',
    Последствия: 'Появляется проверка.',
    Проверка: '`yarn validate`.',
    'Связанные решения': options.relations ?? 'Связанных ADR нет.',
    'Условие пересмотра': 'Пересмотреть при новом потребителе.',
  };
  return {
    filename,
    content: [
      options.heading ?? '# ADR-0017: использовать явную границу',
      '',
      `- **Status:** \`${options.status ?? 'proposed'}\``,
      `- **Date:** \`${options.date ?? '2026-09-20'}\``,
      `- **Owner:** ${options.owner ?? 'architecture'}`,
      `- **Decision basis:** ${options.basis ?? '[proposal](https://example.test/proposal)'}`,
      '',
      ...requiredAdrSections.flatMap((heading) => [
        `## ${heading}`,
        '',
        sectionBodies[heading],
        '',
      ]),
    ].join('\n'),
  };
}

function issueCodes(changes: readonly AdrChange[]): Set<string> {
  return new Set(validateAdrChanges({ changes }).map((issue) => issue.code));
}

describe('adrChangeValidation', () => {
  const oldSource = 'docs/extraction/source.md';
  const movedSource = 'docs/design/decisions/sources/source.md';
  const relocationBefore = () =>
    makeRecord({
      status: 'accepted',
      problem: 'Сохранить [основание](../../extraction/source.md#решение).',
    });
  const relocationAfter = () =>
    makeRecord({
      status: 'accepted',
      problem: 'Сохранить [основание](sources/source.md#решение).',
    });

  it.each(['before', 'after'])('rejects a missing protected section in %s', (side) => {
    const removeSection = (source: AdrSource): AdrSource => ({
      ...source,
      content: source.content.replace('## Проблема', '## Другой раздел'),
    });
    const change = {
      before: side === 'before' ? removeSection(relocationBefore()) : relocationBefore(),
      after: side === 'after' ? removeSection(relocationAfter()) : relocationAfter(),
    };
    expect(validateAdrChanges({ changes: [change] }).map((issue) => issue.code)).toContain(
      'change-locked-content-modified',
    );
  });

  it('allows only a relocated link to the same primary bytes, including links without anchors', () => {
    for (const anchor of ['#решение', '']) {
      const before = relocationBefore();
      const after = relocationAfter();
      expect(
        validateAdrChanges({
          changes: [
            {
              before: { ...before, content: before.content.replace('#решение', anchor) },
              after: { ...after, content: after.content.replace('#решение', anchor) },
            },
          ],
          baselineDocuments: [{ path: oldSource, content: 'primary bytes' }],
          documents: [{ path: movedSource, content: 'primary bytes' }],
        }),
      ).toEqual([]);
    }
  });

  it.each([
    ['text', (s: string) => s.replace('Сохранить', 'Изменить')],
    ['label', (s: string) => s.replace('[основание]', '[другой источник]')],
    ['anchor', (s: string) => s.replace('#решение', '#другое')],
    ['extra fragment', (s: string) => s.replace('#решение', '#решение#другое')],
    ['outside destination', (s: string) => s.replace('sources/source.md', '../../../source.md')],
    [
      'remote destination',
      (s: string) => s.replace('sources/source.md', 'https://example.test/source.md'),
    ],
    ['absolute destination', (s: string) => s.replace('sources/source.md', '/source.md')],
    ['new link', (s: string) => s.replace('Сохранить', '[новый](sources/source.md) Сохранить')],
    [
      'removed link',
      (s: string) => s.replace('[основание](sources/source.md#решение)', 'основание'),
    ],
  ])('rejects relocation with altered %s', (_name, change) => {
    const after = relocationAfter();
    expect(
      validateAdrChanges({
        changes: [
          { before: relocationBefore(), after: { ...after, content: change(after.content) } },
        ],
        baselineDocuments: [{ path: oldSource, content: 'primary bytes' }],
        documents: [{ path: movedSource, content: 'primary bytes' }],
      }).map((issue) => issue.code),
    ).toContain('change-locked-content-modified');
  });

  it.each(['missing baseline', 'missing current', 'different bytes', 'outside origin'])(
    'rejects relocation with %s',
    (kind) => {
      const before = relocationBefore();
      expect(
        validateAdrChanges({
          changes: [
            {
              before:
                kind === 'outside origin'
                  ? {
                      ...before,
                      content: before.content.replace('../../extraction/', '../../other/'),
                    }
                  : before,
              after: relocationAfter(),
            },
          ],
          baselineDocuments:
            kind === 'missing baseline' ? [] : [{ path: oldSource, content: 'primary bytes' }],
          documents:
            kind === 'missing current'
              ? []
              : [
                  {
                    path: movedSource,
                    content: kind === 'different bytes' ? 'changed bytes' : 'primary bytes',
                  },
                ],
        }).map((issue) => issue.code),
      ).toContain('change-locked-content-modified');
    },
  );

  it('accepts no changes and formats the success report', () => {
    const issues = validateAdrChanges({ changes: [] });

    expect(issues).toEqual([]);
    expect(formatAdrChangeValidationReport(issues)).toBe('ADR changes: valid');
  });

  it('allows a new proposal or an accepted ADR with a decision basis', () => {
    const proposed = makeRecord();
    const plainProposed = {
      ...proposed,
      content: proposed.content.replace('`proposed`', 'proposed'),
    };
    const accepted = makeRecord({
      status: 'accepted',
      basis: '[Принятие пользователем](https://example.test/user-decision)',
    });

    expect(issueCodes([{ after: proposed }])).toEqual(new Set());
    expect(issueCodes([{ after: plainProposed }])).toEqual(new Set());
    expect(issueCodes([{ after: accepted }])).toEqual(new Set());
    expect(
      issueCodes([
        { after: { ...accepted, content: accepted.content.replace('`accepted`', 'accepted') } },
      ]),
    ).toEqual(new Set());
  });

  it.each(['superseded', 'draft', ''])('rejects new ADR status %j', (status) => {
    expect(issueCodes([{ after: makeRecord({ status }) }])).toEqual(
      new Set(['change-new-status-invalid']),
    );
  });

  it('requires the decision basis when adding an accepted ADR', () => {
    const after = makeRecord({ status: 'accepted' });
    const withoutBasis = {
      ...after,
      content: after.content.replace(/^- \*\*Decision basis:\*\* .+\n/m, ''),
    };
    expect(issueCodes([{ after: withoutBasis }])).toEqual(new Set(['metadata-missing']));
    expect(issueCodes([{ after: makeRecord({ status: 'accepted', basis: '``' }) }])).toEqual(
      new Set(['decision-basis-empty', 'decision-basis-link-missing']),
    );
    expect(
      issueCodes([{ after: makeRecord({ status: 'accepted', basis: 'Принято без ссылки' }) }]),
    ).toEqual(new Set(['decision-basis-link-missing']));
    expect(
      issueCodes([
        {
          after: makeRecord({
            status: 'accepted',
            basis: '[решение](http://example.test/decision)',
          }),
        },
      ]),
    ).toEqual(new Set(['decision-basis-link-invalid']));
  });

  it('resolves an accepted ADR decision against the supplied documents and exact anchor', () => {
    const after = makeRecord({
      status: 'accepted',
      basis: '[Принятие](../../approval.md#решение)',
    });
    const input = {
      changes: [{ after }],
      documents: [
        {
          path: 'docs/approval.md',
          content: '# Решение\n\nПользователь 2026-10-15: принимаю ADR-0017.\n',
        },
      ],
    };
    expect(validateAdrChanges(input)).toEqual([]);
    expect(issueCodes([{ after }])).toEqual(new Set(['decision-basis-target-missing']));
    expect(
      validateAdrChanges({
        ...input,
        documents: [{ path: 'docs/approval.md', content: '# Другой раздел' }],
      }).map((issue) => issue.code),
    ).toEqual(['decision-basis-anchor-missing']);
  });

  it('preserves accepted and superseded records while allowing removal of a proposal', () => {
    const changes: AdrChange[] = [
      { before: makeRecord() },
      { before: makeRecord({ status: 'accepted' }) },
      { before: makeRecord({ status: 'superseded' }) },
    ];

    expect(issueCodes(changes)).toEqual(new Set(['change-record-removed']));
  });

  it('requires a new acceptance basis for proposed to accepted', () => {
    const proposal = makeRecord();
    const unchangedBasis = makeRecord({ status: 'accepted' });
    const explicitDecision = makeRecord({
      status: 'accepted',
      basis: '[decision](https://example.test/decision)',
    });

    expect(issueCodes([{ before: proposal, after: unchangedBasis }])).toEqual(
      new Set(['change-acceptance-basis-unchanged']),
    );
    expect(issueCodes([{ before: proposal, after: explicitDecision }])).toEqual(new Set());
  });

  it('rejects invalid lifecycle transitions', () => {
    const changes: AdrChange[] = [
      { before: makeRecord(), after: makeRecord({ status: 'superseded' }) },
      {
        before: makeRecord({ status: 'accepted' }),
        after: makeRecord({ status: 'proposed' }),
      },
      {
        before: makeRecord({ status: 'superseded' }),
        after: makeRecord({ status: 'accepted' }),
      },
    ];

    expect(issueCodes(changes)).toEqual(new Set(['change-status-invalid']));
  });

  it('allows lifecycle service fields but locks identity, date, and body', () => {
    const accepted = makeRecord({ status: 'accepted' });
    const changed = makeRecord({
      filename: '0017-renamed.md',
      status: 'superseded',
      date: '2026-09-21',
      owner: 'restored owner',
      basis: '[restored](https://example.test/restored)',
      heading: '# ADR-0017: исправить заголовок',
      relations: '- **Superseded by:** [ADR-0018](0018-new.md) — решение целиком.',
      problem: 'Переписанная проблема.',
    });

    expect(issueCodes([{ before: accepted, after: changed }])).toEqual(
      new Set(['change-record-renamed', 'change-date-modified', 'change-locked-content-modified']),
    );
  });

  it('keeps protected content locked even when input includes a maintenance reason', () => {
    const accepted = makeRecord({ status: 'accepted' });
    const maintained = makeRecord({
      filename: '0017-renamed.md',
      status: 'accepted',
      date: '2026-09-21',
      heading: '# ADR-0017: исправить опечатку',
      problem: 'Исправленная опечатка.',
    });

    const input = {
      changes: [{ before: accepted, after: maintained }],
      maintenanceReason: 'Исправлена опечатка',
    };
    expect(new Set(validateAdrChanges(input).map((issue) => issue.code))).toEqual(
      new Set(['change-record-renamed', 'change-date-modified', 'change-locked-content-modified']),
    );
  });

  it('allows relationship, owner, basis, and accepted to superseded maintenance', () => {
    const accepted = makeRecord({ status: 'accepted' });
    const superseded = makeRecord({
      status: 'superseded',
      owner: 'restored owner',
      basis: '[restored](https://example.test/restored)',
      relations: '- **Superseded by:** [ADR-0018](0018-new.md) — решение целиком.',
    });

    expect(issueCodes([{ before: accepted, after: superseded }])).toEqual(new Set());
  });

  it('accepts unchanged proposed and superseded records plus an empty change item', () => {
    expect(
      issueCodes([
        { before: makeRecord(), after: makeRecord() },
        {
          before: makeRecord({ status: 'superseded' }),
          after: makeRecord({ status: 'superseded' }),
        },
        {},
      ]),
    ).toEqual(new Set());
  });

  it('reports missing next statuses and tolerates an already invalid prior status for journal lint', () => {
    const withoutStatus = (source: AdrSource): AdrSource => ({
      ...source,
      content: source.content.replace(/^- \*\*Status:\*\* .+\n/m, ''),
    });
    const changes: AdrChange[] = [
      { before: makeRecord(), after: withoutStatus(makeRecord()) },
      {
        before: makeRecord({ status: 'accepted' }),
        after: withoutStatus(makeRecord({ status: 'accepted' })),
      },
      {
        before: makeRecord({ status: 'superseded' }),
        after: withoutStatus(makeRecord({ status: 'superseded' })),
      },
      {
        before: makeRecord({ status: 'draft' }),
        after: makeRecord({ status: 'draft' }),
      },
    ];

    expect(issueCodes(changes)).toEqual(new Set(['change-status-invalid']));
  });

  it('formats actionable failures', () => {
    const issues = validateAdrChanges({
      changes: [{ after: makeRecord({ status: 'superseded' }) }],
    });

    expect(formatAdrChangeValidationReport(issues)).toContain(
      '- 0017-decision.md: Новый ADR должен иметь статус proposed либо accepted с явным основанием принятия. [change-new-status-invalid]',
    );
  });
});
