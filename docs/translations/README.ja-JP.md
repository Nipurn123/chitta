# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <b>日本語</b> ·
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

> これは翻訳版です。内容に差異がある場合は [English](../../README.md) 原文が優先されます。

権限を意識した**ナレッジグラフ + ベクトルメモリ**を、単体の **MCP サーバー**として提供します。
あらゆる MCP クライアント（Claude Code、100xprompt、Claude Desktop、Cursor、各種 IDE）が設定だけで利用でき、コード変更は不要です。

AI アシスタントに一度つなぐだけで、すべての会話がチームの知識を**保存・想起・推論**できるようになります。しかも各ユーザーには権限で許可された範囲しか見えません。

> **アーキテクチャと内部構造：** [ARCHITECTURE.md](../../ARCHITECTURE.md) を参照してください。

- **ローカルモード（既定）：** SQLite ファイル 1 つ。取り込み、ナレッジグラフ抽出、検索まで--サーバー不要。
- **セントラルオフィスモード：** 環境変数で共有バックエンド（ArangoDB + Qdrant + 埋め込み）を指定。組織全体が 1 つのグラフを共有し、各ユーザーは ACL が許可する範囲だけを見ます。

## 30 秒でわかる

2 人のユーザー、1 つのストア、3 つのドキュメント--各ユーザーには許可された分だけが見えます：

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

同じクエリでも結果が異なります--ACL グラフがベクトルインデックスに触れる**前に**候補集合を決めるからです。詳しい手順：[examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)。

## MCP で公開されるツール

| ツール | 機能 |
|---|---|
| `context_ingest` | テキストを保存 → レコードノード + **権限エッジ**（ACL）+ **ベクトルチャンク** + **抽出した概念グラフ** |
| `get_context` | ランク付け・引用付き・権限フィルタ済みのスニペットを取得 |
| `context_graph` | そのユーザーがアクセスできるナレッジグラフ（概念 + 関係）を返す |

## 実行する

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## 任意の MCP クライアントから使う

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

**セントラルオフィス：** 共有バックエンドの URL を追加すれば、全員が 1 つのグラフを、ユーザーごとの ACL 付きで検索できます：

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## 仕組み

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## ストレージ（ローカルモード）

`$CONTEXT_DB` または `~/.local/share/100xprompt/context.db` にある 1 ファイル：
- `nodes` - グラフの頂点（レコード、ユーザー、組織、**エンティティ**）
- `edges` - 関係（`permissions`、`belongsTo`、`mentions`、`relates_to`）
- `chunks` - テキスト + 埋め込みベクトル
- `vec_chunks` - **sqlite-vec ANN インデックス**（利用可能な場合--下記参照）

## ベクトル検索--適応型（sqlite-vec、プロセス内）

拡張機能に対応した SQLite があれば、ストアは **[sqlite-vec](https://github.com/asg017/sqlite-vec)** を読み込み、*同じファイル内*に `vec0` ANN インデックスを保持します--TypeScript ネイティブで Python 不要。3,000 ベクトルで総当たりより約 16 倍高速、規模が大きいほど差が広がります。

それ以外の場合は**透過的に総当たりのコサイン検索へフォールバック**します--結果も同じ、インターフェースも同じで、単一バイナリ運用にも完全対応。`bun:sqlite` は既定で拡張機能の読み込みを無効にしています。ANN 高速経路を有効にするには、拡張機能対応の SQLite を指定してください（例：`brew install sqlite`、一般的なパスを自動検出）。設定は不要で、`store.vecEnabled` が現在有効な経路を示します。

## ステータス

実装済み：ACL グラフ、ベクトルストア、検索 + リーク防止、**ナレッジグラフ抽出**、MCP サーバー（ローカル + セントラル）、fetch ベースの Arango/Qdrant/埋め込みアダプター。MCP SDK 以外の依存はありません。

今後（同じインターフェースで差し替え可能）：意味的ランキング向けの本物の埋め込み（transformers.js ONNX `bge-*`）；GraphRAG 検索（`relates_to` エッジに沿って結果を拡張）；再現率を高める LLM ベースのエンティティ抽出。

モジュール単位の内部構造とセキュリティ不変条件は [ARCHITECTURE.md](../../ARCHITECTURE.md) を参照してください。

## ドキュメント

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - パイプライン、モジュール構成、セキュリティ不変条件、拡張方法
- [examples/](../../examples/) - 実行可能なデモ
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - 開発環境とワークフロー
- [SECURITY.md](../../SECURITY.md) - セキュリティモデルと報告方法
- [CHANGELOG.md](../../CHANGELOG.md) - 主な変更点

## ライセンス

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
