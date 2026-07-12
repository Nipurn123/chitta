# Deploying Chitta

Production guide for running Chitta in **local mode** — one SQLite file, in-process, zero servers. (For the shared-backend "central-office" mode, see [ARCHITECTURE.md](../ARCHITECTURE.md); the ACL/retrieval logic is identical across modes — only the storage backend swaps.)

Everything below is configured with a **file path** and a handful of **env vars**. There's no daemon to run and no port to open — Chitta lives inside your process.

## 1. Persistence

By default Chitta runs against `:memory:`, which is **ephemeral** — the store vanishes when the process exits. For production, pass a durable **file path**:

```ts
import { Chitta } from "@100xprompt/chitta"
const memory = new Chitta({ path: "/var/lib/chitta/memory.db" }) // durable
```

Over MCP, set `CONTEXT_DB` (or `--db <path>` at install) instead:

```jsonc
"environment": { "CONTEXT_DB": "/var/lib/chitta/memory.db" }
```

Everything — the graph, vectors, ACL edges, atomic memories, and audit log — lives in that **single file**. Put it on durable, reasonably fast **local** storage (an SSD-backed volume). Network filesystems (NFS/EFS) can break SQLite's file locking; avoid them.

### Backups (mind the WAL)

Chitta runs SQLite in **WAL mode** for concurrency, so at rest the store is up to **three files**:

| File | Holds |
|---|---|
| `memory.db` | the main database |
| `memory.db-wal` | the write-ahead log (writes not yet merged into `.db`) |
| `memory.db-shm` | shared-memory index for the WAL |

Copying only `memory.db` while writes are in flight will miss recent data. Two safe options:

- **Checkpoint, then copy one file.** Fold the WAL back into the main file, then copy just `memory.db`:
  ```sql
  PRAGMA wal_checkpoint(TRUNCATE);
  ```
  (or simply `close()` the store — a clean shutdown checkpoints the WAL — then copy `memory.db`).
- **Copy all three together** (`.db`, `.db-wal`, `.db-shm`) as a set, while the writer is idle.

The store is a plain file, so any file-level backup, volume snapshot, or object-store upload works — just apply one of the two rules above so the WAL isn't left behind.

## 2. Encryption at rest

To encrypt the whole store transparently, add the optional libSQL driver once and set a key:

```bash
bun add libsql
export CONTEXT_DB_KEY="<32+ char secret>"
```

That gives you **transparent AES-256 whole-file encryption** (libSQL) — the file on disk is ciphertext, decrypted only in-process with the key. As a bonus it switches the vector index to libSQL's **native DiskANN**, so **encryption no longer costs you ANN** (the plaintext path relies on the sqlite-vec `vec0` extension, which can't load inside an encrypted file).

Manage the key out-of-band — a secrets manager / KMS, or an env var injected at boot. **If you lose the key, the data is unrecoverable.** Rotate with the CLI:

```bash
chitta rekey --new-key "<new>"                          # encrypt a plaintext store
CONTEXT_DB_KEY="<old>" chitta rekey --new-key "<new>"   # rotate to a new key
CONTEXT_DB_KEY="<key>" chitta rekey --new-key ""        # decrypt back to plaintext
```

The **current** key always comes from `CONTEXT_DB_KEY`, never a flag.

## 3. Scaling flags

All tuning is via env vars — bake them into your MCP `env` block, or export them before the process starts.

| Env | Default | What it does | When to set it |
|---|---|---|---|
| `CONTEXT_DISKANN` | `0` | Native **DiskANN** ANN index — sub-linear dense search on large corpora. | Large, **read-heavy**, relatively static corpora. Opt-in because ingest is much costlier — see [PERFORMANCE.md](PERFORMANCE.md). |
| `CONTEXT_DB_KEY` | — | AES-256 encryption at rest (needs `bun add libsql`); also enables native DiskANN. | Any store holding sensitive data. |
| `CONTEXT_EMBED_PROFILE` | `fast` | Embedding model: `fast` \| `english-large` \| `multilingual` \| `on-device`. | Upgrade retrieval quality or add languages. |
| `CONTEXT_EMBEDDINGS` | `auto` | `auto` (real if present, else hash) \| `hash` (offline, deterministic) \| `transformers`. | Force real semantic embeddings, or pin the offline hasher. |
| `CONTEXT_FILTER_FIRST_MAX` | `2000` | Accessible-set size at/below which dense search scans **only** a user's accessible vectors (filtered-ANN). | Raise for larger per-user slices; lower to cap worst-case scoped scans. |
| `CONTEXT_RERANK` | `1` | Cross-encoder reranker. Set `0` to disable. | Latency-sensitive paths, or to avoid the model download. |

Real embeddings need the optional package once: `bun add @huggingface/transformers` (then `CONTEXT_EMBED_PROFILE` / `CONTEXT_EMBEDDINGS` select the model). Why these flags scale the way they do — with measured numbers — is in [PERFORMANCE.md](PERFORMANCE.md).

## 4. Multi-tenant deployment

The pattern is **one store per org**. Inside that store, every user is a scoped client:

```ts
const memory = new Chitta({ path: "/var/lib/chitta/acme.db", org: "acme" })

const alice = memory.user("alice", { role: "editor", org: "acme", groups: ["eng", "sec"] })
const bob   = memory.user("bob",   { role: "viewer", org: "acme" })

await alice.remember("Q3 roadmap: ship permission-aware retrieval.")
await bob.recall("roadmap")   // → [] unless alice shared it
```

Every read is **ACL-filtered before search runs** — the permission graph produces the candidate set, and only then is the vector index touched (the [security invariant](../ARCHITECTURE.md#the-security-invariant)). A user can never see, recall, reflect on, or forget outside their slice, even though the whole org shares one graph. This is **gate-first, not a post-filter**: there's no code path where an unauthorized row becomes a candidate and gets dropped later.

Provision users at request time from **your own auth** — pass the authenticated identity, role, org, and groups into `memory.user(...)`. Never trust a client-supplied user id.

> Filtered-ANN (§3) means a **scoped** user's dense search is O(their accessible set), not O(the whole corpus) — so multi-tenancy gets *faster* per user as long as each tenant's slice stays bounded, even while the org store grows. See [PERFORMANCE.md](PERFORMANCE.md).

## 5. Resource guidance

Chitta is **in-process** — it uses your app's CPU and RAM; there's no separate service to size.

- **Memory scales with the corpus.** The graph and atomic memories are held for fast traversal, and vectors are compact Float32 BLOBs read through a 256 MB SQLite page cache (plus mmap on the plaintext path). Budget RAM in proportion to record count; a store of tens of thousands of records is comfortable on a normal app instance.
- **The reranker downloads a ~22 MB cross-encoder model on first use** (cached thereafter). In locked-down or offline environments, either pre-warm that cache in your build/image, or disable it with `CONTEXT_RERANK=0`.
- **Real embeddings** load an ONNX model too (via transformers.js) — same guidance: pre-warm the cache, or stick with the built-in `hash` embedder, which needs no download.
- **CPU is dominated by ingest** (chunk → embed → extract → belief-revision); retrieval is light. If you enable `CONTEXT_DISKANN`, expect meaningfully higher ingest cost in exchange for flat query latency at large N.

## 6. Checklist for production

- [ ] **Durable path** set (`path` / `CONTEXT_DB`), not `:memory:`, on SSD-backed **local** storage (not NFS/EFS).
- [ ] **Backups** scheduled with the WAL rule — checkpoint-then-copy `memory.db`, or copy `.db` + `.db-wal` + `.db-shm` as a set.
- [ ] **Encryption at rest** (`bun add libsql` + `CONTEXT_DB_KEY`) if the data is sensitive; key held in a secrets manager, rotation (`chitta rekey`) rehearsed.
- [ ] **Identity wired from your auth** — real user id / role / org / groups into `memory.user(...)`; never client-supplied.
- [ ] **One store per org**; confirm cross-tenant isolation (a scoped user's query returns only their slice).
- [ ] **Embedding profile** chosen (`CONTEXT_EMBED_PROFILE`); `@huggingface/transformers` installed if using real embeddings.
- [ ] **Reranker model pre-warmed** in the image, or `CONTEXT_RERANK=0` in offline environments.
- [ ] **DiskANN** (`CONTEXT_DISKANN=1`) enabled only for large, read-heavy, static corpora — verify the tradeoff in [PERFORMANCE.md](PERFORMANCE.md).
- [ ] **Health check** wired: `chitta doctor` (identity, storage, encryption, ANN, audit, embeddings, counts).
- [ ] **Audit log** enabled (`CHITTA_AUDIT=1`) if you need a tamper-evident access trail; verify with `chitta audit --verify`.

---

See also: [SDK.md](SDK.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PERFORMANCE.md](PERFORMANCE.md) · [BENCHMARKING.md](BENCHMARKING.md)
