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
