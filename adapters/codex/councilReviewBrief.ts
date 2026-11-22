import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { CouncilReviewRequest } from '../../core/council.js';
import { stableJson } from '../../core/equality.js';
import type { InputRef } from '../../core/localRun.js';

export function councilReviewBrief(request: CouncilReviewRequest, file?: InputRef): string {
  if (file !== undefined) {
    const { inputs, target, sources, requirements, reads, ...identity } = request;
    return `Council review request file: ${stableJson({
      ...identity,
      request_file: file,
      request_reader: [
        ...(request.reader === 'runtime-cli'
          ? [process.execPath, fileURLToPath(new URL('../../cli/entry.mjs', import.meta.url))]
          : ['yarn', '--silent', 'agent-workflow']),
        'read-artifact',
        file.locator + '.role.ref.json',
      ],
      sources: { request_file: file, field: 'sources', count: sources.length },
      requirements: { request_file: file, field: 'requirements', count: requirements.length },
      reads: { request_file: file, field: 'reads', count: reads.length },
      inputs: { request_file: file, field: 'inputs', count: inputs.inputs.length },
      target: {
        ...target,
        inputs: { request_file: file, field: 'target.inputs', count: target.inputs.inputs.length },
        ...(target.evidence_inputs === undefined
          ? {}
          : {
              evidence_inputs: {
                request_file: file,
                field: 'target.evidence_inputs',
                count: target.evidence_inputs.inputs.length,
              },
            }),
      },
    })}\n`;
  }
  return `Council review request: ${stableJson(request)}\n`;
}

const answerInstructions = `\nТолько чтение, без сети, записи и помощников. Прочитай assignment, карточку и предметные требования. Фазу бери из request.phase: planning оценивает предложение до реализации, acceptance — фактическое изменение, рабочий сценарий и доказательства на точном target. Прежние FAIL сохраняются. Полный точный запрос сохранён в request_file с SHA-256. request_reader проверяет SHA-256 и выдаёт полные inputs, requirements, sources и reads именно твоей роли; общие target.inputs и target.evidence_inputs остаются адресными ссылками. Прочитай эти предметные данные через request_reader; общий target раскрывай адресно по необходимости. Ссылки на массивы не являются самими массивами. В sources ответа используй полный массив requirements. Остальные данные открывай адресно. Верни только JSON DataAnswer: {outcome:"PASS|FAIL|NOT RUN",scope:[request.target.scope],sources:request.requirements,coverage:"complete",content:JSON.stringify(ReviewAnswer),continuation:null,limitations:[]}. ReviewAnswer: {verdict:тот же outcome,scope:request.target.scope,target_ref:точный request.request_file,coverage:"complete|partial",sources:request.requirements,limitations:[],findings:[{id,scope,condition,reason,blocking,sources}],evidence:{locator:"native-answer",hash:"observed-by-transport"}}. DataAnswer.coverage=complete означает полный отчёт; неполную проверку укажи в ReviewAnswer.coverage=partial, а для дизайнера — также в design. Поле target в компактном ответе не добавляй. PASS не допускает открытых blocking findings. Не требуй повторно принятых решений человека. Planning не доказывает реализацию.`;
const designInstructions = `\nДля ui-ux-designer добавь в ReviewAnswer обязательный design:{ui:DesignAssessment,ux:DesignAssessment}. DesignAssessment:{verdict:"PASS|FAIL|NOT RUN|N/A",coverage:"complete|partial",reason:"обоснование",evidence:[{kind:"proposal|screens|interaction",artifacts:[{locator,hash}],observation:"что фактически проверено"}]}. Каждый artifact входит в request.target.evidence_inputs (при отсутствии поля — request.target.inputs) с тем же SHA-256. Planning PASS требует proposal для каждого применимого направления; acceptance UI PASS требует screens и фактического просмотра изображений, UX PASS — interaction с выполненными шагами и наблюдаемыми результатами. Файлы читает советник, собирает исполнитель; нет просмотра/взаимодействия — NOT RUN. Обоснуй N/A одного направления; обе N/A недопустимы для выбранной роли. Общий verdict: FAIL при любом FAIL, иначе NOT RUN при любом NOT RUN или partial, иначе PASS. Общее coverage complete только если оба направления complete. Полный договор в профиле роли.`;

export function nativeCouncilReviewBrief(
  request: CouncilReviewRequest,
  file: InputRef,
  reason: string,
): string {
  return (
    councilReviewBrief(request, file) +
    `\nПредмет проверки: ${reason}. Проверяй требования и полный набор входов своей роли из request.requirements и request.inputs. Общий план и target дают контекст; чужую область обозначай как зависимость и основание пересмотреть состав совета. Если назначение ошибочно или входы неполны, сообщи ограничение и NOT RUN; обязательная роль не снимает себя через N/A.` +
    answerInstructions +
    (request.role === 'ui-ux-designer' ? designInstructions : '')
  );
}
