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
  <b>Tiếng Việt</b> ·
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

> Đây là bản dịch. Nếu có khác biệt, bản gốc [English](../../README.md) được ưu tiên.

**Đồ thị tri thức + bộ nhớ vector** có nhận biết quyền, cung cấp dưới dạng **máy chủ MCP** độc lập.
Mọi máy khách MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, các IDE) đều dùng được qua cấu hình - không cần đổi mã.

Kết nối trợ lý AI của bạn một lần, và mọi cuộc trò chuyện đều có thể **lưu trữ, gợi nhớ và suy luận** trên tri thức của nhóm - mỗi người dùng chỉ thấy những gì quyền của họ cho phép.

> **Kiến trúc và chi tiết bên trong:** xem [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Chế độ cục bộ (mặc định):** một tệp SQLite duy nhất. Nạp dữ liệu, trích xuất đồ thị tri thức, truy hồi - không cần máy chủ.
- **Chế độ văn phòng trung tâm:** trỏ tới một backend dùng chung (ArangoDB + Qdrant + embedding) qua biến môi trường; cả tổ chức dùng chung một đồ thị, mỗi người dùng chỉ thấy những gì ACL của họ cho phép.

## Xem trong 30 giây

Hai người dùng, một kho lưu trữ, ba tài liệu - mỗi người chỉ thấy phần được phép:

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

Cùng một truy vấn, kết quả khác nhau - vì đồ thị ACL tạo ra tập ứng viên *trước khi* chạm tới chỉ mục vector. Hướng dẫn đầy đủ: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Công cụ cung cấp qua MCP

| Công cụ | Chức năng |
|---|---|
| `context_ingest` | Lưu văn bản → nút bản ghi + **cạnh quyền** (ACL) + **đoạn vector** + **đồ thị khái niệm đã trích xuất** |
| `get_context` | Truy hồi các đoạn đã xếp hạng, có trích dẫn và lọc theo quyền |
| `context_graph` | Trả về đồ thị tri thức (khái niệm + quan hệ) mà người dùng được phép truy cập |

## Chạy

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Dùng từ bất kỳ máy khách MCP nào

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

**Văn phòng trung tâm:** thêm URL của backend dùng chung để mọi người truy vấn cùng một đồ thị với ACL theo từng người dùng:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Cách hoạt động

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Lưu trữ (chế độ cục bộ)

Một tệp tại `$CONTEXT_DB` hoặc `~/.local/share/100xprompt/context.db`:
- `nodes` - các đỉnh đồ thị (bản ghi, người dùng, tổ chức, **thực thể**)
- `edges` - quan hệ (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - văn bản + vector embedding
- `vec_chunks` - **chỉ mục ANN sqlite-vec** (khi có sẵn - xem bên dưới)

## Tìm kiếm vector - thích ứng (sqlite-vec, trong tiến trình)

Nếu có SQLite hỗ trợ tiện ích mở rộng, kho lưu trữ sẽ nạp **[sqlite-vec](https://github.com/asg017/sqlite-vec)** và giữ một chỉ mục ANN `vec0` *trong cùng tệp* - thuần TypeScript, không cần Python. Nhanh hơn khoảng 16× so với vét cạn ở mức 3000 vector, và càng nhiều hơn khi quy mô lớn.

Nếu không, nó **tự động lui về cosine vét cạn một cách trong suốt** - cùng kết quả, cùng giao diện và hoàn toàn khả chuyển cho bản nhị phân đơn. `bun:sqlite` mặc định tắt việc nạp tiện ích mở rộng; để bật đường nhanh ANN, hãy trỏ tới một SQLite hỗ trợ tiện ích mở rộng (ví dụ `brew install sqlite`, tự phát hiện ở các đường dẫn phổ biến). Không cần cấu hình - `store.vecEnabled` phản ánh đường đang hoạt động.

## Trạng thái

Đã hiện thực: đồ thị ACL, kho vector, truy hồi + chống rò rỉ, **trích xuất đồ thị tri thức**, máy chủ MCP (cục bộ + trung tâm) và các adapter Arango/Qdrant/embedding dựa trên fetch. Không phụ thuộc gì ngoài MCP SDK.

Tiếp theo (thay thế được, cùng giao diện): embedding thật (transformers.js ONNX `bge-*`) để xếp hạng theo ngữ nghĩa; truy hồi GraphRAG (mở rộng kết quả theo các cạnh `relates_to`); trích xuất thực thể dựa trên LLM để tăng độ bao phủ.

Xem [ARCHITECTURE.md](../../ARCHITECTURE.md) để biết chi tiết theo từng mô-đun và bất biến bảo mật.

## Tài liệu

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - quy trình, bản đồ mô-đun, bất biến bảo mật và cách mở rộng
- [examples/](../../examples/) - demo chạy được
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - thiết lập phát triển và quy trình làm việc
- [SECURITY.md](../../SECURITY.md) - mô hình bảo mật và cách báo cáo sự cố
- [CHANGELOG.md](../../CHANGELOG.md) - các thay đổi đáng chú ý

## Giấy phép

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
