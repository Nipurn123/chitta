# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.ko-KR.md">한국어</a> ·
  <b>हिन्दी</b> ·
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

> यह एक अनुवाद है। किसी भी भिन्नता की स्थिति में [English](../../README.md) मूल मान्य होगा।

अनुमति-सजग **नॉलेज ग्राफ़ + वेक्टर मेमोरी**, एक स्वतंत्र **MCP सर्वर** के रूप में।
कोई भी MCP क्लाइंट (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) इसे केवल कॉन्फ़िगरेशन से उपयोग करता है - कोड में कोई बदलाव नहीं।

अपने AI असिस्टेंट को एक बार जोड़ें, और हर बातचीत आपकी टीम के ज्ञान को **संग्रहीत, स्मरण और तर्क** कर सकेगी - जहाँ हर उपयोगकर्ता केवल वही देखता है जिसकी उसकी अनुमति है।

> **आर्किटेक्चर और आंतरिक विवरण:** देखें [ARCHITECTURE.md](../../ARCHITECTURE.md)।

- **लोकल मोड (डिफ़ॉल्ट):** एक ही SQLite फ़ाइल। इन्जेस्ट, नॉलेज ग्राफ़ निष्कर्षण, पुनर्प्राप्ति - बिना किसी सर्वर के।
- **सेंट्रल-ऑफ़िस मोड:** env के ज़रिए इसे साझा बैकएंड (ArangoDB + Qdrant + एम्बेडिंग) की ओर इंगित करें; पूरा संगठन एक ही ग्राफ़ साझा करता है, और हर उपयोगकर्ता केवल वही देखता है जिसकी उसकी ACL अनुमति देती है।

## 30 सेकंड में देखें

दो उपयोगकर्ता, एक स्टोर, तीन दस्तावेज़ - हर उपयोगकर्ता केवल वही देखता है जिसकी उसे अनुमति है:

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

एक ही क्वेरी, अलग-अलग परिणाम - क्योंकि ACL ग्राफ़ वेक्टर इंडेक्स को छूने से *पहले* उम्मीदवार समूह तैयार करता है। पूरा वॉकथ्रू: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)।

## MCP के माध्यम से उपलब्ध टूल

| टूल | कार्य |
|---|---|
| `context_ingest` | टेक्स्ट संग्रहीत करें → रिकॉर्ड नोड + **अनुमति किनारे** (ACL) + **वेक्टर खंड** + **निष्कर्षित कॉन्सेप्ट ग्राफ़** |
| `get_context` | रैंक किए गए, उद्धृत और अनुमति-फ़िल्टर किए गए अंश पुनर्प्राप्त करता है |
| `context_graph` | वह नॉलेज ग्राफ़ (कॉन्सेप्ट + संबंध) लौटाता है जिस तक उपयोगकर्ता की पहुँच है |

## चलाएँ

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## किसी भी MCP क्लाइंट से उपयोग करें

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

**सेंट्रल ऑफ़िस:** साझा बैकएंड के URL जोड़ें ताकि सभी प्रति-उपयोगकर्ता ACL के साथ एक ही ग्राफ़ पर क्वेरी करें:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## यह कैसे काम करता है

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## भंडारण (लोकल मोड)

`$CONTEXT_DB` या `~/.local/share/100xprompt/context.db` पर एक फ़ाइल:
- `nodes` - ग्राफ़ शीर्ष (रिकॉर्ड, उपयोगकर्ता, संगठन, **एंटिटी**)
- `edges` - संबंध (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - टेक्स्ट + एम्बेडिंग वेक्टर
- `vec_chunks` - **sqlite-vec ANN इंडेक्स** (जब उपलब्ध हो - नीचे देखें)

## वेक्टर खोज - अनुकूली (sqlite-vec, इन-प्रोसेस)

यदि एक्सटेंशन-सक्षम SQLite मौजूद है, तो स्टोर **[sqlite-vec](https://github.com/asg017/sqlite-vec)** लोड करता है और *उसी फ़ाइल में* एक `vec0` ANN इंडेक्स रखता है - TypeScript-नेटिव, Python-मुक्त। 3000 वेक्टर पर ब्रूट-फ़ोर्स से लगभग 16× तेज़, और बड़े पैमाने पर इससे भी अधिक।

अन्यथा यह **पारदर्शी रूप से ब्रूट-फ़ोर्स कोसाइन पर वापस लौट आता है** - वही परिणाम, वही इंटरफ़ेस, और सिंगल-बाइनरी के लिए पूरी तरह पोर्टेबल। `bun:sqlite` डिफ़ॉल्ट रूप से एक्सटेंशन लोडिंग बंद रखता है; ANN फ़ास्ट-पाथ सक्षम करने के लिए इसे एक्सटेंशन-सक्षम SQLite की ओर इंगित करें (जैसे `brew install sqlite`, सामान्य पथों पर स्वतः पहचाना जाता है)। कोई कॉन्फ़िगरेशन आवश्यक नहीं - `store.vecEnabled` सक्रिय पथ दर्शाता है।

## स्थिति

लागू: ACL ग्राफ़, वेक्टर स्टोर, पुनर्प्राप्ति + लीक गार्ड, **नॉलेज-ग्राफ़ निष्कर्षण**, MCP सर्वर (लोकल + सेंट्रल), fetch-आधारित Arango/Qdrant/एम्बेडिंग अडैप्टर। MCP SDK को छोड़कर कोई निर्भरता नहीं।

आगे (समान इंटरफ़ेस, अदला-बदली योग्य): सिमैंटिक रैंकिंग हेतु वास्तविक एम्बेडिंग (transformers.js ONNX `bge-*`); GraphRAG पुनर्प्राप्ति (`relates_to` किनारों के साथ परिणाम विस्तार); अधिक रिकॉल हेतु LLM-आधारित एंटिटी निष्कर्षण।

मॉड्यूल-दर-मॉड्यूल आंतरिक विवरण और सुरक्षा अपरिवर्तनीय के लिए [ARCHITECTURE.md](../../ARCHITECTURE.md) देखें।

## दस्तावेज़

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - पाइपलाइन, मॉड्यूल मानचित्र, सुरक्षा अपरिवर्तनीय, विस्तार
- [examples/](../../examples/) - चलाने योग्य डेमो
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - डेव सेटअप और वर्कफ़्लो
- [SECURITY.md](../../SECURITY.md) - सुरक्षा मॉडल और समस्याएँ रिपोर्ट करने का तरीका
- [CHANGELOG.md](../../CHANGELOG.md) - उल्लेखनीय परिवर्तन

## लाइसेंस

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
