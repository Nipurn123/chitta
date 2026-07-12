# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.ko-KR.md">한국어</a> ·
  <a href="README.hi-IN.md">हिन्दी</a> ·
  <a href="README.bn-IN.md">বাংলা</a> ·
  <a href="README.es-ES.md">Español</a> ·
  <a href="README.fr-FR.md">Français</a> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <a href="README.ar-SA.md">العربية</a> ·
  <a href="README.fa-IR.md">فارسی</a> ·
  <a href="README.it-IT.md">Italiano</a> ·
  <a href="README.tr-TR.md">Türkçe</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.id-ID.md">Bahasa Indonesia</a> ·
  <a href="README.pl-PL.md">Polski</a> ·
  <b>Українська</b> ·
  <a href="README.nl-NL.md">Nederlands</a> ·
  <a href="README.th-TH.md">ภาษาไทย</a>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-124%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

> Це переклад. У разі розбіжностей пріоритет має оригінал [English](../../README.md).

**Граф знань + векторна пам'ять** з урахуванням прав доступу, постачається як автономний **сервер MCP**.
Будь-який клієнт MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) використовує його через конфігурацію - без змін у коді.

Під'єднайте свого ШІ-асистента один раз - і кожна розмова зможе **зберігати, пригадувати й міркувати** над знаннями вашої команди, причому кожен користувач бачить лише те, що дозволяють його права.

> **Архітектура та внутрішня будова:** див. [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Локальний режим (типовий):** один файл SQLite. Приймання, видобування графа знань і пошук - без серверів.
- **Режим центрального офісу:** через змінні середовища вкажіть спільний бекенд (ArangoDB + Qdrant + ембединги); уся організація користується одним графом, і кожен користувач бачить лише те, що дозволяє його ACL.

## Подивіться за 30 секунд

Два користувачі, одне сховище, три документи - кожен бачить лише дозволене:

```bash
bun install
./examples/permission-aware-retrieval/run.sh
```

```
ALICE (org handbook + her roadmap; NOT comp):
  • [Company Handbook]  Acme builds privacy-first AI infrastructure…
  • [Eng Roadmap]       Q3 roadmap: ship the permission-aware retrieval engine…

BOB (org handbook + his comp; NOT roadmap):
  • [Company Handbook]  Acme builds privacy-first AI infrastructure…
  • [Comp Bands]        Compensation bands for 2026. Senior engineers: 180-220k…
```

Той самий запит, різні результати - бо граф ACL формує набір кандидатів *перш ніж* звернутися до векторного індексу. Повний посібник: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Інструменти, доступні через MCP

| Інструмент | Призначення |
|---|---|
| `context_ingest` | Зберігає текст → вузол запису + **ребра прав** (ACL) + **векторні фрагменти** + **видобутий граф понять** |
| `get_context` | Повертає ранжовані, цитовані та відфільтровані за правами фрагменти |
| `context_graph` | Повертає граф знань (поняття + зв'язки), доступний користувачеві |

## Запуск

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Використовуйте з будь-якого клієнта MCP

```jsonc
{
  "mcp": {
    "context": {
      "type": "local",
      "command": ["bun", "run", "/path/to/chitta/src/mcp/server.ts"],
      "environment": { "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme" }
    }
  }
}
```

**Центральний офіс:** додайте URL спільного бекенда, щоб усі запитували один граф із ACL для кожного користувача:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Як це працює

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Сховище (локальний режим)

Один файл за шляхом `$CONTEXT_DB` або `~/.local/share/100xprompt/context.db`:
- `nodes` - вершини графа (записи, користувачі, організації, **сутності**)
- `edges` - зв'язки (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - текст + вектори ембедингів
- `vec_chunks` - **ANN-індекс sqlite-vec** (коли доступний - див. нижче)

## Векторний пошук - адаптивний (sqlite-vec, у процесі)

Якщо доступний SQLite з підтримкою розширень, сховище завантажує **[sqlite-vec](https://github.com/asg017/sqlite-vec)** і тримає ANN-індекс `vec0` *у тому самому файлі* - нативно на TypeScript, без Python. Приблизно в 16× швидше за повний перебір на 3000 векторах, і тим більше зі зростанням масштабу.

Інакше він **прозоро повертається до косинуса повним перебором** - ті самі результати, той самий інтерфейс і повна переносимість для єдиного бінарника. `bun:sqlite` типово вимикає завантаження розширень; щоб увімкнути швидкий шлях ANN, вкажіть SQLite із розширеннями (напр. `brew install sqlite`, автовизначення за типовими шляхами). Налаштування не потрібні - `store.vecEnabled` відображає активний шлях.

## Статус

Реалізовано: граф ACL, векторне сховище, пошук + захист від витоку, **видобування графа знань**, сервер MCP (локальний + центральний) та адаптери Arango/Qdrant/ембедингів на основі fetch. Жодних залежностей, окрім MCP SDK.

Далі (взаємозамінне, той самий інтерфейс): справжні ембединги (transformers.js ONNX `bge-*`) для семантичного ранжування; пошук GraphRAG (розширення результатів уздовж ребер `relates_to`); видобування сутностей на основі LLM для вищої повноти.

Подробиці помодульно та інваріант безпеки див. у [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Документація

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - конвеєр, карта модулів, інваріант безпеки та розширення
- [examples/](../../examples/) - запускні приклади
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - налаштування розробки та робочий процес
- [SECURITY.md](../../SECURITY.md) - модель безпеки та як повідомляти про проблеми
- [CHANGELOG.md](../../CHANGELOG.md) - помітні зміни

## Ліцензія

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
