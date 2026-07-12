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
  <b>العربية</b> ·
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

> هذه ترجمة. عند وجود اختلاف، يُعتمد الأصل [English](../../README.md).

**رسم بياني للمعرفة + ذاكرة متجهية** واعٍ بالصلاحيات، يُقدَّم كخادم **MCP** مستقل.
أي عميل MCP (Claude Code وClaude Desktop و100xprompt وCursor وبيئات التطوير) يستخدمه عبر الإعداد فقط - دون تغيير الكود.

اربط مساعدك الذكي مرة واحدة، فتصبح كل محادثة قادرة على **تخزين معرفة فريقك واستحضارها والاستدلال عليها** - مع رؤية كل مستخدم لما تسمح به صلاحياته فقط.

> **البنية والتفاصيل الداخلية:** راجع [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **الوضع المحلي (افتراضي):** ملف SQLite واحد. الاستيعاب واستخراج رسم المعرفة والاسترجاع - دون أي خوادم.
- **وضع المكتب المركزي:** وجِّهه عبر متغيرات البيئة إلى خلفية مشتركة (ArangoDB + Qdrant + التضمينات)؛ تتشارك المؤسسة كلها رسمًا واحدًا، ويرى كل مستخدم ما تسمح به قائمة التحكم بالوصول (ACL) الخاصة به فقط.

## شاهده في 30 ثانية

مستخدمان، ومخزن واحد، وثلاث وثائق - يرى كل مستخدم ما هو مسموح له فقط:

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

الاستعلام نفسه، نتائج مختلفة - لأن رسم ACL ينتج مجموعة المرشحين *قبل* لمس الفهرس المتجهي. الشرح الكامل: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## الأدوات المتاحة عبر MCP

| الأداة | الوظيفة |
|---|---|
| `context_ingest` | تخزين النص ← عقدة سجل + **حواف صلاحيات** (ACL) + **مقاطع متجهية** + **رسم مفاهيم مُستخرَج** |
| `get_context` | استرجاع مقاطع مرتّبة وموثّقة ومُرشَّحة حسب الصلاحيات |
| `context_graph` | إرجاع رسم المعرفة (المفاهيم + العلاقات) الذي يمكن للمستخدم الوصول إليه |

## التشغيل

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## استخدمه من أي عميل MCP

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

**المكتب المركزي:** أضِف روابط الخلفية المشتركة ليستعلم الجميع عن رسم واحد مع ACL لكل مستخدم:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## كيف يعمل

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## التخزين (الوضع المحلي)

ملف واحد في `$CONTEXT_DB` أو `~/.local/share/100xprompt/context.db`:
- `nodes` - رؤوس الرسم (السجلات، المستخدمون، المؤسسات، **الكيانات**)
- `edges` - العلاقات (`permissions`، `belongsTo`، `mentions`، `relates_to`)
- `chunks` - نص + متجهات تضمين
- `vec_chunks` - **فهرس ANN الخاص بـ sqlite-vec** (عند توفّره - انظر أدناه)

## البحث المتجهي - تكيّفي (sqlite-vec، داخل العملية)

في حال توفّر SQLite يدعم الإضافات، يحمّل المخزن **[sqlite-vec](https://github.com/asg017/sqlite-vec)** ويحتفظ بفهرس ANN من نوع `vec0` *في الملف نفسه* - أصيل في TypeScript ودون Python. أسرع نحو 16 مرة من البحث الشامل عند 3000 متجه، وأكثر كلما زاد الحجم.

وإلا فإنه **يعود بشفافية إلى جيب التمام بالبحث الشامل** - النتائج نفسها والواجهة نفسها، ومحمول بالكامل لمسار الملف التنفيذي الواحد. يعطّل `bun:sqlite` تحميل الإضافات افتراضيًا؛ ولتفعيل المسار السريع لـ ANN وجِّهه إلى SQLite يدعم الإضافات (مثل `brew install sqlite`، يُكتشف تلقائيًا في المسارات الشائعة). لا حاجة لأي إعداد - يعكس `store.vecEnabled` المسار الفعّال.

## الحالة

مُنفَّذ: رسم ACL، ومخزن متجهي، واسترجاع + حارس تسرّب، و**استخراج رسم المعرفة**، وخادم MCP (محلي + مركزي)، ومحوّلات Arango/Qdrant/التضمين المبنية على fetch. دون أي اعتماديات سوى MCP SDK.

التالي (قابل للاستبدال بالواجهة نفسها): تضمينات حقيقية (transformers.js ONNX `bge-*`) للترتيب الدلالي؛ واسترجاع GraphRAG (توسيع النتائج عبر حواف `relates_to`)؛ واستخراج الكيانات بالاعتماد على LLM لتحسين الاستدعاء.

راجع [ARCHITECTURE.md](../../ARCHITECTURE.md) للتفاصيل الداخلية وحدة بوحدة وثابت الأمان.

## التوثيق

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - خط المعالجة، وخريطة الوحدات، وثابت الأمان، وكيفية التوسيع
- [examples/](../../examples/) - أمثلة قابلة للتشغيل
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - إعداد التطوير وسير العمل
- [SECURITY.md](../../SECURITY.md) - نموذج الأمان وكيفية الإبلاغ عن المشكلات
- [CHANGELOG.md](../../CHANGELOG.md) - أبرز التغييرات

## الترخيص

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
