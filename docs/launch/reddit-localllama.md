# r/LocalLLaMA - draft

## Title

Chitta: local, zero-token knowledge-graph memory for AI agents - SQLite + bge-small (ONNX), no API keys, no cloud calls by default

## Post body

I built a memory layer for AI coding agents (Claude Code, Cursor, Codex CLI, Windsurf,
etc., over MCP) that's local by construction, not local as an afterthought. Posting here
specifically because the stack decisions were made for this crowd's constraints: no
required API key, no telemetry, no native build steps, and every model in the default path
is small enough to run on CPU.

**Why:** coding agents forget everything between sessions. You re-explain your architecture,
your conventions, your decisions, every single day. I wanted persistent memory that doesn't
mean "send my codebase to someone else's API."

**The stack, specifically:**

- **Storage:** one SQLite file (`~/.local/share/100xprompt/context.db` by default, or
  `$CONTEXT_DB`). Bun ships SQLite in-process, so there's no native build step. ANN search
  uses the [sqlite-vec](https://github.com/asg017/sqlite-vec) extension (`vec0`) when it can
  load; otherwise a brute-force cosine fallback in TS (Float32 BLOBs, zero-copy decode,
  bounded top-k - no `JSON.parse` per query). If you turn on encryption
  (`bun add libsql`, `CONTEXT_DB_KEY=<key>`, whole-file AES), the ANN index switches to
  libSQL's native DiskANN instead - you don't lose the index by encrypting the file.
- **Embeddings, default:** a dependency-free deterministic hashing embedder - character
  n-grams + word bigrams + signed feature hashing into 256 dims. Not a neural net. Zero
  downloads, zero network calls, works the instant you install it.
- **Embeddings, optional (recommended):** `bun add @huggingface/transformers`, then
  `CONTEXT_EMBEDDINGS=real`. Default model is `bge-small-en-v1.5` (384d) via transformers.js
  → ONNX runtime, in-process, CPU. One env var (`CONTEXT_EMBED_PROFILE=multilingual` →
  `bge-m3`, `on-device` → a 256d matryoshka-truncated EmbeddingGemma, etc.) switches models.
  First run downloads the weights from HF once; after that it's cached and fully offline -
  same shape as pulling a GGUF once and running it forever after.
- **Reranking, optional:** a distilled cross-encoder, `ms-marco-MiniLM-L-6-v2` (~22M params,
  int8-quantized), also via transformers.js/ONNX, also in-process. Fixes ranking after a
  BM25+dense+graph fusion pass - never a server call.
- **Extraction (building the graph):** deterministic and pattern-based by default - no LLM,
  no tokens, no network. If you want higher recall on messy conversational text, there's an
  opt-in hybrid extractor (`CONTEXT_LLM_URL=...`) that talks to **any OpenAI-compatible
  endpoint** - including your own `llama.cpp`/vLLM/Ollama server. The CLI help text calls
  this out directly: `--llm-url` is documented as "typed-triple extraction + KGQA via a
  local LLM." It is not wired to any specific cloud provider, and it is opt-in, never
  default.

**What's actually zero-token vs. optional:** "zero-token" means no LLM API calls to build or
search the memory - that part is always true, even in the fully-offline default config.
Getting the *published* recall numbers below used the optional local `bge-small` embeddings
(still zero LLM tokens, still 100% local - it's a small encoder, not a chat model). I'd
rather say that plainly than let "zero-token" imply "no models at all," which isn't quite
accurate.

**Numbers** (measured, methodology + a `chitta bench` harness ships in the repo so you can
reproduce or dispute them):

- LongMemEval recall@10: **0.782**
- LoCoMo Tier-A recall@10: **0.552** (LoCoMo has documented label-noise issues as a public
  dataset - weight LongMemEval higher if you're comparing tools)
- Both retrieval-only, zero LLM tokens spent getting there
- ~100ms per query
- On LoCoMo: retrieval hands back ~181 tokens of evidence instead of the full 25,864-token
  conversation history it was drawn from

**Install:**

```bash
curl -fsSL https://bun.sh/install | bash    # once, if you don't have Bun
bunx @100xprompt/chitta install             # auto-detects which of 17 supported tools you have
bunx @100xprompt/chitta doctor              # shows exactly which engines are active: hash vs
                                             # real embeddings, vec0 vs DiskANN, encryption, counts
```

No account, no key, no server, to get running. `--print` dumps the raw MCP config if your
client isn't auto-detected.

**Honest limitations:**

- Bun-only right now, not Node.
- The default embedder (hashing) is genuinely weaker than real semantic search - it's a
  deliberate zero-dependency floor, not a claim that it matches a real embedding model.
  Turning on `bge-small` is one env var + one optional package, not a rewrite.
- The deterministic extractor is weaker than an LLM at parsing unstructured, casual
  conversation into typed facts - the recall numbers above reflect that honestly rather
  than hiding behind an LLM-assisted number.
- Pre-1.0 (0.3.0). I've kept the SDK surface stable across releases so far, but no promises
  yet.
- Tested to 100K records/vectors on a single dev laptop. I don't have data past that, so I'm
  not claiming it.
- There's a permission-aware ACL layer and a "central-office" mode (shared ArangoDB/Qdrant
  backend) for team use, but that's a different deployment shape from what's described
  above - this post is about the single-machine, single-file, local-by-default path.

MIT-licensed. npm: `@100xprompt/chitta`. Source: github.com/Nipurn123/chitta. If you try the
local-LLM extraction hook against your own model server, I'd genuinely like to hear how the
recall numbers move - that comparison isn't something I can fully generate myself without
guessing at whatever model you're running.
