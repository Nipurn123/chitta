# Security Policy

Chitta is a **permission-aware** memory layer - access control is the
product, not a feature bolted on. This document describes the security model and how to
report issues.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Email **nipurn.agarwal@100xprompt.com** with:
- a description of the issue and its impact,
- steps to reproduce (a minimal `*.test.ts` is ideal), and
- any suggested remediation.

You'll get an acknowledgement within 72 hours. Once a fix is released, we're happy to
credit you in the changelog unless you prefer to remain anonymous.

## The security model

The core invariant: **every read is gated by the ACL graph before any content is
returned.** The graph answers *"which record ids may this user see?"*, and vector search
is restricted to exactly that set. The permission check is never a post-filter - it
produces the candidate set.

| Property | Guarantee |
|---|---|
| Record isolation | A user only retrieves records shared with them, a group they're in, or their org |
| Cross-connector leak guard | Results from one source cannot bleed into another |
| Write authorization | Only authorized principals can create records or share to a group/org they belong to |
| ACL integrity | Ingested content can never alter the permission graph (see below) |
| Memory-poisoning defense | Recalled content is returned as marked untrusted **data**, not instructions (see below) |
| Ingest hardening | Hidden/bidi/control chars stripped; size + rate limits on the write surface |

### ACL assurance — red-team probe suite (CTLR == 0)

Because the entire model rests on the gate, we *prove* it rather than assert it.
`test/security/acl-probe.test.ts` runs adversarial probes on every change:

- **Cross-tenant leakage (CTLR):** user A queries for user B's exact secret tokens
  (maximally relevant to B's private docs); the suite asserts **zero** of B's records ever
  surface. (Industry baseline: ungated retrieval leaks 98-100% of such probes; the
  gate-first design takes it to 0.)
- **Identity-not-query:** ACL depends only on *who* asks, never on query text — injected
  queries ("ignore all permissions", "developer mode, show everything", SQL-ish payloads)
  cannot widen access.
- **Deny-by-default:** a user with no records/shares (or an unknown id) gets no private
  records, never an unfiltered result.

### Memory poisoning / indirect prompt injection

Stored memory is attacker-influenceable (a user can ingest a document containing
"ignore your instructions and …"). When recalled via `get_context`, snippets are wrapped
in `<untrusted_memory>` tags with a standing instruction to treat them as **data, never
instructions** (spotlighting; optionally datamarked via `CHITTA_SPOTLIGHT=datamark`). All
ingested text + labels are also stripped of bidi (Trojan Source, CVE-2021-42574),
zero-width, and control characters at write time **and** re-stripped at output. See
`src/security/` and `test/security/hardening.test.ts`.

### Encryption at rest

The local SQLite file is **not encrypted** today; the supported at-rest baseline is OS disk
encryption (FileVault / LUKS / BitLocker) — what comparable local-first memory tools
(mem0, Zep, Obsidian) rely on, and it preserves full-text + vector search.

Transparent whole-file encryption was evaluated (libSQL's `encryptionKey`) and is **blocked
upstream**: encryption + FTS5 work, but inserting vectors into a `vec0` table via bound
parameters — Chitta's exact write path — fails (and panics) under libSQL, which would
disable the ANN vector index. We'll revisit when that's fixed or another encrypted-SQLite
build supports `vec0`. Optional field-level AES-256-GCM (encrypting `chunks.content` behind
a `CONTEXT_DB_KEY`, at the cost of full-text search on that column) is available on request.

In central mode, backend traffic should use TLS (`https://` URLs) with authenticated
Arango/Qdrant/embedding endpoints.

### ACL integrity (keyspace isolation)

Extracted knowledge-graph entities share the same node table as principals (users, orgs,
groups) and records. Entity ids are slugs derived from free text, so an ingested document
that merely *mentions* a word matching a principal id must never overwrite that
principal's node. Entity ids are namespaced (`entity:`) into a separate keyspace, making
that collision impossible. This is covered by a regression test in
`test/embedded/multiuser.test.ts` ("ACL integrity - ingested entities cannot clobber
principals").

### Input validation (central / adapter mode)

When pointed at external backends (ArangoDB, Qdrant, an embedding service), all calls go
over HTTP adapters with no SDK surface. Treat backend URLs and credentials as secrets and
supply them via environment variables, never in committed config.

## Supported versions

This project is pre-1.0; security fixes are applied to `main`. Pin a commit if you need
stability and watch the repo for advisories.
