# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <b>简体中文</b> ·
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

> 本文档为翻译版本。以 [English](../../README.md) 原文为准。

权限感知的**知识图谱 + 向量记忆**，以独立的 **MCP 服务器**形式提供。
任何 MCP 客户端（Claude Code、100xprompt、Claude Desktop、Cursor、各类 IDE）只需配置即可使用，无需改动代码。

只需让你的 AI 助手接入一次，每次对话都能**存储、回忆并推理**团队的知识--而每个用户只能看到其权限允许的内容。

> **架构与内部实现：** 参见 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

- **本地模式（默认）：** 单个 SQLite 文件。摄取、抽取知识图谱、检索--无需任何服务器。
- **中心办公模式：** 通过环境变量指向共享后端（ArangoDB + Qdrant + 嵌入服务）；全组织共享一张图，每个用户只看到其 ACL 允许的内容。

## 30 秒看懂

两个用户、一个存储、三份文档--每个用户只能看到被授权的内容：

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

相同的查询，不同的结果--因为 ACL 图谱会在触及向量索引**之前**先确定候选集。完整演示：[examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)。

## 通过 MCP 暴露的工具

| 工具 | 作用 |
|---|---|
| `context_ingest` | 存储文本 → 记录节点 + **权限边**（ACL）+ **向量分块** + **抽取的概念图谱** |
| `get_context` | 检索经过排序、带引用、按权限过滤的片段 |
| `context_graph` | 返回该用户有权访问的知识图谱（概念 + 关系） |

## 运行

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## 在任意 MCP 客户端中使用

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

**中心办公：** 加上共享后端的 URL，让所有人查询同一张图，并按用户应用 ACL：

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## 工作原理

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## 存储（本地模式）

位于 `$CONTEXT_DB` 或 `~/.local/share/100xprompt/context.db` 的单个文件：
- `nodes` - 图顶点（记录、用户、组织、**实体**）
- `edges` - 关系（`permissions`、`belongsTo`、`mentions`、`relates_to`）
- `chunks` - 文本 + 嵌入向量
- `vec_chunks` - **sqlite-vec ANN 索引**（在可用时--见下文）

## 向量检索--自适应（sqlite-vec，进程内）

如果存在支持扩展的 SQLite，存储层会加载 **[sqlite-vec](https://github.com/asg017/sqlite-vec)**，并在*同一文件内*维护一个 `vec0` ANN 索引--纯 TypeScript、无需 Python。在 3000 条向量时约比暴力检索快 16 倍，规模越大优势越明显。

否则它会**透明地回退到暴力余弦检索**--结果相同、接口相同，完全适配单二进制部署路径。`bun:sqlite` 默认禁用扩展加载；要启用 ANN 快路径，请将其指向支持扩展的 SQLite（例如 `brew install sqlite`，会在常见路径自动检测）。无需配置--`store.vecEnabled` 反映当前生效的路径。

## 状态

已实现：ACL 图谱、向量存储、检索 + 泄漏防护、**知识图谱抽取**、MCP 服务器（本地 + 中心）、基于 fetch 的 Arango/Qdrant/嵌入适配器。除 MCP SDK 外无任何依赖。

后续（可直接替换，接口不变）：用于语义排序的真实嵌入（transformers.js ONNX `bge-*`）；GraphRAG 检索（沿 `relates_to` 边扩展结果）；基于 LLM 的实体抽取以提升召回。

模块级内部实现与安全不变量参见 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

## 文档

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - 流程、模块图、安全不变量、扩展方式
- [examples/](../../examples/) - 可运行的示例
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - 开发环境与工作流
- [SECURITY.md](../../SECURITY.md) - 安全模型与漏洞上报方式
- [CHANGELOG.md](../../CHANGELOG.md) - 重要变更

## 许可证

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
