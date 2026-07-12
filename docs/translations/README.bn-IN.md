# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.ko-KR.md">한국어</a> ·
  <a href="README.hi-IN.md">हिन्दी</a> ·
  <b>বাংলা</b> ·
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

> এটি একটি অনুবাদ। কোনো অমিল থাকলে [English](../../README.md) মূলটিই প্রাধান্য পাবে।

অনুমতি-সচেতন **নলেজ গ্রাফ + ভেক্টর মেমরি**, একটি স্বতন্ত্র **MCP সার্ভার** হিসেবে সরবরাহ করা হয়।
যেকোনো MCP ক্লায়েন্ট (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) কেবল কনফিগারেশনের মাধ্যমে এটি ব্যবহার করে - কোনো কোড পরিবর্তন ছাড়াই।

আপনার AI সহকারীকে একবার যুক্ত করুন, এরপর প্রতিটি কথোপকথন আপনার দলের জ্ঞান **সংরক্ষণ, স্মরণ ও তার উপর যুক্তি** করতে পারবে - যেখানে প্রতিটি ব্যবহারকারী কেবল তার অনুমতি অনুযায়ী যা দেখার কথা তা-ই দেখে।

> **আর্কিটেকচার ও অভ্যন্তরীণ বিবরণ:** দেখুন [ARCHITECTURE.md](../../ARCHITECTURE.md)।

- **লোকাল মোড (ডিফল্ট):** একটিমাত্র SQLite ফাইল। ইনজেস্ট, নলেজ গ্রাফ নিষ্কাশন ও পুনরুদ্ধার - কোনো সার্ভার ছাড়াই।
- **সেন্ট্রাল-অফিস মোড:** env-এর মাধ্যমে একটি শেয়ারড ব্যাকএন্ডে (ArangoDB + Qdrant + এমবেডিং) নির্দেশ করুন; পুরো প্রতিষ্ঠান একটি গ্রাফ ভাগ করে নেয়, এবং প্রতিটি ব্যবহারকারী কেবল তার ACL যা অনুমতি দেয় তা-ই দেখে।

## ৩০ সেকেন্ডে দেখুন

দুজন ব্যবহারকারী, একটি স্টোর, তিনটি নথি - প্রত্যেকে কেবল অনুমোদিত অংশটুকুই দেখেন:

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

একই প্রশ্ন, ভিন্ন ফলাফল - কারণ ভেক্টর ইনডেক্স স্পর্শ করার *আগেই* ACL গ্রাফ প্রার্থী-সেট তৈরি করে। সম্পূর্ণ নির্দেশিকা: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)।

## MCP-এর মাধ্যমে উন্মুক্ত টুল

| টুল | কাজ |
|---|---|
| `context_ingest` | টেক্সট সংরক্ষণ → রেকর্ড নোড + **অনুমতি প্রান্ত** (ACL) + **ভেক্টর খণ্ড** + **নিষ্কাশিত ধারণা গ্রাফ** |
| `get_context` | র‍্যাঙ্ককৃত, উদ্ধৃত ও অনুমতি-ফিল্টারকৃত অংশ পুনরুদ্ধার করে |
| `context_graph` | ব্যবহারকারী যে নলেজ গ্রাফে (ধারণা + সম্পর্ক) প্রবেশাধিকার রাখেন তা ফেরত দেয় |

## চালান

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## যেকোনো MCP ক্লায়েন্ট থেকে ব্যবহার করুন

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

**সেন্ট্রাল অফিস:** শেয়ারড ব্যাকএন্ডের URL যোগ করুন যাতে সবাই প্রতি-ব্যবহারকারী ACL সহ একটিই গ্রাফে কোয়েরি করে:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## এটি কীভাবে কাজ করে

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## সংরক্ষণ (লোকাল মোড)

`$CONTEXT_DB` অথবা `~/.local/share/100xprompt/context.db`-এ একটি ফাইল:
- `nodes` - গ্রাফ শীর্ষবিন্দু (রেকর্ড, ব্যবহারকারী, প্রতিষ্ঠান, **সত্তা**)
- `edges` - সম্পর্ক (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - টেক্সট + এমবেডিং ভেক্টর
- `vec_chunks` - **sqlite-vec ANN ইনডেক্স** (যখন উপলব্ধ - নিচে দেখুন)

## ভেক্টর অনুসন্ধান - অভিযোজী (sqlite-vec, ইন-প্রসেস)

এক্সটেনশন-সক্ষম SQLite থাকলে স্টোর **[sqlite-vec](https://github.com/asg017/sqlite-vec)** লোড করে এবং *একই ফাইলে* একটি `vec0` ANN ইনডেক্স রাখে - TypeScript-নেটিভ, Python ছাড়াই। ৩০০০ ভেক্টরে ব্রুট-ফোর্সের চেয়ে প্রায় ১৬× দ্রুত, এবং বড় স্কেলে আরও বেশি।

অন্যথায় এটি **স্বচ্ছভাবে ব্রুট-ফোর্স কোসাইনে ফিরে যায়** - একই ফলাফল, একই ইন্টারফেস এবং সিঙ্গল-বাইনারি পথের জন্য সম্পূর্ণ পোর্টেবল। `bun:sqlite` ডিফল্টভাবে এক্সটেনশন লোডিং নিষ্ক্রিয় রাখে; ANN ফাস্ট-পাথ সক্রিয় করতে এটিকে একটি এক্সটেনশন-সক্ষম SQLite-এ নির্দেশ করুন (যেমন `brew install sqlite`, সাধারণ পথে স্বয়ংক্রিয়ভাবে শনাক্ত হয়)। কোনো কনফিগারেশন লাগে না - `store.vecEnabled` সক্রিয় পথটি নির্দেশ করে।

## অবস্থা

বাস্তবায়িত: ACL গ্রাফ, ভেক্টর স্টোর, পুনরুদ্ধার + লিক গার্ড, **নলেজ-গ্রাফ নিষ্কাশন**, MCP সার্ভার (লোকাল + সেন্ট্রাল), এবং fetch-ভিত্তিক Arango/Qdrant/এমবেডিং অ্যাডাপ্টার। MCP SDK ছাড়া কোনো নির্ভরতা নেই।

পরবর্তী (একই ইন্টারফেসে অদলবদলযোগ্য): সিম্যান্টিক র‍্যাঙ্কিংয়ের জন্য প্রকৃত এমবেডিং (transformers.js ONNX `bge-*`); GraphRAG পুনরুদ্ধার (`relates_to` প্রান্ত বরাবর ফলাফল সম্প্রসারণ); উচ্চতর রিকলের জন্য LLM-ভিত্তিক সত্তা নিষ্কাশন।

মডিউল-অনুযায়ী অভ্যন্তরীণ বিবরণ ও নিরাপত্তা অপরিবর্তনীয়ের জন্য [ARCHITECTURE.md](../../ARCHITECTURE.md) দেখুন।

## ডকুমেন্টেশন

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - পাইপলাইন, মডিউল ম্যাপ, নিরাপত্তা অপরিবর্তনীয় ও সম্প্রসারণ
- [examples/](../../examples/) - চালানোযোগ্য ডেমো
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - ডেভ সেটআপ ও ওয়ার্কফ্লো
- [SECURITY.md](../../SECURITY.md) - নিরাপত্তা মডেল ও সমস্যা জানানোর উপায়
- [CHANGELOG.md](../../CHANGELOG.md) - উল্লেখযোগ্য পরিবর্তন

## লাইসেন্স

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
