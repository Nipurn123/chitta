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
  <b>Bahasa Indonesia</b> ·
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

> Ini adalah terjemahan. Jika ada perbedaan, versi [English](../../README.md) yang berlaku.

**Graf pengetahuan + memori vektor** yang sadar izin, hadir sebagai **server MCP** mandiri.
Klien MCP apa pun (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) memakainya lewat konfigurasi - tanpa mengubah kode.

Hubungkan asisten AI Anda sekali saja, dan setiap percakapan dapat **menyimpan, mengingat, dan menalar** pengetahuan tim Anda - dengan tiap pengguna hanya melihat yang diizinkan oleh haknya.

> **Arsitektur dan detail internal:** lihat [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Mode lokal (bawaan):** satu berkas SQLite. Ingest, ekstraksi graf pengetahuan, dan pengambilan - tanpa server.
- **Mode kantor pusat:** arahkan ke backend bersama (ArangoDB + Qdrant + embedding) lewat variabel lingkungan; seluruh organisasi berbagi satu graf, dan tiap pengguna hanya melihat yang diizinkan ACL-nya.

## Lihat dalam 30 detik

Dua pengguna, satu penyimpanan, tiga dokumen - tiap pengguna hanya melihat yang diizinkan:

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

Kueri sama, hasil berbeda - karena graf ACL menghasilkan himpunan kandidat *sebelum* menyentuh indeks vektor. Panduan lengkap: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Alat yang diekspos lewat MCP

| Alat | Fungsi |
|---|---|
| `context_ingest` | Simpan teks → simpul rekaman + **sisi izin** (ACL) + **potongan vektor** + **graf konsep hasil ekstraksi** |
| `get_context` | Mengambil cuplikan yang diperingkat, dikutip, dan difilter berdasarkan izin |
| `context_graph` | Mengembalikan graf pengetahuan (konsep + relasi) yang boleh diakses pengguna |

## Jalankan

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Pakai dari klien MCP mana pun

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

**Kantor pusat:** tambahkan URL backend bersama agar semua orang mengkueri satu graf dengan ACL per pengguna:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Cara kerjanya

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Penyimpanan (mode lokal)

Satu berkas di `$CONTEXT_DB` atau `~/.local/share/100xprompt/context.db`:
- `nodes` - simpul graf (rekaman, pengguna, organisasi, **entitas**)
- `edges` - relasi (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - teks + vektor embedding
- `vec_chunks` - **indeks ANN sqlite-vec** (bila tersedia - lihat di bawah)

## Pencarian vektor - adaptif (sqlite-vec, dalam proses)

Jika ada SQLite yang mendukung ekstensi, penyimpanan memuat **[sqlite-vec](https://github.com/asg017/sqlite-vec)** dan menyimpan indeks ANN `vec0` *di berkas yang sama* - native TypeScript, tanpa Python. Sekitar 16× lebih cepat daripada brute force pada 3000 vektor, dan lebih cepat lagi pada skala besar.

Jika tidak, ia **secara transparan kembali ke kosinus brute force** - hasil sama, antarmuka sama, dan sepenuhnya portabel untuk jalur biner tunggal. `bun:sqlite` menonaktifkan pemuatan ekstensi secara bawaan; untuk mengaktifkan jalur cepat ANN, arahkan ke SQLite yang mendukung ekstensi (mis. `brew install sqlite`, terdeteksi otomatis di jalur umum). Tanpa konfigurasi - `store.vecEnabled` mencerminkan jalur yang aktif.

## Status

Terimplementasi: graf ACL, penyimpanan vektor, pengambilan + penjaga kebocoran, **ekstraksi graf pengetahuan**, server MCP (lokal + pusat), serta adapter Arango/Qdrant/embedding berbasis fetch. Tanpa dependensi selain MCP SDK.

Berikutnya (dapat ditukar, antarmuka sama): embedding sungguhan (transformers.js ONNX `bge-*`) untuk pemeringkatan semantik; pengambilan GraphRAG (memperluas hasil sepanjang sisi `relates_to`); ekstraksi entitas berbasis LLM untuk recall lebih tinggi.

Lihat [ARCHITECTURE.md](../../ARCHITECTURE.md) untuk detail per modul dan invarian keamanan.

## Dokumentasi

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - alur, peta modul, invarian keamanan, dan cara memperluas
- [examples/](../../examples/) - demo yang dapat dijalankan
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - penyiapan pengembangan dan alur kerja
- [SECURITY.md](../../SECURITY.md) - model keamanan dan cara melaporkan masalah
- [CHANGELOG.md](../../CHANGELOG.md) - perubahan penting

## Lisensi

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
