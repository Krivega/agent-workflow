export const readFragmentLimit = 8000;

export function readFragmentFits(
  previous: string,
  content: string,
  offset: unknown,
  length: unknown,
): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset === previous.length &&
    typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    content.length > 0 &&
    content.length <= readFragmentLimit &&
    previous.length + content.length <= length
  );
}
