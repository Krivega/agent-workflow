# Отдельная финализация и архив

Procedure: finalization
Version: 2

Основание: DEC-10-A и [договор финализации](../docs/quality/agent-workflow-contracts.md#финализация-и-архив).

1. <!-- aw-rule finalization.01 -->
   Done не запускает финализацию. Получи отдельное поручение, загрузи эту процедуру и evidence,
   подтверди done и остановку всех producers; сохрани их доказательства вне удаляемого namespace.
   <!-- /aw-rule -->

2. <!-- aw-rule finalization.02 -->
   Зафиксируй catalog/revision после freeze. Включи все raw/blobs, исходные FAIL/dispositions,
   решения, инварианты, значимые ссылки и receipts. Pending/unknown operations требуют сверки.
   <!-- /aw-rule -->

3. <!-- aw-rule finalization.03 -->
   Экспортируй полный снимок во внешний каталог, восстанови в другой каталог и проверь IDs,
   байты/контрольные суммы и полноту. Перед archive повторно сверь исходную revision.
   Частичный результат, отсутствующий raw или новый evidence не разрешают архив.
   <!-- /aw-rule -->

4. <!-- aw-rule finalization.04 -->
   Archive требует отдельного явного действия и receipt. Отмена финализации не отменяет done;
   старые proofs сохраняются. Restart читает сохранённые результаты, unknown сначала сверяется.
   <!-- /aw-rule -->

5. <!-- aw-rule finalization.05 -->
   DEC-10-A сохраняет рабочие данные бессрочно. Cleanup доступен только для явно обозначенного
   одноразового испытания: отдельные operator authority, policy version, grace от archive receipt,
   точные namespace/manifest, внешний архив и проверенный restore. Разрешение теста не действует
   для рабочих задач. Не удаляй последнюю копию, архив, receipts или значимые доказательства.
   <!-- /aw-rule -->

<!-- aw-rule finalization.context-01 -->
Выход: отдельный archive receipt и отчёт полноты восстановления; cleanup имеет свой результат.
<!-- /aw-rule -->
