// Confirms the store was built with the real bge-small embedder (384 float32 = 1536 bytes),
// not the 256-dim hashing fallback. usage: bun run check-emb.ts <db>
import { Database } from "bun:sqlite"
const d = new Database(process.argv[2], { readonly: true })
const r = d.query("SELECT length(embedding) AS bytes, COUNT(*) AS chunks FROM chunks").get() as { bytes: number; chunks: number }
console.log(JSON.stringify({ ...r, dim: r.bytes / 4 }))
