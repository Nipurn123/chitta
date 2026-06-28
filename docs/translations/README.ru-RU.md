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
  <b>Русский</b> ·
  <a href="README.ar-SA.md">العربية</a> ·
  <a href="README.fa-IR.md">فارسی</a> ·
  <a href="README.it-IT.md">Italiano</a> ·
  <a href="README.tr-TR.md">Türkçe</a> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.id-ID.md">Bahasa Indonesia</a> ·
  <a href="README.pl-PL.md">Polski</a> ·
  <a href="README.uk-UA.md">Українська</a> ·
  <a href="README.nl-NL.md">Nederlands</a> ·
  <a href="README.th-TH.md">ภาษาไทย</a>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-124%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

> Это перевод. При расхождениях приоритет имеет оригинал [English](../../README.md).

**Граф знаний + векторная память** с учётом прав доступа, поставляется как автономный **MCP-сервер**.
Любой MCP-клиент (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) использует его через конфигурацию - без изменения кода.

Подключите ИИ-ассистента один раз - и каждый диалог сможет **сохранять, вспоминать и рассуждать** о знаниях вашей команды, причём каждый пользователь видит только то, что разрешают его права.

> **Архитектура и внутреннее устройство:** см. [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Локальный режим (по умолчанию):** один файл SQLite. Приём данных, извлечение графа знаний, поиск - без серверов.
- **Режим центрального офиса:** через переменные окружения укажите общий бэкенд (ArangoDB + Qdrant + эмбеддинги); вся организация делит один граф, и каждый пользователь видит только то, что разрешает его ACL.

## Посмотрите за 30 секунд

Два пользователя, одно хранилище, три документа - каждый видит только то, что ему разрешено:

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

Один и тот же запрос, разные результаты - потому что граф ACL формирует набор кандидатов *до* обращения к векторному индексу. Полное руководство: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Инструменты, доступные через MCP

| Инструмент | Что делает |
|---|---|
| `context_ingest` | Сохраняет текст → узел записи + **рёбра прав доступа** (ACL) + **векторные фрагменты** + **извлечённый граф понятий** |
| `get_context` | Возвращает ранжированные, цитируемые и отфильтрованные по правам фрагменты |
| `context_graph` | Возвращает граф знаний (понятия + связи), доступный пользователю |

## Запуск

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Используйте из любого MCP-клиента

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

**Центральный офис:** добавьте URL общего бэкенда, чтобы все обращались к одному графу с ACL по пользователям:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Как это работает

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Хранилище (локальный режим)

Один файл по пути `$CONTEXT_DB` или `~/.local/share/100xprompt/context.db`:
- `nodes` - вершины графа (записи, пользователи, организации, **сущности**)
- `edges` - связи (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - текст + векторы эмбеддингов
- `vec_chunks` - **ANN-индекс sqlite-vec** (если доступен - см. ниже)

## Векторный поиск - адаптивный (sqlite-vec, внутри процесса)

Если доступен SQLite с поддержкой расширений, хранилище загружает **[sqlite-vec](https://github.com/asg017/sqlite-vec)** и держит ANN-индекс `vec0` *в том же файле* - нативно на TypeScript, без Python. Примерно в 16 раз быстрее полного перебора на 3000 векторах и тем больше, чем больше масштаб.

Иначе он **прозрачно переходит к косинусному полному перебору** - те же результаты, тот же интерфейс, полностью переносимо для единого бинарника. `bun:sqlite` по умолчанию отключает загрузку расширений; чтобы включить быстрый путь ANN, укажите SQLite с расширениями (например, `brew install sqlite`, автоопределение по типичным путям). Настройка не требуется - `store.vecEnabled` отражает активный путь.

## Статус

Реализовано: граф ACL, векторное хранилище, поиск + защита от утечек, **извлечение графа знаний**, MCP-сервер (локальный + центральный), адаптеры Arango/Qdrant/эмбеддингов на основе fetch. Никаких зависимостей, кроме MCP SDK.

Далее (взаимозаменяемо, тот же интерфейс): настоящие эмбеддинги (transformers.js ONNX `bge-*`) для семантического ранжирования; поиск GraphRAG (расширение результатов по рёбрам `relates_to`); извлечение сущностей на основе LLM для большей полноты.

Подробности по модулям и инвариант безопасности см. в [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Документация

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - конвейер, карта модулей, инвариант безопасности, расширение
- [examples/](../../examples/) - запускаемые примеры
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - настройка разработки и рабочий процесс
- [SECURITY.md](../../SECURITY.md) - модель безопасности и как сообщать о проблемах
- [CHANGELOG.md](../../CHANGELOG.md) - значимые изменения

## Лицензия

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
