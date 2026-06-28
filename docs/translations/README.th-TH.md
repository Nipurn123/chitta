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
  <a href="README.uk-UA.md">Українська</a> ·
  <a href="README.nl-NL.md">Nederlands</a> ·
  <b>ภาษาไทย</b>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-124%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

> นี่คือฉบับแปล หากมีข้อแตกต่าง ให้ยึดต้นฉบับ [English](../../README.md) เป็นหลัก

**กราฟความรู้ + หน่วยความจำเวกเตอร์** ที่รับรู้สิทธิ์ ให้บริการเป็น **เซิร์ฟเวอร์ MCP** แบบสแตนด์อโลน
ไคลเอนต์ MCP ใดก็ได้ (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE ต่าง ๆ) ใช้งานผ่านการตั้งค่า - ไม่ต้องแก้โค้ด

เชื่อมต่อผู้ช่วย AI ของคุณเพียงครั้งเดียว แล้วทุกบทสนทนาจะสามารถ **จัดเก็บ เรียกคืน และให้เหตุผล** บนความรู้ของทีมได้ โดยผู้ใช้แต่ละคนเห็นเฉพาะสิ่งที่สิทธิ์อนุญาตเท่านั้น

> **สถาปัตยกรรมและรายละเอียดภายใน:** ดู [ARCHITECTURE.md](../../ARCHITECTURE.md)

- **โหมดโลคัล (ค่าเริ่มต้น):** ไฟล์ SQLite ไฟล์เดียว นำเข้า สกัดกราฟความรู้ และดึงข้อมูล - โดยไม่ต้องมีเซิร์ฟเวอร์
- **โหมดสำนักงานกลาง:** ชี้ไปยังแบ็กเอนด์ที่ใช้ร่วมกัน (ArangoDB + Qdrant + เอ็มเบดดิง) ผ่านตัวแปรสภาพแวดล้อม ทั้งองค์กรใช้กราฟเดียวกัน และผู้ใช้แต่ละคนเห็นเฉพาะสิ่งที่ ACL ของตนอนุญาต

## ดูใน 30 วินาที

ผู้ใช้สองคน ที่จัดเก็บหนึ่งแห่ง เอกสารสามฉบับ - ผู้ใช้แต่ละคนเห็นเฉพาะสิ่งที่ได้รับอนุญาต:

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

คำค้นเดียวกัน ผลลัพธ์ต่างกัน - เพราะกราฟ ACL สร้างชุดผู้สมัคร *ก่อน* ที่จะแตะดัชนีเวกเตอร์ คำแนะนำฉบับเต็ม: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/)

## เครื่องมือที่เปิดให้ใช้ผ่าน MCP

| เครื่องมือ | หน้าที่ |
|---|---|
| `context_ingest` | จัดเก็บข้อความ → โหนดเรกคอร์ด + **เส้นเชื่อมสิทธิ์** (ACL) + **ชิ้นส่วนเวกเตอร์** + **กราฟแนวคิดที่สกัดได้** |
| `get_context` | ดึงข้อความตัดตอนที่จัดอันดับ มีการอ้างอิง และกรองตามสิทธิ์ |
| `context_graph` | คืนค่ากราฟความรู้ (แนวคิด + ความสัมพันธ์) ที่ผู้ใช้เข้าถึงได้ |

## เรียกใช้

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## ใช้จากไคลเอนต์ MCP ใดก็ได้

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

**สำนักงานกลาง:** เพิ่ม URL ของแบ็กเอนด์ที่ใช้ร่วมกัน เพื่อให้ทุกคนสอบถามกราฟเดียวกันโดยมี ACL แยกตามผู้ใช้:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## วิธีการทำงาน

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## การจัดเก็บ (โหมดโลคัล)

ไฟล์เดียวที่ `$CONTEXT_DB` หรือ `~/.local/share/100xprompt/context.db`:
- `nodes` - จุดยอดของกราฟ (เรกคอร์ด ผู้ใช้ องค์กร **เอนทิตี**)
- `edges` - ความสัมพันธ์ (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - ข้อความ + เวกเตอร์เอ็มเบดดิง
- `vec_chunks` - **ดัชนี ANN ของ sqlite-vec** (เมื่อมีให้ใช้ - ดูด้านล่าง)

## การค้นหาเวกเตอร์ - ปรับตัว (sqlite-vec ภายในกระบวนการ)

หากมี SQLite ที่รองรับส่วนขยาย ที่จัดเก็บจะโหลด **[sqlite-vec](https://github.com/asg017/sqlite-vec)** และเก็บดัชนี ANN `vec0` *ไว้ในไฟล์เดียวกัน* - เป็น TypeScript ดั้งเดิม ไม่ต้องใช้ Python เร็วกว่าการค้นแบบกวาดทั้งหมดราว 16 เท่าที่ 3000 เวกเตอร์ และยิ่งมากขึ้นเมื่อสเกลใหญ่ขึ้น

มิฉะนั้น มันจะ **ถอยกลับไปใช้โคไซน์แบบกวาดทั้งหมดอย่างโปร่งใส** - ผลลัพธ์เหมือนเดิม อินเทอร์เฟซเหมือนเดิม และพกพาได้เต็มที่สำหรับเส้นทางไบนารีไฟล์เดียว โดยปริยาย `bun:sqlite` ปิดการโหลดส่วนขยาย หากต้องการเปิดเส้นทางเร็ว ANN ให้ชี้ไปยัง SQLite ที่รองรับส่วนขยาย (เช่น `brew install sqlite` ตรวจพบอัตโนมัติในเส้นทางทั่วไป) ไม่ต้องตั้งค่าใด ๆ - `store.vecEnabled` สะท้อนเส้นทางที่กำลังทำงานอยู่

## สถานะ

ที่ทำเสร็จแล้ว: กราฟ ACL, ที่จัดเก็บเวกเตอร์, การดึงข้อมูล + การป้องกันการรั่วไหล, **การสกัดกราฟความรู้**, เซิร์ฟเวอร์ MCP (โลคัล + กลาง) และอะแดปเตอร์ Arango/Qdrant/เอ็มเบดดิงที่อิงกับ fetch ไม่มีการพึ่งพาใด ๆ นอกจาก MCP SDK

ถัดไป (สลับเปลี่ยนได้ อินเทอร์เฟซเดิม): เอ็มเบดดิงจริง (transformers.js ONNX `bge-*`) สำหรับการจัดอันดับเชิงความหมาย; การดึงข้อมูลแบบ GraphRAG (ขยายผลลัพธ์ตามเส้นเชื่อม `relates_to`); การสกัดเอนทิตีด้วย LLM เพื่อเพิ่ม recall

ดู [ARCHITECTURE.md](../../ARCHITECTURE.md) สำหรับรายละเอียดภายในทีละโมดูลและค่าคงที่ด้านความปลอดภัย

## เอกสาร

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - ไปป์ไลน์ แผนผังโมดูล ค่าคงที่ด้านความปลอดภัย และการขยาย
- [examples/](../../examples/) - เดโมที่เรียกใช้ได้
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - การตั้งค่าสำหรับนักพัฒนาและเวิร์กโฟลว์
- [SECURITY.md](../../SECURITY.md) - โมเดลความปลอดภัยและวิธีรายงานปัญหา
- [CHANGELOG.md](../../CHANGELOG.md) - การเปลี่ยนแปลงที่สำคัญ

## สัญญาอนุญาต

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
