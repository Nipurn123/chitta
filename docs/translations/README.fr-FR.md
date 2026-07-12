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
  <b>Français</b> ·
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

> Ceci est une traduction. En cas de divergence, la version [English](../../README.md) fait foi.

**Graphe de connaissances + mémoire vectorielle** sensible aux permissions, livré comme **serveur MCP** autonome.
N'importe quel client MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) l'utilise par configuration, sans modifier le code.

Connectez votre assistant IA une seule fois et chaque conversation pourra **stocker, retrouver et raisonner** sur le savoir de votre équipe, chaque utilisateur ne voyant que ce que ses permissions autorisent.

> **Architecture et internes :** voir [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Mode local (par défaut) :** un seul fichier SQLite. Ingestion, extraction d'un graphe de connaissances, recherche, sans serveur.
- **Mode bureau central :** pointez-le vers un backend partagé (ArangoDB + Qdrant + embeddings) via des variables d'environnement ; toute l'organisation partage un graphe et chaque utilisateur ne voit que ce que son ACL permet.

## À voir en 30 secondes

Deux utilisateurs, un magasin, trois documents : chacun ne voit que ce qui lui est autorisé :

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

Même requête, résultats différents, car le graphe d'ACL produit l'ensemble de candidats *avant* de toucher l'index vectoriel. Démonstration complète : [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Outils exposés via MCP

| Outil | Rôle |
|---|---|
| `context_ingest` | Stocke du texte → nœud d'enregistrement + **arêtes de permission** (ACL) + **fragments vectoriels** + **graphe de concepts extrait** |
| `get_context` | Récupère des extraits classés, cités et filtrés par permissions |
| `context_graph` | Renvoie le graphe de connaissances (concepts + relations) accessible à l'utilisateur |

## Lancer

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Utilisez-le depuis n'importe quel client MCP

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

**Bureau central :** ajoutez les URL du backend partagé pour que tous interrogent un même graphe avec une ACL par utilisateur :

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Comment ça marche

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Stockage (mode local)

Un fichier dans `$CONTEXT_DB` ou `~/.local/share/100xprompt/context.db` :
- `nodes` - sommets du graphe (enregistrements, utilisateurs, organisations, **entités**)
- `edges` - relations (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - texte + vecteurs d'embedding
- `vec_chunks` - **index ANN sqlite-vec** (lorsqu'il est disponible - voir ci-dessous)

## Recherche vectorielle - adaptative (sqlite-vec, en process)

Si un SQLite compatible extensions est présent, le magasin charge **[sqlite-vec](https://github.com/asg017/sqlite-vec)** et conserve un index ANN `vec0` *dans le même fichier* : natif TypeScript, sans Python. Environ 16× plus rapide que la force brute à 3000 vecteurs, et davantage à grande échelle.

Sinon, il **bascule de façon transparente vers un cosinus en force brute** : mêmes résultats, même interface, et parfaitement portable pour le binaire unique. `bun:sqlite` désactive le chargement d'extensions par défaut ; pour activer la voie rapide ANN, pointez-le vers un SQLite compatible (p. ex. `brew install sqlite`, détecté automatiquement aux emplacements habituels). Aucune configuration : `store.vecEnabled` indique la voie active.

## État

Implémenté : graphe ACL, magasin vectoriel, recherche + garde anti-fuite, **extraction de graphe de connaissances**, serveur MCP (local + central), adaptateurs Arango/Qdrant/embeddings basés sur fetch. Aucune dépendance hormis le SDK MCP.

À venir (interchangeable, même interface) : embeddings réels (transformers.js ONNX `bge-*`) pour le classement sémantique ; recherche GraphRAG (étendre les résultats le long des arêtes `relates_to`) ; extraction d'entités par LLM pour un meilleur rappel.

Voir [ARCHITECTURE.md](../../ARCHITECTURE.md) pour les détails module par module et l'invariant de sécurité.

## Documentation

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - pipeline, carte des modules, invariant de sécurité et extension
- [examples/](../../examples/) - démos exécutables
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - installation de dev et flux de travail
- [SECURITY.md](../../SECURITY.md) - modèle de sécurité et signalement
- [CHANGELOG.md](../../CHANGELOG.md) - changements notables

## Licence

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
