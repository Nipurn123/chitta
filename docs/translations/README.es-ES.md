# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <a href="README.ko-KR.md">한국어</a> ·
  <a href="README.hi-IN.md">हिन्दी</a> ·
  <a href="README.bn-IN.md">বাংলা</a> ·
  <b>Español</b> ·
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

> Esta es una traducción. En caso de discrepancia, prevalece el [English](../../README.md) original.

**Grafo de conocimiento + memoria vectorial** con control de permisos, como **servidor MCP** independiente.
Cualquier cliente MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) lo usa mediante configuración, sin cambios de código.

Conecta tu asistente de IA una sola vez y cada conversación podrá **almacenar, recordar y razonar** sobre el conocimiento de tu equipo, viendo cada usuario solo lo que sus permisos permiten.

> **Arquitectura e interiores:** consulta [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Modo local (por defecto):** un único archivo SQLite. Ingiere, extrae un grafo de conocimiento y recupera, sin servidores.
- **Modo oficina central:** apúntalo a un backend compartido (ArangoDB + Qdrant + embeddings) por variables de entorno; toda la organización comparte un grafo y cada usuario ve solo lo que su ACL permite.

## Míralo en 30 segundos

Dos usuarios, un almacén, tres documentos: cada usuario ve solo lo que tiene permitido:

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

Misma consulta, resultados distintos, porque el grafo de ACL produce el conjunto de candidatos *antes* de tocar el índice vectorial. Recorrido completo: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Herramientas expuestas por MCP

| Herramienta | Qué hace |
|---|---|
| `context_ingest` | Guarda texto → nodo de registro + **aristas de permiso** (ACL) + **fragmentos vectoriales** + **grafo de conceptos extraído** |
| `get_context` | Recupera fragmentos ordenados, citados y filtrados por permisos |
| `context_graph` | Devuelve el grafo de conocimiento (conceptos + relaciones) al que el usuario puede acceder |

## Ejecútalo

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Úsalo desde cualquier cliente MCP

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

**Oficina central:** añade las URL del backend compartido para que todos consulten un grafo con ACL por usuario:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Cómo funciona

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Almacenamiento (modo local)

Un archivo en `$CONTEXT_DB` o `~/.local/share/100xprompt/context.db`:
- `nodes` - vértices del grafo (registros, usuarios, organizaciones, **entidades**)
- `edges` - relaciones (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - texto + vectores de embedding
- `vec_chunks` - **índice ANN de sqlite-vec** (cuando está disponible; ver abajo)

## Búsqueda vectorial: adaptativa (sqlite-vec, en proceso)

Si hay un SQLite con soporte de extensiones, el almacén carga **[sqlite-vec](https://github.com/asg017/sqlite-vec)** y mantiene un índice ANN `vec0` *en el mismo archivo*: nativo de TypeScript y sin Python. Unas 16× más rápido que la fuerza bruta con 3000 vectores, y más a mayor escala.

Si no, recurre de forma **transparente a coseno por fuerza bruta**: mismos resultados, misma interfaz y totalmente portable para el binario único. `bun:sqlite` desactiva la carga de extensiones por defecto; para activar la vía rápida ANN, apúntalo a un SQLite con extensiones (p. ej. `brew install sqlite`, detectado automáticamente en rutas habituales). Sin configuración: `store.vecEnabled` refleja la vía activa.

## Estado

Implementado: grafo ACL, almacén vectorial, recuperación + protección contra fugas, **extracción de grafo de conocimiento**, servidor MCP (local + central) y adaptadores Arango/Qdrant/embeddings basados en fetch. Sin dependencias salvo el SDK de MCP.

Próximo (intercambiable, misma interfaz): embeddings reales (transformers.js ONNX `bge-*`) para ranking semántico; recuperación GraphRAG (expandir resultados por aristas `relates_to`); extracción de entidades con LLM para mayor exhaustividad.

Consulta [ARCHITECTURE.md](../../ARCHITECTURE.md) para los detalles por módulo y el invariante de seguridad.

## Documentación

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - flujo, mapa de módulos, invariante de seguridad y cómo extenderlo
- [examples/](../../examples/) - demos ejecutables
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - configuración de desarrollo y flujo de trabajo
- [SECURITY.md](../../SECURITY.md) - modelo de seguridad y cómo reportar problemas
- [CHANGELOG.md](../../CHANGELOG.md) - cambios destacados

## Licencia

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
