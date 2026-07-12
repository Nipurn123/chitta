# Framework adapters

Chitta's memory is just two async methods — `remember` and `recall`. The **ai-tools adapter** wraps them as ready-made *tool definitions* so a tool-calling agent (Vercel AI SDK, OpenAI, Anthropic) can decide, on its own, when to save to and read from long-term memory.

```bash
bun add @100xprompt/chitta
```

## What `chittaTools` gives you

```ts
import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const memory = new Chitta({ path: "./memory.db" })
const tools = chittaTools(memory) // pass a Chitta, or memory.user("alice") for per-user ACL
```

`tools` is `{ rememberMemory, recallMemory }`. Each entry is a **plain, dependency-free** object shaped as the common denominator across the major tool-calling APIs:

```ts
{
  description: string,                 // tells the model when to call it
  parameters: { type: "object", ... }, // a JSON Schema (no zod, no framework types)
  execute: (args) => Promise<...>,     // runs the real Chitta call
}
```

| Tool | `parameters` | `execute` returns |
|---|---|---|
| `rememberMemory` | `{ text: string }` | `{ id }` — the stored record id |
| `recallMemory` | `{ query: string, limit?: number }` | `Array<{ text, score }>` — ranked, cited snippets |

Because the shape is generic, you adapt it to each framework by mapping the same three fields onto that framework's tool type. `execute` is already wired to Chitta — you never re-implement it.

> **Runnable example:** [`examples/ai-tools/index.ts`](../examples/ai-tools/index.ts) — `bun run examples/ai-tools/index.ts`.

---

## Vercel AI SDK

Wrap each tool with `tool()` and hand its JSON-Schema `parameters` to `jsonSchema()`. `execute` passes straight through.

```ts
import { generateText, tool, jsonSchema } from "ai"
import { openai } from "@ai-sdk/openai"
import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const memory = new Chitta({ path: "./memory.db" })
const t = chittaTools(memory)

const tools = {
  rememberMemory: tool({
    description: t.rememberMemory.description,
    parameters: jsonSchema(t.rememberMemory.parameters),
    execute: t.rememberMemory.execute,
  }),
  recallMemory: tool({
    description: t.recallMemory.description,
    parameters: jsonSchema(t.recallMemory.parameters),
    execute: t.recallMemory.execute,
  }),
}

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools,
  maxSteps: 5, // let the model call recall/remember, then answer
  prompt: "Remember that our launch is March 3rd, then tell me when we launch.",
})
```

`jsonSchema()` accepts the raw JSON Schema object the adapter already produces, so there is nothing to translate. (Newer AI SDK versions name the field `inputSchema` instead of `parameters` — rename the key if your version requires it; the value is unchanged.)

---

## OpenAI (function tools)

OpenAI's Chat Completions API uses `{ type: "function", function: { name, description, parameters } }` — a direct mapping of the adapter's fields. Dispatch the model's tool calls back through `execute`.

```ts
import OpenAI from "openai"
import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const client = new OpenAI()
const memory = new Chitta({ path: "./memory.db" })
const t = chittaTools(memory)

const tools = Object.entries(t).map(([name, def]) => ({
  type: "function" as const,
  function: { name, description: def.description, parameters: def.parameters },
}))

const res = await client.chat.completions.create({
  model: "gpt-4o",
  tools,
  messages: [{ role: "user", content: "What did we decide about the launch date?" }],
})

for (const call of res.choices[0].message.tool_calls ?? []) {
  const args = JSON.parse(call.function.arguments)
  // Narrow by tool name so the args are typed and execute() is called safely.
  if (call.function.name === "rememberMemory") {
    const out = await t.rememberMemory.execute(args) // { id }
    // → append a { role: "tool", tool_call_id: call.id, content: JSON.stringify(out) } message
  } else if (call.function.name === "recallMemory") {
    const out = await t.recallMemory.execute(args) // [{ text, score }]
    // → append the tool result the same way, then call the API again to get the final answer
  }
}
```

---

## Anthropic (Messages API tools)

Anthropic names the schema field `input_schema` (everything else lines up). Map the adapter's `parameters` onto it, then feed `tool_use` blocks back through `execute`.

```ts
import Anthropic from "@anthropic-ai/sdk"
import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const client = new Anthropic()
const memory = new Chitta({ path: "./memory.db" })
const t = chittaTools(memory)

const tools = Object.entries(t).map(([name, def]) => ({
  name,
  description: def.description,
  input_schema: def.parameters, // Anthropic calls it input_schema
}))

const res = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "Remember our launch is March 3rd, then tell me when we launch." }],
})

for (const block of res.content) {
  if (block.type !== "tool_use") continue
  if (block.name === "rememberMemory") {
    const out = await t.rememberMemory.execute(block.input as { text: string })
    // → return a { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) } block next turn
  } else if (block.name === "recallMemory") {
    const out = await t.recallMemory.execute(block.input as { query: string; limit?: number })
    // → return the tool_result block, then call messages.create again for the final answer
  }
}
```

---

## Per-user memory (the ACL moat)

`chittaTools` accepts anything with a compatible `remember` / `recall` — including a **user-scoped** client. Give each end-user their own tools and every recall is filtered to what that user is allowed to see, enforced before search:

```ts
const memory = new Chitta({ path: "./memory.db" })

function toolsFor(userId: string) {
  return chittaTools(memory.user(userId)) // scoped to this principal's ACL
}

// alice's agent can never recall bob's private memories
const aliceTools = toolsFor("alice")
```

See [SDK.md](./SDK.md) for the underlying `remember` / `recall` semantics (hybrid retrieval, self-correcting facts, bi-temporal history) and the multi-tenant permission model.
