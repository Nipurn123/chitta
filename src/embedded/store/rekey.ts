// Key rotation - re-encrypt the store under a NEW CONTEXT_DB_KEY (or encrypt a
// previously-plaintext DB, or decrypt back to plaintext). Whole-file AES encryption has
// no in-place "change the key" primitive across drivers, so we do a logical copy: open the
// source with the old key, write every row into a fresh DB opened with the new key, then
// atomically swap the file into place. The audit chain, version chains, validity intervals,
// and provenance are all preserved (rows are copied verbatim); chunks are re-inserted so the
// FTS index is rebuilt. A timestamped backup of the original is kept next to the DB.

import fs from "node:fs"
import { SqliteStore } from "../sqlite-store"

// Copy a table verbatim (all columns, all rows) between two store handles. Used for the
// source-of-truth tables whose temporal/hash/provenance columns must be preserved exactly.
function copyTable(src: SqliteStore, dst: SqliteStore, table: string, conflictReplace = false): number {
  const cols = (src.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  if (cols.length === 0) return 0
  const rows = src.db.query(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>
  const verb = conflictReplace ? "INSERT OR REPLACE" : "INSERT"
  const ins = dst.db.query(`${verb} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
  for (const r of rows) ins.run(...cols.map((c) => r[c] as never))
  return rows.length
}

export interface RekeyResult {
  records: number
  edges: number
  chunks: number
  memories: number
  audit: number
  backup: string
}

/** Rotate the at-rest encryption key for the DB at `path`.
 *  - oldKey: current key ("" if the DB is currently plaintext)
 *  - newKey: desired key ("" to decrypt back to plaintext)
 *  Returns row counts + the backup path. Throws if `libsql` is needed but absent. */
export async function rekeyDatabase(path: string, oldKey: string, newKey: string): Promise<RekeyResult> {
  if (!fs.existsSync(path)) throw new Error(`no database at ${path}`)
  const prevEnv = process.env.CONTEXT_DB_KEY

  // Open the source under the old key and read every source-of-truth row.
  process.env.CONTEXT_DB_KEY = oldKey
  const src = new SqliteStore(path)

  const tmp = `${path}.rekey-${Date.now()}.tmp`
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) try { fs.unlinkSync(f) } catch {}

  // Open the destination under the new key (fresh, migrated schema).
  process.env.CONTEXT_DB_KEY = newKey
  const dst = new SqliteStore(tmp)

  let counts: RekeyResult
  try {
    const records = copyTable(src, dst, "nodes", true)
    const edges = copyTable(src, dst, "edges", true)
    const memories = copyTable(src, dst, "memories", true)
    const audit = copyTable(src, dst, "audit") // preserves id + hash chain verbatim
    // Chunks go through addChunk so the FTS (and vec, when enabled) index is rebuilt.
    const chunkRows = src.db.query("SELECT point_id, virtual_record_id, org_id, content, embedding FROM chunks").all() as Array<{
      point_id: string; virtual_record_id: string; org_id: string; content: string; embedding: string
    }>
    for (const c of chunkRows) dst.addChunk(c.point_id, c.virtual_record_id, c.org_id, c.content, JSON.parse(c.embedding) as number[])
    counts = { records, edges, chunks: chunkRows.length, memories, audit, backup: "" }
  } finally {
    src.close()
    dst.close()
    process.env.CONTEXT_DB_KEY = prevEnv // restore caller's env
  }

  // Atomic swap: back up the original, move the re-encrypted file into place.
  const backup = `${path}.bak-${Date.now()}`
  fs.renameSync(path, backup)
  for (const s of ["-wal", "-shm"]) try { fs.unlinkSync(`${path}${s}`) } catch {}
  fs.renameSync(tmp, path)
  for (const s of ["-wal", "-shm"]) try { fs.renameSync(`${tmp}${s}`, `${path}${s}`) } catch {}
  counts.backup = backup
  return counts
}
