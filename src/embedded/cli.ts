// Standalone context CLI - the complete system in one runnable program.
// Persists to a real .db file, so ingest and query work across invocations.
//
//   bun run cli.ts user-add alice --org org1
//   bun run cli.ts ingest --id doc1 --org org1 --name "Notes" --share-user alice --text "hello world"
//   bun run cli.ts query "hello" --user alice --org org1
//
// Compile to a single binary:
//   bun build cli.ts --compile --outfile ctx

import { buildEmbeddedContext } from "./index"

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
function has(flag: string): boolean {
  return process.argv.includes(flag)
}

async function main() {
  const cmd = process.argv[2]
  const dbPath = arg("--db", process.env.CONTEXT_DB ?? "context.db")!
  const ctx = buildEmbeddedContext({ path: dbPath })

  switch (cmd) {
    case "user-add": {
      const userId = process.argv[3]
      const org = arg("--org", "org1")!
      ctx.ingestor.registerUser(userId, org, arg("--email"))
      console.log(`user '${userId}' added to org '${org}'`)
      break
    }
    case "group-add": {
      ctx.ingestor.registerGroup(process.argv[3])
      console.log(`group '${process.argv[3]}' added`)
      break
    }
    case "member-add": {
      ctx.ingestor.addMembership(process.argv[3], arg("--group")!)
      console.log(`'${process.argv[3]}' added to group '${arg("--group")}'`)
      break
    }
    case "ingest": {
      const out = await ctx.ingestor.ingest({
        recordId: arg("--id") ?? `rec-${Date.now().toString(36)}`,
        orgId: arg("--org", "org1")!,
        recordName: arg("--name", "Untitled")!,
        text: arg("--text") ?? (arg("--file") ? await Bun.file(arg("--file")!).text() : ""),
        permittedPrincipals: [arg("--share-user"), arg("--share-group")].filter(Boolean) as string[],
        shareWithOrg: has("--share-org") ? arg("--org", "org1") : undefined,
      })
      console.log(`ingested '${out.recordId}' (${out.chunks} chunks)`)
      break
    }
    case "query": {
      const res = await ctx.retrieval.searchWithFilters({
        queries: [process.argv[3]],
        userId: arg("--user")!,
        orgId: arg("--org", "org1")!,
        limit: Number(arg("--limit", "5")),
      })
      console.log(`status: ${res.status}`)
      for (const r of res.searchResults) {
        console.log(`  • [${r.metadata.recordName}] ${r.content.slice(0, 80)}`)
      }
      if (res.searchResults.length === 0) console.log("  (no accessible context)")
      break
    }
    case "rebuild-graph": {
      const res = await ctx.rebuildGraph()
      console.log(`rebuilt knowledge graph: ${res.records} records → ${res.entities} concept-mentions`)
      break
    }
    case "reindex-vectors": {
      const n = await ctx.reindex()
      console.log(`re-embedded ${n} chunks and rebuilt the vector index`)
      break
    }
    default:
      console.log("commands: user-add | group-add | member-add | ingest | query | rebuild-graph | reindex-vectors")
  }
  ctx.store.close()
}

main()
