// Schema DDL + migrations + sqlite-vec load detection for the embedded store.
// Pure structural extraction from sqlite-store.ts - identical SQL, identical behavior.

import { Database } from "bun:sqlite"
import fs from "node:fs"
import * as sqliteVec from "sqlite-vec"

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
