// Schema DDL + migrations + sqlite-vec load detection for the embedded store.
// Pure structural extraction from sqlite-store.ts - identical SQL, identical behavior.

import { Database } from "bun:sqlite"
import fs from "node:fs"
import * as sqliteVec from "sqlite-vec"
import { migrateEntityAliases } from "./entities"

// setCustomSQLite must be called once, before any Database is opened. We point bun
// at an extension-capable SQLite (Homebrew / system) so sqlite-vec can load.
let triedCustomSqlite = false
export function tryEnableExtensions(): void {
  if (triedCustomSqlite) return
  triedCustomSqlite = true
  const candidates = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/lib/x86_64-linux-gnu/libsqlite3.so",
    "/usr/lib/aarch64-linux-gnu/libsqlite3.so",
  ]
  const lib = candidates.find((p) => fs.existsSync(p))
  if (!lib) return
  try {
    ;(Database as unknown as { setCustomSQLite(p: string): void }).setCustomSQLite(lib)
  } catch {
    /* already opened a DB, or unsupported - fall back to brute-force */
  }
}

export function tryLoadVec(db: Database): boolean {
  try {
    sqliteVec.load(db)
    return true
  } catch {
    return false // no extension support → brute-force path
  }
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      coll TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_coll ON nodes(coll);
    CREATE TABLE IF NOT EXISTS chunks (
      point_id TEXT PRIMARY KEY,
      virtual_record_id TEXT,
      org_id TEXT,
      content TEXT,
      embedding TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_org ON chunks(org_id);
  `)
  migrateEdges(db)
  // Confidence tier (Graphify EXTRACTED=1.0 / INFERRED≈0.8 / AMBIGUOUS≈0.5) - how
  // sure we are the relationship is real. Added idempotently so existing DBs upgrade.
  const ecols = (db.query("PRAGMA table_info(edges)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!ecols.includes("confidence")) db.exec("ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1")
  migrateMemories(db)
  migrateAudit(db)
  migrateEntityAliases(db)
}

// The AUDIT table - append-only, hash-chained tamper-evident access log (see audit.ts).
// Inherits encryption-at-rest with the rest of the store.
export function migrateAudit(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      org TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 1,
      detail TEXT NOT NULL DEFAULT '',
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor, ts);
  `)
}

// The MEMORIES table - the living-memory layer (Supermemory-style atomic memories,
// but permission-aware). Each row is ONE atomic fact, not a chunk. It carries the
// version chain (root_id/parent_id/version/is_latest), the forgetting axes
// (is_forgotten/forget_after/forget_reason), the static-vs-dynamic flag, and an ACL
// anchor (virtual_record_id - inherits the source record's permissions, exactly like
// chunks). A "current" memory has is_latest=1 AND is_forgotten=0. Contradictions
// supersede (flip is_latest, +1 version) - history is never deleted. The embedding
// makes memories semantically recallable; the subject_key groups a single-valued
// fact's versions (functional predicate) and de-duplicates re-asserted triples.
export function migrateMemories(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      virtual_record_id TEXT,
      subject_key TEXT,
      memory TEXT NOT NULL,
      embedding TEXT,
      is_static INTEGER NOT NULL DEFAULT 0,
      is_forgotten INTEGER NOT NULL DEFAULT 0,
      forget_after INTEGER,
      forget_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      parent_id TEXT,
      root_id TEXT,
      is_latest INTEGER NOT NULL DEFAULT 1,
      relation TEXT,
      source_record_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_acl ON memories(virtual_record_id, is_latest, is_forgotten);
    CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject_key, is_latest);
    CREATE INDEX IF NOT EXISTS idx_memories_root ON memories(root_id);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_record_id);
  `)
  // Memory TYPOLOGY (added idempotently so existing DBs upgrade). One table, three kinds:
  //   • 'semantic'   - timeless atomic facts (the original rows; the default).
  //   • 'episodic'   - time-anchored experiences/events. `occurred_at` is the EVENT time
  //     (valid time), distinct from created_at/updated_at (ingestion/transaction time) -
  //     memories become bi-temporal, which powers "what happened when" + Stage-3 timelines.
  //     `actor_ids` links the episode to the CANONICAL entities involved (Stage 1), so
  //     "last time I spoke with Sarah" resolves Sarah → her node → her episodes.
  //   • 'procedural' - learned how-tos / preferences (trigger → action); supersede-on-change.
  const mcols = (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name)
  if (!mcols.includes("kind")) db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'")
  if (!mcols.includes("occurred_at")) db.exec("ALTER TABLE memories ADD COLUMN occurred_at INTEGER")
  if (!mcols.includes("actor_ids")) db.exec("ALTER TABLE memories ADD COLUMN actor_ids TEXT NOT NULL DEFAULT '[]'")
  // Belief-revision trust: how sure we are this atomic fact is true (from the asserting
  // relation's confidence). A newer functional fact only SUPERSEDES the current one when it
  // is at least as confident - a low-confidence claim can't overwrite a high-confidence belief.
  if (!mcols.includes("confidence")) db.exec("ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1")
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, virtual_record_id, is_forgotten)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at)")
}

// The edges table is a property-graph relation store shared by ACL (permissions/
// belongsTo), structure (mentions), and the concept graph (relates_to / typed verbs).
// It is bi-temporal + merge-on-upsert: one row per (src,dst,label), with `weight`
// accumulating across mentions (frequency≈confidence, LightRAG), `created_at` the
// ingest time, and (valid_at, invalid_at, expired_at) the Graphiti validity axes -
// a "live" edge has expired_at IS NULL. Contradictions INVALIDATE (close the
// interval); they never delete, so history is never lost.
export function migrateEdges(db: Database): void {
  const cols = db.query("PRAGMA table_info(edges)").all() as Array<{ name: string }>
  const hasEdges = cols.length > 0
  const hasWeight = cols.some((c) => c.name === "weight")
  if (hasEdges && hasWeight) return // already current

  db.exec(`
    CREATE TABLE IF NOT EXISTS edges_new (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      label TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      valid_at INTEGER,
      invalid_at INTEGER,
      expired_at INTEGER,
      provenance TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (src, dst, label)
    );
  `)
  if (hasEdges) {
    // Fold any duplicate (src,dst,label) rows from the old schema into one,
    // carrying the duplicate COUNT forward as the starting weight.
    db.exec(`
      INSERT INTO edges_new (src, dst, label, weight, created_at)
      SELECT src, dst, label, COUNT(*), 0 FROM edges GROUP BY src, dst, label;
      DROP TABLE edges;
    `)
  }
  db.exec(`
    ALTER TABLE edges_new RENAME TO edges;
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, label);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, label);
    CREATE INDEX IF NOT EXISTS idx_edges_live ON edges(label, expired_at);
  `)
}

// Small shared placeholder helper for IN (...) clauses.
export function ph(n: number): string {
  return Array.from({ length: n }, () => "?").join(",")
}
