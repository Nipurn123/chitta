# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <b>繁體中文</b> ·
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

> 本文件為翻譯版本。以 [English](../../README.md) 原文為準。

權限感知的**知識圖譜 + 向量記憶**，以獨立的 **MCP 伺服器**形式提供。
任何 MCP 用戶端（Claude Code、100xprompt、Claude Desktop、Cursor、各類 IDE）只需設定即可使用，無需改動程式碼。

只需讓你的 AI 助理接入一次，每次對話都能**儲存、回憶並推理**團隊的知識--而每位使用者只能看到其權限允許的內容。

> **架構與內部實作：** 參見 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

- **本機模式（預設）：** 單一 SQLite 檔案。擷取、抽取知識圖譜、檢索--無需任何伺服器。
- **中央辦公模式：** 透過環境變數指向共用後端（ArangoDB + Qdrant + 嵌入服務）；全組織共用一張圖，每位使用者只看到其 ACL 允許的內容。

## 30 秒看懂

兩位使用者、一個儲存、三份文件--每位使用者只能看到被授權的內容：

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

相同的查詢，不同的結果--因為 ACL 圖譜會在觸及向量索引**之前**先決定候選集。完整示範：[examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)。

## 透過 MCP 公開的工具

| 工具 | 作用 |
|---|---|
| `context_ingest` | 儲存文字 → 記錄節點 + **權限邊**（ACL）+ **向量分塊** + **抽取的概念圖譜** |
| `get_context` | 檢索經過排序、帶引用、依權限過濾的片段 |
| `context_graph` | 回傳該使用者有權存取的知識圖譜（概念 + 關係） |

## 執行

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## 在任意 MCP 用戶端中使用

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

**中央辦公：** 加上共用後端的 URL，讓所有人查詢同一張圖，並依使用者套用 ACL：

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## 運作原理

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## 儲存（本機模式）

位於 `$CONTEXT_DB` 或 `~/.local/share/100xprompt/context.db` 的單一檔案：
- `nodes` - 圖頂點（記錄、使用者、組織、**實體**）
- `edges` - 關係（`permissions`、`belongsTo`、`mentions`、`relates_to`）
- `chunks` - 文字 + 嵌入向量
- `vec_chunks` - **sqlite-vec ANN 索引**（可用時--見下文）

## 向量檢索--自適應（sqlite-vec，行程內）

若存在支援擴充功能的 SQLite，儲存層會載入 **[sqlite-vec](https://github.com/asg017/sqlite-vec)**，並在*同一檔案內*維護一個 `vec0` ANN 索引--純 TypeScript、無需 Python。在 3000 筆向量時約比暴力檢索快 16 倍，規模越大優勢越明顯。

否則它會**透明地回退到暴力餘弦檢索**--結果相同、介面相同，完全適配單一執行檔的部署路徑。`bun:sqlite` 預設停用擴充功能載入；要啟用 ANN 快路徑，請將其指向支援擴充功能的 SQLite（例如 `brew install sqlite`，會在常見路徑自動偵測）。無需設定--`store.vecEnabled` 反映目前生效的路徑。

## 狀態

已實作：ACL 圖譜、向量儲存、檢索 + 洩漏防護、**知識圖譜抽取**、MCP 伺服器（本機 + 中央）、基於 fetch 的 Arango/Qdrant/嵌入轉接器。除 MCP SDK 外無任何相依套件。

後續（可直接替換，介面不變）：用於語意排序的真實嵌入（transformers.js ONNX `bge-*`）；GraphRAG 檢索（沿 `relates_to` 邊擴展結果）；基於 LLM 的實體抽取以提升召回。

模組層級的內部實作與安全不變量參見 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

## 文件

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - 流程、模組圖、安全不變量、擴充方式
- [examples/](../../examples/) - 可執行的範例
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - 開發環境與工作流程
- [SECURITY.md](../../SECURITY.md) - 安全模型與漏洞回報方式
- [CHANGELOG.md](../../CHANGELOG.md) - 重要變更

## 授權條款

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
