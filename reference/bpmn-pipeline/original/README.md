# BPMN Diagram Pipeline

Таблиця процесу (CSV) → готова BPMN-діаграма (.drawio) однією командою.

## Склад архіву

- `scripts/` — 4 файли ланцюга. Для запуску в Colab завантажуються всі чотири.
- `examples/` — 4 приклади: CSV-таблиці + згенеровані з них діаграми.
- `docs/` — опис рішення та запит до тех команди (Confluence-ready markdown).

## Запуск у Google Colab

1. Завантажити в панель файлів: 4 файли зі `scripts/` + свій CSV.
2. Клітинка 1 (раз на сесію):
   `!npm install bpmn-auto-layout@2.0.0-alpha.2 --silent`
3. Клітинка 2:
   `!bash run_pipeline.sh мій_процес.csv "Назва процесу" результат.drawio`
4. Оновити панель (🔄) → завантажити результат → відкрити в draw.io.

## Контракт таблиці

CSV, 8 колонок: `id, label, type, role, next, yes, no, assoc`

Типи: `start`, `end`, `xor`, `and`, `timer`, `msg`, `sub`,
`linkStart`/`linkEnd` (пара — однаковий label), `task`, `srv`, `manual`,
`note`, `data`, `db` (три останні — через `assoc`).

Правила: label без ком; у шлюзів `yes`/`no` замість `next`;
паралельні гілки — `next=4|5`; прогалини джерела — `[TO DEFINE: причина]`.

Повний опис і таблиця покриття нотації — у `docs/`.
