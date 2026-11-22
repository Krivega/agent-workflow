export const criteriaSection =
  /^## (?:Критерии(?: приёмки)?|Границы и критерии)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu;

export function cardCriteria(content: string): string[] {
  const section = criteriaSection.exec(content);
  return [...(section?.[1] ?? '').matchAll(/^- \[[ x]\] (.*(?:\r?\n[ \t]+.*)*)/gmu)].map((match) =>
    match[1]!.replace(/\s+/gu, ' ').trim(),
  );
}
