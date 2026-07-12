# Chitta

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja-JP.md">日本語</a> ·
  <b>한국어</b> ·
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
  <a href="README.nl-NL.md">Nederlands</a> ·
  <a href="README.th-TH.md">ภาษาไทย</a>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"/>
  <img src="https://img.shields.io/badge/tests-124%20passing-brightgreen" alt="Tests"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun"/>
  <img src="https://img.shields.io/badge/protocol-MCP-blue" alt="MCP"/>
</p>

> 이 문서는 번역본입니다. 내용이 다를 경우 [English](../../README.md) 원문이 우선합니다.

권한을 인식하는 **지식 그래프 + 벡터 메모리**를 독립형 **MCP 서버**로 제공합니다.
모든 MCP 클라이언트(Claude Code, 100xprompt, Claude Desktop, Cursor, IDE)가 설정만으로 사용할 수 있으며 코드 변경이 필요 없습니다.

AI 어시스턴트를 한 번만 연결하면 모든 대화가 팀의 지식을 **저장·회상·추론**할 수 있고, 각 사용자는 권한이 허용하는 범위만 보게 됩니다.

> **아키텍처와 내부 구조:** [ARCHITECTURE.md](../../ARCHITECTURE.md)를 참조하세요.

- **로컬 모드(기본값):** 단일 SQLite 파일. 수집, 지식 그래프 추출, 검색까지 - 서버가 필요 없습니다.
- **센트럴 오피스 모드:** 환경 변수로 공유 백엔드(ArangoDB + Qdrant + 임베딩)를 가리키면, 조직 전체가 하나의 그래프를 공유하고 각 사용자는 자신의 ACL이 허용하는 것만 봅니다.

## 30초 만에 보기

두 명의 사용자, 하나의 저장소, 세 개의 문서 - 각 사용자는 허용된 것만 봅니다:

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

같은 질의, 다른 결과 - ACL 그래프가 벡터 인덱스에 접근하기 *전에* 후보 집합을 만들기 때문입니다. 전체 가이드: [examples/permission-aware-retrieval](../../examples/permission-aware-retrieval/).

## MCP로 노출되는 도구

| 도구 | 기능 |
|---|---|
| `context_ingest` | 텍스트 저장 → 레코드 노드 + **권한 엣지**(ACL) + **벡터 청크** + **추출된 개념 그래프** |
| `get_context` | 순위가 매겨지고 인용되며 권한으로 필터링된 스니펫을 검색 |
| `context_graph` | 사용자가 접근할 수 있는 지식 그래프(개념 + 관계)를 반환 |

## 실행하기

```bash
bun install
bun start                         # MCP server (stdio)
bun test                          # 124 tests
bun run build                     # → dist/chitta (single binary)
```

## 어떤 MCP 클라이언트에서든 사용

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

**센트럴 오피스:** 공유 백엔드 URL을 추가하면 모두가 사용자별 ACL이 적용된 하나의 그래프를 질의합니다:

```jsonc
"environment": {
  "CONTEXT_USER_ID": "alice", "CONTEXT_ORG_ID": "acme",
  "CONTEXT_ARANGO_URL": "https://office.internal/arango",
  "CONTEXT_QDRANT_URL": "https://office.internal/qdrant",
  "CONTEXT_EMBED_URL": "https://office.internal/embed",
  "CONTEXT_COLLECTION": "records"
}
```

## 동작 방식

```
ingest → record node + permission edges (ACL)      ┐
       → chunk + embed → vectors                    ├─ all in one SQLite file (local)
       → extract entities + relations → graph       ┘
query  → ACL: which records may this user see?  (graph traversal)
       → vector search restricted to those records
       → cross-connector leak guard → cited snippets
```

## 저장소(로컬 모드)

`$CONTEXT_DB` 또는 `~/.local/share/100xprompt/context.db`에 있는 단일 파일:
- `nodes` - 그래프 정점(레코드, 사용자, 조직, **엔티티**)
- `edges` - 관계(`permissions`, `belongsTo`, `mentions`, `relates_to`)
- `chunks` - 텍스트 + 임베딩 벡터
- `vec_chunks` - **sqlite-vec ANN 인덱스**(사용 가능할 때 - 아래 참조)

## 벡터 검색 - 적응형(sqlite-vec, 인프로세스)

확장 기능을 지원하는 SQLite가 있으면 저장소는 **[sqlite-vec](https://github.com/asg017/sqlite-vec)**를 로드하고 *같은 파일 안에* `vec0` ANN 인덱스를 유지합니다 - TypeScript 네이티브이며 Python이 필요 없습니다. 3,000개 벡터에서 완전 탐색보다 약 16배 빠르고, 규모가 커질수록 더 빨라집니다.

그렇지 않으면 **투명하게 완전 탐색 코사인으로 폴백**합니다 - 결과도 같고 인터페이스도 같으며 단일 바이너리 배포에 완전히 이식 가능합니다. `bun:sqlite`는 기본적으로 확장 로딩을 비활성화합니다. ANN 빠른 경로를 켜려면 확장을 지원하는 SQLite를 가리키세요(예: `brew install sqlite`, 일반 경로에서 자동 감지). 설정은 필요 없으며 `store.vecEnabled`가 활성 경로를 나타냅니다.

## 상태

구현됨: ACL 그래프, 벡터 저장소, 검색 + 누출 방지, **지식 그래프 추출**, MCP 서버(로컬 + 센트럴), fetch 기반 Arango/Qdrant/임베딩 어댑터. MCP SDK 외에 의존성이 없습니다.

다음(동일 인터페이스로 교체 가능): 의미 기반 순위를 위한 실제 임베딩(transformers.js ONNX `bge-*`); GraphRAG 검색(`relates_to` 엣지를 따라 결과 확장); 재현율을 높이는 LLM 기반 엔티티 추출.

모듈별 내부 구조와 보안 불변식은 [ARCHITECTURE.md](../../ARCHITECTURE.md)를 참조하세요.

## 문서

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - 파이프라인, 모듈 맵, 보안 불변식, 확장 방법
- [examples/](../../examples/) - 실행 가능한 데모
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - 개발 환경 설정과 작업 흐름
- [SECURITY.md](../../SECURITY.md) - 보안 모델과 문제 보고 방법
- [CHANGELOG.md](../../CHANGELOG.md) - 주요 변경 사항

## 라이선스

[MIT](../../LICENSE) © 2026 Nipurn Agarwal
