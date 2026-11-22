# Проверка границ

Procedure: boundary-review
Version: 2

<!-- aw-rule boundary-review.context-01 -->
Основание: DEC-01-B и [профиль анализа влияния](../.agents/skills/analyze-change-impact/SKILL.md).
Ревью сохраняет владельца [review-git-branch](../.agents/skills/review-git-branch/SKILL.md).
<!-- /aw-rule -->

1. <!-- aw-rule boundary-review.01 -->
   Определи изменённые договоры и фактических производителей/потребителей по точному diff/base.
   Прочитай применимый профиль до оценки. Не считай прежнее участие в planning достаточным.
   <!-- /aw-rule -->

2. <!-- aw-rule boundary-review.02 -->
   Проверь обычный, пограничный и запрещённый сценарии, сохранение данных, совместимость и
   полномочия только в затронутой области. Недоступная проверка остаётся NOT RUN.
   <!-- /aw-rule -->

3. <!-- aw-rule boundary-review.03 -->
   Верни scoped PASS/FAIL либо обоснованное N/A; finding содержит identity, источник/revision,
   условие устранения и непроверенное. Пропущенный обязательный reviewer не является N/A.
   <!-- /aw-rule -->

4. <!-- aw-rule boundary-review.04 -->
   Не переписывай исходный FAIL и не принимай всю задачу из локального результата.
   Повторная оценка охватывает исправление, открытые замечания и новую delta.
   <!-- /aw-rule -->

<!-- aw-rule boundary-review.context-02 -->
Выход: ограниченное заключение с основаниями. Полный council и счёт раундов — последующие этапы.
<!-- /aw-rule -->
