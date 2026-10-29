// How chunks look in the ingested store: size distribution and how many carry the session date.
import { Database } from "bun:sqlite"
const d = new Database(process.argv[2], { readonly: true })
const rows = d.query("SELECT virtual_record_id v, content FROM chunks").all() as Array<{ v: string; content: string }>
const lens = rows.map((r) => r.content.length).sort((a, b) => a - b)
const q = (p: number) => lens[Math.floor(p * (lens.length - 1))]
const dated = rows.filter((r) => /\(\d{4}\/\d{2}\/\d{2}/.test(r.content)).length
const perSession = new Map<string, number>()
for (const r of rows) perSession.set(r.v, (perSession.get(r.v) ?? 0) + 1)
const startsWithAssistant = rows.filter((r) => !/^(\(\d{4}|user:|assistant:)/.test(r.content)).length
console.log(JSON.stringify({
  chunks: rows.length, sessions: perSession.size,
  chunkChars: { p10: q(0.1), p50: q(0.5), p90: q(0.9) },
  under100chars: lens.filter((n) => n < 100).length,
  chunksWithDate: dated,
  chunksWithNoSpeakerOrDate: startsWithAssistant,
  chunksPerSession: { p50: [...perSession.values()].sort((a, b) => a - b)[perSession.size >> 1], max: Math.max(...perSession.values()) },
}))
