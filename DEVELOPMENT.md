# Разработка Agent Workflow

Самостоятельный инструмент процесса агентов: общий CLI, движок процесса,
Temporal Workflows/Activities/Workers, проектные адаптеры и проверяемые артефакты.

## Установка и проверки

Для подключения другого проекта предусмотрены точная версия `@krivega/agent-workflow`
из npm-реестра и команды `agent-workflow init` и `agent-workflow doctor`. Общие навыки,
процедуры и базовые профили входят в пакет. Проектные настройки хранятся в Git.
Порядок подключения и обновления описан в [инструкции установки](README.md#установка-и-проверки).

Из корня рабочей копии установите зависимости и проверьте сборку.

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn build
```

Для полного прогона на macOS или Linux нужен архив Temporal CLI 1.9.1 для архитектуры
хоста из [официального выпуска](https://github.com/temporalio/cli/releases/tag/v1.9.1).
Команда подготовки сверяет закреплённый SHA-256 и извлекает бинарник в
`tmp/temporal-downloads/temporal-v1.9.1`. Проверьте разрешение на локальный сервисный прогон.

```sh
yarn prepare:temporal-cli /absolute/path/to/temporal_cli_1.9.1_PLATFORM.tar.gz
yarn validate
```

`validate` проверяет CLI, ядро и Temporal, включая сценарии с локальным сервером
и четырьмя порогами покрытия 100%. Для проверки контракта без сервера можно выполнить
`yarn test tests/temporal/contracts.test.ts`. Отдельно запускаемый
[профиль CI](.github/workflows/validate.yml) готовит закреплённый CLI и исполняет полный прогон.
`yarn validate:static` запускает только статические проверки; `yarn validate --serial`
сохраняет полный состав в последовательном режиме. Кеши и распределение ресурсов описаны
в [стратегии проверок](docs/testing/strategy.md#время-выполнения-и-кеш).

## Вход и договоры

- `yarn agent-workflow` вызывает тот же CLI, что и установленный пакет. Формат входа описан в [руководстве Temporal](CURRENT-CHAT.md#запуск-через-temporal).
- [Сравнительные проверки из исходников](docs/current-chat/loading.md#команды-и-состояние-запуска)
  используют `node --import tsx cli/main.ts` и [дескриптор локального контура](project/workflow.json).
- [Дескриптор Temporal этого репозитория](project/temporal.json) задаёт правила, карточки,
  профили и команды проверки. Подключённые проекты задают собственные пути.
- [Самостоятельный Temporal SDK](docs/temporal-sdk.md), [карта потребителей](docs/temporal-consumers.md).
- [Процедуры](procedures/README.md), [роли](roles/README.md), [подключение и откат](MIGRATION.md).
- [Хранение и восстановление](docs/temporal-storage-recovery.md), [активный долг](docs/exec-plans/tech-debt-tracker.md).

Сервисные game-consumer проверки получают явный `AGENT_WORKFLOW_CONSUMER_ROOT` с корнем
проверяемой игры. Neutral-only использует собственный toolkit root для запрета чтения. Scope запуска
и конкретный пользовательский допуск остаются обязательными.

## Документы и планы

- [Архитектура процесса](docs/design/architecture.md).
- [Планы в работе](docs/exec-plans/active/README.md), [на проверке](docs/exec-plans/verifying/README.md).
- [Качество и границы допуска](docs/quality/README.md), [каталог документации](docs/README.md).
