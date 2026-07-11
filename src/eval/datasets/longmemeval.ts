// LongMemEval loader - maps the on-disk LongMemEval JSON (github.com/xiaowu0162/LongMemEval)
// onto the frozen normalized BenchmarkDataset schema in ./types.
//
// ON-DISK SHAPE (verified against the repo README + src/retrieval/run_retrieval.py, which
// zips `haystack_session_ids`, `haystack_sessions`, `haystack_dates` and reads each turn's
// `{role, content, has_answer}`): the file is a JSON ARRAY of instances, each with:
//   question_id, question_type, question, answer, question_date,
//   haystack_session_ids: string[]            // parallel to haystack_sessions
//   haystack_dates:       string[]            // parallel to haystack_sessions
//   haystack_sessions:    Turn[][]            // list of sessions; each session a list of turns
//   answer_session_ids:   string[]            // the EVIDENCE sessions
// A Turn is { role: "user"|"assistant", content: string, has_answer?: boolean }.
//
// Each LongMemEval instance carries its OWN haystack + a single question, so it maps to ONE
// BenchmarkCase (history = its sessions, questions = [that one question]). Evidence is at
// SESSION granularity (answer_session_ids), so each session becomes one HistoryItem whose id
// is the session id - that is exactly what the evidenceIds point at.

import type {
  BenchmarkCase,
  BenchmarkDataset,
  BenchQuestion,
  DatasetLoader,
  HistoryItem,
  QuestionCategory,
} from "./types"

// --- raw on-disk shapes (only the fields we read) ---
interface LmeTurn {
  role?: string
  content?: string
  has_answer?: boolean
}
interface LmeItem {
  question_id: string
  question_type?: string
  question?: string
  answer?: string
  question_date?: string
  haystack_session_ids?: string[]
  haystack_dates?: string[]
  haystack_sessions?: LmeTurn[][]
  answer_session_ids?: string[]
}

/**
 * question_type -> QuestionCategory, per the LongMemEval README's five core abilities
 * (README: "one of single-session-user, single-session-assistant, single-session-preference,
 * temporal-reasoning, knowledge-update, and multi-session ... if question_id ends with _abs,
 * then the question is an abstention question"):
 *   single-session-*   -> single-hop
 *   multi-session      -> multi-hop
 *   temporal-reasoning -> temporal
 *   knowledge-update   -> knowledge-update
 *   *_abs (any type)   -> abstention   (handled by the isAbstention override below)
 */
function mapCategory(questionType: string | undefined, isAbstention: boolean): QuestionCategory {
  if (isAbstention) return "abstention"
  const t = questionType ?? ""
  if (t === "multi-session") return "multi-hop"
  if (t === "temporal-reasoning") return "temporal"
  if (t === "knowledge-update") return "knowledge-update"
  if (t.startsWith("single-session")) return "single-hop"
  // Unknown/renamed types default to single-hop (one fact) rather than crashing the run.
  return "single-hop"
}

/** An instance is an abstention case when its id ends with `_abs` (README convention). */
function isAbstentionItem(item: LmeItem): boolean {
  return item.question_id.endsWith("_abs") || /abstention|abstain/i.test(item.question_type ?? "")
}

/** Join a session's turns into a single record text with speaker (role) labels preserved. */
function sessionText(turns: LmeTurn[]): string {
  return turns.map((t) => `${t.role ?? "speaker"}: ${t.content ?? ""}`).join("\n")
}

function toCase(item: LmeItem): BenchmarkCase {
  const sessions = item.haystack_sessions ?? []
  const ids = item.haystack_session_ids ?? []
  const dates = item.haystack_dates ?? []

  const history: HistoryItem[] = sessions.map((turns, i) => {
    // Stable id: prefer the dataset's session id, else derive one from the instance + index.
    const id = ids[i] ?? `${item.question_id}_session_${i}`
    const h: HistoryItem = { id, text: sessionText(turns ?? []) }
    const ts = dates[i]
    if (ts) h.timestamp = ts
    return h
  })

  const abstain = isAbstentionItem(item)
  const question: BenchQuestion = {
    id: item.question_id,
    question: item.question ?? "",
    answer: item.answer ?? "",
    category: mapCategory(item.question_type, abstain),
    // Abstention questions have NO supporting evidence by contract (nothing should support them).
    evidenceIds: abstain ? [] : (item.answer_session_ids ?? []),
  }
  if (abstain) question.abstain = true

  return { id: item.question_id, history, questions: [question] }
}

async function readInstances(path: string | undefined): Promise<LmeItem[]> {
  if (!path) throw new Error("longMemEval loader requires a `path` to the dataset JSON file")
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`longMemEval dataset not found or unreadable at: ${path}`)
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new Error(`longMemEval dataset unreadable at ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`longMemEval dataset at ${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`longMemEval dataset at ${path} must be a JSON array of instances`)
  }
  return parsed as LmeItem[]
}

export const longMemEvalLoader: DatasetLoader = {
  name: "longmemeval",
  async load(opts): Promise<BenchmarkDataset> {
    const items = await readInstances(opts?.path)
    const limit = opts?.limit
    const capped = typeof limit === "number" && limit >= 0 ? items.slice(0, limit) : items
    return { name: "longmemeval", cases: capped.map(toCase) }
  },
}
