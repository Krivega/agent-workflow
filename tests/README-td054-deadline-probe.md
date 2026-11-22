# TD-054: deadline первичного LOAD

`td054DeadlineProbe.mjs` готовит точный запрос, проверяет его и выполняет короткую пробу через
действующие H06 supervisor, транспорт, owned server и ControlledReaderWorkflow. Другого
исполнителя процессов нет. Полный H06, F01, Writer, warm/cold RESUME и повтор не входят в пробу.
Обычные H06/2 и H06/3 grant bodies сохранены.

Подготовка не запускает модель или службу, не копирует runtime, не создаёт source/authority.
`PREPARATION_PASS_NATIVE_UNKNOWN` означает только целостность подготовки. Native deadline и
LIVE12 formal cold STOP остаются UNKNOWN; результат обычного завершения LIVE13 не меняется.

## Подготовка после остановки правок

Из корня репозитория, с имеющимся REFERENCE (`temporal-attempt.json`) и новым OUTPUT:

```sh
node --import tsx tests/td054DeadlineProbe.mjs --prepare "$REFERENCE" td054-deadline-unique "$OUTPUT"
node --import tsx tests/td054DeadlineProbe.mjs --check "$OUTPUT"
node --import tsx tests/td054DeadlineProbe.mjs --show-run-plan "$OUTPUT"
```

REFERENCE даёт читаемые входы, профиль и binary pins. Старые grants, сроки и результаты не
переносятся. Пакет закрепляет текущие исходники, compiled workflows, установленную dependency
closure, бинарники и LOAD inputs на месте. После изменения входов нужен новый пакет; перезапись
OUTPUT запрещена. CLI размещает будущие evidence/server roots рядом с новым OUTPUT; OUTPUT
должен лежать во внешнем пакете, вне рабочего repo и LOAD workspace. Архив REFERENCE не пополняется.

LOAD workspace — отдельный Git-репозиторий квалификации со своей `.git`, без общего рабочего
worktree registry. Файлы исходной копии не меняются; артефакты и сервер получают два новых корня.
`requireTaskBackend` вызывается до запуска. При активной policy необходимо уже существующее
назначение Temporal диагностической задаче; отсутствие блокирует пробу. Policy/assignment
инструмент не создаёт. Runtime использует `startControlledReader` с `bindTaskBackendClient`
и обычные Activity guards.

## Предложенные пределы

| Граница | Предложение |
| --- | --- |
| Общее окно от атомарного claim | 90 с |
| Первичный LOAD должен начаться не позже | 45 с от claim |
| workDeadline: связанная IPC-отмена | 60 с от claim |
| Очистка, fallback и immutable STOP | ещё 27 с, до 87 с от claim |
| Проверка отсутствия позднего запуска | 3 с внутри общего окна |
| Модельные turn/start | не более одного первичного LOAD |
| Uncached input / output | 120000 / 4000 токенов |

60 с учитывают запуск существующего сервера/Worker, проверку runtime и тяжёлый первичный
контекст. В начале LOAD модель получает одно **отдельно разрешаемое читающее действие**:
foreground `Atomics.wait` на 120 с, который ожидается прервать хостом. Это удерживает LOAD без
Writer и ожидания полного чтения; обычный LOAD не меняется. Все числа пока лишь предложение.

Число стартов ограничено одноразовым ledger, время — прежним supervisor и OS fallback.
Расход сверяется после STOP общими primary usage receipts: превышение запрещает PASS,
неполный расход остаётся UNKNOWN. Provider hard cap не доказан.

## Точный допуск и запуск

`--show-run-plan` возвращает `expectedGrantText`: один новый authorization envelope с отдельными
секциями `td054-native-load-deadline-grant/1` и `td054-native-load-deadline-server-grant/1`.
Обе связывают тот же requestHash и свои полномочия. Пользователь должен выдать весь точный
envelope текущим первичным сообщением. Отдельная секция, старый H06 grant, assistant draft,
изменённое или superseded сообщение не разрешают ни claim, ни процесс. Применяется общий
strict current/latest `observeH06NativePrimaryGrant`.

Только после нового подлинного допуска:

```sh
node --import tsx tests/td054DeadlineProbe.mjs --run "$OUTPUT"
```

Источник обнаруживает штатный `resolveH06NativeGrant`; собственной authority инструмент не
выдаёт. Необязательный третий аргумент PRIMARY_SOURCE_JSON содержит уже существующие
`transcript`, `turnId`, `source.locator/hash` и проходит тот же checker. После обеих проверок
общий атомарный claim занимает evidence root. Повтор после частичного исхода запрещён.

## Opt-in reference/2: настоящее согласие на опубликованный пакет

Буквальный `/1` сохранён. Отдельный `td054-native-load-deadline-reference/2` принимает
существующее настоящее согласие пользователя, связанное с непосредственно предшествующим
завершённым предложением в том же чате. Разрешённые точные естественные формулировки берутся
из существующего H06/4 resolver. Происхождение, исходный текст, turn ID и hash сохраняются;
агент не создаёт USER-запись и не выдаёт согласие за численный JSON.

BINDING_JSON содержит ссылки `approvedPacket`, `approvedGrant`, `publication`, `assistant`,
`primary` и `authorityBaselines`. Первичный tool-output до предложения и пользователя
обязан содержать тот же literal envelope и hash файла, на который указывает завершённый final.
Baseline-файлы — только доказательства старых authority callers; они не исполняются.

```sh
node --import tsx tests/td054DeadlineProbe.mjs --prepare-reference "$BINDING_JSON" "$REFERENCE_OUTPUT"
node --import tsx tests/td054DeadlineProbe.mjs --check-reference "$REFERENCE_OUTPUT"
```

Подготовка проверяет, что производный packet сохраняет все operational поля, корни, binary/LOAD
pins и пределы утверждённого пакета. Допускаются только новый pure reference-модуль и помеченные
authority-вставки двух callers: их удаление обязано побайтно восстановить прежний `/1`.
Изменение старого LOAD, STOP, supervisor, бюджетов или любого другого runtime-файла запрещено.
Перед исполнением нового кода обязателен его полный локальный допуск.

Для нового пакета, уже содержащего Reference и оба помеченных caller, допустимо точное
тождество всего approved/current runtime. В этом случае `authorityBaselines` пуст;
`translation.replaced` и `translation.added` тоже пусты. Это не разрешает runtime drift:
операция, корни, LOAD/binary pins, пределы и весь runtime обязаны совпасть с новым
утверждённым пакетом. Общая проверка packet по-прежнему сверяет реальную closure до
source/live допуска. Прежний перевод из `/1` требует две baseline-записи и сохраняет
побайтную проверку authority-вставок.

Новый exact-runtime пакет и точный envelope должны быть опубликованы до нового genuine
USER-согласия в том же чате. Identity-путь не создаёт источник, не переносит старый
допуск и не открывает уже израсходованные operation/evidence root. Для нового живого
прогона требуется собственный свежий допуск; текущий UNKNOWN повторять нельзя.

```sh
node --import tsx tests/td054DeadlineProbe.mjs --run-reference "$REFERENCE_OUTPUT"
```

Запуск повторно проверяет current/latest первичный источник и основной чат. Claim имеет явный
kind `td054-native-load-deadline-reference-claim/2` и actual reference proof. У `/1` и `/2`
одни operation ID и evidence root: второй старт, повтор и новый бюджет не выдаются.
Часы, единственный LOAD и приёмка STOP остаются прежними. Сохранённый proof читается по
неизменному native prefix без разрешения повторного исполнения.

## Первичные свидетельства

Worker сохраняет primary LOAD session/turn; при deadline cancel делает один `thread/read`.
Тот же turn обязан оставаться `inProgress` уже на границе отмены. Раннее завершение, иной turn
и неизвестный исход не дают PASS. Далее обычный Host останавливает reader, транспорт
подтверждает исчезновение native процессов, supervisor сохраняет immutable
`worker-deadline-load-outcome.json`, сервер ждёт очистку перед STOP. Принудительное завершение
без cleanup evidence оставляет UNKNOWN.

До stopDeadline нужны primary транспортный STOP, наблюдённый Worker exit/outcome и серверный
STOP с точными identities. Затем проверяются отсутствие процессов/слушателей, неизменность
квитанций/диагностики и один ledger start в течение трёх секунд. Недостающие STOP, поздняя
запись, изменённый hash или дубликат запрещают PASS. `live-result.json` получает scoped PASS
либо UNKNOWN; UNKNOWN завершает CLI с ненулевым кодом.

```sh
node --import tsx tests/td054DeadlineProbe.mjs --check-live "$LIVE_RESULT"
node --import tsx --test tests/td054DeadlineProbe.test.mjs
```

Начало native stage повторно требует current/latest source и непросроченный workDeadline;
проверка сервера связывает его с requestHash пакета. PS проверяет весь набор PID одной командой,
каждый lsof и quiet pause ограничены остатком исходного finalDeadline; срок не перевыдаётся.
Saved checker использует отдельный read-only historical-source путь для consumed claim.
Позднее сообщение не уничтожает старое свидетельство; такое чтение никогда не разрешает
новый запуск и сохраняет `mayRun:false`. Live preflight всегда требует текущий source.
Scoped deadline PASS не закрывает весь H06, T6, полную пару расходов или квалификацию.
