// LoCoMo loader - maps the on-disk LoCoMo JSON (snap-research/locomo, `data/locomo10.json`,
// the format Mem0's benchmark consumes) onto the frozen normalized BenchmarkDataset in ./types.
//
// ON-DISK SHAPE (verified by inspecting data/locomo10.json directly): the file is a JSON ARRAY
// of samples, each with:
//   sample_id: string
//   conversation: {
//     speaker_a, speaker_b: string
//     session_<N>: Turn[]                 // N = 1..K, dialogue turns for that session
//     session_<N>_date_time: string       // e.g. "1:56 pm on 8 May, 2023"
//   }
//   qa: Qa[]
// A Turn is { speaker, dia_id, text, img_url?, blip_caption?, query? } where dia_id looks like
// "D2:8" (session:turn) and is UNIQUE within a sample. A Qa is
//   { question, answer, evidence: string[], category: 1..5 }  for categories 1-4, and
//   { question, adversarial_answer, evidence: string[], category: 5 } for the adversarial set.
// `evidence` entries are dia_ids, i.e. TURN granularity - so each turn becomes one HistoryItem
// whose id is its dia_id, and evidenceIds point straight at those ids.

import type {
  BenchmarkCase,
  BenchmarkDataset,
  BenchQuestion,
  DatasetLoader,
  HistoryItem,
  QuestionCategory,
} from "./types"

// --- raw on-disk shapes (only the fields we read) ---
interface LocomoTurn {
  speaker?: string
  dia_id?: string
  text?: string
  blip_caption?: string
  img_url?: string[]
}
interface LocomoQa {
  question?: string
  answer?: string | number
  adversarial_answer?: string | number
  evidence?: string[]
  category?: number
}
type LocomoConversation = Record<string, unknown> & {
  speaker_a?: string
  speaker_b?: string
}
interface LocomoSample {
  sample_id?: string
  conversation?: LocomoConversation
  qa?: LocomoQa[]
}

/**
 * LoCoMo integer category -> QuestionCategory.
 *
 * VERIFIED mapping. LoCoMo's paper (Maharana et al., "Evaluating Very Long-Term Conversational
 * Memory of LLM Agents", ACL 2024) and the snap-research/locomo repo define five QA types, and
 * downstream benchmarks (e.g. Mem0's evaluation harness) encode them as ints 1-5:
 *   1 = multi-hop retrieval        -> multi-hop
 *   2 = temporal reasoning         -> temporal
 *   3 = open-domain knowledge      -> open-domain
 *   4 = single-hop retrieval       -> single-hop
 *   5 = adversarial / unanswerable -> abstention  (uses `adversarial_answer`; the correct
 *                                                   behavior is to NOT answer)
 */
function mapCategory(category: number | undefined): QuestionCategory {
  switch (category) {
    case 1:
      return "multi-hop"
    case 2:
      return "temporal"
    case 3:
      return "open-domain"
    case 4:
      return "single-hop"
    case 5:
      return "abstention"
    default:
      // Unknown/missing category defaults to single-hop rather than crashing the run.
      return "single-hop"
  }
}

/** Session numbers present as real turn arrays, in NUMERIC order (session_2 before session_10). */
function orderedSessionNumbers(conv: LocomoConversation): number[] {
  const nums: number[] = []
  for (const key of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(key)
    if (m && Array.isArray(conv[key])) nums.push(Number(m[1]))
  }
  return nums.sort((a, b) => a - b)
}

/** A turn's stored text - the utterance, plus any shared-image caption so the record is complete. */
function turnText(turn: LocomoTurn): string {
  const base = turn.text ?? ""
  if (turn.blip_caption) {
    return base ? `${base} [shared photo: ${turn.blip_caption}]` : `[shared photo: ${turn.blip_caption}]`
  }
  return base
}

function toCase(sample: LocomoSample, index: number): BenchmarkCase {
  const conv = sample.conversation ?? {}
  const caseId = sample.sample_id ?? `locomo_${index}`

  const history: HistoryItem[] = []
  for (const n of orderedSessionNumbers(conv)) {
    const turns = (conv[`session_${n}`] as LocomoTurn[]) ?? []
    const date = conv[`session_${n}_date_time`] as string | undefined
    for (const turn of turns) {
      if (!turn?.dia_id) continue // dia_id is the record id + the evidence label; skip malformed turns
      const h: HistoryItem = { id: turn.dia_id, text: turnText(turn) }
      if (turn.speaker) h.speaker = turn.speaker
      if (date) h.timestamp = date // carry the session date so temporal questions have a time anchor
      history.push(h)
    }
  }

  const questions: BenchQuestion[] = (sample.qa ?? []).map((qa, qi) => {
    const abstain = qa.category === 5
    // Category 5 stores its (deliberately unsupported) gold under `adversarial_answer`.
    const rawAnswer = abstain ? qa.adversarial_answer ?? qa.answer : qa.answer
    const q: BenchQuestion = {
      id: `${caseId}_q${qi}`,
      question: qa.question ?? "",
      answer: rawAnswer === undefined || rawAnswer === null ? "" : String(rawAnswer),
      category: mapCategory(qa.category),
      // Abstention questions carry NO supporting evidence by contract.
      evidenceIds: abstain ? [] : (qa.evidence ?? []),
    }
    if (abstain) q.abstain = true
    return q
  })

  return { id: caseId, history, questions }
}

async function readSamples(path: string | undefined): Promise<LocomoSample[]> {
  if (!path) throw new Error("locomo loader requires a `path` to the dataset JSON file")
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`locomo dataset not found or unreadable at: ${path}`)
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new Error(`locomo dataset unreadable at ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`locomo dataset at ${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`locomo dataset at ${path} must be a JSON array of samples`)
  }
  return parsed as LocomoSample[]
}

export const locomoLoader: DatasetLoader = {
  name: "locomo",
  async load(opts): Promise<BenchmarkDataset> {
    const samples = await readSamples(opts?.path)
    const limit = opts?.limit
    const capped = typeof limit === "number" && limit >= 0 ? samples.slice(0, limit) : samples
    return { name: "locomo", cases: capped.map((s, i) => toCase(s, i)) }
  },
}
