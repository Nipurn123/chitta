// The keyword (FTS5) leg in isolation on a pooled store: which tokenizer + query handling ranks
// the gold sessions best? Builds an unstemmed copy of the index next to the porter one and scores
// record-level all-gold@10 / recall@10 per variant. Run on a COPY of the store (it adds a table).
// usage: bun run fts-exp.ts <store-copy.db> <lme-questions.json>
import { Database } from "bun:sqlite"

const [dbPath, qPath] = process.argv.slice(2)
const db = new Database(dbPath)
db.exec("DROP TABLE IF EXISTS fts_plain; CREATE VIRTUAL TABLE fts_plain USING fts5(content); INSERT INTO fts_plain(rowid, content) SELECT rowid, content FROM chunks;")
const vidOf = new Map((db.query("SELECT rowid r, virtual_record_id v FROM chunks").all() as Array<{ r: number; v: string }>).map((x) => [x.r, x.v]))
const recOf = new Map(
  (db.query("SELECT id, json_extract(data,'$.virtualRecordId') v FROM nodes WHERE coll = 'records'").all() as Array<{ id: string; v: string }>).map((x) => [x.v, x.id]),
)
// same list as src/embedded/store/fts.ts
const STOP = new Set(
  ("a an the and or but if then than so of to in on at for with from by as into about over after before " +
    "is are was were be been being am do does did doing done have has had having can could would should will shall may might must " +
    "i me my mine myself you your yours we us our ours he him his she her hers it its they them their theirs " +
    "this that these those what which who whom whose when where why how there here just also very any some all").split(" "),
)
const qs = ((await Bun.file(qPath).json()) as Array<{ id: string; type: string; abs: boolean; question: string; gold: string[] }>).filter((q) => !q.abs)

for (const [table, stop] of [["fts_plain", false], ["fts_plain", true], ["chunks_fts", false], ["chunks_fts", true]] as const) {
  let all = 0, rk = 0
  const byType = new Map<string, [number, number]>()
  for (const q of qs) {
    const raw = [...new Set((q.question.toLowerCase().match(/[\p{L}\p{N}£$€%.\-]+/gu) ?? []).filter((t) => t.replace(/[^a-z0-9]/g, "").length >= 2))]
    const kept = stop ? raw.filter((t) => !STOP.has(t)) : raw
    const terms = kept.length ? kept : raw
    const rowids = terms.length
      ? (db.query(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT 400`).all(terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")) as Array<{ rowid: number }>)
      : []
    const ranked: string[] = []
    for (const { rowid } of rowids) {
      const rec = recOf.get(vidOf.get(rowid)!) ?? vidOf.get(rowid)!
      if (!ranked.includes(rec)) ranked.push(rec)
      if (ranked.length >= 10) break
    }
    const hit = q.gold.filter((g) => ranked.includes(g)).length
    const pass = hit === q.gold.length ? 1 : 0
    all += pass
    rk += hit / q.gold.length
    const t = byType.get(q.type) ?? [0, 0]
    byType.set(q.type, [t[0] + pass, t[1] + 1])
  }
  const types = [...byType].map(([t, [p, n]]) => `${t.replace("single-session-", "ss-")}:${(p / n).toFixed(2)}`).join(" ")
  console.log(`${table === "chunks_fts" ? "porter " : "plain  "} stopwords=${stop ? "drop" : "keep"}  all@10 ${(all / qs.length).toFixed(3)}  R@10 ${(rk / qs.length).toFixed(3)}  | ${types}`)
}
