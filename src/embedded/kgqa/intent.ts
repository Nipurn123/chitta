// Intent parsing - the no-LLM heuristic for simple "who/what do I <verb>" questions.
// (The LLM path is preferred; this covers the offline case.)

import type { QuestionIntent } from "../extract"

export function heuristicIntent(q: string): QuestionIntent | null {
  // "who/what do/does/did I/you/<x> <verb>" → forward relation query
  const m = q.toLowerCase().match(/\b(who|what)\b\s+(?:do|does|did)\s+([a-z]+)\s+([a-z]+)/)
  if (m) {
    const subj = ["i", "me", "my", "we", "you"].includes(m[2]) ? "user" : m[2]
    return { type: "relation_query", subject: subj, predicate: m[3] }
  }
  return null
}
