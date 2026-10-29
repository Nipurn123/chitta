// Pooled-haystack LongMemEval: every session from all 500 questions goes into ONE store, so
// each question must find its evidence among all 940 sessions (vs its own ~1-6 in the oracle
// file). Same record format as Chitta's own bench (src/eval/bench/ingest.ts): "(date): text".
// usage: bun run lme-ingest.ts <db> [limitSessions]
import { buildEmbeddedContext } from "../../src/embedded/index"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"

const SRC = process.env.LME_DATA ?? `${import.meta.dir}/longmemeval_oracle.json`
const [db, limitArg] = [process.argv[2], process.argv[3]]
const limit = limitArg ? Number(limitArg) : Infinity
for (const s of ["", "-wal", "-shm"]) if (existsSync(db + s)) unlinkSync(db + s)

const data = (await Bun.file(SRC).json()) as any[]
const sessions = new Map<string, { date: string; text: string }>()
for (const q of data)
  q.haystack_session_ids.forEach((sid: string, i: number) => {
    if (!sessions.has(sid))
      sessions.set(sid, { date: q.haystack_dates[i], text: q.haystack_sessions[i].map((t: any) => `${t.role}: ${t.content}`).join("\n") })
  })
writeFileSync(
  `${import.meta.dir}/lme-questions.json`,
  JSON.stringify(data.map((q) => ({ id: q.question_id, type: q.question_type, abs: q.question_id.endsWith("_abs"), question: q.question, answer: String(q.answer), gold: q.answer_session_ids }))),
)

const ctx = buildEmbeddedContext({ path: db })
ctx.ingestor.registerUser("u", "o", "u@o.com", "admin")
const t0 = performance.now()
let n = 0, chars = 0
for (const [sid, s] of sessions) {
  if (n >= limit) break
  await ctx.authorizedIngest("u", { recordId: sid, orgId: "o", recordName: sid, text: `(${s.date}): ${s.text}`, permittedPrincipals: ["u"] })
  n++; chars += s.text.length
  if (n % 50 === 0) console.log(`${n}/${sessions.size} sessions  ${((performance.now() - t0) / 1000).toFixed(0)}s`)
}
const secs = (performance.now() - t0) / 1000
const st: any = ctx.store
const chunks = st.db.query("SELECT COUNT(*) AS n FROM chunks").get().n
console.log(JSON.stringify({ sessions: n, chars, chunks, ingestSeconds: +secs.toFixed(1), msPerSession: +((secs * 1000) / n).toFixed(1) }))
