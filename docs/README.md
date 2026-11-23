# Документация Agent Workflow

Agent Workflow подключает репозиторий через дескриптор проекта и управляет работой агентов.
Общий CLI и Temporal SDK используют правила проекта, независимые роли и проверяемые артефакты.

## Начало работы

- [Установка и проверки](../README.md#установка-и-проверки).
- [Текущий чат и команды CLI](../CURRENT-CHAT.md).
- [Temporal SDK](temporal-sdk.md): подключение проекта, роли, управление и завершение задачи.

## Устройство и правила

- [Архитектура](design/architecture.md).
- Договоры Temporal: [процесс и внешние действия](design/temporal-workflow.md),
  [данные, версии и подключение](design/temporal-data-and-projects.md).
- [Предметные правила](design/business-rules.md), [API](design/api-contract.md).
- [Договор процесса](quality/agent-workflow-contracts.md), [процедуры](../procedures/README.md), [роли](../roles/README.md).
- [Архитектурные решения](design/decisions/README.md).

## Проверка и эксплуатация

- [Качество и границы допуска](quality/README.md), [рабочий цикл](quality/harness-engineering.md).
- [Стратегия проверок](testing/strategy.md), [профиль команд](testing/profiles/agent-workflow.md), [сценарии](testing/traceability.md).
- [Хранение и восстановление](temporal-storage-recovery.md).
- [Размещение и переключение](temporal-operation.md), [сценарии квалификации](testing/temporal-qualification.md).

## Работа над инструментом

- [Правила планов](PLANS.md), [активные планы](exec-plans/active/README.md), [планы на проверке](exec-plans/verifying/README.md).
- [Технический долг](exec-plans/tech-debt-tracker.md).
