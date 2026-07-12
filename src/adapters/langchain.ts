// Chitta → LangChain adapter. LangChain's retriever and chat-memory contracts are *structural*, so
// Chitta can plug into a LangChain app WITHOUT depending on `langchain` / `@langchain/*`. We just
// produce the shapes LangChain expects: a retriever returns `Document[]` (`{ pageContent, metadata }`),
// and a `BaseMemory` exposes `loadMemoryVariables` / `saveContext`. No `langchain`, no `zod`, no new
// deps - drop these into a chain (or wrap the retriever in a 5-line `BaseRetriever`). See docs/adapters.md.

import type { Chitta } from "../sdk"

/** The minimal slice of a Chitta / ChittaUser these adapters need. Pass a `Chitta`, a `ChittaUser`
 *  from `.user(id)` (per-user ACL), or any object with compatible `remember` / `recall`. */
export interface MemoryLike {
  remember: Chitta["remember"]
  recall: Chitta["recall"]
}

/** A LangChain `Document` - the exact shape a retriever returns. Structurally assignable to
 *  `@langchain/core`'s `Document` (whose `metadata` is `Record<string, any>`). */
export interface LcDocument {
  pageContent: string
  metadata: Record<string, unknown>
}

/** Options for `chittaRetriever`. */
export interface RetrieverOptions {
  /** Max documents to return - maps to Chitta's recall `limit`. */
  limit?: number
}

/** A dependency-free LangChain retriever: `getRelevantDocuments` (legacy name) plus `invoke` (the
 *  newer Runnable name), both returning `LcDocument[]`. Wrap in a `BaseRetriever` subclass to get a
 *  first-class, pipeable retriever (see docs/adapters.md). */
export interface ChittaRetriever {
  getRelevantDocuments(query: string): Promise<LcDocument[]>
  invoke(query: string): Promise<LcDocument[]>
}

/** Turn a Chitta / ChittaUser memory into a LangChain-shaped retriever. Each recall hit becomes a
 *  `Document` whose `pageContent` is the snippet text and whose `metadata` carries the citation
 *  (`score`, `recordId`, `recordName`). Dependency-free. See docs/adapters.md. */
export function chittaRetriever(memory: MemoryLike, opts: RetrieverOptions = {}): ChittaRetriever {
  const getRelevantDocuments = async (query: string): Promise<LcDocument[]> => {
    const hits = await memory.recall(query, { limit: opts.limit })
    return hits.map((h) => ({
      pageContent: h.text,
      metadata: { score: h.score, recordId: h.recordId, recordName: h.recordName },
    }))
  }
  // `invoke` is LangChain's newer Runnable alias for the same call.
  return { getRelevantDocuments, invoke: getRelevantDocuments }
}

/** The chain input values LangChain hands to `loadMemoryVariables` / `saveContext`. We read `input`
 *  as the recall query (and store it as the human turn); other keys are ignored. */
export interface ChatInputValues {
  input?: string
  [k: string]: unknown
}

/** Options for `chittaChatMemory`. */
export interface ChatMemoryOptions {
  /** How many relevant memories to load into the block. Default 5. */
  limit?: number
  /** Variable name the loaded block is returned under - LangChain's `memoryKey`. Default "history". */
  memoryKey?: string
}

/** A dependency-free LangChain `BaseMemory`: `loadMemoryVariables` returns the relevant memory as a
 *  string block under `memoryKey`; `saveContext` persists the turn via `remember`. `memoryKeys` is
 *  included for `BaseMemory` structural compatibility. */
export interface ChittaChatMemory {
  memoryKey: string
  memoryKeys: string[]
  loadMemoryVariables(values?: ChatInputValues): Promise<{ [k: string]: string }>
  saveContext(input: { input: string }, output: { output: string }): Promise<void>
}

/** Turn a Chitta / ChittaUser memory into LangChain chat memory. On each turn LangChain calls
 *  `loadMemoryVariables(inputs)` (we recall memories relevant to `inputs.input` and return them as a
 *  block) then `saveContext(inputs, outputs)` (we `remember` the exchange). Minimal + stateless - the
 *  "history" is Chitta's ranked recall, not a raw transcript. See docs/adapters.md. */
export function chittaChatMemory(memory: MemoryLike, opts: ChatMemoryOptions = {}): ChittaChatMemory {
  const memoryKey = opts.memoryKey ?? "history"
  const limit = opts.limit ?? 5
  return {
    memoryKey,
    memoryKeys: [memoryKey],
    async loadMemoryVariables(values: ChatInputValues = {}): Promise<{ [k: string]: string }> {
      const query = typeof values.input === "string" ? values.input : ""
      const hits = query.length > 0 ? await memory.recall(query, { limit }) : []
      return { [memoryKey]: hits.map((h) => h.text).join("\n") }
    },
    async saveContext(input: { input: string }, output: { output: string }): Promise<void> {
      await memory.remember(`Human: ${input.input}\nAI: ${output.output}`)
    },
  }
}
