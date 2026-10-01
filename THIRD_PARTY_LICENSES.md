# Сторонні ліцензії (перевірено 01.10.2026 за файлами встановлених пакетів)

Це перелік за даними пакетів, а не юридична консультація.

| Пакет | Версія | Де використовується | Ліцензія |
|---|---|---|---|
| `bpmn-auto-layout` | 2.0.0-alpha.2 | генератор схем (виконання) | MIT. Поле `license` пакета й README — MIT; окремого файлу LICENSE в опублікованому пакеті немає. Текст і копірайт — у гілці за замовчуванням репозиторію bpmn-io: «Copyright (c) 2016-present Camunda Services GmbH» |
| `bpmn-moddle` 10.3.1, `moddle` 8.2.1, `moddle-xml` 12.3.1, `min-dash` 5.1.0 | — | залежності лейаутера | MIT (Camunda Services GmbH) |
| `saxen` | 11.2.0 | залежність `moddle-xml` | MIT (Vopilovskii Konstantin; Nico Rehwaldt) |
| `bpmn-js` | 18.30.1 | **лише розробка**: переглядач тестових схем і знімки (`scripts/lib/viewer.ts`) | Файл LICENSE: MIT-подібна ліцензія (Camunda Services GmbH) **з умовою**: код, що показує водяний знак bpmn.io з посиланням на https://bpmn.io, **не можна видаляти чи змінювати**; під час використання в сайті чи застосунку знак має бути повністю видимим і не перекритим іншими елементами (D30) |
| переглядач draw.io `viewer-static` (jgraph/drawio) | з гілки `dev`, 01.10.2026 | **лише для знімків `.drawio`** у тимчасовій теці; **у репозиторій не додається** і не поширюється | Apache-2.0 (за репозиторієм jgraph/drawio) |

## Текст MIT (для `bpmn-auto-layout` і його залежностей)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Водяний знак у наших переглядачах (`docs/bpmn-3a/schemes/*.html`) — стандартний знак `bpmn-js`; його не вилучено й не перекрито (див. знімки).
