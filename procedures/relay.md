# Передача после сжатия контекста

Procedure: relay
Version: 6

<!-- aw-rule relay.context-01 -->
Загрузи эту процедуру у predecessor до работы и у fresh successor до adoption. Только
подтверждённый native item/completed с contextCompaction для executor/orchestrator запускает
relay. Resume, текст модели и compaction помощника не являются триггером. Manual и auto имеют
отдельные primary receipts; для auto должен отсутствовать manual request данного события.
<!-- /aw-rule -->

<!-- aw-rule relay.context-02 -->
До release сохрани полный durable checkpoint без удаления неизвестных полей: assignment/card,
active stage, estimate/elapsed/external waits, next action, audit checkpoint, FAIL/dissent,
dispositions/gates, pending human decisions, child evidence, ownership и mapping/dependencies.
В отсутствие карточки сохраняется исходное assignment; карточка не выдумывается ради relay.
Внешний контроллер хранит собственный журнал передачи отдельно от освобождаемого namespace.
<!-- /aw-rule -->

<!-- aw-rule relay.context-03 -->
Подтверди полноту перечня принадлежащих scope writers. Прерви активный ход; отдельно проверь
background terminals и принадлежащие им процессы/потомков. Terminate только подтверждённые
собственные IDs, учитывая повторное использование PID. Проверь завершение процесса, отсутствие
активного хода и поздних записей. Неизвестный writer, неполная выдача или только interrupt Ack
запрещают release. Не останавливай чужие процессы и не расширяй права при отказе.
<!-- /aw-rule -->

<!-- aw-rule relay.context-04 -->
После сохранённого STOP release старой generation оставляет исходный checkpoint неизменным.
До thread/start сохрани единственный RESERVE с operation. Fresh persistent successor получает
точные native project/root, профиль и scope; fork/history/worktree запрещены. Unknown outcome
восстанавливается по первичной correlation и actual identity; неполная выдача не разрешает
второе создание. clientThreadId не подтверждает identity. Пока identity неизвестна, записи
преемника запрещены. Отказ permissions закрывает relay; O6 его не обходит.
<!-- /aw-rule -->

<!-- aw-rule relay.context-05 -->
Created/identity, LOAD, adoption и continuation — разные подтверждения. Преемник сверяет
snapshot/release, принимает следующее поколение, сохраняет весь исходный checkpoint и progress
в adoption receipt. Только после adoption выполняет ближайшее указанное действие; внешний
контроллер проверяет его наблюдаемый результат. Тайм-аут/idle/сводка модели не равны adoption.
<!-- /aw-rule -->

<!-- aw-rule relay.context-06 -->
O6 допустим при подтверждённой технической недоступности. Разрешённый координатор проверяет
release и сохраняет dispatch с authority, operation, native project/root и одной попыткой.
Контроллер проверяет dispatch; он не принимает чужую карточку и не обходит исходный отказ.
Новые сообщения разрешены только внутри grant. Отдельный wait не больше 60 секунд.
<!-- /aw-rule -->

<!-- aw-rule relay.context-07 -->
После release predecessor может только читать или помогать восстановлению; старые generation
не пишут. Повтор compaction/event не создаёт второго successor. Сбой сохраняет исходный FAIL и
незавершённое состояние. Неполученное живое доказательство остаётся NOT RUN, не успешным relay.
<!-- /aw-rule -->

<!-- aw-rule relay.context-08 -->
Продолжение той же identity текущего чата по [ADR-0048](https://github.com/Krivega/agent-workflow/blob/main/docs/design/decisions/inherited/0048-drive-agent-workflow-from-codex-chat.md)
не запускает этот fresh-session relay. Оно проверяет собственные первичные границы, новый LOAD,
входы и intent/receipt. Новая identity требует всей цепочки stop/release/adopt/continue и явных
полномочий. Не подменяй app-owned чат отдельным App Server; его видимость и остановка требуют
собственной живой квалификации. Сам текущий активный ход себя не interrupt/resume.
<!-- /aw-rule -->

<!-- aw-rule relay.context-09 -->
Краткое поручение преемнику: исходная цель и границы → актуальные требования/карточка →
принятые результаты и их существенные входы → checkpoint и открытые FAIL/pending operations →
ближайший наблюдаемый результат и его проверка. Подробности передавай ссылками на durable
источники. Недоступный источник не заменяй пересказом; прежние STOP/release/LOAD/adoption и
проверка unknown обязательны. Неизменные принятые проверки сохраняют применимость по
[договору reuse](https://github.com/Krivega/agent-workflow/blob/main/docs/design/decisions/inherited/0060-preserve-reviews-after-dependency-restoration.md).
<!-- /aw-rule -->
