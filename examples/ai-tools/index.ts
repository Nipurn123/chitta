// Chitta → tool-calling adapter demo — run with:  bun run examples/ai-tools/index.ts
// Turns a Chitta memory into `{ rememberMemory, recallMemory }` tool definitions your agent can
// call. Dependency-free — the SAME shape wraps with the Vercel AI SDK, OpenAI, or Anthropic
// (see docs/adapters.md). hash embedder + rerank off ⇒ offline + deterministic for the demo.

import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const memory = new Chitta({ embeddings: "hash", rerank: false })
const tools = chittaTools(memory)

// Your agent runtime calls these `execute` functions when the model invokes the tool.
const saved = await tools.rememberMemory.execute({ text: "The launch is scheduled for March 3rd." })
console.log("rememberMemory →", saved) // { id: "mem-…" }

await tools.rememberMemory.execute({ text: "Our primary datastore is PostgreSQL 16." })

const hits = await tools.recallMemory.execute({ query: "when do we launch?", limit: 3 })
console.log("recallMemory →", hits) // [{ text: "The launch is scheduled for March 3rd.", score }, …]

memory.close()
