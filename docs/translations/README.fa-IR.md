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
  <b>فارسی</b> ·
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

> این یک ترجمه است. در صورت مغایرت، نسخهٔ اصلی [English](../../README.md) معتبر است.

**گراف دانش + حافظهٔ برداری** آگاه به مجوز، که به‌صورت یک **سرور MCP** مستقل ارائه می‌شود.
هر کلاینت MCP (Claude Code، 100xprompt، Claude Desktop، Cursor، محیط‌های توسعه) آن را تنها با پیکربندی استفاده می‌کند - بدون تغییر کد.

دستیار هوش مصنوعی خود را یک‌بار متصل کنید تا هر گفتگو بتواند دانش تیم شما را **ذخیره، یادآوری و بر پایهٔ آن استدلال** کند - و هر کاربر تنها چیزی را ببیند که مجوزهایش اجازه می‌دهد.

> **معماری و جزئیات درونی:** به [ARCHITECTURE.md](../../ARCHITECTURE.md) مراجعه کنید.

- **حالت محلی (پیش‌فرض):** یک فایل SQLite. دریافت، استخراج گراف دانش و بازیابی - بدون هیچ سروری.
- **حالت دفتر مرکزی:** از طریق متغیرهای محیطی آن را به یک بک‌اند مشترک (ArangoDB + Qdrant + امبدینگ) متصل کنید؛ کل سازمان یک گراف مشترک دارد و هر کاربر تنها چیزی را می‌بیند که ACL او اجازه می‌دهد.

## در ۳۰ ثانیه ببینید

دو کاربر، یک مخزن، سه سند - هر کاربر فقط آنچه مجاز است می‌بیند:

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

یک پرس‌وجو، نتایج متفاوت - زیرا گراف ACL مجموعهٔ نامزدها را *پیش از* دست‌زدن به نمایهٔ برداری می‌سازد. راهنمای کامل: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## ابزارهای ارائه‌شده از طریق MCP

| ابزار | کارکرد |
|---|---|
| `context_ingest` | ذخیرهٔ متن ← گرهٔ رکورد + **یال‌های مجوز** (ACL) + **قطعات برداری** + **گراف مفاهیم استخراج‌شده** |
| `get_context` | بازیابی قطعات رتبه‌بندی‌شده، استنادشده و فیلترشده بر اساس مجوز |
| `context_graph` | بازگرداندن گراف دانش (مفاهیم + روابط) که کاربر به آن دسترسی دارد |

## اجرا

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## از هر کلاینت MCP استفاده کنید

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

**دفتر مرکزی:** نشانی‌های بک‌اند مشترک را اضافه کنید تا همه یک گراف واحد را با ACL به‌ازای هر کاربر پرس‌وجو کنند:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## چگونه کار می‌کند

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## ذخیره‌سازی (حالت محلی)

یک فایل در مسیر `$CONTEXT_DB` یا `~/.local/share/100xprompt/context.db`:
- `nodes` - رأس‌های گراف (رکوردها، کاربران، سازمان‌ها، **موجودیت‌ها**)
- `edges` - روابط (`permissions`، `belongsTo`، `mentions`، `relates_to`)
- `chunks` - متن + بردارهای امبدینگ
- `vec_chunks` - **نمایهٔ ANN مربوط به sqlite-vec** (هنگام در دسترس بودن - پایین را ببینید)

## جست‌وجوی برداری - تطبیقی (sqlite-vec، درون‌پردازشی)

اگر یک SQLite با پشتیبانی از افزونه موجود باشد، مخزن **[sqlite-vec](https://github.com/asg017/sqlite-vec)** را بارگذاری می‌کند و یک نمایهٔ ANN از نوع `vec0` را *در همان فایل* نگه می‌دارد - بومیِ TypeScript و بدون Python. در ۳۰۰۰ بردار حدود ۱۶ برابر سریع‌تر از جست‌وجوی فراگیر، و در مقیاس بزرگ‌تر بیشتر.

در غیر این صورت **به‌صورت شفاف به کسینوسِ فراگیر بازمی‌گردد** - همان نتایج، همان رابط، و کاملاً قابل‌حمل برای مسیر تک‌فایل اجرایی. `bun:sqlite` به‌طور پیش‌فرض بارگذاری افزونه‌ها را غیرفعال می‌کند؛ برای فعال‌سازی مسیر سریع ANN، آن را به یک SQLite با افزونه اشاره دهید (مثلاً `brew install sqlite`، که در مسیرهای رایج به‌طور خودکار شناسایی می‌شود). بدون نیاز به پیکربندی - `store.vecEnabled` مسیر فعال را نشان می‌دهد.

## وضعیت

پیاده‌سازی‌شده: گراف ACL، مخزن برداری، بازیابی + محافظ نشت، **استخراج گراف دانش**، سرور MCP (محلی + مرکزی) و آداپتورهای Arango/Qdrant/امبدینگ مبتنی بر fetch. بدون هیچ وابستگی به‌جز MCP SDK.

بعدی (قابل‌تعویض، با همان رابط): امبدینگ‌های واقعی (transformers.js ONNX `bge-*`) برای رتبه‌بندی معنایی؛ بازیابی GraphRAG (گسترش نتایج در امتداد یال‌های `relates_to`)؛ استخراج موجودیت مبتنی بر LLM برای فراخوانی بیشتر.

برای جزئیات ماژول‌به‌ماژول و ناوردای امنیتی به [ARCHITECTURE.md](../../ARCHITECTURE.md) مراجعه کنید.

## مستندات

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - خط لوله، نقشهٔ ماژول‌ها، ناوردای امنیتی و گسترش
- [examples/](../../examples/) - دموهای قابل‌اجرا
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - راه‌اندازی توسعه و گردش کار
- [SECURITY.md](../../SECURITY.md) - مدل امنیتی و نحوهٔ گزارش مشکلات
- [CHANGELOG.md](../../CHANGELOG.md) - تغییرات مهم

## مجوز

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
