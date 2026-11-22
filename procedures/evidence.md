# Работа с доказательствами

Procedure: evidence
Version: 4

Основание: DEC-07-A/08-A и [договор хранилища](../STORAGE.md).

1. <!-- aw-rule evidence.01 -->
   Сверь project/task/run context и отдельные read/produce/resolve/manage права до запроса.
   Известный ID читай напрямую, различая exact revision и current head.
   <!-- /aw-rule -->

2. <!-- aw-rule evidence.02 -->
   Сохраняй полный материал, scope, исходные FAIL, provenance и отдельный manifest существенных
   входов. Вывод без источников или с неполным manifest не доказывает повторную применимость.
   <!-- /aw-rule -->

3. <!-- aw-rule evidence.03 -->
   Для mutation используй operation_id, CAS и owner generation. Unknown outcome сначала
   восстанавливается через receipt; слепой повтор с новым ID запрещён.
   <!-- /aw-rule -->

4. <!-- aw-rule evidence.04 -->
   При отказе Store сохраняй необрезанный local fallback и явный NOT RUN. Поиск имеет scoped
   budget и continuation, но не отменяет обязательную проверку. Не урезай общую задачу по таймеру.
   <!-- /aw-rule -->

5. <!-- aw-rule evidence.05 -->
   Data role возвращает чтение владельцу; не захватывает карточку, не resolve и не архивирует.
   Без task_id сохраняй assignment/local evidence. Финализация и cleanup имеют отдельную
   [процедуру](finalization.md): done не запускает их, рабочие данные сохраняются бессрочно
   по DEC-10-A; очистка одноразового стенда требует отдельного operator authority и grace.
   <!-- /aw-rule -->

<!-- aw-rule evidence.context-01 -->
Выход: точный ID/revision либо fallback, coverage/continuation, ограничения и проверяемый источник.
<!-- /aw-rule -->

<!-- aw-rule evidence.context-02 -->
В режиме текущего чата первичный человеческий источник отличай от ответа модели и результата
инструмента. Перед продолжением сверяй intent/proof/locks: неизвестный create/send/check не
повторяется с новым ID. Известное ожидание роли с подтверждёнными session/load/turn продолжается
опросом. Локальные doubles не доказывают native stop, auditor, compaction или полный чатовый цикл.
<!-- /aw-rule -->
