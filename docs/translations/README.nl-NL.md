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
  <b>Nederlands</b> ·
  <a href="README.th-TH.md">ภาษาไทย</a>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-124%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

> Dit is een vertaling. Bij verschillen geldt het [English](../../README.md) origineel.

Rechten-bewuste **kennisgraaf + vectorgeheugen**, geleverd als zelfstandige **MCP-server**.
Elke MCP-client (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE's) gebruikt het via configuratie - zonder codewijzigingen.

Koppel je AI-assistent één keer, en elk gesprek kan de kennis van je team **opslaan, oproepen en erover redeneren** - waarbij elke gebruiker alleen ziet wat zijn rechten toestaan.

> **Architectuur en interne werking:** zie [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Lokale modus (standaard):** één SQLite-bestand. Inlezen, een kennisgraaf extraheren en ophalen - zonder servers.
- **Centraal-kantoormodus:** wijs het via omgevingsvariabelen naar een gedeelde backend (ArangoDB + Qdrant + embeddings); de hele organisatie deelt één graaf en elke gebruiker ziet alleen wat zijn ACL toestaat.

## Bekijk het in 30 seconden

Twee gebruikers, één opslag, drie documenten - elke gebruiker ziet alleen wat is toegestaan:

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

Zelfde query, andere resultaten - omdat de ACL-graaf de kandidatenset opbouwt *voordat* de vectorindex wordt aangeraakt. Volledige uitleg: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Tools beschikbaar via MCP

| Tool | Functie |
|---|---|
| `context_ingest` | Slaat tekst op → recordknoop + **rechtenranden** (ACL) + **vectorfragmenten** + **geëxtraheerde conceptgraaf** |
| `get_context` | Haalt gerangschikte, geciteerde en op rechten gefilterde fragmenten op |
| `context_graph` | Geeft de kennisgraaf (concepten + relaties) terug waartoe de gebruiker toegang heeft |

## Uitvoeren

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Gebruik het vanuit elke MCP-client

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

**Centraal kantoor:** voeg de URL's van de gedeelde backend toe zodat iedereen één graaf bevraagt met ACL per gebruiker:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Hoe het werkt

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Opslag (lokale modus)

Eén bestand op `$CONTEXT_DB` of `~/.local/share/100xprompt/context.db`:
- `nodes` - graafknopen (records, gebruikers, organisaties, **entiteiten**)
- `edges` - relaties (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - tekst + embeddingvectoren
- `vec_chunks` - **sqlite-vec ANN-index** (indien beschikbaar - zie hieronder)

## Vectorzoeken - adaptief (sqlite-vec, in-process)

Als er een SQLite met extensieondersteuning aanwezig is, laadt de opslag **[sqlite-vec](https://github.com/asg017/sqlite-vec)** en houdt een `vec0` ANN-index *in hetzelfde bestand* - TypeScript-native, zonder Python. Ongeveer 16× sneller dan brute kracht bij 3000 vectoren, en meer op grotere schaal.

Anders valt het **transparant terug op brute-kracht-cosinus** - dezelfde resultaten, dezelfde interface en volledig porteerbaar voor het pad met één binary. `bun:sqlite` schakelt het laden van extensies standaard uit; om het snelle ANN-pad in te schakelen, wijs het naar een SQLite met extensies (bijv. `brew install sqlite`, automatisch gedetecteerd op gangbare paden). Geen configuratie nodig - `store.vecEnabled` geeft het actieve pad weer.

## Status

Geïmplementeerd: ACL-graaf, vectoropslag, ophalen + lekbeveiliging, **kennisgraafextractie**, MCP-server (lokaal + centraal) en op fetch gebaseerde Arango-/Qdrant-/embeddingadapters. Geen afhankelijkheden behalve de MCP-SDK.

Volgende (verwisselbaar, zelfde interface): echte embeddings (transformers.js ONNX `bge-*`) voor semantische rangschikking; GraphRAG-ophalen (resultaten uitbreiden langs `relates_to`-randen); LLM-gebaseerde entiteitsextractie voor hogere recall.

Zie [ARCHITECTURE.md](../../ARCHITECTURE.md) voor de interne werking per module en de beveiligingsinvariant.

## Documentatie

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - pijplijn, modulekaart, beveiligingsinvariant en uitbreiden
- [examples/](../../examples/) - uitvoerbare demo's
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - ontwikkelopzet en workflow
- [SECURITY.md](../../SECURITY.md) - beveiligingsmodel en problemen melden
- [CHANGELOG.md](../../CHANGELOG.md) - noemenswaardige wijzigingen

## Licentie

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
