# Потребители Temporal и прежнего исполнения

Карта базовых входов сверена 2026-11-08 и дополнена срезом input12 от 2026-11-09;
установочные результаты ниже относятся
к своим закреплённым снимкам. Владелец решения —
[ADR-0067](design/decisions/inherited/0067-run-reusable-agent-workflow-on-temporal.md),
критериев и допуска — [план миграции](exec-plans/active/2026-10-27-agent-workflow-temporal-migration.md).
Решение о физическом выносе и текущая граница игры зафиксированы в
[поручении от 2026-11-16](design/decisions/sources/2026-11-16-decision.md#завершение-физического-выноса).

Полный установочный прогон от 2026-11-05 прошёл на игровом и нейтральном потребителях
с архивом SHA-256 `41fe8d8d8cb6fdafae5f33d5ed0ef77d8d8c46603be07deb2b0941d974ac6ed5`.
Подтверждены три изолированные установки, две проверки игры по 10 188 тестов
со 100% покрытия по четырём метрикам и пятью пропусками, replay десяти историй
и 14 остановок. Новый Worker и клиент прочитали те же завершённые результаты.
Модельных вызовов было 0, `qualification:false`. Живое восстановление активного
Writer и рабочее включение входят в оставшиеся проверки T5 и T6.

В историческом комплекте v5 standalone прошёл 33 шага, включая 1193 теста с четырьмя
метриками покрытия 100% и replay 265 историй. Игра M1 получила RESULT/DONE, прошла две
проверки по 10 186 тестов с пятью пропусками и четырьмя метриками покрытия 100%.
Подтверждены экспорт, чтение завершённого результата после восстановления и replay
пяти историй. Итог полного v5 — **FAIL** с остановкой neutral по `mechanical-checks-incomplete`.
Standalone не содержит `test:crash` и не квалифицирует физическую потерю Worker.

V6 закреплён отдельно: 391259 байт, SHA-256
`0fdff2cd8e58f4cde7934d2baf317edcae60228be64cf406ba2051b55af28fd7`, 20 exports,
354 compiled-файла совпадают с v5. Отдельный neutral-only v6 реально установлен и прошёл
SDK за 16306 мс: RESULT/DONE, пять checks, completed-result recovery новым Worker/клиентом
без нового simulated turn и replay пяти историй; source-read denial и все stop подтверждены.
Host root10545/четыре100%, 586+354 pins совпали. Одна установка/один SDK/0 game/0 моделей;
`partialScope:true`, `qualification:false`. Допуск1/1 использован; standalone/full v6
не квалифицированы. Подготовительные 64Node/47portable не заменяют этот отдельный actual.

Сохранённые SDK PASS семи Input11 basic-сценариев и отдельного настоящего серверного CAN сохраняют
свою область: Activities/authority/budget/checkpoint ports были синтетическими. Это не native
приёмка, полный T3–T5 или модельное сравнение. Исторический installed preparation PASS
19 входов относится к прежнему снимку; исторический input12 объявлял 21, включая
`./task-execution` и `./task-backend`. Текущая поставка объявляет также `./consumer-release`;
состав входов проверяется по `package.json`, без переноса прежнего installed PASS.
Сводка и первичные исходы — в плане миграции, порядок запуска — в [инструкции](temporal-installation.md).

Текущий source-backed Input11 basic также выполнен отдельно на SDK1.25:7/7 PASS за17491мс,
один сервер, три создания Worker с пиком2, replacement client1, моделей/CAN/установок0.
Source/runtime неизменны, все STOP подтверждены без forced signal;305 файлов доказательств сохранены.
`input11-current-prepared-20261108-b11e0140-92ab-47b9-9c51-5557f0cd677d/execution-result.json`,
SHA-256 `824ede369ca4656a73f6f54a390712daa1bf911c39ab947773961c94707d353b`.
Это actual SDK-проверка текущего среза с синтетическими authority/effects, не native/human
приёмка и не активация T6. Исторический CAN не объявляется заново выполненным.

Подготовленная поставка среза 2026-11-08 после полного `bGAIsf` PASS:21exports, архив454093байта,
SHA-256 `125d98c21994219e1bde2c70e2023943f7b85d46c6536b25fd21fce85ee31fa8`;
`current-package/` в пакете `temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2`
во внешнем каталоге доказательств. Статический checker: errors0,28unknown,
`STATIC_CLOSURE_WITH_UNKNOWNS`, complete:false. Статический результат сохраняет эти неизвестные.
Отдельный текущий neutral-only прогон этого точного архива завершился actual exit0:
одна offline-установка SDK1.25, загрузка всех21 exports из installed-пути,
mechanical RESULT/DONE, пять checks со STOP, восстановление завершённого результата новым
Worker/клиентом без дополнительного simulated turn и replay пяти историй. Запрет чтения
исходников реально проверен, пять родительских процессов остановлены, listener закрыт,
cleanupErrors0. Четыре simulated turns, моделей0, игровых проверок0.
Первичный `actual/report.json` в пакете
`neutral-current-prepared-20261108-9cc0f5b4-d7fb-4d43-984b-87a79317c5de`, SHA-256
`6748a3787cccccd3849287a20aeaae0016343e3f6cb126c5cf4ad0564ae0cd62`.
Это `partialScope:true`, `qualification:false`:21 успешный import не доказывает21 жизненный
цикл. Реально упражнялись reader-host, planning review, task-backend binding и local-task;
activated backend assignment, неизвестный start, pending recovery и рабочее включение T6
этим не квалифицированы. Разовый запуск израсходован, повтор не разрешён.
Установочные исторические результаты ниже сохраняют свои архивы и области.

## Подключаемая приёмка input12, 2026-11-09

Новый исходный срез input12 находится в реализации. Он меняет SDK closure и требует
своих общей проверки, сборки и адресной проверки установленного пакета; результат архива
`125d98c2…` на него не переносится. В этом срезе число публичных входов оставалось21: новые договоры доступны
через прежние `./local-task`, `./task-backend`, `./task-execution`, `./reader-host`.
Рабочие policy/default не переключены, новые модели и службы этим этапом не запускаются.

| Владелец и договор | Производители и потребители | Необходимая проверка |
| --- | --- | --- |
| `task-start-admission/1`, assignment2/policy2 | `adapters/project/taskStartAdmission.ts`, `taskBackend.ts` → `client/taskBackend.ts`, `client/localTask.ts`, `activities/localTask.ts` | Полный inventory origin-card, доверенный principal, previous/+1, отказ до task effects/RPC, неизменность origin |
| Managed input11 → opt-in input12 | `contracts/localTask.ts`, `policy/localTask.ts` → общие `workflows/localTask.ts`, `workflows/taskExecution.ts`, `activities/substantialTask.ts` | Старые bytes/default/checkpoint/Activity traces; настоящие пути attempt12; единый technical pipeline |
| Human ASK/DECIDE и команды исполнения | `nativeTaskSource.ts`, `nativeHumanChoice.ts`, `taskHumanAuthority.ts`, `client/taskExecution.ts` → `workflows/taskHuman.ts`, `activities/taskHuman.ts` | ASK intent не равен публикации; настоящий Native User choice, CAS/дубликаты, гонки команд, Unicode и private source prefix |
| Human checkpoint2 | Общий Workflow → `activities/taskHuman.ts` → продолжение того же Workflow | Настоящий predecessor run из SDK, versioned bytes, тот же TECHPASS/STOP без повторного Writer; новый requirements revision инвалидирует прежние решения |
| Human completion seal | `activities/taskHuman.ts`, `taskHumanCompletion.ts`, `taskHumanCompletionGate.ts` → `activities/localTask.ts`, `finalization.ts`, retained DONE/intent | Actual Activity producer, первичный STOP, completion-only reservation без Writer grant, seal до любого завершающего эффекта; неизвестная чужая reservation не присваивается |
| Файловый backup input12 | `./backup`, CLI `--backup`, schema2 roots → `stageRestore`; private admission/attempt/command/human pointers находятся в Git common-dir | Явно включить внешний common-dir в `legacy` root и отдельно проверить обязательный inventory и artifact refs. Generic files-only PASS не доказывает полноту input12, actual restore, authority или activation; staged bytes требуют reconciliation |

В `./task-execution` новый `controlTaskHuman` использует отдельный Update, а `queryTaskHuman`,
`prepareTaskHumanAsk`, `prepareTaskHumanQuestion` и `prepareTaskHumanDecision` связывают target,
manifest и durable pending ASK. `makeTaskHumanWaitResumeCommand` создаёт отдельный held-free
payload2: same requirements сохраняют attempt/TECHPASS, revision+1 требует новую декларацию.
Эти helpers не вызывают UI за пользователя: внешний доверенный исполнитель публикует настоящий
вопрос, а native adapter проверяет фактические publication/reply refs. `./reader-host`
регистрирует все шесть TaskHuman Activities на control queue.

Текущий task-chat CLI остаётся отдельным потребителем Legacy; этот исходный срез не выдаётся
за его переключение. Перед рабочим T6 нужен inventory начатых задач: старый started-v1 без
сохранённого admission блокирует включение policy2. Исторические архивы и доказательства остаются
с прежними версиями; новое поле не переименовывает прошлую приёмку в human/native qualification.

## Сверка safety7 и нового Legacy receipt, 2026-11-09

13 изменений safety7 относятся к Legacy core/application/journal, source-native стенду,
reference-наблюдателю, тестам и документации. SDK build включает только src;794 локальных
import/export рёбер не выходят из src. Эти изменения не входят в архив `125d98c2…` и его21 exports,
не меняют source task-backend guards, Input11 или T4. Их прежние scoped PASS сохраняют область;
повторное installed/SDK/T4 исполнение только из-за delta13 не требуется.

Новый optional `human_completion` — дополнительный потребительский случай данных. Настоящий
compiled reader/exporter `legacyArchive.js` SHA-256
`0070bf68cdfbe513546159729430d9b6818a9b87d8c16c39f5975af2c5160f80` и вся его локальная closure
из6 модулей совпали с точным архивом; внешние imports — только Node built-ins.
Read/export и verifyBackup на3 форматах сохранили version1 receipt с2 Unicode decisions,
source/target и expanded history точно. Исходные имена/bytes/modes неизменны,
history/manifest refs и backup blobs проверены; executionImport=false/requiresReconciliation=true.
Пакет `td055-legacy-archive-receipt-proof-20261109-957160b5-ab92-4a91-bacd-b68ec142297b`,
result SHA-256 `5eafc9b3acf4ac72c8b2e5736fc8333a63de31d8d6ae72b2117041dc550fd66c`.
Это local data-preservation proof на тех же compiled bytes без установки/сборки/SDK/моделей;
не новый installed-all21 PASS и не подтверждение настоящей human authority.

Root full7 прошёл:15074 теста, четыре100%,13371 исходник/toolchain неизменны.
Новая native deadline LOAD/STOP граница остаётся UNKNOWN до свежего разового grant;
новый общий допуск и data proof не включают T6 или v12 human gates.

## Проверенные потребители

### Подключение после окончательного выноса

Игровой проект закрепляет архив `@agent-workflow/runtime@0.1.2` и передаёт проектные настройки
установленному инструменту. Общие команды разработки, процедуры, профили и стенды исполняются
из собственной поставки или репозитория agent-workflow. Для разработки и проверок инструмента
достаточно отдельного checkout. Стенд с реальным потребителем получает корень этого потребителя явно.

Для сравнения сохранена статическая карта версии 0.1.1.
Она перечисляет исходные точки вызова, владельцев эффектов, тесты и вопросы TEMP-01/02/15/16/19
на момент описи. Сохранённые права и проверки принадлежат исходным попыткам.

### Договоры и оставшаяся квалификация

| Потребитель и вход | Нынешний договор и зависимости | Подготовка / необходимое изменение перед T6 | Проверка перед включением |
| --- | --- | --- | --- |
| Корневой CLI `package.json` → `cli/main.ts` | `task-chat start` при политике версии 2 проверяет Input12 и запускает Temporal через SDK; другие пути `task-chat`, `chatCommand.ts`, `chatRuntime.ts` и `application/currentChatWorkflow.ts` охраняют прежний Store | Квалифицировать штатный запуск и проверку единственного назначения до эффекта | Повтор зарегистрированной задачи под новым ID и пишущий Legacy-вход после T6 получают отказ до эффекта; неизвестный backend запрещает запись |
| Навык `.agents/skills/agent-workflow/SKILL.md` | `task-chat`, `CURRENT-CHAT.md`, `project/workflow.json`, версии/hash процедур и прежние команды | В T6 согласованно обновить обнаружение клиента и команды запуска и управления в Temporal | Новый start идёт в Temporal, продолжение Temporal использует существующее исполнение; LOAD, требования, owner/generation сохраняются |
| Repository H-01: `tests/comparisonH01.ts` | Отдельная version2 attempt: baseline legacy, candidate Temporal; подготовитель черновиков, ограниченный внешний оператор, общий primary grant, managed credits, checker и совет | Optional CLI не переключает task-chat или навык | Профильные doubles/Node-процессы и общий validate; настоящий H-01 требует собственного допуска и остаётся открытым |
| Repository H06: `tests/comparisonH06Package.ts` | Команды инструмента `comparison:h06:package` и `comparison:h06:preflight` через `scripts/agentWorkflow.mjs dev` вызывают самостоятельный инструмент; пакет связывает существующие Legacy/Temporal API с точными входами | Репозиторный вход заменяет копируемый runner; подготовка и проверки не переключают backend рабочих задач | [Порядок проверок H06](temporal-comparison.md#подготовка-h06-и-порядок-проверок); preflight использует настоящий SQLite, журналы, копии, STOP процессов и /3 control с заменой только модельного RPC и первичных входов фикстуры; это не новый живой допуск |
| Temporal CLI `src/client/index.ts` | Подготовка, статус и backup. Состав SDK закреплён публичными exports пакета | Проверять штатные входы Temporal через установленный пакет. Архивный вход удалён в кандидате T6 | Схема/версия, чужой project/task, дубликат и конфликт; новая модель не запускается ради статуса |
| `harness2/pilot.py`, `cli/harness2.ts`, `adapters/codex/harness2Bridge.ts` | Прямой TS-вход, CLI и Python отвергают новые модельные запуски; чистые проверки и чтение прежних отчётов сохраняются | Выбранная часть TEMP-15 реализована локальным отказом до RPC, процесса и записи, без обходного флага. Исторический bridge на Temporal не переносится | TS/Python-регрессии проверяют отсутствие эффектов; остальные consumers и включение T6 требуют своих доказательств |
| `comparison/`, `cli/comparisonSeries.ts`, `comparisonReport.ts` | Прежние `core/comparison.ts`, snapshot/materials, `FileCurrentChatHost`, journal/Store, native usage | Существующий исполнитель не сравнивает Temporal автоматически. `tests/comparisonReadiness.ts` офлайн сверяет manifest шести прежних cases; для полной серии ещё нужны оркестрация и квалификация двух путей; отдельный H01 уже реализован для одной attempt; методика — [temporal-comparison.md](temporal-comparison.md) | Одинаковые задача/байты/модель/критерии/среда, все попытки и расходы, первичные native-доказательства; прежняя живая серия не переиспользуется как разрешение |
| Игра: `tools/agent-workflow/project/temporal.json` | `ProjectDescriptor` v1, `AGENTS.md`, `docs/exec-plans/active`, роль architecture, check ID `validate` | Preparation копирует только входы descriptor; отдельный installed-full использует реальное M1-приложение и полную verification-копию | Candidate и integrated `validate:brief` прошли на v5 и `41fe8d8d…`; роли синтетические, живая приёмка T5 открыта |
| Нейтральный пример `examples/neutral/` | Descriptor v1; собственные `RULES.md`, `tasks`, reviewer, syntax; используется preparation/SDK стендами | `examples/temporal-consumers/neutral/` — отдельный устанавливаемый потребитель с `work-items`, `roles` и syntax | Полный прогон `41fe8d8d…` прошёл при запрете чтения исходного checkout; тот же пакет и схема с игрой, иные правила, пути и команды |
| Installed neutral: `tests/temporal/installed-full-consumers.mjs`, `consumer:"neutral"` | Отдельная суммирующая функция `total.mjs`, project checks `baseline` и `validate`; реальные `node:test` команды | Optional request выбирает только neutral. Узкий v6 прошёл за 16,3 с с одной offline-установкой и одним SDK | Пять квитанций с kind/order/owner SHA/command/sourceError/stop, result/recovery/replay и экспорт подтверждены также в полном прогоне `41fe8d8d…` |
| `tests/temporal/standalone.mjs` | Копирует собственные исходники/тесты/lock, отдельно устанавливает/собирает/проверяет при OS-запрете исходных checkout | V5 PASS 33 шагов/1193/четыре 100%/replay 265. Это отдельное доказательство от installed neutral; standalone v6 не запускался | Исходный запрет реально действует; `test:crash` в 33 шага не входит, физическая потеря Worker этим не подтверждена |
| Планы, профиль, README/PORTABILITY, архитектурные проверки | Описывают два сосуществующих пути, запрещают новым Activities старый сохраняющий lifecycle-код | Обновлять по фактическим входам и доказательствам. Исторические ссылки и намеренную совместимость отличать от пропущенного потребителя | Документальные ссылки и инвентаризация оставшихся imports/команд перед общей проверкой |

Пути владельцев инструмента в таблице относятся к корню самостоятельного `agent-workflow`.
Пути игры явно помечены; её замороженный runtime остаётся в `tools/agent-workflow/`.
Исторические пути и результаты не превращаются в новые квалификации после переноса.

## Границы создания, продолжения и записи перед T6

Реализованы общее неизменяемое назначение backend и проверки перечисленных ниже входов.
Они ещё не включены в рабочем проекте. Таблица сохраняет исходную карту потребителей;
состояние реализации и оставшиеся ограничения описаны после неё. Наличие guard в исходниках
не квалифицирует старые установленные версии и не заменяет допуск T6.

| Производитель / потребитель | Исходная граница до backend guard | Требование к подключению T6 |
| --- | --- | --- |
| Корневой `package.json` → `cli/main.ts` → `taskChatCommand.ts` | `start` создаёт connection journal, council, managed/request и затем Store; `continue`, `revise`, `load` также могут сохранять managed-состояние. Проверки backend нет | До первой записи проверить неизменное назначение задачи; новый `start` после включения не должен попадать в legacy. `load` не считать автоматически читающей операцией |
| `cli/main.ts` → `chatCommand.ts` → `chatRuntime.ts` | Прямые JSON-команды обходят `task-chat`. Все runtime-команды кроме `status-chat`/`compact-context-chat` используют writer lock и live Store; `prepare-chat`/`bootstrap-chat` могут инициализировать Store | Проверять назначение в общей пишущей границе, включая прямые вызовы `executeChatRequest`, до инициализации, lease, intent и эффекта. Проверки только в `main.ts` недостаточно |
| `taskConnectionCommand.ts`, `chatCommand.ts` | `apply-task`, `disable-task`, `rollback-task`, `connect-chat`, выдача команд, обслуживание Store/файлов и подготовка доказательств имеют собственные записи вне runtime-dispatch | Подключение карточки не равно выбору движка. Не позволять этим входам создать второе подключение задачи; обслуживание сохраняет прежние отдельные полномочия и принадлежность backend |
| `.agents/skills/agent-workflow/SKILL.md` → `CURRENT-CHAT.md` | Навык выбирает прежние `task-chat start/continue/revise/load/wait`; не читает общий реестр backend | Обновлять discovery и команды вместе с рабочим клиентом. Продолжение выбирает сохранённый backend, а не текущий default или наличие Temporal |
| `src/client/index.ts` и exports `./preparation`, `./local-admission`, `./local-task` | `startPreparation`, `startLocalAdmission`, `startLocalTask` непосредственно вызывают `client.workflow.start`; CLI предоставляет preparation, статус, backup и legacy archive | Общий допуск обязателен и для прямого SDK, до server start. Preparation и admission не заменяют назначение backend. `startLocalTask` уже запрещает ненулевую continuation attempt, но не знает старый Store |
| Exports `./reader`, `./review`, `./audit`, `./finalization` | `startControlledReader`, `startReview`, `startAudit`, `startFinalization` — ещё четыре прямых `client.workflow.start` | Проверять связь с назначенной задачей и полномочия запуска; разрешённый отдельный квалификационный сценарий явно отличать от рабочей задачи |
| Exports `./task-continuation`, `./task-execution`, `./reader` | `controlTaskPlanning`, `controlTaskExecution`, `controlReader` получают handle и вызывают update; проверяют target/hash/receipt, но не общий backend | До update сверять назначение и целевой workflow. Ошибка соединения не разрешает fallback или новый start |
| `src/workflows/localTask.ts`, `taskContinuation.ts`, `taskExecution.ts`, `taskAudit.ts`, `stageAudit.ts`, `review.ts` | Child Review/Audit/ControlledReader создаются через `executeChild`, из уже начатого родителя | Дочернее исполнение сохраняет принадлежность родителю; не назначать ему новый backend и не создавать второй журнал lifecycle |
| Exports `./worker`, `./reader-host`, `./reader-recovery`, `./finalization-host`; `src/worker/taskRecovery.ts` | Workers исполняют полученные workflow/Activity; reader host уже отказывает незарегистрированному project/task/host. Recovery восстанавливает привязанный объект, а не выбирает движок | Сохранить существующие host-проверки и связать рабочий допуск с неизменным назначением задачи до внешнего эффекта. Регистрация host не является общим назначением backend; прямой RPC start не должен обходить границу эффектов |
| `cli/comparisonSeries.ts` → `FileCurrentChatHost`; `cli/comparisonReport.ts` | `comparison-prepare` пишет изолированный комплект; `comparison-run` имеет собственный live-допуск, series lock и native-запуск; report читает прежний результат | Старый runner не становится Temporal от смены default. До штатного нового запуска либо квалифицировать маршрут обоих участников, либо явно исключить этот запуск; report и исходные FAIL сохранять |
| `harness2/pilot.py` → `cli/harness2.ts` → `adapters/codex/harness2Bridge.ts` | Отказные входы без App Server transport и запуска модели; прежние отчёты и чистые проверки доступны | Новый запуск запрещён до RPC и записи независимо от backend. Локальный отказ не является квалификацией Temporal или приёмкой остальных consumers |
| `tests/comparisonH01*`, `comparisonH04*`, `comparisonH06*`, `tests/temporal/*`, `examples/temporal-consumers/full/sdk-run.mjs` | Изолированные квалификационные producers, включая прямые `client.workflow.start` в control/native-reader/task-execution-sdk/T4-стенде и SDK starts в остальных | Сохранить точные разрешения стендов; они не должны принимать рабочую задачу в обход общего допуска. Их PASS не доказывает подключение CLI/навыка |
| `adapters/storage/processEvidenceStore.ts` → `cli/storageWorker.ts` | Worker непосредственно открывает `SqliteEvidenceStore`; операции передаются отдельным запросом. Найденные потребители ProcessEvidenceStore — тесты ownerLease/storageProcess/storageRecovery/archiveJson; рабочего вызова вне тестов не найдено | Сохранить опись прямого storage-входа при подключении реального потребителя; один CLI guard его не защищает. Не добавлять в неиспользуемый адаптер новый маршрутизатор lifecycle |
| `status-chat`, `compact-context-chat`, `./status`, `./legacy-archive`, comparison report, artifact readers | Чтение состояния/архива без модели; SQLite status/compact используют inspect и отказывают при WAL/journal recovery-required | Квалифицировать статус Temporal и неизменность первичных доказательств. Поддержка Legacy-форматов вне целевой поставки |

Поиск по `client.workflow.start` в `src/client` на этом срезе даёт семь владельцев:
preparation, localAdmission, localTask, reader, review, audit, finalization. Прямые SDK-вызовы,
child workflows и стенды перечислены отдельно, поскольку одна проверка корневого CLI их не охватит.
Внешние установленные пакеты, shell-обёртки и фоновые Workers остаются unknown до адресной описи.

## Подготовленный порядок включения, без активации

1. Проверить реализованное единственное каноническое место **неизменяемого назначения**
   backend: Git common-dir `agent-workflow/backend-assignments`. Оно хранит
   назначение и ссылку на карточку, а не второй изменяемый lifecycle. Назначение закрепляется
   до первой записи/внешнего эффекта и проверяется на последующих пишущих входах; движки не могут независимо
   объявить одну задачу новой. Смена ID карточки ради продолжения в другом движке запрещена.
2. До открытия новых запусков проверить обнаружение повторного запроса по исходным ID и
   карточке зарегистрированной задачи. Неизвестная принадлежность блокирует запись до сверки.
3. Подключить применимые границы таблицы к этому назначению и проверить обычные и обходные входы.
   Неизвестные consumer/backend, версия назначения, коллизия идентичности и недоступный
   источник назначения запрещают start/control/write до эффекта. После переключения
   пишущие входы Legacy также получают отказ. Temporal-задача восстанавливается в Temporal.
4. Отдельно квалифицировать рабочие CLI/навык и принятое решение по новым запускам
   harness2/comparison, сверить установленные версии и оставшиеся runtime imports. Выполнить
   применимые T3–T5 и обязательные проверки плана. Лишь после отдельного разрешения T6
   менять default для новых задач; допуск архитектуры или эта карта его не заменяют.
5. Откат включения запрещает дальнейшие новые starts и сохраняет назначения созданных задач.
   Исполнение восстанавливается в Temporal. Поддержка Legacy исключается из рабочей
   поставки в T6 по [ADR-0075](design/decisions/0075-exclude-legacy-from-temporal-delivery.md).
   Очистка исходных Store остаётся отдельным действием.

### Реализованные границы и оставшаяся квалификация

`src/adapters/project/taskBackend.ts` хранит policy и атомарно резервируемые назначения
в Git common-dir. Назначение содержит project/task/backend, basename карточки и SHA-256
её исходных байтов; замена backend, повтор карточки под новым ID и конфликт байтов запрещены.
Одинаковые basename разных вложенных карточек также считаются коллизией: это консервативное
ограничение, не доказательство распознавания смысловых копий изменённого текста.

Активация требует policy и отдельной декларации `schemaVersion:1, required:true` в
`.agent-workflow-backend.json` рабочей копии или `agent-workflow-backend.json` Git common-dir.
Наблюдавший включение guard запоминает его: потеря policy, Git или назначения не возвращает
старый маршрут. Для сохранения этого требования после полного удаления метаданных и перезапуска
доверенная регистрация использует `taskBackend:required`. Эти файлы здесь не создавались.

Подключены Legacy task-chat/JSON/connection, comparison и harness2, семь публичных SDK starts,
четыре control-входа (включая отдельный `controlTaskHuman`) и Worker Activities перед эффектами. SDK требует явный
`bindTaskBackendClient(client, registration)` из `./task-backend`, даже без policy; fallback
по cwd отсутствует. Для input12 регистрация включает `artifactRoot`, а третий аргумент
`bindTaskBackendClient` передаёт доверенный `TaskStartPrincipalAuthority`; прежний двухаргументный
вход сохраняется для старых договоров. Привязка закрепляет проект, реальную рабочую папку, host/owner/generation;
несовпадение отказывает до RPC. CLI preparation принимает четвёртый аргумент REGISTRATION.json.
Стенды и установочный пример обновлены; fixture-корни изолированы собственным Git, без
декларации включения. Завершающие STOP/release и читающие архивные пути сохранены.

Storage-worker при включённом backend в его cwd блокируется. Старый opaque storage-запрос
не содержит доверенной рабочей папки: запуск из другого cwd и старые установленные бинарники
не получают этим изменением глобальной защиты. До T6 нужны адресная опись, квалификация
установленных входов и запрет неизвестных внешних writers. Штатный `task-chat start` при
действующей политике версии 2 принимает подготовленный пакет Temporal. Смена default
относится к T6.

Адресная опись ProcessEvidenceStore нашла только четыре тестовых потребителя: owner lease,
storage recovery, JSON archive и storage process. Штатный CLI его не вызывает; legacy storage
modules отсутствуют в точном установленном архиве `125d98…` (`tsconfig.build.json` включает
`src/**/*.ts`). Этот экспериментальный source-only запуск исключён из штатных T6 writers,
как допускает TEMP-15. Это не исправление обхода cwd и не запрет файловой записи произвольного
старого бинарника с прежними OS-правами. При появлении рабочего потребителя нужны явная доверенная
workspace-binding и проверка до любого Store effect; новую инфраструктуру без такого потребителя
сейчас не добавляем.

В архиве `858b85a4…` правила упаковки CLI и адаптеров уже включали
`cli/storageWorker.ts` и `adapters/storage/processEvidenceStore.ts`. У обоих
файлов только тестовые потребители. Теперь правила упаковки исключают эти
файлы. Проверка поставки сверяет оба пути в архиве, загружает публичные входы
и запускает установленный `freeze-checks` из внешнего каталога. При политике
Temporal в указанном проекте ожидается `backend-consumer-not-qualified`.
Ранее распакованные версии требуют отдельного учёта перед T6.

#### Опись игры и нейтрального стенда от 2026-11-19

| Потребитель | Установка и вход | Результат сверки |
| --- | --- | --- |
| Рабочая копия игры | Проектная команда `yarn agent-workflow` и навык используют игровой `scripts/agentWorkflow.mjs`. Для SDK обёртка принимает `--status`, `--backup`, `--legacy-archive`. | Штатная команда `node scripts/agentWorkflow.mjs verify` подтвердила архив `77bd5a62…` версии 0.1.2 и манифест из 989 файлов. В установке присутствуют `cli/storageWorker.ts` и `adapters/storage/processEvidenceStore.ts`. Декларации включения в рабочей копии и Git common-dir, политика и каталог назначений отсутствовали при проверке. |
| Нейтральный проект полного стенда | Отчёт прогона `t7-full-retry-20261105-UNl0p7` закрепляет архив `41fe8d8d…` и временный каталог установки. | Контрольная сумма отчёта совпала с итоговой квитанцией. Очистка завершена, указанный каталог отсутствует. Образец `examples/temporal-consumers/neutral` остаётся входом для следующей установки. |

У кандидата версии 0.1.2 архив `d97d6395…`. При итоговой установке T5
сверить архив и состав файлов обоих потребителей. До T6 также требуется проверить
внешние процессы и их права записи. Опись показывает доступные файлы в названных
местах и оставляет статус действующих разрешений открытым.
Квитанция — `tmp/t15-consumer-inventory-20261119/inventory.json`.

Штатный `task-chat start` через [подготовленный пакет SDK](../CURRENT-CHAT.md#запуск-через-temporal)
проверяет строгий `SubstantialPlan`, обе фазы совета с полным составом ролей дескриптора
Temporal, профили, команды и первичный допуск до создания назначения. Применимость ролей
задаётся явно. Назначение сохраняет адрес, namespace и очередь Temporal. `startLocalTask`
проверяет это назначение, использует стабильный Workflow ID и сверяет точный вход исполнения.
На изолированном стенде установленная команда передала Input12 зарегистрированному
Worker. Завершённая Activity `prepareTaskExecution` вернула ссылку на квитанцию
`task-execution-admission` с исходным допуском. Повтор сохранил Workflow ID и Run ID,
а смена очереди завершилась отказом `backend-assignment-conflict`; байты назначения
остались прежними. CLI и Worker загружены из распакованного npm-архива с общими
локальными зависимостями. Источником поручения служила изолированная тестовая запись
Desktop 0.166. Прогон остановлен после допуска, модельных запусков — ноль.
Квитанция — `tmp/t15-installed-start-20261119/stand-VmRcd2/proof.json`.

После штатного назначения тестовой задачи и остановки стенда проверены 13 отказов
установленного CLI. Старый формат `task-chat start` потребовал вход Temporal.
Для тестового сохранённого состояния с идентификаторами назначенной задачи
`continue`, `load` и `revise` вернули `backend-route-conflict`, для неизвестной
задачи `continue` вернул `backend-assignment-required`. Семь команд записи
(`freeze-checks`, `package-checks`, `refresh-council`, `repeat-council`, `retain-store`,
`relocate-files`, `materialize-files`) и `comparison-run` вернули
`backend-consumer-not-qualified`. После каждого отказа сверены содержимое и режимы
файлов проекта с назначением, обоих тестовых состояний, хранилища артефактов
и каталога Worker. Каталог серии не появился. Квитанция —
`tmp/t15-legacy-fence-20261119/stand-GLnkSn/fence.json`.

Исходные policy2/assignment2/input12, native ASK/DECIDE adapter, completion seal и checkpoint2
реализованы и подключены к общему SDK/Workflow. Они ещё требуют текущей успешной полной
проверки, установленного потребителя и отдельно разрешённых actual SDK/native/backup сценариев.
Вход Temporal принимает уже подготовленные ссылки и допуск SDK. Свободное предложение
`--plan` относится к прежнему входу.
Подготовленный SDK12 стенд с синтетическими authority/effect ports не доказывает реальную
пару native question/reply, физическую потерю Worker или рабочее включение T6.

Регрессии размещены у реальных границ. Полная приёмка T6 дополнительно должна подтвердить:

- Новый start до включения сохраняет нынешний маршрут; после разрешённого включения единожды
  резервирует Temporal. Одновременные starts через CLI и SDK не создают двух владельцев;
  повтор читает то же назначение, конфликт не меняет его и не вызывает эффект.
- Назначение зарегистрированной задачи неизменно. Попытка смены backend или создания копии
  под новым ID получает отказ. Неизвестный consumer/backend/формат, неполный пакет и
  недоступное назначение блокируют запись и Temporal start/update.
- Прямые JSON runtime-команды, семь SDK starts, control updates, connection/maintenance,
  storage-worker и native harness/comparison проходят тот же допуск либо явно запрещены
  в штатной поставке. Child workflow наследует задачу и не создаёт новое назначение.
- Сбой между резервированием и start восстанавливается по той же identity; timeout/unknown
  после start не запускает другой backend или новый operation ID. Сохраняются исходные FAIL,
  evidence ID/hash, receipts, проверки owner/generation и отдельные права на эффекты.
- Статус Temporal читается без модели и записи назначения. Backup/restore подтверждает
  восстановление Temporal с прежними квитанциями и привязкой задачи.

Адресные backend-проверки уже размещены у перечисленных потребителей. Таблица сохраняет
владельцев недостающих сценариев; установленная поставка и неизвестные внешние writers
требуют отдельной квалификации:

| Граница | Владельцы проверок отказа, повтора и оставшейся квалификации |
| --- | --- |
| `task-chat` и прямые JSON runtime-команды | `tests/taskChatCommand.test.ts`, `tests/chatRuntime.test.ts`, `tests/cli.integration.test.ts` |
| Подключение и обслуживание | `tests/taskConnection.test.ts`; тесты конкретного maintenance-владельца при его подключении |
| Семь SDK starts и control | `tests/temporal/preparation.test.ts`, `localAdmission.test.ts`, `localTask.test.ts`, `readerControl.test.ts`, `review.test.ts`, `audit.test.ts`, `finalization.test.ts`, `taskContinuation.test.ts`, `taskExecutionClient.test.ts` в том же каталоге |
| Наследование child workflow | `tests/temporal/localTaskWorkflow.test.ts`, `taskContinuationWorkflow.test.ts`, `taskExecutionWorkflow.test.ts`, `reviewWorkflow.test.ts`, `auditWorkflow.test.ts` в том же каталоге |
| Worker и восстановление | `tests/temporal/readerHost.test.ts`, `readerRecovery.test.ts`, `taskRecovery.test.ts`, `finalizationWorkflow.test.ts` в том же каталоге; отсутствующий сценарий finalization host добавить у его реального внешнего порта |
| Сохраняемые comparison/harness2 входы | `tests/comparisonSeries.test.ts`, `tests/comparisonReport.test.ts`, `cli/harness2.test.ts`, `adapters/codex/harness2Bridge.test.ts`, `harness2/test_pilot.py` |
| Прямой storage-worker и установленный пакет | `tests/storageProcess.test.ts`, `tests/storageRecovery.integration.test.ts`; при подключении рабочего потребителя — сценарий его записи. `tests/temporal/packageClosure.test.mjs`, `pinned-consumers.test.mjs`, `installed-full-consumers.test.mjs` в том же каталоге; затем квалификация установленного потребителя |

До реализации и проверки этих границ состояние остаётся **T6 не включён, к включению не готов**.

## Что пока требует прежнего runtime

| Обязанность | Владельцы | Условие удаления / сохранения |
| --- | --- | --- |
| Штатное исполнение Legacy до переключения | `application/*Workflow.ts`, `cli/chatRuntime.ts`, `core/localRun.ts`, `core/execution.ts` | В T6 закрыть пишущие входы и проверить оставшихся потребителей перед удалением исполняющих модулей из штатной поставки |
| Технический lifecycle и lease/checkpoint | `adapters/storage/storeDatabase.ts`, `workflowJournal.ts`, `localRunStores.ts`, coordination/relay journals | Новые Temporal Workflows не импортируют их. Оставшиеся зависимости проверяются при удалении из штатной поставки в T6 |
| Исторические evidence/ID/hash и Result | `ports/evidenceStore.ts`, `adapters/storage/archiveJson.ts`, `sharedJson.ts`, `sharedArtifacts.ts`, `storeBackup.ts` | Существующие доказательства сохраняются с исходными ссылками. Legacy reader/exporter исключён из критериев поставки |
| Статус и контекст прежней задачи | `cli/chatRuntime.ts` → `SqliteEvidenceStore` → `StoreDatabase` в режиме `inspect` | Существующие `status-chat` и `compact-context-chat` читают через SQLite-блокировку без записи и смены режима журнала. Их совместимость не входит в T6 |
| Источник команд исполнения Temporal | `src/activities/localTask.ts` ← доверенный `LocalTaskHost` | По умолчанию только `human`. Проверенный стенд H06/3 явно выбирает `executionCommandOrigin: initial-grant`; автор, hash, proof и прежний intent проверяются так же. Общий native reader и рабочие точки входа сохраняют прежние права |
| Внешние identity/intent/outcome/unknown/stop | Узкие Codex, Git, FS и process adapters | Не удалять вместе с lifecycle: это самостоятельные внешние гарантии. Перенос по потребителю и контракту, без второго технического автомата |
| Старые comparison/harness2 отчёты | Их читатели/схемы и первичные журналы | Сохранять первичные материалы проведённых проверок |

Из кандидата T6 исключены 13 модулей прежней реализации, включая `relayWorkflow`,
`finalizationWorkflow`, их журналы и `workflowUpgrade`. Их исходники остаются доступны
разработчику и историческим проверкам. Перечень модулей, оставшиеся пути импорта
и результат проверки установленной игровой обёртки приведены в
[плане миграции](exec-plans/active/2026-10-27-agent-workflow-temporal-migration.md#стендовая-проверка-маршрута-t6-от-22-ноября).
Остальные используемые компоненты прежнего исполнителя входят в поставку до рабочего
переключения. T7 оформляет квалифицированную самостоятельную поставку.

## Старые задачи и Store

Чтение старой задачи использует её исходные identity, backend, формат и доказательства.
Новый checkout не перепривязывает owner/SourceBinding и не даёт права продолжать исполнение.
UNKNOWN блокирует повтор или передачу до первичной сверки. Конкретные старые task IDs и
locators доступны в [первичных материалах](evidence/README.md).

## Порядок дальнейшего перехода

1. Учитывать установочный PASS обоих потребителей для закреплённого архива `41fe8d8d…`.
   Для полного T5 остаётся живая приёмка восстановления активного Writer. Для нового архива
   выполнить проверки по [инструкции](temporal-installation.md).
   Оставшиеся T3/T4/T5 проверять по [единому порядку](exec-plans/active/2026-10-27-agent-workflow-temporal-migration.md#единый-порядок-приёмки-без-повторных-прогонов):
   один окончательный пакет, общие пригодные доказательства и повторы только по изменённым входам,
   отказу или новому риску. Проверки разных потребителей и native-границ не подменяют друг друга.
2. До серии отдельно согласовать и записать методику, бюджет и первичный источник поручения.
3. Перед T6 сверить карту с реальными входами и зависимостями поставки. Назначение backend
   атомарно закреплять до первого эффекта; unknown блокирует старт.
   Реализовать и проверить отказ новым модельным запускам Harness² в штатной поставке;
   документное исключение не является уже действующим запретом.
4. После отдельного разрешения включить Temporal для новых задач. При сбое Temporal
   исполнение остаётся у своего backend на паузе до сверки.
5. В T6 после проверок переключения исключить поддержку Legacy из штатной поставки.
   Параллельно в T7 проверить подключение внешнего репозитория и обновление зависимости
   с сохранением его проектных настроек.
   Физическая очистка исходных Store требует отдельных полномочий и проверенной копии.

## Подготовка полного установленного game/neutral

Новый `tests/temporal/installed-full-consumers.mjs` отделён от preparation-стенда. Он использует
один pinned tarball в двух установленных driver, настоящий SDK M1 и полную verification-копию
игры с полной проверкой для candidate/integrated — команда проекта-потребителя G `yarn validate:brief`.
Она выполняется в копии игры; это не команда самостоятельного agent-workflow. Checker получает только заранее
разрешённые exact candidate bytes/hash; OS-запрет runtime распространяется на оба исходных
checkout и полные verification-копии, включая их source инструмента. Checker читает только
собственную полную копию по фиксированным командам и не считается source-free runtime.

Владелец реального игрового сценария — `playerStoryProfileScores.ts`; прямая карта включает
PlayerStoryFlow, playerStoryHost, playerNativeGameRuntime и существующие тесты проекции/библиотеки.
Временный намеренный дефект и его точное исправление не меняют исходную игру или её правила.
Нейтральный проект имеет собственную суммирующую функцию и `node:test`.

Ранний timeout FAIL и последующие checker FAIL сохранены как отдельные первичные исходы.
Позднее выполненный v5 bundle завершил standalone и игру, но весь full отказал на neutral:
обязательный baseline отсутствовал в материале. Runtime правильно остановил задачу; scope игры
не заменяет непройденный neutral. Failed roots не используются для записи, новых сборок или повторов.

В текущем host-стенде material наследует все project.checks; checker допускает baseline только
для pinned before/approved, validate — только approved. Default full по-прежнему использует
три установки и два проекта. Отдельный neutral-only использует одну установку, один SDK и две
последовательности baseline/validate после исходного baseline; игровых команд нет. Узкий
`--plan REQUEST` отражает внутренний cap 10 минут и `partialScope:true`; он не запускает
установку/службы и не выдаёт допуск. Pin архива и hashes реально используемых host helper-файлов
закрепляются отдельно. Подготовительные 64 Node/47 source-denied/root PASS и отдельный фактический v6 neutral
за 16,3с имеют разные области. Его разрешение использовано, первичные данные и точный
host-снимок сохранены; повтор требует нового комплекта и допуска.

Native роли заменены явным deterministic double; восстановление ограничено новым Worker/клиентом
завершённого результата и replay. Активные операции, независимая native приёмка, пиковые ресурсы
и полный T3–T5 не квалифицированы. Этот прогон предшествовал подключению штатного `task-chat start`
через SDK при политике версии 2. Рабочее переключение остаётся этапом T6. Точные команды, pins, остановка/экспорт и
необходимый отдельный допуск — в [инструкции](temporal-installation.md#узкий-neutral-only-порядок-подготовки-и-запуска).
