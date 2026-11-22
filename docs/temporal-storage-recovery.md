# Архив истории, копии файлов и восстановление

Эти операции сохраняют доказательства независимо от исполнения. Они не назначают следующую
стадию Workflow, не подтверждают остановку исполнителя и не выдают RESULT/DONE. Незавершённая
задача остаётся в прежнем движке; архив никогда не импортирует её исполнение в Temporal.

## Границы данных

| Данные | Владелец и восстановление |
| --- | --- |
| История и состояние нового исполнения | Temporal persistence; нужен настоящий PostgreSQL backup/restore и проверка Temporal |
| Неизменяемые доказательства | Отдельные файлы по SHA-256; сохраняются исходные FAIL, findings, Result и ссылки |
| Локальные квитанции | Identity/intent/outcome/unknown и поколения; после восстановления обязательна первичная сверка |
| Проекции | Производные файлы; копируются независимо, не становятся источником истины |
| Рабочие копии и сборка | Отдельные файловые границы; сохранение не подтверждает остановку writer или совместимость Worker |

Пути абсолютные, без ссылок и пересечений. Назначение должно отсутствовать. Источники не
удаляются и не изменяются; повтор не перезаписывает копию. Все восстановленные каталоги
получают права 0700, файлы 0600, исполняемые файлы 0700. Копия может содержать закрытые
материалы проекта: доступ нужен только оператору и назначенному восстановителю.

## Что подтверждено и какой допуск нужен дальше

Срез на 2026-10-30 по [плану миграции](exec-plans/completed/2026-10-27-agent-workflow-temporal-migration.md).
Запись доказательства ниже не выдаёт полномочия на новый запуск; прежние разовые окна закрыты.

| Граница | Доказано | Неизвестно / не проверено | Следующий допуск |
| --- | --- | --- | --- |
| Подготовка копии `save` / `verify` | Проверка закреплённых manifest/blob refs, hash/bytes и отказ неполной или повреждённой копии | Целостность БД по одной сигнатуре dump, остановка writer и действительность grants | Файловая операция в согласованных новых каталогах; БД/SDK этим не разрешены |
| Staging и перенос locator | [Files-only relocation](evidence/README.md): прежние manifest/snapshot refs, ID/hash/FAIL/findings/Result сохранены; API verify/stage приняли новый locator | Новое восстановление БД после переноса, off-disk защита и разрешение продолжения | Для проверки/stage — отдельные новые файловые назначения; запуск backend требует нового прямого допуска |
| Закрытый SQLite-снимок CLI | Отдельная прежняя проба восстановила читаемость восьми закрытых историй и refs через mutable копию snapshot | Незавершённый writer, grants и whole-store восстановление | Новый CLI/SDK-сервисный стенд требует собственного ограниченного допуска; архивный snapshot не открывать как mutable persistence |
| Малый quiesced PG Temporal restore | [Реальная проба](#реальное-доказательство-2026-10-29-и-его-пределы): native restore default/visibility и тестовых файлов; RPO metric 957 ms, RTO metric 3188 ms в указанном ниже локальном scope | Production ACL/секреты, нагрузка, действующие внешние writers, off-disk и SLA | Новый конкретный restore config с данными, версиями, ресурсами, stop/export и новым прямым допуском; старый PASS не разрешает повтор |
| Последние v5 game/neutral exports | [Files-only preservation](evidence/README.md): 252 файла и обе SQLite совпали с export; ID/hash/CAS и known-stop observations сохранены | БД не открывались; новый restore, integrity, согласованный DB/artifacts cut и in-flight recovery не проверялись | Чтение refs не разрешает запуск БД, Workers или resume; для restore нужен отдельно принятый комплект и новый допуск |
| Whole-store / промышленный контур | Эти пробы его не квалифицируют | Production ACL, внешний диск, расписание, потеря хоста, RPO 24 ч / RTO 2 ч под нагрузкой и SLA | Сначала закрепить реальные backend/данные/права, границы writers/unknown и проверяемый план восстановления; затем согласовать точный новый прогон |

В последнем v5 комплекте standalone/game имеют свои scoped PASS, но общий full остаётся FAIL:
neutral сохранил blocked. Физический export SQLite и game completed-result recovery не являются
новым восстановлением persistence. Независимый files-only разбор не открывал SQLite, не запускал
сервер и не снимал unknown. Его known-stop snapshot относится к записанным identities/endpoints
в момент наблюдения, а не подтверждает их будущую остановку. Failed root и первичные exports
остаются сохранёнными; эта таблица не разрешает их очистку.

Ссылки на отчёты — локальные read-only locators квалификационных копий, не новые доказательства
и не содержимое Git/npm. При их недоступности граница остаётся неподтверждённой. При этой
документальной сверке отчёты не копировались, primary/hashes/БД повторно не проверялись.

## Свежая синтетическая сервисная проба, 2026-11-08

На текущем проверенном срезе один отдельно согласованный прогон завершился
`PASS_SCOPED_FRESH_SYNTHETIC_RESTORE`, exit0 за11110мс. Первичный результат:
[/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2/t4-service-execution-c54e20c1-df07-4e39-a975-6fc09d07755c/result.json](/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2/t4-service-execution-c54e20c1-df07-4e39-a975-6fc09d07755c/result.json),
SHA-256 `c7a65dd53783bca486e977dbe37ad787a2541dd9393392fd480425bf5b3b3ccb`.

Реально запускались два PostgreSQL, два Temporal, два SDK Worker и три синтетических
Workflow; моделей и signals0. После восстановления совпали две закрытые истории/results,
исходный prefix и query pending Workflow; он остался RUNNING без сигнала и активации grants.
В текущем native dump проверены две deletion timer tasks и readback в разрешённом окне.
Все службы, их descendants и listeners остановлены;50 файлов/2126011байт доказательств
сохранены точно, исходные доказательства удержаны. Временные рабочие копии удалены только
после полного PASS и проверки неизменяемого recovery set. Разовый допуск израсходован.

RPO1120мс/RTO3086мс — наблюдения этого локального синтетического среза. Retention старых
архивов, эксплуатационные RPO/RTO, восстановление рабочих writers/grants, зависший SDK
и принудительное прерывание синхронного filesystem I/O остаются неподтверждёнными.
Обычный совместный SDK/PG shutdown в этой пробе прошёл; T6 не активирован.

## Независимые файловые копии

`node dist/client/index.js --backup save INPUT.json` принимает прежний вход версии 1:

```json
{
  "schemaVersion": 1,
  "persistence": "/absolute/quiesced/temporal.pgdump",
  "roots": {
    "artifacts": "/absolute/artifacts",
    "receipts": "/absolute/receipts",
    "workspaces": "/absolute/workspaces",
    "build": "/absolute/build"
  },
  "destination": "/absolute/new-backup"
}
```

Это упаковка настоящего PostgreSQL custom dump и файлов. Проверка сигнатуры PGDMP не
доказывает исправность базы. До снимка оператор отдельно останавливает writers и получает
согласованный dump; три равных чтения файлов не доказывают эту границу.

Вход версии 2 сохраняет выбранные файловые границы без PostgreSQL:

```json
{
  "schemaVersion": 2,
  "roots": {
    "artifacts": "/absolute/artifacts",
    "projections": "/absolute/projections",
    "workspaces": "/absolute/workspaces"
  },
  "destination": "/absolute/new-files-backup"
}
```

Допустимы непустой набор `artifacts`, `receipts`, `workspaces`, `build`, `projections`, `legacy`.
Эта версия подтверждает только копирование файлов, а не восстановление persistence Temporal.
Manifest и каждый blob закреплены SHA-256 и размером. Manifest-ref из результата хранится
отдельно от копии. `.backup-incomplete` означает незавершённую запись даже при наличии manifest.

`inspectFileBackup` проверяет тот же вход версии 2 без публикации и возвращает
`{manifest, inventory}`. Сериализация inventory для hash — UTF-8 `JSON.stringify(inventory)`,
без перевода строки, BOM и отступов; roots и имена файлов упорядочены. При неизменных
источниках `createBackup` возвращает тот же manifest-ref. Это позволяет закрепить конкретный
набор до архивного эффекта и сверить сохранённую копию после потери ответа.

Для отдельного разрешения на конкретный состав вызывается
`createBackup(input, approved.manifest)`. Необязательный второй аргумент сохраняет прежние
вызовы с одним аргументом и байты manifest версии 1. Принятый ref сверяется с предварительным
снимком до создания назначения: несовпадение даёт `backup-approved-manifest-mismatch`.
Во время копирования каждый путь, тип, исполняемый режим и hash/размер сверяются с принятым
составом **до** публикации блоба; dump версии 1 проверяется так же. Итоговый снимок и manifest
проверяются повторно. При гонке возможен incomplete-каталог только с подмножеством разрешённых
блобов, без manifest и без недопущенных байтов. Ошибка фактического изменения —
`backup-source-changed`. Обычный вызов также защищает свой предварительный снимок, но сам
по себе не заменяет отдельное пользовательское разрешение на архивирование.

Для `--backup verify`:

```json
{
  "schemaVersion": 1,
  "backup": "/absolute/new-backup",
  "manifest": { "sha256": "<64 hex>", "bytes": 1234 }
}
```

Проверка читает каждый объявленный blob и не создаёт восстановленный каталог. Для
`--backup restore` добавляется `destination`: новый независимый каталог. Результат всегда
`staged`, `requiresReconciliation=true`. `.restore-incomplete` запрещает использовать
частичную копию. Исходные manifest/blobs не ремонтируются. ENOSPC, недоступные файлы,
неполнота, повреждение, ссылки и неизвестные версии дают отказ.

После staging оператор отдельно восстанавливает persistence, проверяет подходящую сборку
Worker и replay, сверяет owners/unknown с первичными исполнителями и только затем разрешает
продолжение в том же движке. Staging не является разрешением запускать задачу.

## Сроки хранения

`--backup retention INPUT.json` строит только отчёт; удаления в пакете нет. Вход:

```json
{
  "schemaVersion": 1,
  "root": "/absolute/retained-files",
  "now": "2026-10-29T00:00:00.000Z",
  "files": [{
    "path": "original-fail.log",
    "kind": "fail",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "content": { "sha256": "<64 hex>", "bytes": 123 }
  }],
  "protected": [{ "sha256": "<referenced evidence hash>", "bytes": 123 }],
  "backups": []
}
```

`backups` содержит независимо закреплённые входы `verify`, каждый проверяется полностью.
Ссылки из этих копий и `protected` защищают доказательства и после истечения срока. Все
заявленные исходные файлы также сверяются по hash/размеру. Повреждённая или неполная копия
не засчитывается как страховка. Минимум: log 30 дней, fail/manifest 180; evidence, projection
и workcopy требуют отдельного решения всегда. Кандидат в отчёте не разрешает удаление.
Необъявленные файлы отчётом не оцениваются; полнота реестра и внешние ссылки остаются
ответственностью оператора. Периодический запуск и очистка автоматически не включаются.

## Учебное восстановление PostgreSQL

Исполняемый стенд: `tests/temporal/t4-postgres-recovery.mjs`; пример входа:
`tests/temporal/t4-postgres-recovery.config.example.json`. Он не запускается с незаменённой
заглушкой полномочий. `--self-test` проверяет только договор, бюджеты и отказ без допуска,
не запускает службы. `--run CONFIG.json` требует прямого разрешения пользователя на точный
объём; запись в config фиксирует полученное разрешение, но сама его не создаёт.

Перед командами PostgreSQL удаляются все унаследованные переменные PG*; дочерние процессы
получают только собственные PGHOST/PGPORT/PGUSER/PGCONNECT_TIMEOUT. Это касается также
остановки и проверки pg_ctl. Чужие PGSERVICE, PGHOSTADDR, PGOPTIONS и настройки паролей не
могут перенаправить libpq к другому хранилищу. Чистая функция проверяется self-test с
загрязнённым окружением без вывода его значений и без запуска службы.

Стенд создаёт один собственный каталог `/private/tmp/aw-t4-pg-*`, отдельный cluster PostgreSQL,
Unix socket без TCP, socket-port 55437. Никаких установок, Docker, фонового сервиса и моделей.
Создаёт синтетическую БД с FAIL/ID/hash/findings/Result, делает настоящий custom dump, добавляет
одну намеренно не сохранённую строку, удаляет только эту синтетическую исходную БД и
восстанавливает dump в новую. SQL сверка должна полностью совпасть с исходным снимком.
Это проверка PostgreSQL dump/restore; Temporal schema, server, histories и Workers в ней
отсутствуют и не считаются восстановленными.

Пределы примера: 120 секунд основной работы плюс до 20 секунд остановки/проверки;
shared_buffers 32 MiB, max_connections 8, work_mem 1 MiB, maintenance_work_mem 16 MiB,
autovacuum и parallel workers выключены; max_wal_size 64 MiB, temp_file_limit 64 MiB.
Размер собственного каталога проверяется между командами, предел 256 MiB. Это наблюдаемый
предел, а не жёсткая квота или ограничение RSS. `ps` сохраняет наблюдаемые PID/RSS/CPU PostgreSQL
и детей, включая оговорку о повторном учёте общих страниц; пик между наблюдениями неизвестен.

`proof.json` сохраняет версии, команды/время, bytes/hash dump, наблюдаемые ресурсы, источник
допуска, RPO = lossAt − snapshotAt, RTO = restoredAt − lossAt и исход остановки. Цели проекта:
RPO 24 часа и RTO 2 часа; быстрая проба не доказывает ежедневное расписание, нагрузку настоящей
Temporal БД, восстановление хоста или отказ диска. После сбоя копия на основном диске не
защищает от его физической потери.

Все интервалы, RPO/RTO и deadline вычисляются по монотонным `performance.now`; UTC-метки —
только подписи. Изменение системных часов не превращает отрицательный интервал в успешный.

`finally` выполняет `pg_ctl -D <reported-root>/data -m immediate -w stop` и проверяет отсутствие
процесса. При SIGKILL или потере хоста `finally` недоступен: оператор использует эту же команду
для объявленного временного cluster. Dump/config/log/proof и остановленный cluster остаются
для проверки; удалять можно только созданный стендом root после сохранения нужных доказательств.

Для допуска постоянного Temporal остаются обязательными: согласованные настоящие dump и
версии схемы/server/Worker; восстановление в независимое PostgreSQL хранилище; проверка
исходных Workflow IDs, histories и refs; replay совместимой сборкой; сверка внешних эффектов
без повторного старта; измерения ресурсов/RPO/RTO на реальном объёме; проверка stop/reconcile
при полной разрешённой загрузке. Обновление Worker сначала проверяется на закреплённых
историях, а откат использует совместимую сборку и прежнее хранилище, без смены движка задачи.

## Обновление и откат Worker

Это порядок подготовки T4 и последующей отдельно разрешённой квалификации T5, а не включение
T6. Текущие фабрики `src/worker/host.ts`, `readerHost.ts` и `finalizationHost.ts` передают
`workflowsPath` и очереди в SDK; договор развёртывания с Worker Versioning они пока не задают.
Наличие версии пакета или успешного replay не означает, что сервер направляет задачи
совместимой версии. Выбор маршрута обновления остаётся открытым до проверки конкретной поставки.

1. Сохранить прежнюю неизменяемую поставку, lock, конфигурацию, descriptor/регистрации,
   Worker bundle и их SHA-256/размеры. Связать их с namespace, очередями, Workflow/run IDs,
   артефактами и receipts. Один Git commit при незакоммиченных исходниках не закрепляет сборку.
   Не дописывать отсутствующую версию в исторические manifests задним числом.
2. В новой отдельной копии закрепить кандидат и выполнить применимые адресные проверки,
   полный `yarn validate` и replay сохранённых историй через `yarn test:replay`.
   [Replay-стенд](../tests/temporal/replay.mjs) проверяет 265 историй из 15 корпусов,
   включая незавершённые ожидания, и отказ намеренно несовместимой сборке. Он не запускает
   Temporal Server или модель. Это проверка воспроизведения, а не продолжения активных
   Activities, действующих grants или фактической маршрутизации Workers.
3. До живого обновления закрепить конкретную схему совместимости: какие новые задачи получают
   кандидат, какие начатые сохраняют прежний код и как это проверяется по первичной истории.
   Для изменения Workflow отдельно обосновать штатный Worker Versioning либо совместимое
   patching; текущие фабрики не позволяют считать такой выбор уже реализованным.
   Неизвестная исходная сборка, несовместимый replay или неизвестный маршрут блокируют
   обновление зависимых задач. Старый Worker не заменять новым на той же очереди вслепую.
4. В отдельно согласованном сервисном окне проверить назначение новых задач, продолжение
   незавершённого ожидания, команды/бюджет/результат и отсутствие повторного внешнего эффекта.
   Сохранить исходные и новые run IDs, сборки, первичные истории и stop receipts.
   Без этих данных TEMP-11 остаётся открытым; локальный replay не заменяет живую проверку.
5. При дефекте прекратить назначение новых задач дефектной версии и вернуть их на прежнюю
   проверенную поставку по согласованному маршруту. Начатые задачи продолжать только совместимым
   кодом в их прежнем backend. Откат пакета не откатывает историю, Git или эффекты Codex.
   При UNKNOWN приостановить зависимое продолжение и сверить первичные данные.
6. Удалять старый исполняющий Worker только после подтверждения отсутствия зависимых
   незавершённых запусков. Его сборку и конфигурацию сохранять также для историй и копий,
   которым они нужны по срокам хранения. Ошибка кандидата не разрешает удаление прежней версии.

### Проверка закреплённой версии на стенде T4

19 ноября 2026 года архивная сборка `70fa9c7b…` воспроизвела три истории из
`tmp/t4-pg-temporal-k8TCPg/`. Восстановленные истории совпали с архивом, включая префикс
ожидающего Workflow. Кандидат `21bb1fea…` добавляет поле в ответ Query стендового
`t4StorageCase` и также воспроизводит все три истории.

В отдельном локальном Temporal Server два SDK Worker опрашивали одну очередь
`t4-routing-test` с политикой `PINNED`. Текущая версия последовательно переключалась
с архивной на кандидата и обратно. Workflow, ожидавший сигнала во время переключения,
завершился на исходной сборке. Workflow кандидата так же пережил откат. Новый запуск
после отката получил архивную сборку. Для каждого из трёх запусков сверены run ID,
один сигнал и обе записи завершения Workflow Task с версией Worker и именем deployment.
Оба Worker и временный сервер остановлены. Модели и внешние Activities в сценарии отсутствуют.

Исходный отказ команды чтения конфигурации сохранён в
`tmp/t4-archived-replay-20261119/route-1.log`. Сверка историй и трёх переключений —
`tmp/t4-archived-replay-20261119/route-nRZPeA/verified.json`. Для рабочей поставки ещё
требуется проверить её фабрики Worker, версии Activities и права внешнего Writer.

### Остановка процесса между внешней записью и квитанцией

На изолированном стенде 19 ноября 2026 года дочерний процесс использовал штатный
`effectJournal` и записывал результат в отдельный каталог. После подтверждения точки
остановки родитель посылал процессу `SIGKILL` и дожидался его завершения. Только затем
он создавал файловую резервную копию и восстанавливал её в отдельный каталог.
Повторное открытие исходного журнала проверял новый процесс.

| Точка остановки | Состояние в восстановленной копии | Результат повторного открытия исходного журнала |
| --- | --- | --- |
| Намерение сохранено, внешний результат ещё отсутствует | `pending`, файла нет | `effect-outcome-unknown`; операция остаётся ожидающей |
| Внешний файл сохранён, квитанция ещё отсутствует | `pending`, байты файла совпадают с исходными | После сверки всех байтов, включая идентификатор операции и владельца, опубликована квитанция |
| Штатное завершение после сохранения квитанции | `completed`, артефакт читается по исходной ссылке | Возвращена прежняя квитанция |

Во всех трёх случаях обработчик внешней записи вызывался ровно один раз, а чтение
с другим поколением завершалось отказом. Восстановленная копия сохраняла исходное
состояние и требование сверки. Первичные результаты — `tmp/t4-external-write-20261119/proof-AEkmp1/proof.json`.
Проверены файловый результат и журнал, которым пользуется адаптер Writer. Проверка
полного сеанса Codex, действующего права продолжения и его взаимодействия с Temporal
остаётся в H06.

### Восстановление результата подготовки задачи

Штатный Worker подготовки завершил одну Activity на локальном стенде Temporal с SQLite.
После остановки Worker и службы отдельно сохранили базу, рабочие файлы и хранилище
артефактов. На копии базы запустили вторую службу. По исходным Workflow ID и Run ID
она вернула тот же результат и все 11 событий истории без повторного запуска Worker.
По ссылке из результата прочитали манифест из восстановленного хранилища и побайтно
сверили его с оригиналом. Три восстановленных входных файла также совпали.
При изменении одного бита резервной копии восстановление завершилось ошибкой
`artifact-corrupted` до создания каталога назначения. Исправная копия осталась
в состоянии `staged` и требует сверки. Квитанция стенда —
`tmp/t4-preparation-restore-20261119/run-ToIESk/proof.json`.

## Остановка после таймаута записи

Для `LocalTaskWorkflow` со входом версии 1 после таймаута сердцебиения
`writeLocalTask` проверьте историю и ответ `localTaskStatus` для одного Run ID.
В истории свяжите таймаут с назначением записи по `scheduledEventId`. Затем найдите
назначение `stopLocalTask` в очереди управления (имя очереди задачи с суффиксом
`.control`). Сопоставьте его `activityId` со списком ожидающих Activities в Describe.

| Наблюдение | Что проверить |
| --- | --- |
| Фаза `stopping`, команда остановки ожидает в очереди | Сохраните идентификатор команды. Перезапуск обработчика Workflow и запрос отмены могут оставить ту же остановку в ожидании. |
| Фаза `stop-unknown`, попытка остановки завершилась ошибкой | Прочитайте причину из события ошибки Activity. Проверьте, зарегистрирована ли `stopLocalTask` у Worker очереди управления. |
| После `localTaskReconcile` фаза всё ещё `stop-unknown` | По истории и Describe установите, назначена ли новая попытка остановки. Ответ Query может сохранять ошибку предыдущей попытки, пока следующая ожидает обработки. |

До первичной квитанции остановки сохраняйте запись владельца, право Writer и
резервирование источника. Статус RUNNING и запрос отмены сами по себе не устанавливают
исход внешней записи. На стенде отдельный процесс записал файл, а транспорт Codex
имитировался. История после обработки отмены сохранена в
`tmp/t4-stop-dispatch-20261119/run-ATGd5C/cancel-confirmed.json`, ошибка Worker
и новая попытка остановки — в `tmp/t4-stop-dispatch-20261119/run-fpQQJ7/reconcile.json`.

## Сверка перед административным Reset

Reset не реализован как команда этого пакета и не выполняется автоматически. Для отдельного
административного действия нужны точные Workflow/run и точка истории, собственный допуск
и порядок остановки. До него сохранить исходную историю, артефакты и квитанции; сверить
фактические session/turn IDs, живые процессы, grants, scope/generation, текущие байты Git
и журналы эффектов. Отсутствие PID само по себе не доказывает исход внешнего действия.

Task identity и логические operation IDs сохраняются; защита от повторов находится вне
откатываемой истории. Новый runId не разрешает ещё один model start, запись или интеграцию.
Потерянная квитанция, неизвестный writer или неустановленный исход сохраняют UNKNOWN
и запрещают зависимое продолжение. После отдельно разрешённого Reset до нового эффекта
повторить сверку с первичными источниками и проверить совместимую сборку. Reset не возвращает
старые grants, не снимает frozen/released и не подтверждает остановку исполнителей.

## Диагностика без модельного опроса

Для уже доступного разрешённого сервиса читающий клиент однократно выполняет
`yarn reader-status WORKFLOW_ID ADDRESS` после сборки. Он использует Describe, Query
`readerStatus` и хвост истории; собственного lifecycle-хранилища или модели нет.
Команда не запускает Server/Worker и не разрешает их запуск. Её договор и ограничения описаны
в [SDK](temporal-sdk.md#конфигурация-диагностика-и-восстановление-читающего-хоста).

| Наблюдение | Проверка и следующий шаг |
| --- | --- |
| Ожидание человека | Сверить `reader.diagnostic`, редакцию и требуемое решение; не посылать RESUME без первичного источника |
| `waiting-worker` | Проверить `taskQueue`, хост и свободные места; очередь сама по себе не устанавливает точную причину |
| `technical-error` | Сверить `pending` с operation ID: попытку, `maximumAttempts`, время ожидания и `lastFailure`; не начинать новую логическую операцию |
| `workflow-error` | Сохранить ошибку Workflow Task и `workerVersion`; проверить историю и совместимую сборку до продолжения |
| Неизвестный эффект | Сверить operation ID, session/turn IDs и первичную историю; новый ход до выяснения запрещён |
| `unavailable`, `queryError`, `historyError` или версия `null` | Причина или версия остаётся неизвестной; не делать вывод о завершении, остановке или совместимости |
| Terminal execution | Читать сохранённый предметный результат; завершение Temporal само по себе не доказывает PASS роли или DONE |

В пакет диагностики включить project/task, Workflow/run, очередь, известную версию Worker,
operation ID, первичную ошибку и ссылки на receipts. Источником остаются журналы и данные SDK;
неизменное ожидание не требует нового модельного хода.

## Восстановление закрытого SQLite-снимка Temporal CLI

Отдельный test-only стенд `tests/temporal/t4-temporal-restore.mjs` не меняет схему production
backup. `--self-test` проверяет договоры, закрытость Workflow и смысловое сравнение protobuf
историй без сервера. `--inspect /absolute/closed-case` только читает известный native PASS
case: проверяет целостность закрытой SQLite, hashes всех файлов и артефактов, восемь закрытых
предметных исполнений и первичные history/run IDs. Неизвестный prefix Workflow или открытый
предметный Workflow дают отказ. Два точно названных `temporal-sys-*` scanner учитываются как
внутренние системные исполнения; их состояние не объявляется закрытой предметной задачей.

`--run CONFIG.json` требует отдельной команды в согласованном SDK-окне; пример входа —
`tests/temporal/t4-temporal-restore.config.example.json`. Нужен уже установленный cached CLI
1.9.1: установки и загрузки отсутствуют. Само наличие конфигурации не разрешает сервер.
До запуска требуется окончательная сборка T4 backup-зависимостей; Workflow bundle и Workers
стенд не загружает. Модельных стартов нет.

Стенд копирует исходный case в собственный временный каталог, сохраняет точные байты SQLite
как content-addressed artifact, manifest `temporal-cli-sqlite` версии 1 с версией CLI, IDs/run IDs,
history refs и исходным file inventory. Все исходные artifacts и остальные доступные receipts/
материалы case плюс result projection упаковываются существующим files-only backup версии 2
с заранее закреплённым manifest. Удаляется только временный source; затем выполняется staging
в новый каталог и повторная проверка hashes.

Content-addressed SQLite snapshot остаётся неизменяемым: cached Temporal CLI запускается
на отдельной mutable копии в новом `runtime-data/`, с адресом 127.0.0.1 и выключенным UI.
Client только читает восемь закрытых histories, IDs/run IDs/status/results. Истории сравниваются
через имеющееся protobuf-преобразование `historyToJSON`; исходные JSON не переписываются.
Проверяются все hashes артефактов, ссылки результата, исходные FAIL/findings/Result и projection.
Исторические grants/receipts сохраняются как данные; прежние workspace и действующие права
не реконструируются и остаются unknown. In-flight business execution не переносится.

RTO измеряется монотонно от удаления временного source до полной читающей сверки. RPC и
основной wall ограничены; `finally` закрывает Client и останавливает только собственный CLI
(SIGTERM, при необходимости SIGKILL), сверяет исходный case и snapshot artifact после остановки,
экспортирует raw histories/logs/proof/backup, затем удаляет собственные временные копии.
Доказательства остаются в `tmp/t4-temporal-restore-*`. Такой PASS докажет восстановление
конкретного закрытого SQLite-снимка используемого dev backend, а не PostgreSQL persistence,
in-flight execution, прежних внешних writers или эксплуатационное восстановление всего хоста.

Квалификация 2026-10-29: один отдельно направленный прогон на закрытом native case 0Tux4E
прошёл с CLI 1.9.1 / Server 1.32.0: восемь закрытых histories/run IDs/status/results совпали,
163 artifacts и 279 исходных файлов сохранены по hash/bytes, source SQLite и immutable blob
не изменились. Монотонный RTO 3390 ms, общий wall 6574 ms; сервер остановлен и временные
копии удалены. Первичные материалы: `tmp/t4-temporal-restore-aGZqH5/`, независимая сверка —
`tmp/t4-temporal-admission-9CUdWd/verified.json`. Прежние workspace/grants остаются unknown;
эта квалификация не подтверждает PostgreSQL или перенос незавершённого исполнения.

## Дополнительные данные input12

Подключаемая human-приёмка input12 добавляет обязательные локальные связи, которых нет
в одном дампе Temporal. Помимо content-addressed artifacts сохраняются metadata фактического
Git common directory: assignment2 и origin, `human-checkpoints/<hash>.json`,
`human-completion/<snapshot-hash>.json`, execution-command intents/receipts и первичные
`grant/permission/revoked/stopped/snapshot/acceptance/completion-intent/done` текущей попытки.
Рабочее дерево с `.git`-указателем не означает, что внешний common directory попал в backup.

Перед восстановлением нужен явный inventory этих путей и их владельцев с исходными hash/bytes
и private modes; сохранённые разрешения остаются данными. Нельзя создавать отсутствующий seal,
считать serialized checkpoint доказательством серверного predecessor run или возвращать Writer
grant ради human completion. Остаточная completion-only reservation не присваивается и остаётся
UNKNOWN; ограничение ведётся как [TD-056](exec-plans/tech-debt-tracker.md).

Текущие исторические installed/T4 PASS не доказывают восстановление этого нового набора.
Его включение в физический recovery set и адресная сверка после восстановления должны быть
подтверждены отдельно до рабочего T6. При отсутствии metadata результат остаётся UNKNOWN;
новый первичный допуск не восстанавливает потерянную историю.

## Связанный recovery set PostgreSQL Temporal

`parseTemporalRecoverySnapshot`, `verifyTemporalRecoverySet` и `stageTemporalRecoverySet`
из backup adapter добавляют отдельный descriptor поверх прежних backup 1/2, не меняя их байты
или существующие вызовы. Descriptor версии 1 хранится как `build/storage-snapshot.json` и
закрепляется самостоятельным ref. Вход проверки: `{schemaVersion:1, backup, manifest, snapshot}`.
Вход staging дополнительно содержит новый `destination`.

Обязательные физические границы — artifacts, receipts, projections, workspaces и build.
Descriptor связывает версии PostgreSQL/Temporal, исходную конфигурацию, Worker bundle, ID/UTC
среза и его первичную квитанцию, логические default/visibility stores, workflow namespace/ID/
run ID/history/result refs, evidence ID/content refs и реестр workcopy roots. Физический
источник задаётся явными `source` и `database`, схема — наблюдаемой `schemaVersion`; количество
физических БД не угадывается. Две роли могут ссылаться на один dump одного источника; разные
dump для того же source/database отклоняются. Неизвестный datastore role требует отдельного
решения, а не молчаливого пропуска secondary/другого backend.

Проверка требует принадлежности каждого ref своему физическому manifest: dump/history/result/
evidence находятся под исходными hash-именами в artifacts, configuration/bundle — в build,
cut receipt — в receipts. Каждый workcopy — объявленный прямой подкаталог workspaces; лишний
или отсутствующий root и файл вне реестра дают отказ. Проверяются все объявленные blobs,
hash/bytes, версии descriptor, уникальные IDs, даты и границы путей до создания назначения.

Итог проверки — `files-verified`, staging — `staged`, `requiresReconciliation=true`,
`activationAllowed=false`. PGDMP здесь подтверждает только сигнатуру формата. Квитанция cut
не проверяется как полномочие или доказательство остановки живого writer; unknown не становится
grant. Staging не запускает БД/Workers и не восстанавливает владельца. `RECOVERY.json` завершает
только файловую операцию; при отказе его нет, а частичный файловый restore остаётся incomplete.

### Реальное доказательство 2026-10-29 и его пределы

После двух сохранённых первичных ошибок отдельно разрешённая проба завершилась PASS:
настоящие dumps новых default/visibility БД и все файловые границы восстановлены в другом
новом PG cluster того же backend. Это ограниченное доказательство одного тестового комплекта,
а не квалификация всего хранилища, промышленного контура, внешнего диска или SLA.

Первичные материалы в квалификационной копии пакета:

- [proof.json](evidence/README.md), SHA-256
  `e750e37a82830ea55eafc45e64ad0f885984b4d366c410fa843a1b99741a777b`;
- [сводка](evidence/README.md) и
  [независимая проверка остановки](evidence/README.md);
- [recovery-set.json](evidence/README.md),
  [snapshot.json](evidence/README.md),
  [manifest и blobs](evidence/README.md),
  [реестр экспорта](evidence/README.md).

`tmp` — локальные материалы этой копии, не поставка из Git/npm. При переносе нужно сохранить
их байты и независимо закреплённые refs; недоступная ссылка не подтверждает готовность копии.

Проверены 22 manifest entries, 16 blobs, в том числе два native PGDMP dump: default 61 358 bytes
со схемой `1.19|1.0`, visibility 45 051 bytes со схемой `1.14|0.1`. Выполнены native dump,
`pg_restore --list`, восстановление обоих dumps и сравнение схем. Экспортированы исходные и
целевые histories, result/evidence refs, receipts, projection, workcopy, config и Worker bundle.
Два Workflow остались `COMPLETED` с прежними ID/run ID и равными histories/results; `FAIL` —
доменный payload внутри одного из них, с исходными findings `F-1` и `Result`, а не отдельная
квалификация Temporal `WorkflowExecutionFailed`.

Третий тестовый Workflow остался `RUNNING`: исходный prefix и query состояния совпали,
Signal/RESUME не отправлялись. Его незавершённое исполнение не переносилось между движками;
реальные Activities/writers не восстанавливались. Grants остались `unknown`,
`activationAllowed=false`; staging и этот PASS не выдают права продолжения рабочей задачи.
Raw SQL schema/list stdout и query response отдельно не экспортированы: их сравнения отражены
в assert/proof; dumps и обе стороны histories сохранены как первичные файлы.

| Измерение | Наблюдение | Точная граница |
| --- | --- | --- |
| RPO metric | 957 ms | Возраст quiesced cut: от начала двух dumps до проверенной копии и имитации потери source |
| RTO metric | 3188 ms | От начала удаления временного source до stage, нового PG/restore, Server/Worker и сверки histories/results/query |
| Server RSS | max 144 352 KiB, около 140.97 MiB | 5 выборок Server в 30 общих samples |
| PG group RSS | max 106 768 KiB, около 104.27 MiB | Сумма PG/owned descendants за вычетом известных Temporal PID; shared pages считаются повторно |
| Node maxRSS | 655 792 KiB, около 640.42 MiB | Отдельный процесс SDK/bundler; не одновременный общий peak с PG/Server |
| Disk observed | max 65 744 887 bytes, около 62.70 MiB | Свой run root + evidence, без прежнего FAIL-root и cache |

Интервалы монотонные. RPO957 не измеряет потерю транзакций при продолжающихся writers:
SDK/Temporal были остановлены перед dump, новых прикладных записей не было. RTO3188 измерен
на том же тёплом Node/SDK host с уже доступными binaries; он исключает acquisition/build,
подготовку source, окончательные stop и export/hash-проверку evidence. Proof elapsed —
10 866 ms. Наблюдаемые RSS/disk — выборки, не hard cap и не измерение общего физического пика.
Нагрузка, WAL/replication, роли/ACL/секреты, ежедневное расписание и потеря диска не проверены.

Оба PG cluster и оба Server остановлены, SDK handles закрыты, девять портов PG55438 и
Temporal17239–17246 закрыты, owned processes не найдены. Временный PASS-root удалён только
после verified recovery set/evidence и подтверждённых stops; immutable backup остался.

Первичные ошибки сохраняются рядом с PASS и не переименованы в успех:

1. [Первый extract FAIL](evidence/README.md) до публикации binaries: upstream
   symlink `config/development.yaml` → `development-sqlite.yaml`, type2/size0. Parser затем
   получил узкое исключение только для этой ignored metadata tuple, без создания ссылки.
2. [Первый PG run FAIL](evidence/README.md) и
   [исходный proof](evidence/README.md): membership57243–57246 не
   помещались в PostgreSQL signed smallint, Server завершился с FATAL heartbeat, connection
   остался late-rejected/unknown. Business histories/dump/restore и RPO/RTO не получены;
   root и unknown сохранены. После cap `grpcPort + 7 <= 32767` следующий PASS использовал
   low range17239–17246 по отдельному допуску; старый operator-config не переписывался.

### Из проверенного recovery set в staging без продолжения задачи

В ветке `--backup` публичный [client/index.ts](../src/client/index.ts) поддерживает
`save|verify|restore|retention`. Команды `--stage` для coherent wrapper у него нет.
[backupCommand](../src/client/backup.ts) передаёт `verify` внутренний file-backup input
`{schemaVersion, backup, manifest}`, а `restore` — тот же input плюс `destination`.
Полный `{schemaVersion, backup, manifest, snapshot}` принимают только API
`verifyTemporalRecoverySet`/`stageTemporalRecoverySet` из
[backup adapter](../src/adapters/artifacts/backup.ts) и отдельный test-only
[PG harness](../tests/temporal/t4-pg-temporal-recovery.mjs). Это не новая публичная CLI-команда.

Минимальный порядок; команды ниже выполняются из `tools/agent-workflow` с уже собранным dist:

1. Сохранить внешний recovery-set record и его принятые manifest/snapshot refs отдельно от
   копии. Для этого PASS manifest — `b2409ca8de338c0cbd1c6b55fffd278e63f8f4c170fd7177b425ee7c5210620f`/
   3342 bytes, snapshot — `8237a1c66d0905d57e45b3b191735dc35048a8437c5593886a90478f003aed1b`/
   2211 bytes. При переносе меняется locator `backup`, а не байты/ref содержимого.
2. Проверить внутренний file manifest по внешнему ref. `VERIFY.json` содержит только три поля
   входа: `schemaVersion:1`, абсолютный `backup` и `manifest:{sha256,bytes}`; не передавать
   ему весь wrapper или добавочное поле `snapshot`:

   ```sh
   node dist/client/index.js --backup verify VERIFY.json
   ```

   Результат `status=verified`, `scope=files-only` проверяет manifest/blobs, но не связь snapshot с БД,
   histories и workcopies. Сам по себе он не подтверждает восстановление Temporal.
3. Связанную проверку и staging выполнить одним из существующих путей. В установленном
   пакете это API `@krivega/agent-workflow/backup`; отдельной публичной CLI для wrapper нет:

   ```js
   import { readFileSync } from 'node:fs';
   import {
     verifyTemporalRecoverySet,
     stageTemporalRecoverySet,
   } from '@krivega/agent-workflow/backup';

   const recoverySet = JSON.parse(readFileSync('RECOVERY_SET.json', 'utf8'));
   verifyTemporalRecoverySet(recoverySet);
   stageTemporalRecoverySet({ ...recoverySet, destination: '/absolute/new-stage' });
   ```

   API сначала проверит закреплённый file manifest, затем совпадение ref
   `build/storage-snapshot.json`, descriptor и всех его границ; лишь после этого создаст stage.
   В копии репозитория ту же связку предоставляет test-only harness: взять отдельную копию
   [полного test config](../tests/temporal/t4-pg-temporal-recovery.config.example.json), оставить
   `authorization.evidence=null` и установить `recoverySet` ровно в сохранённый wrapper с
   актуальным backup locator:

   ```sh
   node tests/temporal/t4-pg-temporal-recovery.mjs --stage STAGE_CONFIG.json /absolute/new-stage
   ```

   Это **test-only harness**, не `dist/client/index.js --stage`. Для читающей проверки wrapper
   без staging есть его `--preflight STAGE_CONFIG.json`; общий статус может остаться `blocked`
   из-за отсутствия runtime/authority observations даже при `checks` с `files-verified`.
   `staged` и `RECOVERY.json` означают только файлы; `requiresReconciliation=true`,
   `activationAllowed=false`. `.restore-incomplete`/отсутствующий завершающий record — отказ.
   Публичный `--backup restore` тоже делает только file staging и не заменяет эту проверку
   snapshot wrapper. Нельзя добавлять snapshot в его input и ожидать coherent restore.
4. Остановиться на staging до отдельного допуска на БД/сервисы и сверки owners/unknown.
   Перед запуском Temporal проверить, что закрытые истории доступны в течение всего
   `budget.outerMs`, включая остановку. Для этого закрепить локальное наблюдение в
   `target.archivedReadback` как `{path, content: {sha256, bytes}}` и повторить
   `--preflight` непосредственно перед запуском сервера.

   JSON наблюдения имеет `kind: "t4-archived-readback/1"`, ссылки `snapshot` и
   `defaultDump` в форме `{sha256, bytes}` и список `workflows`. Для каждого Workflow
   в снимке указать ровно одну запись с `namespace`, `workflowId`, `runId`, ссылкой
   `history`, `state` и `deleteAtMs`. Состояние `open` и `deleteAtMs: null` требуют
   подтверждения незавершённости по архивному источнику. Для `closed` указать точное
   время удаления в миллисекундах Unix, наблюдённое по заданию удаления этого Run
   в закреплённом источнике. Срок хранения namespace и возраст среза по отдельности
   такой срок не подтверждают.

   Проверка сверяет хеш и размер наблюдения, ссылки на снимок и дамп и точный набор
   историй. Неизвестный срок, отсутствующая привязка и срок удаления до конца окна
   или ровно на его границе блокируют серверное чтение. Файловая проверка и staging
   доступны и для архивов без этого наблюдения. Положительный результат проверки
   окна не выдаёт допуск и не подтверждает происхождение наблюдения за оператора.

   В разрешённом плане БД восстанавливаются только в новый собственный cluster того же backend
   по `snapshot.datastores`: оригинальные имена БД, native custom dumps, закреплённые версии
   и проверенные configuration/Worker refs. Применявшееся действие — `pg_restore --exit-on-error
   --no-owner --no-privileges --single-transaction -d <database> <stage/artifacts/dump-sha>`;
   оно не восстанавливает SQL ACL/секреты и не запускает Workflow. IDs/history/results сверяются
   читающим Client; никаких `Workflow.start`, reset, Signal/RESUME или автоматического старта
   Workers для реальной pending задачи. Сборка/replay и право продолжения требуют первичной
   сверки владельца в прежнем backend. Неизвестное остаётся unknown.

Учебный `--run` создаёт **новый source** и проверяет новый source→target; он отказывается от
существующего `recoverySet` и не является командой восстановления сохранённого комплекта.
Его запуск ради чтения старой истории или продолжения задачи повторил бы эксперимент, а не
восстановил прежний task. Файловая операция не управляет T3 lifecycle и не выдаёт RESULT/DONE.

### Проверяемый сервисный план сохранённого комплекта

Для подготовки точного PostgreSQL/Temporal restore используй существующий test-only вход:

```sh
node tests/temporal/t4-pg-temporal-recovery.mjs --show-restore-plan RESTORE_CONFIG.json /private/tmp/aw-t4-approved-restore
```

Команда только читает файлы и печатает JSON `t4-saved-recovery-service-plan/1`: не создаёт
назначение, не выполняет даже `--version`, не запускает БД, SDK или Worker. Взять полный
пример config выше, заменить `recoverySet` сохранённым coherent wrapper и выбрать существующие
пути инструментов и pins. `authorization.evidence=null` остаётся допустимым для подготовки.
Корень должен отсутствовать и быть прямым потомком канонического `target.parent`; внутри
backup он запрещён. План не содержит скачивания или установки.

Сначала проверяются весь manifest/blobs, snapshot и связанные границы. Затем конфигурация
читается из закреплённого blob и повторно сверяется по SHA/размеру. Поддержан узкий JSON-профиль
конфигурации существующего T4-стенда: PostgreSQL `postgres12`, два логических store и один
локальный cluster без global namespaces. Сохраняются исходные имена БД, число history shards,
cluster identity и failover metadata; адреса заменяются на отдельные loopback-порты, учётная
запись — на тестовую `aw_t4`. Дополнительные datastore, параметры SQL/TLS, неизвестные поля
конфигурации, другой формат schema readback и совпадающие имена БД разных источников дают
отказ. Такой отказ требует отдельного точного плана конфигурации; нельзя удалять неизвестные
поля из исходной копии ради принятия. YAML автоматически не преобразуется.

Результат содержит:

- исходные manifest/snapshot/cut refs, версии и pins инструментов;
- JSON целевой конфигурации с ref её точных UTF-8 байтов `JSON.stringify(json)` без перевода
  строки, PostgreSQL settings, argv инициализации/запуска/остановки;
- по одной группе `pg_restore --list`, `createdb`, `pg_restore` на физическую БД, с исходным
  dump ref; общая БД двух ролей не восстанавливается повторно;
- argv SQL-проверки и ожидаемый точный `curr_version|min_compatible_version`;
- исходные namespace/workflow/run/history/result refs, evidence, workcopies и Worker build;
- `serverStarts=0`, `workerStarts=0`, `activationAllowed=false`, `requiresReconciliation=true`,
  `operationalRpo=UNKNOWN`, `operationalRto=UNKNOWN` и оставшиеся gates.

Это reviewable план команд, не автоматический исполнитель сохранённого recovery set. Нельзя
передавать его в `--run`: этот режим сохраняет прежний синтетический договор. После отдельного
допуска оператор выполняет следующие шаги в одном ограниченном сервисном окне:

1. Закрепить config и весь JSON плана по hash/размеру. Допуск должен назвать именно этот
   комплект, новые root/ports, существующие binaries, бюджет основной работы и остановки,
   наблюдаемые пределы disk/RSS и место экспорта. Для изолированного readback требуется
   первичный retention/readback на всё окно; эксплуатационные цели RPO/RTO не присваиваются
   догадкой и определяются перед эксплуатационной приёмкой. Длительность учебного прогона
   их не задаёт. Первичная сверка T3 сохраняет owner/generation, terminal boundaries и unknown effects.
2. Сверить все pins через `assertAllExecutablePins` из `t4-pg-temporal-binaries.mjs` до любого
   исполнения. С очищенным `childEnvironment` и `boundedExecutor` из runner выполнить
   `versionChecks`, сравнить их полный stdout с `expected`; несовпадение запрещает restore.
   Доступные порты не доказывают владение будущим endpoint. Проверить свободные порты,
   запас диска под stage, распакованные БД и экспорт; размер custom dump не равен размеру БД.
3. Создать только согласованные root и `socket` с 0700. Через `--stage RESTORE_CONFIG.json
   <plan.stage>` восстановить файлы в новый stage и проверить завершающий `RECOVERY.json`.
   Не открывать immutable backup как mutable persistence. Не запускать восстановленные
   workcopies или Worker build. Сохранить исходные hash refs вне mutable cluster.
4. Выполнить первый argv `initialize` (`initdb` нового `postgres-target`). Перед вторым
   (`pg_ctl start`) записать `postgresConfiguration` в его `postgresql.conf`, а точные байты
   `serverConfiguration.json` — по `serverConfiguration.path`, сверив указанный ref. Настройки
   PG ограничивают TCP loopback и приватный socket. Применять очищенное окружение с этим
   socket/port; timeout каждой команды ограничивать остатком бюджета. Сохранить stdout/stderr.
5. Проверить `assertOwnedPostgres` из `t4-pg-temporal-ownership.mjs` перед каждой SQL-операцией
   и запуском Temporal: PID, data directory, socket, executable и listeners должны относиться
   к новому cluster. Для каждой записи `databases` выполнить `commands` по порядку ровно один
   раз, затем `schemaReadback.command`; код выхода должен быть нулевым, stdout после удаления
   краевых переводов строк — равным `expected`. Не выполнять create/update-schema и не менять
   версии ради успешной сверки. `--no-owner --no-privileges` не восстанавливают production ACL.
6. Непосредственно перед `serverStart` снова проверить закреплённый `archivedReadback` через
   `--preflight`: требуется `checks[name=archived-readback-window].result.status=within-window`
   для всего окна. Общий preflight остаётся prepare-only и не заменяет проверки runtime,
   версии, конфигурации и полномочий. Unknown/истёкший срок запрещают запуск Server. Затем
   запускать ровно argv `serverStart` с учётом PID и ограниченного времени остановки.
7. Читающим SDK Client сверить каждую запись `readback` в её namespace и прежнем run:
   `describe`/`fetchHistory`, а для сохранённого завершённого result — `result`. Сравнить
   каноническую protobuf JSON-историю (`historyToJSON`) и декодированный result с исходными
   artifacts. При `result=null` не ждать `result`, не вызывать query без Worker. Workers,
   Activities, Signal/RESUME, reset и новые Workflow этим окном не разрешаются.
8. Экспортировать первичные логи, IDs/refs, результаты всех сравнений, монотонные интервалы
   и наблюдаемые ресурсы, включая FAIL/unknown. Закрыть SDK connections, остановить только
   собственные Server/PG через существующие ownership/stop guards и `stop`, проверить отсутствие
   descendants/listeners. Любой FAIL/unknown сохраняет root. Удаление возможно лишь после
   отдельной проверки полноты immutable recovery set/evidence и всех остановок.

`--self-test` включает положительную проверку полного файлового комплекта и отрицательные
проверки подмены, неизвестной конфигурации, конфликта БД и unsafe destination; native команды
не выполняются. Это доказывает подготовку и границы отказа. Живое восстановление backend,
совместимость Worker/replay, продолжение pending writer, production ACL и эксплуатационные
RPO/RTO остаются отдельными непроверенными границами.

На 2026-11-07 после файлового fixture адресно найдены и проверены два настоящих coherent PG
комплекта прежних тестовых сервисных прогонов: relocation20261029 и PG-resume20261101.
Оба получили `files-verified` и конкретный план без запуска служб. Выбран relocation wrapper
[первичный locator](evidence/README.md);
manifest `b2409ca8…`, snapshot `8237a1c6…`, два native dump, три Workflow и одна workcopy.
Исходный `kc4W5U` найден также в копии `temporal-team-integration`; отсутствие старого locator
не означает потери архива. Это тестовые SDK-данные, не эксплуатационная база рабочих задач.

Проверяемый пакет сохранён в
`/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-20261107-9d961e8c-e2a6-4b44-8b4f-de29ff23a50f/t4`:
`selected-config.json`, исходный план, canonical `cli-plan.json`, текущие executable pins/inventory,
наблюдение версий и отчёт поиска retention/readback. Canonical CLI совпал с сохранённым планом,
SHA-256 вывода `2f0956606b0c06f80c7b5cb5e96697f0db8374d1970fa810d04b6b70714b4429`.
Уже установленные PG12.22/Temporal1.32 совпали с версиями снимка через bounded `--version`;
хеши до/после сохранились. Target не создан, PG/Server/Workers и модели не запускались.

В каждом комплекте проверены 11 объявленных небольших файлов, включая первичные proof,
конфигурацию, истории и журналы. Первичного retention response/deleteAtMs или готового
`archivedReadback` не найдено: `UNKNOWN_BLOCKS_SERVER_READBACK`. Срок не выводился из возраста
снимка или предполагаемого TTL. До старта нужны допустимый первичный readback на всё окно,
актуальная сверка T3 и отдельный сервисный допуск на закреплённые config/root/ports/budget/export.
Закрытый H06 files-only архив этих границ не заменяет; эксплуатационные RPO/RTO остаются UNKNOWN.

### Подготовка нового ограниченного окна с первичным retention

Свежий синтетический source→target использует прежний защищённый `--run`; нового исполнителя
нет. Для подготовки без служб и даже без `--version` предусмотрен отдельный вывод:

```sh
node tests/temporal/t4-pg-temporal-recovery.mjs --show-fresh-plan FRESH_CONFIG.json /private/tmp/aw-t4-proposed-window
```

Взять полный config с уже установленными закреплёнными PG/Server/SQL-tool, установить
`recoverySet=null`, `authorization.evidence=null`, не включать `resumePending`. Команда проверяет
все binary pins/inventory чтением файлов и печатает `t4-fresh-service-preparation/1`. Она
отклоняет старый recovery set, записанное разрешение, Signal и существующее/постороннее
назначение. В плане нет скачивания или установки; `serverStarts=0`, `modelStarts=0`,
`activationAllowed=false`. Подготовка не разрешает последующий `--run`.

План фиксирует parent/prefix новых private root и места экспорта, loopback-порты, точные argv
и конфигурацию, основной/внешний/остановочный бюджеты и наблюдаемые пределы disk/RSS. Пример
root нужен для просмотра argv: действующий runner выбирает новый прямой дочерний каталог
через `mkdtemp`, не занимает заранее пример и не переиспользует старые файлы. Перед отдельным
допуском закрепить SHA/размер config, полного плана и текущих helper-файлов; разрешение должно
назвать эти байты, parent/prefix, порты, budgets, export и существующие binaries. Доступный
диск проверить заново перед стартом; наблюдаемый предел не резервирует место и не является
жёсткой квотой. Пределы времени учебного стенда не являются эксплуатационными целями RPO/RTO.

Общие монотонные часы открываются при входе runner, до проверки binary pins и импорта SDK.
Команды, RPC, получение SDK-ресурсов и PS/lsof используют остаток основного срока; очистка
использует тот же исходный внешний deadline без выдачи нового окна. Последовательность
Worker→Native→Client и первая Temporal stop-попытка с её наблюдениями делят одну стадию
`cleanupMs`, ограниченную внешним остатком. Конфигурация требует минимум две такие стадии
после основного срока; вторая сохраняет время для PG stop и его наблюдений.
Первая остановка принадлежащего Temporal начинается параллельно этой последовательности;
PostgreSQL получает попытку остановки перед дополнительным Temporal fallback. Ошибки SDK
сохраняются даже при подтверждённой остановке сервера. Поздний SDK handle после исчерпания
внешнего срока не получает нового окна закрытия. При нехватке времени новые native-команды,
RPC и наблюдения не начинаются: ошибки/UNKNOWN и рабочие данные сохраняются, STOP не выдумывается.
Получение SDK handle повторно проверяет монотонный срок при arrival, перед передачей владельцу
и после записи квитанции: fulfilled Promise не обходит deadline, даже если timer ещё не исполнился.
Поздний handle сохраняется в acquisition-записи с прежней late/unknown очисткой; INITIALIZED
Worker не запускается ради освобождения. Непосредственно перед `worker.run()` срок проверяется
ещё раз, отказ сохраняет принадлежащий handle и UNKNOWN.
Проверки срока окружают файловую сверку и экспорт; принудительное прерывание синхронного
файлового I/O не квалифицировано. Pure-тесты проверяют остатки и порядок, но совместимость
параллельного SDK/Temporal shutdown с настоящими PG/SDK остаётся за отдельным живым допуском.

При отдельно разрешённом свежем прогоне runner теперь сохраняет первичный `DescribeNamespace`
с `namespaceInfo.id` и `config.workflowExecutionRetentionTtl`, а также точные Describe/history/
result каждого Run до остановки source. После остановки он публикует native dumps в CAS,
затем читает `timer_tasks` из файла того же default dump ref через pinned `pg_restore
--data-only --table=timer_tasks --file=-`. Это только чтение dump, без восстановления в БД.
Snapshot и последующее восстановление используют этот же ref; повторного чтения mutable
scratch для публикации нет. После извлечения CAS снова сверяется по hash/размеру.
Для закрытого Run требуется ровно одно настоящее задание `DELETE_HISTORY_EVENT=16`; сверяются
namespace ID, workflow/run, task ID и timestamp SQL-ключа с `TimerTaskInfo.visibility_time`.
`deleteAtMs` берётся из этого задания с округлением вниз до миллисекунд. Namespace retention
сохраняется отдельно и не используется для подстановки неизвестного срока.

Это соответствует [TimerTaskInfo Server v1.32.0](https://github.com/temporalio/temporal/blob/v1.32.0/proto/internal/temporal/server/api/persistence/v1/executions.proto)
и [типу задания 16](https://github.com/temporalio/temporal/blob/v1.32.0/proto/internal/temporal/server/api/enums/v1/task.proto).
В [генераторе этой версии](https://github.com/temporalio/temporal/blob/v1.32.0/service/history/workflow/task_generator.go)
к close time и retention добавляется jitter, поэтому сумма close+TTL не заменяет первичное
задание удаления. Неизвестная схема, кодировка, Run, срок, несогласованные timestamps или
дубликат дают отказ. Для open Run одновременно проверяются первичный RUNNING, отсутствие
завершающего события/результата и задания удаления.

В immutable backup добавляются artifacts первичного namespace response, timer COPY, readback
и производного наблюдения; snapshot закрепляет их refs. Отдельный `archived-readback.json`
ссылается на точные snapshot/defaultDump/history refs и допускает повторный штатный
`--preflight`. После экспорта и непосредственно перед target Server runner требует каждый
закрытый `deleteAtMs > now + budget.outerMs`; равенство границе тоже запрещает старт.
`--preflight` сохранённых комплектов также проверяет полное внешнее окно. FAIL/unknown
сохраняют рабочие данные; существующие guards останавливают только собственные процессы.

`--self-test` включает чистые отрицательные проверки пропущенного/дублированного задания,
подмены namespace/run/task/timestamp/encoding, несогласованного readback и точной границы
окна. Это подготовка нового доказательства: реальный свежий прогон пока не выполнен.
Прежний выбранный архив остаётся `UNKNOWN_BLOCKS_SERVER_READBACK`; никакой новый синтетический
результат не заменит его историческую приёмку, сверку T3 или эксплуатационное восстановление.

Пакет подготовки на 2026-11-07 лежит в `t4/fresh-window-preparation` внутри указанного выше
четырёхпоточного evidence root: `fresh-config.json`, `fresh-plan.json`, идентичный
`canonical-cli-plan.json`, pins helper-файлов, `version-observation.json` и журналы self-test/
eslint. План SHA-256 `3327f9de5ce5d0dbbbc1af4a9889b02973369b8f5ff98c9acec80827f57d7e12`,
12 140 bytes. Предложены PG 55441, gRPC/membership 17251–17258, основное окно 180 s,
внешнее 240 s и остановка 20 s; наблюдаемые пределы disk 768 MiB и RSS Server 1 GiB.
Текущие binary pins повторно проверены, bounded `--version` подтвердил PG 12.22 и Server/
SQL-tool 1.32.0 без служб; canonical CLI совпал побайтно. Перед стартом нужен отдельный
допуск и повторная проверка минимум 1 GiB свободного диска; свободное место не зарезервировано.

### Стенд и условия отдельного следующего запуска

`tests/temporal/t4-pg-temporal-recovery.mjs` предоставляет `--preflight`, `--show-plan`, `--stage`
и отдельно защищённый `--run`. Пример — `t4-pg-temporal-recovery.config.example.json`.
`--preflight` незаполненного примера остаётся `blocked`: пример не содержит принятого recovery set
и нового допуска. Этот статус не отменяет сохранённый ниже результат отдельной пробы. `--show-plan CONFIG PROPOSED_ROOT TOOLS_ROOT`
выдаёт полный JSON конфигурации и точные argv команд без их исполнения.

Для выполненной пробы Mac arm64 получен приватный набор Server/SQL-tool **1.32.0** из официального
[release archive](https://github.com/temporalio/temporal/releases/expanded_assets/v1.32.0):
`temporal_1.32.0_darwin_arm64.tar.gz`, 96 287 042 bytes, SHA-256
`f95748376241f5941327fa4c4e8e76641e8c4a9acabf77de9c86eb3d8238f4d7`.
[Конфигурация сборки этого tag](https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/.goreleaser.yml)
включает оба нужных executable. После отдельного допуска hash проверен до распаковки в
`tmp/t4-next/runtime/temporal-1.32.0/`; PATH, daemon и Docker не менялись. Сохранён
[результат реальной распаковки](evidence/README.md): два regular binary,
служебная ссылка не материализована. Новые получение или запуск требуют нового допуска;
удалять можно только собственный cache после сохранения нужных proof и refs.

Зафиксированные входы пробы: arm64, PostgreSQL **12.22**, Go **1.27.2**, TypeScript SDK **1.24.0**,
полученные standalone Server/SQL-tool **1.32.0**. Cached CLI 1.9.1 содержит
dev Server 1.32.0, но его SQLite-режим не заменяет standalone PostgreSQL Server. Схема
`postgres12` и оба логических stores заданы в
[официальном tagged PostgreSQL config](https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/config/development-postgres12.yaml),
embedded schema names и setup/update команды — в
[SQL-tool README этого же tag](https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/tools/sql/README.md).
Фактические curr_version/min_compatible_version читаются из созданных БД и сверяются после restore;
номера схем не выдумываются.

При согласовании этой пробы PostgreSQL 12+ указан для
[SQL Visibility](https://docs.temporal.io/self-hosted-guide/visibility), а зафиксированная при подготовке
[матрица Temporal](https://docs.temporal.io/temporal-service/persistence)
перечисляет PostgreSQL 13–16; PostgreSQL 12.22 уже
[не поддерживается самим PostgreSQL](https://www.postgresql.org/support/versioning/).
Успех описанной локальной пробы с 12.22 не является промышленной рекомендацией или
подтверждением совместимости другой конфигурации или версии. 1.32.0 выбран для совпадения
с наблюдавшимся dev Server, без одновременного обновления источника и цели.

Учебный `--run` не принимает существующий recoverySet: он создаёт новый изолированный
PGTemporal source и не импортирует SQLite/legacy. Два закрытых SDK Workflow возвращают исходные
PASS/FAIL/findings/Result; третий остаётся pending на условии, без внешних Activities и моделей.
После остановки SDK Worker и всех сервисов Temporal выполняются native dump обоих выбранных
новых БД, упаковка artifacts/projections/workcopy/build/receipts единым set, остановка source PG
и удаление только новых временных source-копий после сохранения backup.

Отдельный новый target cluster восстанавливает оба dump, проверяет схемы, запускает тот же
Server и Worker **из восстановленного bundle**, читает прежние IDs/run IDs, полную семантику
закрытых историй/результатов и исходный prefix pending-истории с query состояния. Pending не
получает Signal и остаётся RUNNING; неизвестный grant сохраняется unknown. Это pending
тестового Workflow, не восстановление живого T3 writer. Описанный ниже PASS получен настоящим
PG dump/restore, а не только проверкой кода, сигнатур или fake-exec self-tests.

Отдельная необязательная ветка `resumePending: true` продолжает новый синтетический pending
после восстановления: сначала сверяются прежние WorkflowID/runID, query и исходный prefix
истории, затем один Signal доводит его до COMPLETED. Результат и полная история должны
подтвердить ровно один Signal и одно завершение без Activities и моделей. Отсутствие поля
сохраняет прежнюю query-only ветку. Intent фиксируется до единственной отправки; unknown или
ошибка запрещают повтор и сохраняют root/proof. Эта ветка использует новый source/target и
свой восстановленный bundle, не импортирует старый recoverySet и не восстанавливает права
живого writer. Прежний query-only PASS не присваивается новому resume-сценарию.

Один новый resume-прогон 2026-11-01 прошёл в этих границах: прежний pending run стал
COMPLETED, SignalCalls/events/completion=1/1/1, Activities0; source prefix/query/result
совпали. Outer wall12523,165 мс; RPO905 мс/RTO3043 мс относятся только к этому малому
синтетическому набору. Grants остались unknown, activationfalse; все сервисы остановлены,
136 owned identities отсутствуют, девять портов закрыты. Сверены 42 первичных файла,
включая два native dump и intent/outcome/final history. Полный результат —
`tmp/team-next/pg-resume-20261101-01/t4/runtime-prep/actual-pg-resume-summary.json`.
Это не целевой SLA и не подтверждение восстановления native writer или рабочего backend.

Отдельный запуск использует один приватный root `/private/tmp/aw-t4-pg-temporal-*`; два PG cluster
и два Temporal Server запускаются последовательно, два SDK Worker без моделей. В примере
PG TCP 55438 и Temporal TCP 17239–17246, всё на 127.0.0.1; UI/HTTP/pprof отключены. Listener
проверяется по PID через lsof перед SDK-запросами; занятый порт даёт отказ. PG socket находится
в собственном root. Временный trust/no-auth ограничен этим новым localhost-контуром и требует
явного разрешения. Наследуемые PG*/SQL_*/TEMPORAL*/proxy настройки не направляют подключения наружу.

Границы разового стенда, не постоянный допуск: acquisition до 128 MiB сети и до 1 GiB cache;
run 180 s плюс cleanup до 20 s на операцию; dataset/logs до 1 GiB наблюдаемого диска;
shared_buffers 64 MiB, max_connections 32, SQL pools 4+2 на сервис; наблюдаемый RSS Server до
1 GiB. Cleanup нескольких операций может суммарно занять около 180 s; внешнее окно run — до
7 минут, acquisition отдельно. Хост имеет 16 GiB RAM; наблюдения выполненной пробы приведены
ниже, общий физический пик памяти не измерен. Все durations/RPO/RTO монотонные; PID/RSS/CPU/disk сохраняются как выборки, без заявления hard RSS cap/OS quota.
Выполняются только перечисленные executable; native ошибка или лимит дают FAIL без повтора.

Cleanup: закрыть SDK/native connections, остановить только собственный Temporal PID (TERM→KILL
при необходимости), `pg_ctl -D <собственный cluster> -m immediate -w stop`, проверить отсутствие
сервера, export proof/logs/backup, затем удалить только созданный run root. Dump и доказательства
остаются. Не меняются существующие БД, чек-ауты, рабочие задачи, владельцы и grants; команды DROP
не используются. Полный продуктовый in-flight restore, SQL ACL/секреты настоящего размещения,
действующие T3 grants, RPO 24 ч/RTO 2 ч под нагрузкой и ежедневный backup остаются отдельными входами.

Перед любым выполнением native binary, включая `--version`, оператор закрепляет
`executablePins` по каноническим абсолютным путям всех семи PG tools, Server, SQL-tool и
наблюдателей `/bin/ps`, `/usr/sbin/lsof`. Проверяются regular/single-link, отсутствие symlink
в пути, точные hash/bytes; проверка повторяется непосредственно перед каждым launch.
Для установленного PostgreSQL используется фактически прочитанный
`/opt/homebrew/Cellar/postgresql@12/12.22_2/bin`, не изменяемый alias `opt`.
`--observe-installed-pins CONFIG` только читает эти файлы и не выполняет их. Наблюдение refs
не является допуском запуска.

После отдельного acquisition-допуска `--extract-archive CONFIG ARCHIVE NEW_DESTINATION`
сначала проверяет закреплённый archive SHA, затем строго читает tar без внешнего `tar`:
отказывает при traversal, посторонних links/special/unsupported headers, дубликате или неполноте. Только
два названных binary пишутся в новый приватный каталог. Их inventory и ref самого inventory
попадают в `executablePins`/`temporalBinaryInventory` operator config. `--run` сверяет эту
цепочку с закреплённым архивом до первого выполнения; неизвестный tar формат остаётся
blocker, обхода проверки нет. Самопроверки используют искусственный gzip/tar; фактическая
распаковка этого release archive подтверждена отдельно указанным выше первичным журналом.

Native `psql`/`createdb`/dump/restore используют уникальный private Unix socket. До SQL-эффекта
и Server/SDK проверяются postmaster PID, data-directory, socket/port, binary txt и принадлежность
TCP listener. SQL-tool и Server подключаются к проверенному loopback TCP: выбранный
[SQL-tool handler](https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/tools/sql/handler.go)
требует hostname, а [PostgreSQL session](https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/common/persistence/sql/sqlplugin/postgresql/session/session.go)
строит URI; неподтверждённый Unix-path в `--ep` не используется.

При shutdown сохраняются ранее наблюдавшиеся descendants; после остановки проверяются они,
весь свой диапазон TCP listeners и private Unix socket. Живой потомок, занятый listener,
ошибка наблюдения либо SDK timeout дают FAIL/unknown. Ссылки на неизвестно завершившийся
Worker/connection не обнуляются. Временный root удаляется только после полного PASS,
проверенного immutable recovery set, полного сохранённого/hash-проверенного evidence и всех
подтверждённых stops. Любой FAIL, ранняя ошибка без set, serverError или unknown сохраняет
root и доступные данные для разбирательства. Последующие очистка или запуск требуют отдельного
решения. Дополнительные stop/ownership проверки имеют собственные deadlines; внешнее окно
следует резервировать до 7 минут (main 180 s, cleanup/наблюдения и export отдельно), а не
считать per-operation cleanupMs общим таймером всей очистки.

Дочерняя среда дополнительно исключает DYLD_*/LD_* и NODE_OPTIONS/NODE_PATH, не меняя
переданный исходный объект. Поскольку SDK создаёт потоки внутри собственного Node host,
перед native/SDK запуском host с такими переменными отклоняется; запускать его следует с
очищенным дочерним окружением, без изменения окружения вызывающего процесса.

Connection/NativeConnection/Worker.create используют отдельный acquisition guard. Операция,
проигравшая deadline, остаётся в реестре вместе с Promise и поздним handle; unknown необратим
для этого прогона. Поздний close ограничен временем и сохраняет исход/ошибку в
`sdk-acquisitions.json` и proof даже после основного finally. Успешный поздний close не
разрешает удаление root. Поздний INITIALIZED Worker не запускается ради очистки: публичный
shutdown SDK1.24 отказывает до RUNNING, этот отказ сохраняется с handle как unknown.

В фактически закреплённом release archive обнаружена единственная служебная запись
`config/development.yaml`, type2, size0, target `development-sqlite.yaml`. Parser допускает
именно эту запись один раз как ignored metadata и фиксирует `materialized:false` в inventory;
каталог config и symlink не создаются. Другой target/path/type/size, ссылка вместо выбранного
binary и повтор этой записи по-прежнему дают отказ до публикации файлов.

Первый настоящий PostgreSQL Temporal source-запуск завершился FAIL до business histories:
реальная schema отклонила membership57243–57246 как PostgreSQL smallint (22003), после чего
Server сообщил fatal membership heartbeat. Этот прогон не доказывает dump/restore, RPO/RTO
или восстановление Workflow. Исторический operator-config/proof сохраняют исходные порты.
Общий test config parser теперь требует grpcPort+7<=32767 до любого native исполнения;
PostgreSQL port55438 ограничением membership не затрагивается. Следующий пример использует
17239–17246; он использован в отдельно разрешённом PASS. Stop-verification зафиксировал
закрытие этих портов после пробы, а не их будущую свободность. Перед следующим запуском
требуются новая проверка, свежий допуск и dispatch; старые разовые допуски израсходованы.
