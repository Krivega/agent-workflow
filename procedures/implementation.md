# Реализация

Procedure: implementation
Version: 5

Основание: DEC-05-B и [реализация и приёмка](../docs/quality/agent-workflow-contracts.md#реализация-и-приёмка).

1. <!-- aw-rule implementation.01 -->
   До записи проверь READY, writer/generation, разрешённый scope и entrypoint с потребителями.
   Orchestrator и data role не получают права реализации из факта своего запуска.
   Ограниченный coder по ADR-0064 пишет только в выделенной копии после собственного LOAD/READY.
   Executor сохраняет исходную область, интеграцию и общие проверки; точный lifecycle — [CODER](../CODER.md).
   <!-- /aw-rule -->

2. <!-- aw-rule implementation.02 -->
   Минимальный регрессионный тест до исправления допустим по DEC-05-B. Затем предъяви реальный
   рабочий сценарий и измеренный baseline. Подмена или fixture не доказывает интеграцию.
   <!-- /aw-rule -->

3. <!-- aw-rule implementation.03 -->
   Выполни затронутые проверки поведения/границ, затем обязательный полный validate с прежними
   порогами, изоляцией и тайм-аутами. Отказ сохраняется; NOT RUN не становится PASS.
   <!-- /aw-rule -->

4. <!-- aw-rule implementation.04 -->
   Передай точные входы, diff/base и evidence на acceptance по процедуре council.
   Bootstrap подтверждает готовность; сам по себе он не доказывает реализацию и приёмку.
   <!-- /aw-rule -->

<!-- aw-rule implementation.context-01 -->
Выход: ограниченный результат, источники, рабочий сценарий, проверки и незавершённые условия.
<!-- /aw-rule -->

<!-- aw-rule implementation.context-02 -->
В текущем чате фактический check сохраняет команду, exit/signal, полный log и manifest до/после.
Изменение входов запрещает пригодный PASS. Исправление получает новый operation id прежнего
criterion, сохраняя FAIL. Result/DONE и проекция — отдельные проверки; конфликт остаётся pending.
<!-- /aw-rule -->
