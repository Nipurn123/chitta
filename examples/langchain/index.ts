// Chitta → LangChain adapter demo - run with:  bun run examples/langchain/index.ts
// Turns a Chitta memory into a LangChain-shaped retriever (`{ pageContent, metadata }` docs) with no
// dependency on `langchain`. Drop it into a RAG chain via `RunnableLambda`, or wrap it in a ~5-line
// `BaseRetriever` subclass (see docs/adapters.md). hash embedder + rerank off ⇒ offline + deterministic.
//
// NOTE: the `@100xprompt/chitta/adapters/langchain` subpath below needs a matching `exports` entry in
// package.json ("./adapters/langchain": "./src/adapters/langchain.ts") - added centrally by the maintainer.

import { Chitta } from "@100xprompt/chitta"
import { chittaRetriever } from "@100xprompt/chitta/adapters/langchain"

const memory = new Chitta({ embeddings: "hash", rerank: false })

// A LangChain retriever, backed by Chitta's hybrid + ACL-filtered recall.
const retriever = chittaRetriever(memory, { limit: 3 })

// Store a couple of durable facts.
await memory.remember("The launch is scheduled for March 3rd.")
await memory.remember("Our primary datastore is PostgreSQL 16.")

// Retrieve LangChain `Document`s - `{ pageContent, metadata: { score, recordId, recordName } }`.
const docs = await retriever.getRelevantDocuments("when do we launch?")
console.log("getRelevantDocuments →", docs)

// `invoke` is the newer LangChain Runnable alias for the same call.
const viaInvoke = await retriever.invoke("what database do we run?")
console.log("invoke →", viaInvoke)

memory.close()
