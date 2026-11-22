import { posix } from 'node:path';
import {
  adrHeading,
  adrMetadataValue,
  adrSectionBody,
  requiredAdrSections,
  validateAdrDecisionBasis,
  type AdrSource,
  type RepositoryDocument,
} from './adrValidation.js';

export type AdrChange = {
  readonly before?: AdrSource;
  readonly after?: AdrSource;
};

export type AdrChangeValidationInput = {
  readonly changes: readonly AdrChange[];
  readonly documents?: readonly RepositoryDocument[];
  readonly baselineDocuments?: readonly RepositoryDocument[];
};

export type AdrChangeValidationIssue = {
  readonly code: string;
  readonly file: string;
  readonly message: string;
};

const lockedSections = requiredAdrSections.filter((heading) => heading !== 'Связанные решения');

function scalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return /^`([^`]*)`$/.exec(trimmed)?.[1] ?? trimmed;
}

function status(source: AdrSource): string | undefined {
  return scalar(adrMetadataValue(source.content, 'Status'));
}

function addIssue(
  issues: AdrChangeValidationIssue[],
  file: string,
  code: string,
  message: string,
): void {
  issues.push({ code, file, message });
}

function validateNewRecord(
  after: AdrSource,
  documents: readonly RepositoryDocument[] | undefined,
  issues: AdrChangeValidationIssue[],
): void {
  if (status(after) === 'accepted') {
    issues.push(...validateAdrDecisionBasis(after, documents));
    return;
  }
  if (status(after) !== 'proposed') {
    addIssue(
      issues,
      after.filename,
      'change-new-status-invalid',
      'Новый ADR должен иметь статус proposed либо accepted с явным основанием принятия.',
    );
  }
}

function validateRemovedRecord(before: AdrSource, issues: AdrChangeValidationIssue[]): void {
  const previousStatus = status(before);
  if (previousStatus === 'accepted' || previousStatus === 'superseded') {
    addIssue(
      issues,
      before.filename,
      'change-record-removed',
      `Нельзя удалить ADR со статусом ${previousStatus}.`,
    );
  }
}

function validateTransition(
  before: AdrSource,
  after: AdrSource,
  issues: AdrChangeValidationIssue[],
): void {
  const previousStatus = status(before);
  const nextStatus = status(after);
  if (previousStatus === 'proposed') {
    if (nextStatus !== 'proposed' && nextStatus !== 'accepted') {
      addIssue(
        issues,
        after.filename,
        'change-status-invalid',
        `Недопустимый переход proposed → ${nextStatus ?? 'missing'}.`,
      );
      return;
    }
    if (
      nextStatus === 'accepted' &&
      adrMetadataValue(before.content, 'Decision basis')?.trim() ===
        adrMetadataValue(after.content, 'Decision basis')?.trim()
    ) {
      addIssue(
        issues,
        after.filename,
        'change-acceptance-basis-unchanged',
        'При переходе proposed → accepted нужно заменить основание предложения на явное решение.',
      );
    }
    return;
  }
  if (previousStatus === 'accepted' && nextStatus !== 'accepted' && nextStatus !== 'superseded') {
    addIssue(
      issues,
      after.filename,
      'change-status-invalid',
      `Недопустимый переход accepted → ${nextStatus ?? 'missing'}.`,
    );
  }
  if (previousStatus === 'superseded' && nextStatus !== 'superseded') {
    addIssue(
      issues,
      after.filename,
      'change-status-invalid',
      `Недопустимый переход superseded → ${nextStatus ?? 'missing'}.`,
    );
  }
}

function sameLockedSection(
  before: AdrSource,
  after: AdrSource,
  heading: string,
  input: AdrChangeValidationInput,
): boolean {
  const original = adrSectionBody(before.content, heading);
  const current = adrSectionBody(after.content, heading);
  if (original === current) return true;
  if (original === undefined || current === undefined) return false;

  const links = /(\[[^\]\n]*\]\()([^\s)]+)(\))/g;
  const currentLinks = [...current.matchAll(links)];
  let index = 0;
  const relocated = original.replace(links, (whole, label: string, href: string, end: string) => {
    const next = currentLinks[index++];
    if (!next || next[1] !== label || next[2] === href) return whole;
    const nextHref = next[2]!;
    if (
      [href, nextHref].some((target) => target.startsWith('/') || /^[a-z][\w+.-]*:/i.test(target))
    )
      return whole;
    const resolve = (source: AdrSource, target: string) => {
      const hash = target.indexOf('#');
      return {
        path: posix.normalize(
          posix.join(
            posix.dirname(source.path ?? `docs/design/decisions/${source.filename}`),
            hash < 0 ? target : target.slice(0, hash),
          ),
        ),
        fragment: hash < 0 ? '' : target.slice(hash),
      };
    };
    const from = resolve(before, href);
    const to = resolve(after, nextHref);
    if (
      !from.path.startsWith('docs/extraction/') ||
      !to.path.startsWith('docs/design/decisions/') ||
      from.fragment !== to.fragment
    )
      return whole;
    const previous = input.baselineDocuments?.find((d) => d.path === from.path);
    const moved = input.documents?.find((d) => d.path === to.path);
    if (!previous || !moved || previous.content !== moved.content) return whole;
    return label + nextHref + end;
  });
  return relocated === current;
}

function validateLockedRecord(
  before: AdrSource,
  after: AdrSource,
  issues: AdrChangeValidationIssue[],
  input: AdrChangeValidationInput,
): void {
  const previousStatus = status(before);
  if (previousStatus !== 'accepted' && previousStatus !== 'superseded') return;

  if (before.filename !== after.filename) {
    addIssue(
      issues,
      after.filename,
      'change-record-renamed',
      `Нельзя переименовать ADR со статусом ${previousStatus}.`,
    );
  }
  if (
    scalar(adrMetadataValue(before.content, 'Date')) !==
    scalar(adrMetadataValue(after.content, 'Date'))
  ) {
    addIssue(
      issues,
      after.filename,
      'change-date-modified',
      'Дата первоначального решения неизменяема.',
    );
  }

  const changedParts = [
    ...(adrHeading(before.content) === adrHeading(after.content) ? [] : ['заголовок']),
    ...lockedSections.filter((heading) => !sameLockedSection(before, after, heading, input)),
  ];
  if (changedParts.length > 0) {
    addIssue(
      issues,
      after.filename,
      'change-locked-content-modified',
      `Изменены защищённые части принятого ADR: ${changedParts.join(', ')}.`,
    );
  }
}

export function validateAdrChanges(
  input: AdrChangeValidationInput,
): readonly AdrChangeValidationIssue[] {
  const issues: AdrChangeValidationIssue[] = [];
  for (const change of input.changes) {
    if (!change.before && change.after) {
      validateNewRecord(change.after, input.documents, issues);
      continue;
    }
    if (change.before && !change.after) {
      validateRemovedRecord(change.before, issues);
      continue;
    }
    if (!change.before || !change.after) continue;
    validateTransition(change.before, change.after, issues);
    validateLockedRecord(change.before, change.after, issues, input);
  }
  return issues;
}

export function formatAdrChangeValidationReport(
  issues: readonly AdrChangeValidationIssue[],
): string {
  if (issues.length === 0) return 'ADR changes: valid';
  return [
    'ADR changes: invalid',
    ...issues.map((issue) => `- ${issue.file}: ${issue.message} [${issue.code}]`),
  ].join('\n');
}
