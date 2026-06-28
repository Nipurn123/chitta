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
  <b>Türkçe</b> ·
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

> Bu bir çeviridir. Farklılık olması halinde [English](../../README.md) özgün metni esas alınır.

İzin farkındalıklı **bilgi grafiği + vektör belleği**, bağımsız bir **MCP sunucusu** olarak sunulur.
Herhangi bir MCP istemcisi (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE'ler) yapılandırma ile kullanır - kod değişikliği gerekmez.

Yapay zekâ asistanınızı bir kez bağlayın; her konuşma ekibinizin bilgisini **saklayabilir, hatırlayabilir ve üzerinde akıl yürütebilir** - her kullanıcı yalnızca izinlerinin elverdiğini görür.

> **Mimari ve iç yapı:** bkz. [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Yerel mod (varsayılan):** tek bir SQLite dosyası. Alma, bilgi grafiği çıkarımı ve geri getirme - sunucu yok.
- **Merkez ofis modu:** ortam değişkenleriyle paylaşılan bir arka uca (ArangoDB + Qdrant + gömme) yönlendirin; tüm kuruluş tek bir grafiği paylaşır ve her kullanıcı yalnızca ACL'sinin izin verdiğini görür.

## 30 saniyede görün

İki kullanıcı, tek bir depo, üç belge - her kullanıcı yalnızca izinli olduğunu görür:

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

Aynı sorgu, farklı sonuçlar - çünkü ACL grafiği aday kümesini vektör dizinine dokunmadan *önce* üretir. Tam anlatım: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## MCP üzerinden sunulan araçlar

| Araç | İşlevi |
|---|---|
| `context_ingest` | Metni sakla → kayıt düğümü + **izin kenarları** (ACL) + **vektör parçaları** + **çıkarılan kavram grafiği** |
| `get_context` | Sıralanmış, alıntılı ve izne göre filtrelenmiş parçaları getirir |
| `context_graph` | Kullanıcının erişebileceği bilgi grafiğini (kavramlar + ilişkiler) döndürür |

## Çalıştır

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Herhangi bir MCP istemcisinden kullanın

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

**Merkez ofis:** paylaşılan arka uç URL'lerini ekleyin ki herkes kullanıcı bazlı ACL ile tek bir grafiği sorgulasın:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Nasıl çalışır

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Depolama (yerel mod)

`$CONTEXT_DB` veya `~/.local/share/100xprompt/context.db` konumunda tek bir dosya:
- `nodes` - grafik düğümleri (kayıtlar, kullanıcılar, kuruluşlar, **varlıklar**)
- `edges` - ilişkiler (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - metin + gömme vektörleri
- `vec_chunks` - **sqlite-vec ANN dizini** (kullanılabilir olduğunda - aşağıya bakın)

## Vektör arama - uyarlanır (sqlite-vec, süreç içi)

Uzantı destekli bir SQLite varsa, depo **[sqlite-vec](https://github.com/asg017/sqlite-vec)** yükler ve *aynı dosyada* bir `vec0` ANN dizini tutar - TypeScript-doğal, Python gerektirmez. 3000 vektörde kaba kuvvetten yaklaşık 16× hızlı, ölçek büyüdükçe daha da fazla.

Aksi takdirde **şeffaf biçimde kaba kuvvet kosinüsüne geri döner** - aynı sonuçlar, aynı arayüz ve tek ikili dosya için tamamen taşınabilir. `bun:sqlite` uzantı yüklemeyi varsayılan olarak devre dışı bırakır; ANN hızlı yolunu etkinleştirmek için onu uzantı destekli bir SQLite'a yönlendirin (örn. `brew install sqlite`, yaygın yollarda otomatik algılanır). Yapılandırma gerekmez - `store.vecEnabled` etkin yolu yansıtır.

## Durum

Uygulandı: ACL grafiği, vektör deposu, geri getirme + sızıntı koruması, **bilgi grafiği çıkarımı**, MCP sunucusu (yerel + merkezi) ve fetch tabanlı Arango/Qdrant/gömme bağdaştırıcıları. MCP SDK dışında bağımlılık yok.

Sırada (aynı arayüzle değiştirilebilir): anlamsal sıralama için gerçek gömmeler (transformers.js ONNX `bge-*`); GraphRAG geri getirme (`relates_to` kenarları boyunca sonuçları genişletme); daha yüksek anma için LLM tabanlı varlık çıkarımı.

Modül modül iç yapı ve güvenlik değişmezi için [ARCHITECTURE.md](../../ARCHITECTURE.md) bölümüne bakın.

## Belgeler

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - boru hattı, modül haritası, güvenlik değişmezi ve genişletme
- [examples/](../../examples/) - çalıştırılabilir demolar
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - geliştirme kurulumu ve iş akışı
- [SECURITY.md](../../SECURITY.md) - güvenlik modeli ve sorunları bildirme
- [CHANGELOG.md](../../CHANGELOG.md) - önemli değişiklikler

## Lisans

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
