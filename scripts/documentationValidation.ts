import { posix } from 'node:path';

export interface DocumentationSource {
  readonly path: string;
  readonly content: string;
}

export interface DocumentationIssue {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface DocumentationInput {
  readonly documents: readonly DocumentationSource[];
  readonly files: readonly string[];
  readonly scripts: readonly string[];
}

export interface DocumentationReport {
  readonly issues: readonly DocumentationIssue[];
  readonly currentDocuments: number;
  readonly historicalDocuments: number;
  readonly localLinks: number;
  readonly externalLinks: number;
  readonly templateLinks: number;
  readonly consumerCommands: number;
}

interface Link {
  readonly target: string;
  readonly line: number;
}

const historicalDirectories = [
  'docs/design/decisions/inherited/',
  'docs/design/decisions/sources/',
  'comparison/revisions/',
];
const yarnBuiltins = new Set(['install', 'node', 'exec', 'run', 'pack', 'version']);
const historicalStart = '<!-- documentation-check: historical:start -->';
const historicalEnd = '<!-- documentation-check: historical:end -->';

function visibleLines(
  content: string,
): { text: string; shell: boolean; historical: boolean; marker: string }[] {
  let fence = '';
  let shell = false;
  let historical = false;
  return content.split('\n').map((line) => {
    const marker =
      !fence && line.trim() === historicalStart
        ? 'start'
        : !fence && line.trim() === historicalEnd
          ? 'end'
          : '';
    if (marker === 'start') historical = true;
    if (marker === 'end') historical = false;
    const delimiter = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) {
        fence = delimiter[1]!;
        shell = /^(?:sh|bash|shell|console)\s*$/.test(delimiter[2]!.trim());
      } else if (
        delimiter[1]![0] === fence[0] &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      ) {
        fence = '';
        shell = false;
      }
      return { text: '', shell: false, historical, marker };
    }
    return { text: fence && !shell ? '' : line, shell: !!fence, historical, marker };
  });
}

function withoutComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function headingAnchor(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function anchors(content: string): ReadonlySet<string> {
  const result = new Set<string>();
  const lines = visibleLines(withoutComments(content));
  for (let index = 0; index < lines.length; index += 1) {
    const { text, shell } = lines[index]!;
    if (shell) continue;
    for (const match of text.matchAll(/<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/g)) {
      result.add(match[1]!);
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(text);
    const underline = lines[index + 1]?.text;
    const value =
      heading?.[1] ?? (text.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(underline ?? '') ? text : '');
    if (!value) continue;
    const base = headingAnchor(value);
    let anchor = base;
    let suffix = 0;
    while (result.has(anchor)) anchor = `${base}-${++suffix}`;
    result.add(anchor);
  }
  return result;
}

function referenceId(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function links(content: string): Link[] {
  const lines = visibleLines(withoutComments(content));
  const references = new Map<string, string>();
  const result: Link[] = [];
  const definition = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]*)>|(\S+))/;
  for (const { text, shell } of lines) {
    if (shell) continue;
    const match = definition.exec(text);
    if (match) references.set(referenceId(match[1]!), match[2] ?? match[3]!);
  }
  lines.forEach(({ text, shell }, index) => {
    if (shell) return;
    const defined = definition.exec(text);
    if (defined) {
      result.push({ target: defined[2] ?? defined[3]!, line: index + 1 });
      return;
    }
    const code = [...text.matchAll(/(`+)(.*?)\1/g)];
    const inCode = (offset: number) =>
      code.some((span) => offset >= span.index && offset < span.index + span[0].length);
    const inline =
      /(?<!\\)!?\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|((?:\\.|[^()\s]|\([^()\n]*\))*))(?:\s+["'][^\n]*["'])?\s*\)/g;
    const occupied: { start: number; end: number }[] = [];
    for (const match of text.matchAll(inline)) {
      if (inCode(match.index)) continue;
      result.push({ target: match[1] ?? match[2]!, line: index + 1 });
      occupied.push({ start: match.index, end: match.index + match[0].length });
    }
    for (const match of text.matchAll(/(?<!\\)!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
      if (
        inCode(match.index) ||
        occupied.some((span) => match.index >= span.start && match.index < span.end)
      )
        continue;
      const id = referenceId(match[2] || match[1]!);
      const target = references.get(id);
      if (target !== undefined) result.push({ target, line: index + 1 });
    }
  });
  return result;
}

function commands(content: string): { command: string; line: number; consumer: boolean }[] {
  const exposed = withoutComments(content).split('\n');
  return visibleLines(content).flatMap(({ text: visibleText, shell, historical }, index) => {
    const text = visibleText ? exposed[index]! : '';
    if (historical || /историческая команда G/i.test(text)) return [];
    const code = shell ? [text] : [...text.matchAll(/(`+)(.*?)\1/g)].map((match) => match[2]!);
    return code.flatMap((value) =>
      [
        ...value.matchAll(
          /\byarn\s+(?:(?:--silent|--offline|--frozen-lockfile|--ignore-scripts|--non-interactive|--verbose)\s+)*(?:run\s+)?([a-zA-Z][\w:.-]*)/g,
        ),
      ].map((match) => ({
        command: match[1]!,
        line: index + 1,
        consumer: /команда проекта-потребителя G/i.test(text),
      })),
    );
  });
}

export function validateDocumentation(input: DocumentationInput): DocumentationReport {
  const issues: DocumentationIssue[] = [];
  const documents = new Map(
    input.documents.map((document) => [posix.normalize(document.path), document.content]),
  );
  const files = new Set(input.files.map((file) => posix.normalize(file)));
  const scripts = new Set(input.scripts);
  let historicalDocuments = 0;
  let currentDocuments = 0;
  let localLinks = 0;
  let externalLinks = 0;
  let templateLinks = 0;
  let consumerCommands = 0;
  for (const document of input.documents) {
    if (
      historicalDirectories.some((directory) => document.path.startsWith(directory)) ||
      /^docs\/exec-plans\/(?:completed|cancelled)\/(?!README\.md$)/.test(document.path)
    ) {
      historicalDocuments += 1;
      continue;
    }
    currentDocuments += 1;
    const addIssue = (line: number, message: string) =>
      issues.push({ file: document.path, line, message });
    let historicalBlock = false;
    visibleLines(document.content).forEach(({ marker }, index) => {
      if (marker === 'start') {
        if (historicalBlock) addIssue(index + 1, 'Вложенный исторический блок команд.');
        historicalBlock = true;
      }
      if (marker === 'end') {
        if (!historicalBlock) addIssue(index + 1, 'Исторический блок команд не был открыт.');
        historicalBlock = false;
      }
    });
    if (historicalBlock)
      addIssue(document.content.split('\n').length, 'Исторический блок команд не закрыт.');
    for (const link of links(document.content)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(link.target) || link.target.startsWith('/')) {
        externalLinks += 1;
        continue;
      }
      if (
        (document.path.includes('/_template') || document.path.startsWith('examples/')) &&
        /\{\{|0000-example\.md/.test(link.target)
      ) {
        templateLinks += 1;
        continue;
      }
      localLinks += 1;
      const hash = link.target.indexOf('#');
      const rawPath = (hash < 0 ? link.target : link.target.slice(0, hash)).split('?')[0]!;
      const rawFragment = hash < 0 ? '' : link.target.slice(hash + 1);
      let pathname: string;
      let fragment: string;
      try {
        pathname = decodeURIComponent(rawPath.replace(/\\([() ])/g, '$1'));
        fragment = decodeURIComponent(rawFragment);
      } catch {
        addIssue(link.line, `Некорректное кодирование ссылки: ${link.target}`);
        continue;
      }
      const file = pathname
        ? posix.normalize(posix.join(posix.dirname(document.path), pathname))
        : document.path;
      const exists =
        files.has(file) || [...files].some((candidate) => candidate.startsWith(`${file}/`));
      if (file === '..' || file.startsWith('../') || !exists) {
        addIssue(link.line, `Не найдена локальная цель: ${link.target}`);
        continue;
      }
      const content = documents.get(file);
      if (fragment && content !== undefined && !anchors(content).has(fragment))
        addIssue(link.line, `Не найден якорь: ${link.target}`);
    }
    for (const { command, line, consumer } of commands(document.content)) {
      if (consumer) {
        consumerCommands += 1;
        continue;
      }
      if (!scripts.has(command) && !yarnBuiltins.has(command))
        addIssue(line, `Неизвестная команда package.json: yarn ${command}`);
    }
  }
  return {
    issues,
    currentDocuments,
    historicalDocuments,
    localLinks,
    externalLinks,
    templateLinks,
    consumerCommands,
  };
}

export function formatDocumentationReport(report: DocumentationReport): string {
  return [
    `Documentation: ${report.issues.length ? 'invalid' : 'valid'}; current=${report.currentDocuments}, historical=${report.historicalDocuments}, local-links=${report.localLinks}, external-locators=${report.externalLinks}, template-targets=${report.templateLinks}, consumer-commands=${report.consumerCommands}`,
    ...report.issues.map((issue) => `${issue.file}:${issue.line}: ${issue.message}`),
  ].join('\n');
}
