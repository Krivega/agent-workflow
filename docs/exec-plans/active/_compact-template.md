# Задача: {{OUTCOME}}

- **ID:** `{{TASK_ID}}`; проект `{{PROJECT_ID}}`.
- **Статус:** `active`.
- **Вид / владелец / writer:** `{{KIND_OWNER_WRITER}}`.
- **Приоритет / даты / пересмотр:** `{{PRIORITY_DATES_REVIEW}}`.
- **Поручение / требования:** `{{ASSIGNMENT_REQUIREMENTS}}`.
- **Подключение:** `{{DISABLED_OR_CONNECTION_RECEIPT}}`.

## Границы и критерии

Scope: `{{SCOPE}}`. Не-цели: `{{NON_GOALS}}`. Полномочия: `{{AUTHORITY}}`.

- [ ] CHECK-01: `{{OBSERVABLE_CRITERION}}`.

В подключённой карточке каждый критерий получает уникальный ASCII ID в форме `CHECK-01: описание`.

## Состояние и результат

Исходная цель / актуальные требования: `{{SOURCE_LINKS}}`.
Этап или checkpoint задачи: `{{STAGE_OR_TASK_CHECKPOINT}}`.
Открытые FAIL / незавершённые операции: `{{NONE_OR_STORE_LINKS}}`.
Сделано / осталось / следующий шаг: `{{STATE_NEXT_ACTION}}`.
Blocker / решение человека: `{{NONE_OR_BLOCKER}}`.
Baseline / входы / доказательства: `{{LINKS}}`.
Восстановление / ограничения: `{{RECOVERY_LIMITATIONS}}`.
Result, включая невыполненное при отмене: `{{RESULT}}`.

[PLANS](../../PLANS.md#lifecycle) владеет статусом и индексом.
[Миграция](../../../MIGRATION.md) добавляет TaskNotes с явными ID;
технический журнал и elapsed остаются в Store. Для сложной работы нужен полный шаблон.
