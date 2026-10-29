// Re-grade existing per-question rows: same answers, judged again with the per-type rules, every
// non-empty row treated alike. Use it when a run's judge calls may have failed silently (before
// the judge threw on "no verdict", a failed call graded a right answer wrong). Rows with an empty
// answer are DROPPED, so a resumed `--per-question` run answers those questions again.
// A judge call that fails is retried; a row whose judge never answers is dropped too (resumed).
// usage: CONTEXT_LLM_URL=... bun run rejudge.ts <longmemeval_s.json> <in.jsonl,...> <out-dir>
import { mkdirSync } from "node:fs"
import { basename, join } from "node:path"
import { longMemEvalLoader } from "../../src/eval/datasets/longmemeval"
import { httpBenchLlmFromEnv } from "../../src/eval/bench/llm"
import { judgePrediction } from "../../src/eval/bench/qa"
import type { PerQuestionRow } from "../../src/eval/bench/per-question"

const [dataPath, inputs, outDir] = process.argv.slice(2)
const judge = httpBenchLlmFromEnv()
if (!judge || !dataPath || !inputs || !outDir) throw new Error("usage: CONTEXT_LLM_URL=... bun run rejudge.ts <data.json> <rows.jsonl,...> <out-dir>")
const qs = new Map((await longMemEvalLoader.load({ path: dataPath })).cases.flatMap((c) => c.questions).map((q) => [q.id, q]))
mkdirSync(outDir, { recursive: true })
let kept = 0, flipped = 0, dropped = 0
for (const file of inputs.split(",")) {
  const rows = (await Bun.file(file).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as PerQuestionRow)
  const out: string[] = []
  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++]
      const q = qs.get(r.id)
      if (!q || !r.answer) {
        dropped++
        continue
      }
      let correct: boolean | null = null
      for (let a = 0; a < 4 && correct === null; a++) correct = await judgePrediction(q, r.answer, judge, { rethrow: true }).catch(() => null)
      if (correct === null) {
        dropped++
        continue
      }
      if (correct !== r.correct) flipped++
      kept++
      out.push(JSON.stringify({ ...r, correct }))
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  await Bun.write(join(outDir, basename(file)), out.join("\n") + (out.length ? "\n" : ""))
}
console.log(`rejudged ${kept} rows (${flipped} changed verdict), dropped ${dropped} (empty answer or no verdict) - resume to answer them`)
