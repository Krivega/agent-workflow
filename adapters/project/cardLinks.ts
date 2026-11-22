import { dirname, posix } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';

// Only destinations are edited. Labels, fragments, unknown fields and all other bytes survive.
export function moveCardLinks(
  content: string,
  file: string,
  destinationFile: string,
  from: string,
  to: string,
): string {
  const protectedStart =
    /^# ADR-/u.test(content) && /\*\*Status:\*\* `accepted`/u.test(content)
      ? content.indexOf('\n## ')
      : -1;
  const literalRanges = [
    ...content.matchAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$|<!--[^]*?-->/gmu),
  ].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return content.replace(
    /(\]\(<?|^\s*\[[^\]\n]+\]:\s*<?|\bhref=["'])([^\s<>"')]+)(>?\)?)/gmu,
    (match: string, prefix: string, url: string, suffix: string, offset: number) => {
      if (literalRanges.some((range) => offset >= range.start && offset < range.end)) return match;
      if (/^(?:[a-z]+:|\/|#)/iu.test(url)) return match;
      const split = url.indexOf('#');
      const path = split < 0 ? url : url.slice(0, split);
      const fragment = split < 0 ? '' : url.slice(split);
      const resolved = posix.normalize(posix.join(dirname(file), decodeURIComponent(path)));
      const target = resolved === from ? to : resolved;
      if (file === destinationFile && resolved !== from) return match;
      const relative = posix.relative(dirname(destinationFile), target);
      const changed = `${prefix}${relative}${fragment}${suffix}`;
      requireWorkflow(
        protectedStart < 0 || offset < protectedStart || changed === match,
        'protected-adr-body-link',
      );
      return changed;
    },
  );
}
