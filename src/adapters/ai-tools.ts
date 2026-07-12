// Chitta → tool-calling adapter. Turns a Chitta (or ChittaUser) memory into two plain,
// dependency-free tool definitions - `rememberMemory` and `recallMemory` - shaped as the common
// denominator across the Vercel AI SDK, OpenAI, and Anthropic tool APIs: a `description`, a
// JSON-Schema `parameters` object, and an async `execute`. No `zod`, no `ai`, no new deps -
// wrap the output with your framework's helper. See docs/adapters.md.

import type { Chitta } from "../sdk"

/** The minimal slice of a Chitta / ChittaUser these tools need. Pass a `Chitta`, a `ChittaUser`
 *  from `.user(id)` (per-user ACL), or any object with compatible `remember` / `recall`. */
export interface MemoryLike {
  remember: Chitta["remember"]
  recall: Chitta["recall"]
}

/** One property in a JSON-Schema `properties` map. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array"
  description?: string
}

/** A JSON-Schema object - the `parameters` shape every tool-calling API accepts. */
export interface JsonSchema {
  type: "object"
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

/** A framework-agnostic tool definition: description + JSON-Schema parameters + async execute.
 *  Usable as-is by the Vercel AI SDK `tool()`, and maps directly onto OpenAI / Anthropic tools. */
export interface ChittaTool<Args, Result> {
  description: string
  parameters: JsonSchema
  execute: (args: Args) => Promise<Result>
}

/** Args for `rememberMemory.execute`. */
export interface RememberArgs {
  /** The durable text to store in memory. */
  text: string
}

/** Args for `recallMemory.execute`. */
export interface RecallArgs {
  /** What to search memory for. */
  query: string
  /** Max number of snippets to return. */
  limit?: number
}

/** A ranked, cited snippet returned by `recallMemory`. */
export interface RecallResult {
  text: string
  score: number
}

/** The tools produced by `chittaTools`. */
export interface ChittaTools {
  rememberMemory: ChittaTool<RememberArgs, { id: string }>
  recallMemory: ChittaTool<RecallArgs, RecallResult[]>
}

/** Turn a Chitta / ChittaUser memory into `{ rememberMemory, recallMemory }` tool definitions for
 *  tool-calling agents. Dependency-free - wrap each with your framework's helper. See docs/adapters.md. */
export function chittaTools(memory: MemoryLike): ChittaTools {
  return {
    rememberMemory: {
      description:
        "Save a durable fact, preference, decision, or piece of context to long-term memory so it can be recalled in future turns. Use whenever the user states something worth remembering.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The durable text to remember." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args: RememberArgs): Promise<{ id: string }> => {
        const { id } = await memory.remember(args.text)
        return { id }
      },
    },
    recallMemory: {
      description:
        "Search long-term memory for snippets relevant to a query. Call before answering anything that could depend on prior context, the user's notes, people, projects, or earlier statements.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search memory for." },
          limit: { type: "integer", description: "Maximum number of snippets to return." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args: RecallArgs): Promise<RecallResult[]> => {
        const hits = await memory.recall(args.query, { limit: args.limit })
        return hits.map((h) => ({ text: h.text, score: h.score }))
      },
    },
  }
}
