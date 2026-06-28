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
  <b>Português</b> ·
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

> Esta é uma tradução. Em caso de divergência, prevalece o [English](../../README.md) original.

**Grafo de conhecimento + memória vetorial** com reconhecimento de permissões, entregue como **servidor MCP** independente.
Qualquer cliente MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDEs) usa via configuração, sem alterar código.

Conecte seu assistente de IA uma vez e cada conversa poderá **armazenar, lembrar e raciocinar** sobre o conhecimento da sua equipe, com cada usuário vendo apenas o que suas permissões permitem.

> **Arquitetura e internos:** consulte [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Modo local (padrão):** um único arquivo SQLite. Ingere, extrai um grafo de conhecimento e recupera, sem servidores.
- **Modo escritório central:** aponte para um backend compartilhado (ArangoDB + Qdrant + embeddings) por variáveis de ambiente; toda a organização compartilha um grafo e cada usuário vê apenas o que sua ACL permite.

## Veja em 30 segundos

Dois usuários, um repositório, três documentos: cada usuário vê apenas o que lhe é permitido:

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

Mesma consulta, resultados diferentes, porque o grafo de ACL produz o conjunto de candidatos *antes* de tocar no índice vetorial. Passo a passo completo: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Ferramentas expostas via MCP

| Ferramenta | O que faz |
|---|---|
| `context_ingest` | Armazena texto → nó de registro + **arestas de permissão** (ACL) + **trechos vetoriais** + **grafo de conceitos extraído** |
| `get_context` | Recupera trechos ranqueados, citados e filtrados por permissão |
| `context_graph` | Retorna o grafo de conhecimento (conceitos + relações) que o usuário pode acessar |

## Executar

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Use a partir de qualquer cliente MCP

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

**Escritório central:** adicione as URLs do backend compartilhado para que todos consultem um grafo com ACL por usuário:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Como funciona

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Armazenamento (modo local)

Um arquivo em `$CONTEXT_DB` ou `~/.local/share/100xprompt/context.db`:
- `nodes` - vértices do grafo (registros, usuários, organizações, **entidades**)
- `edges` - relações (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - texto + vetores de embedding
- `vec_chunks` - **índice ANN do sqlite-vec** (quando disponível - veja abaixo)

## Busca vetorial - adaptativa (sqlite-vec, em processo)

Se houver um SQLite com suporte a extensões, o repositório carrega **[sqlite-vec](https://github.com/asg017/sqlite-vec)** e mantém um índice ANN `vec0` *no mesmo arquivo* - nativo em TypeScript e sem Python. Cerca de 16× mais rápido que a força bruta com 3000 vetores, e mais em escala maior.

Caso contrário, ele **recorre de forma transparente ao cosseno por força bruta** - mesmos resultados, mesma interface e totalmente portátil para o binário único. O `bun:sqlite` desativa o carregamento de extensões por padrão; para ativar o caminho rápido ANN, aponte para um SQLite com extensões (ex.: `brew install sqlite`, detectado automaticamente em caminhos comuns). Sem configuração: `store.vecEnabled` reflete o caminho ativo.

## Status

Implementado: grafo ACL, repositório vetorial, recuperação + proteção contra vazamento, **extração de grafo de conhecimento**, servidor MCP (local + central) e adaptadores Arango/Qdrant/embeddings baseados em fetch. Sem dependências além do SDK do MCP.

A seguir (substituível, mesma interface): embeddings reais (transformers.js ONNX `bge-*`) para ranqueamento semântico; recuperação GraphRAG (expandir resultados ao longo das arestas `relates_to`); extração de entidades por LLM para maior abrangência.

Veja [ARCHITECTURE.md](../../ARCHITECTURE.md) para os detalhes módulo a módulo e o invariante de segurança.

## Documentação

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - pipeline, mapa de módulos, invariante de segurança e como estender
- [examples/](../../examples/) - demos executáveis
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - configuração de desenvolvimento e fluxo de trabalho
- [SECURITY.md](../../SECURITY.md) - modelo de segurança e como relatar problemas
- [CHANGELOG.md](../../CHANGELOG.md) - mudanças relevantes

## Licença

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
