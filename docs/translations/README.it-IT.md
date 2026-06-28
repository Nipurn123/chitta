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
  <b>Italiano</b> ·
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

> Questa è una traduzione. In caso di discrepanze prevale l'originale [English](../../README.md).

**Grafo della conoscenza + memoria vettoriale** con gestione dei permessi, fornito come **server MCP** autonomo.
Qualsiasi client MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) lo usa tramite configurazione, senza modifiche al codice.

Collega il tuo assistente IA una sola volta e ogni conversazione potrà **memorizzare, richiamare e ragionare** sulla conoscenza del team, con ciascun utente che vede solo ciò che i suoi permessi consentono.

> **Architettura e dettagli interni:** vedi [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Modalità locale (predefinita):** un unico file SQLite. Ingestione, estrazione di un grafo della conoscenza e recupero, senza server.
- **Modalità ufficio centrale:** puntalo a un backend condiviso (ArangoDB + Qdrant + embedding) tramite variabili d'ambiente; l'intera organizzazione condivide un grafo e ogni utente vede solo ciò che la sua ACL consente.

## Guarda in 30 secondi

Due utenti, un archivio, tre documenti: ogni utente vede solo ciò che gli è consentito:

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

Stessa query, risultati diversi, perché il grafo ACL produce l'insieme dei candidati *prima* di toccare l'indice vettoriale. Guida completa: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Strumenti esposti via MCP

| Strumento | Cosa fa |
|---|---|
| `context_ingest` | Memorizza testo → nodo record + **archi di permesso** (ACL) + **chunk vettoriali** + **grafo dei concetti estratto** |
| `get_context` | Recupera frammenti ordinati, citati e filtrati per permessi |
| `context_graph` | Restituisce il grafo della conoscenza (concetti + relazioni) a cui l'utente può accedere |

## Esegui

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Usalo da qualsiasi client MCP

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

**Ufficio centrale:** aggiungi gli URL del backend condiviso così tutti interrogano un unico grafo con ACL per utente:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Come funziona

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Archiviazione (modalità locale)

Un file in `$CONTEXT_DB` o `~/.local/share/100xprompt/context.db`:
- `nodes` - vertici del grafo (record, utenti, organizzazioni, **entità**)
- `edges` - relazioni (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - testo + vettori di embedding
- `vec_chunks` - **indice ANN di sqlite-vec** (quando disponibile - vedi sotto)

## Ricerca vettoriale - adattiva (sqlite-vec, in-process)

Se è presente uno SQLite con supporto per le estensioni, l'archivio carica **[sqlite-vec](https://github.com/asg017/sqlite-vec)** e mantiene un indice ANN `vec0` *nello stesso file*: nativo in TypeScript e senza Python. Circa 16× più veloce della forza bruta con 3000 vettori, e di più su larga scala.

Altrimenti ricorre in modo **trasparente al coseno a forza bruta**: stessi risultati, stessa interfaccia e totalmente portabile per il binario singolo. `bun:sqlite` disabilita per impostazione predefinita il caricamento delle estensioni; per abilitare il percorso rapido ANN, puntalo a uno SQLite con estensioni (es. `brew install sqlite`, rilevato automaticamente nei percorsi comuni). Nessuna configurazione: `store.vecEnabled` riflette il percorso attivo.

## Stato

Implementato: grafo ACL, archivio vettoriale, recupero + protezione dalle fughe, **estrazione del grafo della conoscenza**, server MCP (locale + centrale) e adattatori Arango/Qdrant/embedding basati su fetch. Nessuna dipendenza tranne l'SDK MCP.

Prossimi (sostituibili, stessa interfaccia): embedding reali (transformers.js ONNX `bge-*`) per il ranking semantico; recupero GraphRAG (espansione dei risultati lungo gli archi `relates_to`); estrazione di entità basata su LLM per un richiamo maggiore.

Vedi [ARCHITECTURE.md](../../ARCHITECTURE.md) per i dettagli modulo per modulo e l'invariante di sicurezza.

## Documentazione

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - pipeline, mappa dei moduli, invariante di sicurezza ed estensione
- [examples/](../../examples/) - demo eseguibili
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - configurazione di sviluppo e flusso di lavoro
- [SECURITY.md](../../SECURITY.md) - modello di sicurezza e come segnalare problemi
- [CHANGELOG.md](../../CHANGELOG.md) - modifiche rilevanti

## Licenza

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
