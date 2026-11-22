import type { ReaderInput } from '../../contracts/reader.js';
import type { ReviewSnapshot } from '../../contracts/review.js';
import { scopedReader, readerOperationKey } from '../../policy/readerControl.js';
import { object, requireContract } from '../../contracts/project.js';
import { parseReviewReport } from '../../policy/review.js';
import type { ScopedReaderInput } from '../../contracts/reader.js';
import { digest } from '../artifacts/files.js';
import { readFragmentLimit } from '../../policy/readFragments.js';

export function readerOperationId(value: ReaderInput, operation: string, attempt: number): string {
  return `reader-${operation}-${digest(JSON.stringify(readerOperationKey(value, attempt)))}`;
}
export function readerReport(
  turn: Record<string, unknown>,
  input: ScopedReaderInput,
  snapshot: ReviewSnapshot,
) {
  requireContract(Array.isArray(turn.items), 'review-report-items-missing');
  const message = turn.items
    .map(object)
    .filter(
      (item) =>
        item.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0,
    )
    .at(-1);
  requireContract(message !== undefined, 'review-report-missing');
  return parseReviewReport(JSON.parse(message.text as string) as unknown, input, snapshot);
}
export function readerLoadPrompt(
  refs: { path: string; sha256: string }[],
  version: 1 | 2 | 3 | 4 = 2,
): string {
  const legacy = `Только чтение, без сети, записи, помощников и внешней истории. Прочитай полностью каждый файл и выведи инструментом отдельную JSON-строку {"path":"...","sha256":"...","content":"полный исходный текст"}. Пути и хеши: ${JSON.stringify(refs)}. Для больших файлов используй части {"format":"aw-native-read-parts/1","path":"...","sha256":"...","offset":0,"length":полная длина UTF-16,"content":"точный фрагмент"}; части непрерывны, один вывод команды до 24000 байт UTF-8. Не сокращай текст. Само задание пока не выполняй.`;
  if (version === 1) return legacy;
  const bounded = `${legacy} Один content не длиннее ${readFragmentLimit} кодовых единиц UTF-16; offset и length измеряй как Node.js string.length/slice, не индексами кодовых точек Unicode. Первая часть offset=0, следующие непрерывны и идут по порядку. Команды с частями одного файла выполняй строго последовательно: одна часть, одна команда, отдельный вызов инструмента; следующая только после получения предыдущего вывода. Не используй параллельные команды или пакет из нескольких больших частей. До вывода проверь размер полной JSON-строки с переводом строки, всего вывода команды и вызова инструмента: каждый не больше 24000 байт UTF-8; уменьши часть, если нужно. Не печатай пробные, повторные или некорректные части: любая такая строка делает LOAD неподтверждённым. Не смешивай полный текст и части одного файла; пустой файл выведи полной строкой.`;
  if (version === 2) return bounded;
  const direct = `${bounded} Для LOAD каждый вызов exec должен содержать только одно прямое выражение вида text(await tools.exec_command({cmd:"буквальная команда чтения одной части",max_output_tokens:12000}));. В cmd помести готовую команду строковым литералом в двойных кавычках JSON вместе с точными путём, SHA-256 и offset; вычислять содержимое файла внутри самой команды разрешено. Чтобы вывод не обрезался после JSON-экранирования структурированного ответа, stdout одной команды вместе с переводом строки ограничь 10000 байт UTF-8, уменьшая часть до вывода. Весь структурированный ответ tools.exec_command передай в text без изменений: сохрани output, exit_code и session_id. Не извлекай и не перерисовывай сырой текст через text(r.output), trim или JSON.parse/stringify ответа. Запрещены eval, load, store, Function, переменные и вычисления для внешней команды, циклы, функции-обёртки и параллельные вызовы инструментов. Нужен terminal ответ с exit_code=0; если получен session_id или неизвестный исход, останови LOAD как неподтверждённый, не повторяй команду и не начинай следующую часть. Следующую часть читай только после подтверждённого завершения предыдущей команды.`;
  if (version === 3) return direct;
  return `${direct} Ниже готовое первое выражение для каждого файла, offset=0. Выполняй их по одному. Скрипт сам проверяет SHA-256 и до вывода уменьшает часть до обоих пределов; непустой файл всегда читает частями, пустой — полной строкой. Не заменяй его пробой полного файла и не переписывай команду. Если offset+content.length меньше length, повтори то же выражение, изменив ТОЛЬКО последнее число 0 в cmd на offset+content.length из предыдущего вывода (UTF-16). Скрипт, путь и хеш не изменяй. После последней части переходи к первому выражению следующего файла.\n${refs.map(readerLoadCommand).join('\n')}`;
}

function readerLoadCommand(ref: { path: string; sha256: string }): string {
  const script = String.raw`const fs=require("node:fs"),c=require("node:crypto"),[p,h,a]=process.argv.slice(1),b=fs.readFileSync(p),s=b.toString("utf8"),o=Number(a);
if(c.createHash("sha256").update(b).digest("hex")!==h)throw Error("hash");
if(!Number.isSafeInteger(o)||o<0||(s.length?o>=s.length:o!==0))throw Error("offset");
let n=Math.min(${readFragmentLimit},s.length-o),j;
for(;;){j=JSON.stringify(s.length?{path:p,sha256:h,format:"aw-native-read-parts/1",offset:o,length:s.length,content:s.slice(o,o+n)}:{path:p,sha256:h,content:""})+"\n";if(Buffer.byteLength(j)<=10000)break;n=Math.floor(n/2);if(!n)throw Error("size");}
process.stdout.write(j);`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `node -e ${quote(script)} ${quote(ref.path)} ${quote(ref.sha256)} 0`;
  return `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:12000}));`;
}
export function readerAnswerPrompt(value: ReaderInput, snapshot: ReviewSnapshot | null): string {
  if (scopedReader(value) && snapshot?.schemaVersion === 7)
    return readerAnswerPrompt(value, { ...snapshot, schemaVersion: 5 }).replace(
      'первичным трём FAIL',
      'подтверждённому первичному противоречию до writer',
    );
  if (scopedReader(value) && snapshot?.schemaVersion === 6)
    return `Выполни planning только своего пакета. Верни одно agentMessage с JSON без Markdown: ${JSON.stringify({ schemaVersion: 4, roleId: value.roleId, phase: snapshot.phase, scope: snapshot.scope, review: value.review, verdict: 'PASS|FAIL|NOT RUN', coverage: 'complete|partial', findings: [], limitations: [], conflicts: [] })}. PASS несовместим с blocking findings. Обычный FAIL не означает противоречие. Только при подтверждённом противоречии добавь в conflicts {findingId, sources:[{path,sha256,bytes},...]}: не менее двух различных точных источников из files прочитанного пакета. Допустимые точные источники: ${JSON.stringify(snapshot.files)}. В sources копируй эти относительные path, sha256 и bytes без изменения; абсолютные пути команд LOAD здесь запрещены. Finding должен быть blocking, verdict FAIL, coverage complete; в тексте finding объясни несовместимые требования. Не реализуй и не закрывай finding. Без записи, сети, помощников и внешней истории.`;
  if (scopedReader(value) && snapshot?.schemaVersion === 5)
    return `Арбитраж только finding ${JSON.stringify(snapshot.arbitration.target)} по прочитанной процедуре и первичным трём FAIL. Верни одно agentMessage с JSON без Markdown: ${JSON.stringify({ schemaVersion: 3, roleId: value.roleId, phase: snapshot.phase, scope: snapshot.scope, review: value.review, verdict: 'NOT RUN', coverage: 'complete', findings: [], limitations: [], decision: { kind: 'direction|compromise|no-decision', mandatoryDefect: true, direction: 'точное узкое направление', exception: null, residualRisk: null, dissent: [], condition: null } })}. PASS несовместим с ролью арбитра: ты не выполняешь техническую приёмку и не закрываешь finding. Direction требует непустого direction и null exception/residualRisk/condition; compromise — непустых direction, точного exception и residualRisk с null condition; no-decision — непустого condition и null direction/exception/residualRisk. Сохрани dissent. mandatoryDefect — true/false для direction/compromise, null при no-decision; обязательный дефект помечай true. Направление ограничено writablePaths из пакета; не предлагай запись других файлов. Нельзя снимать обязательный дефект, критерий или проверку. Неполные данные требуют no-decision. Без реализации, запуска проверок, записи, сети, помощников и внешней истории.`;
  if (!scopedReader(value))
    return 'Выполни читающую экспертизу задания из прочитанной карточки в пределах своего профиля. Верни вывод с основаниями и ограничениями. Без записи, сети, помощников и внешней истории.';
  return `Выполни экспертизу только своего пакета. Верни одно agentMessage с JSON без Markdown: {"schemaVersion":${snapshot!.schemaVersion === 4 ? 2 : 1},"roleId":${JSON.stringify(value.roleId)},"phase":${JSON.stringify(snapshot!.phase)},"scope":${JSON.stringify(snapshot!.scope)},"review":${JSON.stringify(value.review)},"verdict":"PASS|FAIL|NOT RUN","coverage":"complete|partial","findings":[{"id":"...","blocking":true,"text":"..."}],"limitations":[]${snapshot!.schemaVersion === 4 ? ',"resolved":[]' : ''}}. PASS несовместим с blocking findings. Не выдавай RESULT/DONE или заключение другой роли.${snapshot!.schemaVersion === 4 ? ` Открытые finding IDs: ${JSON.stringify(snapshot!.openFindings)}. В resolved перечисли только устранённые прежние findings; PASS требует закрытия всех blockers с основаниями.` : ''} Без записи, сети, помощников и внешней истории.`;
}

export function readerReportSchema(value: ScopedReaderInput, snapshot: ReviewSnapshot) {
  if (snapshot.schemaVersion === 6) {
    const base = baseReportSchema(value, { ...snapshot, schemaVersion: 3 });
    return {
      ...base,
      required: [...base.required, 'conflicts'],
      properties: {
        ...base.properties,
        schemaVersion: { type: 'integer', enum: [4] },
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['findingId', 'sources'],
            properties: {
              findingId: { type: 'string' },
              sources: {
                type: 'array',
                minItems: 2,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['path', 'sha256', 'bytes'],
                  properties: {
                    path: { type: 'string', enum: snapshot.files.map((file) => file.path) },
                    sha256: { type: 'string' },
                    bytes: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  if (snapshot.schemaVersion !== 5 && snapshot.schemaVersion !== 7)
    return baseReportSchema(value, snapshot);
  const base = baseReportSchema(value, { ...snapshot, schemaVersion: 3 }),
    nullable = { type: ['string', 'null'] };
  return {
    ...base,
    required: [...base.required, 'decision'],
    properties: {
      ...base.properties,
      schemaVersion: { type: 'integer', enum: [3] },
      verdict: { type: 'string', enum: ['NOT RUN'] },
      findings: { type: 'array', maxItems: 0, items: base.properties.findings.items },
      decision: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'mandatoryDefect',
          'direction',
          'exception',
          'residualRisk',
          'dissent',
          'condition',
        ],
        properties: {
          mandatoryDefect: { type: ['boolean', 'null'] },
          kind: { type: 'string', enum: ['direction', 'compromise', 'no-decision'] },
          direction: nullable,
          exception: nullable,
          residualRisk: nullable,
          dissent: { type: 'array', items: { type: 'string' } },
          condition: nullable,
        },
      },
    },
  };
}
function baseReportSchema(value: ScopedReaderInput, snapshot: ReviewSnapshot) {
  const fixed = (type: string, entry: string | number) => ({ type, enum: [entry] });
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'roleId',
      'phase',
      'scope',
      'review',
      'verdict',
      'coverage',
      'findings',
      'limitations',
      ...(snapshot.schemaVersion === 4 ? ['resolved'] : []),
    ],
    properties: {
      schemaVersion: fixed('integer', snapshot.schemaVersion === 4 ? 2 : 1),
      roleId: fixed('string', value.roleId),
      phase: fixed('string', snapshot.phase),
      scope: fixed('string', snapshot.scope),
      review: {
        type: 'object',
        additionalProperties: false,
        required: ['sha256', 'bytes'],
        properties: {
          sha256: fixed('string', value.review.sha256),
          bytes: fixed('integer', value.review.bytes),
        },
      },
      verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT RUN'] },
      coverage: { type: 'string', enum: ['complete', 'partial'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'blocking', 'text'],
          properties: {
            id: { type: 'string' },
            blocking: { type: 'boolean' },
            text: { type: 'string' },
          },
        },
      },
      limitations: { type: 'array', items: { type: 'string' } },
      ...(snapshot.schemaVersion === 4
        ? {
            resolved: {
              type: 'array',
              items:
                snapshot.openFindings.length === 0
                  ? { type: 'string' }
                  : { type: 'string', enum: snapshot.openFindings },
            },
          }
        : {}),
    },
  };
}
