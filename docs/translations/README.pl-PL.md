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
  <b>Polski</b> ·
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

> To jest tłumaczenie. W razie rozbieżności obowiązuje oryginał [English](../../README.md).

Świadomy uprawnień **graf wiedzy + pamięć wektorowa**, dostarczany jako samodzielny **serwer MCP**.
Dowolny klient MCP (Claude Code, 100xprompt, Claude Desktop, Cursor, IDE) używa go przez konfigurację - bez zmian w kodzie.

Podłącz asystenta AI raz, a każda rozmowa będzie mogła **przechowywać, przypominać i wnioskować** na temat wiedzy zespołu - przy czym każdy użytkownik widzi tylko to, na co pozwalają jego uprawnienia.

> **Architektura i szczegóły wewnętrzne:** zobacz [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **Tryb lokalny (domyślny):** jeden plik SQLite. Wczytywanie, ekstrakcja grafu wiedzy i wyszukiwanie - bez serwerów.
- **Tryb biura centralnego:** wskaż przez zmienne środowiskowe współdzielony backend (ArangoDB + Qdrant + embeddingi); cała organizacja współdzieli jeden graf, a każdy użytkownik widzi tylko to, na co pozwala jego ACL.

## Zobacz w 30 sekund

Dwóch użytkowników, jedno repozytorium, trzy dokumenty - każdy widzi tylko to, na co ma pozwolenie:

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

To samo zapytanie, różne wyniki - bo graf ACL tworzy zbiór kandydatów *zanim* dotknie indeksu wektorowego. Pełny przewodnik: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## Narzędzia udostępniane przez MCP

| Narzędzie | Działanie |
|---|---|
| `context_ingest` | Zapisuje tekst → węzeł rekordu + **krawędzie uprawnień** (ACL) + **fragmenty wektorowe** + **wyekstrahowany graf pojęć** |
| `get_context` | Pobiera fragmenty uszeregowane, z cytatami i filtrowane według uprawnień |
| `context_graph` | Zwraca graf wiedzy (pojęcia + relacje), do którego użytkownik ma dostęp |

## Uruchom

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## Używaj z dowolnego klienta MCP

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

**Biuro centralne:** dodaj adresy URL współdzielonego backendu, aby wszyscy odpytywali jeden graf z ACL per użytkownik:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## Jak to działa

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## Przechowywanie (tryb lokalny)

Jeden plik w `$CONTEXT_DB` lub `~/.local/share/100xprompt/context.db`:
- `nodes` - wierzchołki grafu (rekordy, użytkownicy, organizacje, **encje**)
- `edges` - relacje (`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - tekst + wektory embeddingów
- `vec_chunks` - **indeks ANN sqlite-vec** (gdy dostępny - patrz niżej)

## Wyszukiwanie wektorowe - adaptacyjne (sqlite-vec, w procesie)

Jeśli dostępny jest SQLite z obsługą rozszerzeń, magazyn ładuje **[sqlite-vec](https://github.com/asg017/sqlite-vec)** i utrzymuje indeks ANN `vec0` *w tym samym pliku* - natywnie w TypeScript, bez Pythona. Około 16× szybszy niż przeszukiwanie siłowe przy 3000 wektorach, a przy większej skali jeszcze bardziej.

W przeciwnym razie **przejrzyście wraca do kosinusa metodą siłową** - te same wyniki, ten sam interfejs i pełna przenośność dla pojedynczego pliku binarnego. `bun:sqlite` domyślnie wyłącza ładowanie rozszerzeń; aby włączyć szybką ścieżkę ANN, wskaż SQLite z rozszerzeniami (np. `brew install sqlite`, wykrywany automatycznie w typowych ścieżkach). Bez konfiguracji - `store.vecEnabled` odzwierciedla aktywną ścieżkę.

## Status

Zaimplementowano: graf ACL, magazyn wektorowy, wyszukiwanie + ochronę przed wyciekiem, **ekstrakcję grafu wiedzy**, serwer MCP (lokalny + centralny) oraz adaptery Arango/Qdrant/embeddingów oparte na fetch. Brak zależności poza SDK MCP.

Dalej (wymienne, ten sam interfejs): prawdziwe embeddingi (transformers.js ONNX `bge-*`) do rankingu semantycznego; wyszukiwanie GraphRAG (rozszerzanie wyników wzdłuż krawędzi `relates_to`); ekstrakcja encji oparta na LLM dla wyższej kompletności.

Szczegóły moduł po module oraz niezmiennik bezpieczeństwa znajdziesz w [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Dokumentacja

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - potok, mapa modułów, niezmiennik bezpieczeństwa i rozszerzanie
- [examples/](../../examples/) - uruchamialne dema
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - konfiguracja deweloperska i przepływ pracy
- [SECURITY.md](../../SECURITY.md) - model bezpieczeństwa i zgłaszanie problemów
- [CHANGELOG.md](../../CHANGELOG.md) - istotne zmiany

## Licencja

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
