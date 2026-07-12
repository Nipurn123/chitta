// Database driver selection. DEFAULT = bun:sqlite (fast, zero native deps, the path the
// whole test suite + all existing users run — untouched). When CONTEXT_DB_KEY is set, open
// an ENCRYPTED database via libSQL (transparent AES-256 whole-file encryption at rest) and
// wrap it to the exact minimal surface the store uses, so the rest of the store is driver-
// agnostic. libSQL preserves FTS5 + sqlite-vec; the one caveat (vec0 inserts must be literal,
// not bound params) is handled in store/chunks.ts via the `encrypted` flag.
import { Database } from "bun:sqlite"
import { createRequire } from "node:module"

/** The at-rest encryption key, read live from the env (so it can be set per-process). */
export function dbKey(): string {
  return process.env.CONTEXT_DB_KEY || ""
}
/** True when at-rest encryption is requested (and thus the libSQL driver is in use). */
export function isEncrypted(): boolean {
  return !!dbKey()
}

/** True when we open with the libSQL driver: for at-rest encryption (CONTEXT_DB_KEY), OR to get
 *  the native DiskANN vector index in PLAINTEXT (CONTEXT_DISKANN=1) - sub-linear ANN without
 *  encryption. Either way the handle is libSQL, so the store uses the native vector path (not
 *  the sqlite-vec extension, which libSQL can't load). Default (neither set) = bun:sqlite. */
export function useLibsql(): boolean {
  return isEncrypted() || /^(1|true|on)$/i.test(process.env.CONTEXT_DISKANN ?? "")
}

/** Open the store database. Returns a bun:sqlite-compatible handle either way. */
export function openDatabase(path: string): Database {
  const key = dbKey()
  if (!useLibsql()) return new Database(path) // default bun:sqlite, unchanged

  let mod: any
  try {
    mod = createRequire(import.meta.url)("libsql")
  } catch {
    throw new Error(
      "libSQL mode requested (CONTEXT_DB_KEY for encryption, or CONTEXT_DISKANN=1 for native ANN) " +
        "but the optional `libsql` package is not installed. Run `bun add libsql`, or unset both to " +
        "use the default bun:sqlite store.",
    )
  }
  const Ctor = mod?.default ?? mod
  // Encrypted iff a key is present; otherwise a PLAINTEXT libSQL db that still has native DiskANN.
  const raw = key ? new Ctor(path, { encryptionKey: key }) : new Ctor(path)
  // Minimal bun:sqlite-shaped facade. The store only ever calls .query(sql).{get,all,run},
  // .exec(sql), .close(), and (via sqlite-vec) .loadExtension(). libSQL's prepared
  // statements are better-sqlite3-style (.all/.get/.run with positional args + run() ->
  // { lastInsertRowid, changes }), which matches what callers expect.
  const facade = {
    query: (sql: string) => raw.prepare(sql),
    exec: (sql: string) => raw.exec(sql),
    close: () => raw.close(),
    loadExtension: (p: string, entry?: string) => raw.loadExtension(p, entry),
  }
  return facade as unknown as Database
}
