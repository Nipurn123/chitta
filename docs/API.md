# Chitta SDK - API reference

A complete reference for the embeddable **Chitta** SDK: the `Chitta` class, per-user `ChittaUser`
scopes, the graph namespace, every option/return type, the typed errors, the `onEvent` hook, and
the `chittaTools` framework adapter. For a narrative walkthrough see [SDK.md](SDK.md); for tone and
scaling flags see [PERFORMANCE.md](PERFORMANCE.md).

Everything here is **in-process** (Bun + `bun:sqlite`), **permission-aware**, and **zero-token** -
no servers, no LLM in the retrieve/remember path.

```bash
bun add @100xprompt/chitta
```

## Imports

| Import | From | What |
|---|---|---|
| `Chitta`, `ChittaUser` | `@100xprompt/chitta` | The classes. `Chitta` also at `@100xprompt/chitta/sdk`. |
| `ChittaOptions`, `RememberOptions`, `Recalled`, `Entity`, `Relation` | `@100xprompt/chitta` | Public SDK types. |
| `ChittaError`, `ConfigError` | `@100xprompt/chitta` | Typed errors. |
| `chittaTools` | `@100xprompt/chitta` or `@100xprompt/chitta/adapters/ai-tools` | Tool-calling adapter. |

```ts
import { Chitta } from "@100xprompt/chitta"
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"
```

---

## `class Chitta`

The single entry point. The single-user convenience methods (`remember`, `recall`, …) operate as a
default **admin** user (`userId: "me"`) in the configured org; for multi-tenant per-user ACL use
[`.user(id)`](#user). The full low-level engine is always reachable at [`.ctx`](#escape-hatch-ctx).

```ts
const memory = new Chitta({ path: "./memory.db" })
await memory.remember("The launch is March 3rd.")
const hits = await memory.recall("when do we launch?")
memory.close()
```

### `new Chitta(opts?: ChittaOptions)`

Validates the options (throws [`ConfigError`](#errors) on bad input), then builds the engine.

#### `ChittaOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `":memory:"` | SQLite file path. `":memory:"` is ephemeral; a real path persists across runs. |
| `embeddings` | `"auto" \| "hash" \| "transformers" \| EmbeddingProvider` | `"auto"` | `"auto"` = real semantic embeddings with a hash fallback; `"hash"` = offline/deterministic/fast; `"transformers"` = force the real model; or pass your own `EmbeddingProvider`. |
| `embedModel` | `string` | `undefined` | Override the transformers model (e.g. a multilingual one). See also `CONTEXT_EMBED_PROFILE`. |
| `rerank` | `boolean` | `true` | Cross-encoder reranker (downloads a small model on first use; degrades to RRF order if unavailable). Set `false` for the fastest / fully-offline path. |
| `org` | `string` | `"default-org"` | Default organization id for the single-user API (multi-tenant uses `.user(id, { org })`). |
| `onEvent` | `(e: { op: string; ms: number; count?: number }) => void` | `undefined` | Observability hook - see [`onEvent`](#observability-onevent). |

Invalid input fails fast: an unknown `embeddings` string, or a non-string / empty `path`, throws
`ConfigError` before the engine is built.

### Properties

| Property | Type | Description |
|---|---|---|
| `ctx` | `EmbeddedContext` | The full low-level engine (escape hatch). See [below](#escape-hatch-ctx). |

### Methods

Single-user convenience - each delegates to the built-in admin user. Signatures:

| Method | Signature | Returns | Behavior |
|---|---|---|---|
| `remember` | `(text: string, opts?: RememberOptions)` | `Promise<{ id: string }>` | Store a durable memory (+ optional typed graph). Pass the same `id` back to update it. |
| `rememberMany` | `(items: Array<{ text: string } & RememberOptions>)` | `Promise<{ id: string }[]>` | Store many memories; ids returned in input order. |
| `recall` | `(query: string, opts?: { limit?: number })` | `Promise<Recalled[]>` | Ranked, cited snippets - hybrid (vector + BM25 + graph), reranked, ACL-filtered. |
| `facts` | `(query: string, opts?: { limit?: number })` | `Promise<RecalledMemory[]>` | Current atomic facts (self-correcting: superseded/contradicted excluded). `limit` default `8`. |
| `forget` | `(query: string, reason?: string)` | `Promise<string[]>` | Non-destructive forget (history kept). `reason` default `"forgotten via SDK"`. |
| `profile` | `(subject: string)` | `Promise<Profile \| null>` | Static + recent facts + graph neighborhood for an entity. |
| `timeline` | `(subject: string)` | `Promise<{ subject: string; events: TimelineEvent[] }>` | Chronological fact-changes + experiences (bi-temporal). |
| `graph` | getter | [graph namespace](#graph-namespace) | ACL-scoped graph queries. |
| `about` | `()` | `{ records: number; entities: number; chunks: number; annEnabled: boolean }` | Store stats + whether the ANN index is live. |
| `close` | `()` | `void` | Close the underlying database. |

> `recallAll` and `asOf` are exposed on [`ChittaUser`](#class-chittauser), not on the single-user
> facade - reach them via `memory.user("me")` (or any `.user(id)`), or via `memory.ctx`.

### <a id="user"></a>`user(userId, opts?)` → `ChittaUser`

```ts
user(userId: string, opts?: { role?: Role; org?: string; groups?: string[] }): ChittaUser
```

Returns a [user-scoped client](#class-chittauser) whose every call is ACL-filtered to what that
principal may see. **Idempotently provisions** the user on first call (and registers/joins any
`groups`).

| Param | Type | Default | Notes |
|---|---|---|---|
| `userId` | `string` | - | The principal id. |
| `opts.role` | `Role` = `"admin" \| "editor" \| "viewer"` | `"editor"` | Write/permission role. |
| `opts.org` | `string` | the `Chitta` instance's `org` | Organization id. |
| `opts.groups` | `string[]` | `[]` | Groups the user belongs to (drive shared access). |

---

## `class ChittaUser`

A user-scoped view - the permission moat. Obtain one via `chitta.user(id)` (do not construct
directly). Every read/write is scoped to `userId` within `orgId`.

```ts
const alice = memory.user("alice", { role: "editor" })
await alice.remember("Alice's private roadmap: ship v2 in Q3.")
await alice.recall("roadmap")   // only what alice may see
```

### Properties

| Property | Type | Description |
|---|---|---|
| `ctx` | `EmbeddedContext` | Escape hatch to the low-level engine (shared with the parent `Chitta`). |
| `userId` | `string` | This scope's principal id. |
| `orgId` | `string` | This scope's organization id. |

### Methods

| Method | Signature | Returns | Behavior |
|---|---|---|---|
| `remember` | `(text: string, opts?: RememberOptions)` | `Promise<{ id: string }>` | Store durable memory for this user (+ optional typed graph, sharing, episodes, procedures). |
| `rememberMany` | `(items: Array<{ text: string } & RememberOptions>)` | `Promise<{ id: string }[]>` | Batch `remember`; ids in input order. |
| `recall` | `(query: string, opts?: { limit?: number })` | `Promise<Recalled[]>` | Ranked, cited snippets, ACL-filtered to this user. |
| `facts` | `(query: string, opts?: { limit?: number })` | `Promise<RecalledMemory[]>` | Current atomic facts. `limit` default `8`. |
| `recallAll` | `(query: string)` | `Promise<{ facts: RecalledMemory[]; episodes: RecalledEpisode[]; procedures: RecalledProcedure[] }>` | Everything relevant: current facts + episodic events + procedural how-tos. |
| `forget` | `(query: string, reason?: string)` | `Promise<string[]>` | Non-destructive forget. `reason` default `"forgotten via SDK"`. |
| `profile` | `(subject: string)` | `Promise<Profile \| null>` | Structured profile of an entity. |
| `timeline` | `(subject: string)` | `Promise<{ subject: string; events: TimelineEvent[] }>` | Chronological timeline (bi-temporal). |
| `asOf` | `(time: number \| Date, subject?: string)` | `Promise<string[]>` | Facts believed true **at** a past point in time (bi-temporal "as of"). |
| `graph` | getter | [graph namespace](#graph-namespace) | ACL-scoped graph queries. |

---

## Graph namespace

`chitta.graph` and `chittaUser.graph` both return the same shape - five ACL-scoped graph queries.

| Method | Signature | Returns | Behavior |
|---|---|---|---|
| `neighbors` | `(name: string, relation?: string)` | `Promise<NeighborResult \| null>` | Typed neighbors of an entity, optionally filtered to one relation. |
| `related` | `(query: string, limit?: number)` | `Promise<NeighborResult \| null>` | Entity-centric recall from free text ("everything about Alice"). `limit` default `40`. |
| `pathBetween` | `(a: string, b: string)` | `Promise<PathResult>` | Shortest relation chain connecting two entities. |
| `central` | `(limit?: number)` | `Promise<Array<{ label: string; degree: number; strength: number }>>` | Most-connected concepts. `limit` default `10`. |
| `communities` | `()` | `Promise<Array<{ size: number; hub: string; members: string[]; summary: string }>>` | Cohesive clusters of related entities, each with a summary. |

```ts
await memory.graph.neighbors("Sarah Chen")           // typed neighbors
await memory.graph.related("everything about Meta")  // free-text → entity neighborhood
await memory.graph.pathBetween("Sarah Chen", "Meta") // how are they connected?
await memory.graph.central()                          // hubs
```

---

## Types

### `Entity`

```ts
interface Entity { name: string; type?: string }   // type e.g. "PERSON" | "ORG" | …
```

### `Relation`

```ts
interface Relation {
  from: string
  to: string
  type: string   // SHORT snake_case predicate: works_at, lives_in, acquired, reports_to, …
}
```

### `RememberOptions`

Everything is optional - a bare `remember(text)` works.

| Field | Type | Description |
|---|---|---|
| `entities` | `Entity[]` | Precise typed entities you already extracted (the zero-token graph path). |
| `relations` | `Relation[]` | Typed triples (subject → predicate → object). |
| `id` | `string` | Stable record id (auto-generated if omitted). Pass the **same** id later to **update**. |
| `name` | `string` | Human label for the source record (defaults to the id). |
| `shareWith` | `string[]` | Additional principals who may **read** this memory. |
| `shareWithOrg` | `boolean` | `true` ⇒ make it visible org-wide (within the author's org). |
| `episodes` | `Array<{ event: string; occurredAt?: number \| string; actors?: string[] }>` | Time-anchored experiences → **episodic** memory. |
| `procedures` | `Array<{ trigger?: string; action: string }>` | Learned how-tos / preferences → **procedural** memory (supersedes on change). |

### `Recalled` - returned by `recall`

```ts
interface Recalled {
  text: string
  score: number
  recordId?: string
  recordName?: string
}
```

### `RecalledMemory` - returned by `facts` (and inside `recallAll`)

```ts
interface RecalledMemory {
  memory: string
  version: number
  isStatic: boolean   // static facts (names, birthplaces) vs dynamic
  updatedAt: number
  rootId: string      // version-chain root
}
```

### `RecalledEpisode` / `RecalledProcedure` - inside `recallAll`

```ts
interface RecalledEpisode   { event: string; occurredAt: number; actorIds: string[] }
interface RecalledProcedure { procedure: string; version: number }
```

### `Profile` - returned by `profile`

```ts
interface Profile {
  subject: string
  staticFacts: string[]    // permanent
  recentFacts: string[]    // dynamic, newest-first, contradictions resolved
  related: string[]        // most-connected entities
}
```

### `TimelineEvent` - inside `timeline`

```ts
interface TimelineEvent {
  at: number
  kind: "fact" | "episode"
  text: string
  version: number
  superseded: boolean   // true for a fact version later superseded / forgotten
}
```

### `NeighborResult` / `PathResult` - graph returns

```ts
interface NeighborResult {
  entity: string
  neighbors: Array<{ label: string; relation: string; direction: "out" | "in"; weight: number }>
}
interface PathResult {
  found: boolean
  hops: number
  steps: Array<{ from: string; relation: string; to: string }>
}
```

---

## Errors

A tiny, dependency-free hierarchy - `catch` and branch on the stable `err.code` (or `instanceof`)
instead of string-matching messages.

| Class | Extends | `code` | Thrown when |
|---|---|---|---|
| `ChittaError` | `Error` | (varies) | Base for every error Chitta throws deliberately. |
| `ConfigError` | `ChittaError` | `"config"` | Invalid `ChittaOptions` (bad `embeddings` mode, non-string/empty `path`) - at construction. |

```ts
import { Chitta, ConfigError } from "@100xprompt/chitta"

try {
  new Chitta({ embeddings: "nope" as any })
} catch (e) {
  if (e instanceof ConfigError) console.error(e.code, e.message) // "config" …
}
```

> **Permission failures are separate.** Write-side access-control violations surface as the
> `AuthorizationError` thrown by the authorizer (`src/embedded/authorizer.ts`; reachable via
> `memory.ctx`, not re-exported from the package root) - it is **not** part of this `ChittaError`
> hierarchy. Reads never throw on permission: they simply return only what the asking user may see.

---

## Observability (`onEvent`)

Pass `onEvent` in `ChittaOptions` to observe timing. It fires **after** `remember`, `recall`, and
`facts`, and is threaded to every `ChittaUser` scope.

```ts
type ChittaEvent = { op: string; ms: number; count?: number }
```

| Field | Type | Meaning |
|---|---|---|
| `op` | `string` | The operation name: `"remember"`, `"recall"`, or `"facts"`. |
| `ms` | `number` | Elapsed milliseconds (`performance.now()` delta). |
| `count` | `number \| undefined` | Result count where meaningful (`recall`, `facts`); omitted for `remember`. |

The hook is **guarded** (unset ⇒ zero work) and **try/catch-wrapped** - a throwing handler can never
break the memory operation it observes.

```ts
const memory = new Chitta({
  path: "./memory.db",
  onEvent: (e) => console.log(`${e.op} took ${e.ms.toFixed(1)}ms`, e.count ?? ""),
})
```

---

## Escape hatch (`.ctx`)

`memory.ctx` (and `chittaUser.ctx`) exposes the full low-level `EmbeddedContext` engine - episodic /
procedural recall, reflection (`reflect`), sleep-time consolidation (`sleep`), KGQA (`ask`), entity
dedupe (`dedupeEntities`), reindex, `factsAsOf`, and more. Use it when the SDK surface doesn't cover
an advanced need; the SDK methods are thin, typed wrappers over it.

---

## `chittaTools(memory)` - framework tool adapter

Turns a `Chitta` (or `ChittaUser`) into two **dependency-free** tool definitions for tool-calling
agents. Shaped as the common denominator across the Vercel AI SDK, OpenAI, and Anthropic tool APIs -
no `zod`, no `ai`, no new deps. Full framework wiring: [adapters.md](adapters.md).

```ts
import { chittaTools } from "@100xprompt/chitta/adapters/ai-tools"

const tools = chittaTools(memory)              // or chittaTools(memory.user("alice")) for per-user ACL
// tools === { rememberMemory, recallMemory }
```

### Signature

```ts
function chittaTools(memory: MemoryLike): ChittaTools

interface MemoryLike { remember: Chitta["remember"]; recall: Chitta["recall"] }  // Chitta, ChittaUser, or compatible
```

### The tools

| Tool | `parameters` (JSON Schema props) | `execute(args)` returns |
|---|---|---|
| `rememberMemory` | `{ text: string }` (required: `text`) | `Promise<{ id: string }>` - the stored record id |
| `recallMemory` | `{ query: string; limit?: number }` (required: `query`) | `Promise<Array<{ text: string; score: number }>>` - ranked, cited snippets |

### Shapes

```ts
interface ChittaTool<Args, Result> {
  description: string          // tells the model when to call it
  parameters: JsonSchema       // { type: "object"; properties; required?; additionalProperties? }
  execute: (args: Args) => Promise<Result>
}

interface ChittaTools {
  rememberMemory: ChittaTool<{ text: string }, { id: string }>
  recallMemory:   ChittaTool<{ query: string; limit?: number }, Array<{ text: string; score: number }>>
}
```

Each tool is a plain object - map its three fields onto your framework's tool type (`tool()` for the
Vercel AI SDK, `function` for OpenAI, `input_schema` for Anthropic). `execute` is already wired to
Chitta; you never re-implement it. See [adapters.md](adapters.md) for copy-paste examples per
framework.

---

See also: [SDK.md](SDK.md) · [adapters.md](adapters.md) · [PERFORMANCE.md](PERFORMANCE.md) ·
[DEPLOYMENT.md](DEPLOYMENT.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
