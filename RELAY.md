# Передача после сжатия контекста AW8

Владелец договора — [условия R1–R5/O6](docs/quality/agent-workflow-contracts.md). Процедура
[relay](procedures/relay.md) загружается в обоих сеансах до действий в точной версии
дескриптора подключённого проекта.

## Сохранение и остановка

`compactionEvent` принимает только нативный `item/completed` с `contextCompaction`
для предшественника. Resume, событие помощника и повтор не создают нового владельца.
`beginRelay` сохраняет весь checkpoint, отдельный snapshot, active stage, исходную оценку,
elapsed/external wait, next action, audit checkpoint, findings/dispositions, gates,
pending human decisions, child evidence и mapping. Неизвестные поля сохраняются.

`AppServerWriters` останавливает только явно переданные собственные turn/terminals/processes.
Для nullable `osPid` требуется проверенное первичное соответствие terminal → процессы,
включая потомков. `NativeWriterProcesses` сверяет PID и время начала перед сигналом;
чужие PID, неоднозначная принадлежность или неполный перечень не становятся успехом.
До RPC interrupt/terminate адаптер приостанавливает собственное дерево через SIGSTOP,
повторно собирает потомков и подтверждает остановку всех обнаруженных процессов.
Затем SIGKILL завершает их без обработчиков сигналов, способных породить нового writer.
Receipt содержит и потомков, появившихся после первого снимка. Потеря identity или
неподтверждённая остановка запрещает receipt; при отказе возобновляются только процессы,
которые приостановил этот вызов и чья identity всё ещё совпадает.
После interrupt/terminate проверяются отсутствие активного turn, terminals и процессов,
а также стабильность контрольных файлов. Один interrupt не доказывает прекращение записи.

`TaskRelayOwnership` освобождает lease исходного SQLite, сохраняя checkpoint.
`AssignmentRelayOwnership` отменяет отдельный cardless LocalRun без выдуманной карточки.
Журнал контроллера находится в другом namespace и не теряет возможность записать release.

Если SQLite уже сохранил release, а ответ или файл receipt потерян, повтор сверяет исходный
operation ID, Ack, revision и generation. Затем Store проверяет точный исходный запрос и
возвращает прежний Ack без второй мутации. Совпадающий receipt читается повторно, посторонний
сохраняется как конфликт. Другое поколение, checkpoint или payload не разрешают восстановление.

## Единственный преемник

`dispatchRelay` сначала сохраняет RESERVE, затем делает одну попытку `thread/start`.
Неизвестный ответ оставляет reservation: повторный dispatch отклоняется. Контроллер
восстанавливает тот же ID по первичному creation receipt и нативному чтению; новый сеанс
не создаёт. Fresh persistent thread должен иметь точные project/root/profile, ноль
начальных ходов, отсутствие fork, нужный режим записи и отключённую сеть.

Текущий App Server может не поддерживать `thread/read(includeTurns)` до загрузки сеанса.
Восстановление использует `thread/resume` по точному сохранённому ID, затем повторное чтение.
Если холодное resume возвращает `projectId: null`, исходная нативная привязка восстанавливается
явным `thread/metadata/update` только после сверки creation receipt и рабочего каталога;
следующее чтение обязано подтвердить исходный project ID. Это наблюдавшийся путь восстановления,
не молчаливое признание отсутствующего project успешным результатом.

O6 разрешён после release при подтверждённом техническом ограничении. Dispatch содержит
конкретный coordinator, authority, project/root, release и одну operation. Отказ permissions
не является основанием помощи; свежий controller не получает права обходить его.

## Принятие и продолжение

Identity, LOAD, ADOPT и CONTINUE — разные события и доказательства. `FileRelayProofs`
проверяет SHA-256, первичный нативный ответ, загрузку точных процедур и весь adoption.
`readySuccessor` создаёт новое поколение с прежним временем и новым inbox. `adoptedCheckpoint`
сохраняет исходную историю, findings и соседние поля, переносит владельца исполнения;
координатор использует wrapper `coordination.schema_version: 2` над исходным журналом.
Неизвестная версия или несовпадение исходного владельца отклоняются до записи.

Старый LocalRun/журнал не получает права записи в новом поколении. При CONTINUE нужен
реальный наблюдаемый результат next action; ack модели и ожидание сами по себе недостаточны.
Открытые FAIL/gates/решения человека не исчезают при передаче. Relay не означает task done.

## Проверки и границы

`relay.test.ts`, `relayCheckpoint.test.ts`, `relayPersistence.integration.test.ts` и
`relayOwnership.integration.test.ts` проверяют transitions, dedupe, неизвестность,
отмену/отказы, полный снимок, CAS, поколение и настоящее SQLite/cardless хранение.
`relayWriters.test.ts`, `writerProcesses.test.ts`, `writerProcesses.integration.test.ts`
проверяют ограниченную остановку, позднюю запись и настоящий родительский процесс с потомком.
Отдельная регрессия создаёт detached-потомка между первым снимком и прерыванием, затем
после выдачи receipt пытается вызвать его отложенную запись. RPC в этой локальной проверке
подменён; это не новая квалификация живого App Server.
Живые manual/auto relay и O6 требуют собственных первичных доказательств; исторические
материалы этапа доступны через [manifest архива](https://github.com/Krivega/agent-workflow/blob/main/docs/evidence/README.md). Условия подключения —
в [каталоге процедур](procedures/README.md), текущие ограничения — в [разделе качества](https://github.com/Krivega/agent-workflow/blob/main/docs/quality/README.md).
