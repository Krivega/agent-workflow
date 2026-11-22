# Ограниченные роли чтения

Procedure: data-roles
Version: 4

Основание: DEC-09-A и [ролевые поручения](../docs/quality/agent-workflow-contracts.md#ролевые-поручения).

1. <!-- aw-rule data-roles.01 -->
   A1 Explorer ищет источники; A2 Raw-data-reader читает заданные ranges без пересказа;
   A3 Evidence-explorer ищет metadata по явному task_id. Известный evidence ID читает caller.
   <!-- /aw-rule -->

2. <!-- aw-rule data-roles.02 -->
   Запускай A1–A3 без истории родителя: fork_turns=none. Brief самодостаточен: вопрос/цель,
   bounded scope, источники/revisions, критерий, формат, read-права и выбранные правила.
   Неполное поручение возвращается caller с точным недостающим полем.
   <!-- /aw-rule -->

3. <!-- aw-rule data-roles.03 -->
   Исходные профили: A1/A3 gpt-6.2-sol/medium; A2 gpt-6-luna/high. Явный выбор пользователя
   приоритетен. Фактические model/effort/permissions должны совпасть с requested; unknown не PASS.
   <!-- /aw-rule -->

4. <!-- aw-rule data-roles.04 -->
   Follow-up адресуется тому же session/agent identity. При смене source revision заново сверь
   ranges/selection. Потерянный identity требует recovery или явно разрешённого нового запуска.
   <!-- /aw-rule -->

5. <!-- aw-rule data-roles.05 -->
   Возвращай источники/revisions, fragments или metadata, coverage, continuation, ограничения
   и PASS/FAIL/NOT RUN/N/A в своём scope. Нет прав реализации, update-card, resolve, archive,
   successor или дополнительного делегирования. Запись evidence выполняет producer/main.
   <!-- /aw-rule -->

<!-- aw-rule data-roles.context-01 -->
Выход: ограниченный результат с проверяемым источником и прежним identity при follow-up.
<!-- /aw-rule -->
