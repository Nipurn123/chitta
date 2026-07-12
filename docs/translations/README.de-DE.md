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
  <b>Deutsch</b> ·
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

> Dies ist eine Übersetzung. Bei Abweichungen gilt das [English](../../README.md) Original.

Berechtigungsbewusster **Wissensgraph + Vektorspeicher**, ausgeliefert als eigenständiger **MCP-Server**.
Jeder MCP-Client (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) nutzt ihn per Konfiguration - ohne Codeänderungen.

Verbinde deinen KI-Assistenten einmal, und jede Unterhaltung kann das Wissen deines Teams **speichern, abrufen und darüber schlussfolgern** - wobei jeder Nutzer nur sieht, was seine Berechtigungen erlauben.

> **Architektur und Interna:** siehe [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Lokaler Modus (Standard):** eine einzige SQLite-Datei. Aufnehmen, Wissensgraph extrahieren, abrufen - ohne Server.
- **Zentraler Modus:** per Umgebungsvariablen auf ein gemeinsames Backend (ArangoDB + Qdrant + Embeddings) zeigen; die ganze Organisation teilt sich einen Graphen, jeder Nutzer sieht nur, was seine ACL erlaubt.

## In 30 Sekunden erklärt

Zwei Nutzer, ein Speicher, drei Dokumente - jeder sieht nur, was ihm erlaubt ist:

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

Gleiche Abfrage, unterschiedliche Ergebnisse - weil der ACL-Graph die Kandidatenmenge erzeugt, *bevor* der Vektorindex angefasst wird. Vollständige Anleitung: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Über MCP bereitgestellte Tools

| Tool | Funktion |
|---|---|
| `context_ingest` | Text speichern → Datensatzknoten + **Berechtigungskanten** (ACL) + **Vektor-Chunks** + **extrahierter Konzeptgraph** |
| `get_context` | Ruft gerankte, zitierte, nach Berechtigungen gefilterte Ausschnitte ab |
| `context_graph` | Gibt den Wissensgraphen (Konzepte + Beziehungen) zurück, auf den der Nutzer zugreifen darf |

## Ausführen

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Aus jedem MCP-Client nutzen

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

**Zentrale:** Füge die URLs des gemeinsamen Backends hinzu, damit alle einen Graphen mit nutzerspezifischer ACL abfragen:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## So funktioniert es

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Speicherung (lokaler Modus)

Eine Datei unter `$CONTEXT_DB` oder `~/.local/share/100xprompt/context.db`:
- `nodes` - Graphknoten (Datensätze, Nutzer, Organisationen, **Entitäten**)
- `edges` - Beziehungen (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - Text + Embedding-Vektoren
- `vec_chunks` - **sqlite-vec-ANN-Index** (sofern verfügbar - siehe unten)

## Vektorsuche - adaptiv (sqlite-vec, im Prozess)

Ist ein erweiterungsfähiges SQLite vorhanden, lädt der Speicher **[sqlite-vec](https://github.com/asg017/sqlite-vec)** und hält einen `vec0`-ANN-Index *in derselben Datei* - TypeScript-nativ, ohne Python. Bei 3000 Vektoren rund 16× schneller als Brute Force, mit zunehmender Größe noch mehr.

Andernfalls fällt es **transparent auf Brute-Force-Kosinus zurück** - gleiche Ergebnisse, gleiche Schnittstelle, voll portabel für den Single-Binary-Pfad. `bun:sqlite` deaktiviert das Laden von Erweiterungen standardmäßig; um den schnellen ANN-Pfad zu aktivieren, verweise auf ein erweiterungsfähiges SQLite (z. B. `brew install sqlite`, an gängigen Pfaden automatisch erkannt). Keine Konfiguration nötig - `store.vecEnabled` zeigt den aktiven Pfad.

## Status

Implementiert: ACL-Graph, Vektorspeicher, Abruf + Leck-Schutz, **Wissensgraph-Extraktion**, MCP-Server (lokal + zentral), fetch-basierte Arango-/Qdrant-/Embedding-Adapter. Keine Abhängigkeiten außer dem MCP-SDK.

Als Nächstes (austauschbar, gleiche Schnittstelle): echte Embeddings (transformers.js ONNX `bge-*`) für semantisches Ranking; GraphRAG-Abruf (Ergebnisse entlang `relates_to`-Kanten erweitern); LLM-basierte Entitätsextraktion für höhere Trefferquote.

Modulweise Interna und die Sicherheitsinvariante in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Dokumentation

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - Pipeline, Modulübersicht, Sicherheitsinvariante, Erweiterung
- [examples/](../../examples/) - ausführbare Demos
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Entwicklungsumgebung und Arbeitsablauf
- [SECURITY.md](../../SECURITY.md) - Sicherheitsmodell und Meldung von Problemen
- [CHANGELOG.md](../../CHANGELOG.md) - wesentliche Änderungen

## Lizenz

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
