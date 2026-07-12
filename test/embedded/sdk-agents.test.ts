// Multi-agent memory - agents as first-class principals over ONE shared store. Verifies the
// namespaced agent principals (no collision with humans), private-by-default agent memory,
// direct agent-to-agent shares, team-shared visibility, the grant boundary (no sharing to a
// team you don't belong to), and the perspective queries (beliefDiff / sharedBeliefs) that
// compare what different principals can see. Hash embedder + rerank off ⇒ deterministic,
// offline, no downloads.

import { describe, expect, test } from "bun:test"
import { Chitta, agentPrincipal, teamPrincipal } from "../../src/sdk"

const mk = () => new Chitta({ embeddings: "hash", rerank: false })
const texts = (rs: Array<{ text: string }>) => rs.map((r) => r.text).join(" ")

describe("Chitta SDK - multi-agent memory", () => {
  test("agents are namespaced principals with private-by-default memory", async () => {
    const m = mk()
    const planner = m.agent("planner")
    const critic = m.agent("critic")
    expect(planner.userId).toBe("agent:planner")
    expect(agentPrincipal("agent:planner")).toBe("agent:planner") // already-prefixed passes through

    await planner.remember("The rollout plan targets March 3.")
    await critic.remember("The design review flagged the login flow.")

    expect(texts(await critic.recall("rollout plan date"))).not.toContain("March 3") // critic can't see planner's
    expect(texts(await planner.recall("rollout plan date"))).toContain("March 3") // planner still sees their own
    expect(texts(await planner.recall("design review"))).not.toContain("login flow") // and vice versa
    m.close()
  })

  test("a team-shared memory is recalled by every member", async () => {
    const m = mk()
    const planner = m.agent("planner")
    const critic = m.agent("critic")
    const team = m.team("research", { agents: [planner, critic] })
    expect(team.id).toBe(teamPrincipal("research"))
    expect(team.agents).toEqual(["agent:planner", "agent:critic"])

    await planner.remember("The evaluation corpus lives at s3://corpus-v2.", { shareWithTeam: "research" })

    expect(texts(await critic.recall("where is the evaluation corpus"))).toContain("corpus-v2") // teammate sees it
    expect(texts(await planner.recall("evaluation corpus"))).toContain("corpus-v2") // author still sees their own
    m.close()
  })

  test("a direct agent-to-agent share grants exactly that agent", async () => {
    const m = mk()
    const planner = m.agent("planner")
    const critic = m.agent("critic")
    const scout = m.agent("scout")

    await planner.remember("Handoff: verify the pricing table.", { shareWith: [critic] })

    expect(texts(await critic.recall("pricing table handoff"))).toContain("pricing table")
    expect(texts(await scout.recall("pricing table handoff"))).not.toContain("pricing table")
    m.close()
  })

  test("an agent cannot grant to a team it does not belong to", async () => {
    const m = mk()
    const planner = m.agent("planner")
    m.team("ops", { agents: [] }) // the team exists, but planner is not a member
    await expect(planner.remember("ops secret", { shareWithTeam: "ops" })).rejects.toThrow("outside your scope")
    m.close()
  })

  test("beliefDiff returns exactly each side's private beliefs, correctly directed", async () => {
    const m = mk()
    const planner = m.agent("planner")
    const critic = m.agent("critic")
    await planner.remember("Acme acquired Globex.", {
      entities: [{ name: "Acme", type: "ORG" }, { name: "Globex", type: "ORG" }],
      relations: [{ from: "Acme", to: "Globex", type: "acquired" }],
    })
    await critic.remember("Globex partners with Initech.", {
      entities: [{ name: "Globex", type: "ORG" }, { name: "Initech", type: "ORG" }],
      relations: [{ from: "Globex", to: "Initech", type: "partners_with" }],
    })

    const d = await m.perspectives.diff(planner, critic)
    expect(d.aOnly).toEqual([{ from: "Acme", type: "acquired", to: "Globex" }]) // planner-only, planner's side
    expect(d.bOnly).toEqual([{ from: "Globex", type: "partners_with", to: "Initech" }]) // critic-only, critic's side
    m.close()
  })

  test("sharedBeliefs returns the team-shared fact and nothing private", async () => {
    const m = mk()
    const planner = m.agent("planner")
    const critic = m.agent("critic")
    m.team("research", { agents: [planner, critic] })
    await planner.remember("Acme acquired Globex.", {
      entities: [{ name: "Acme", type: "ORG" }, { name: "Globex", type: "ORG" }],
      relations: [{ from: "Acme", to: "Globex", type: "acquired" }],
    }) // private to planner
    await planner.remember("The research team tracks Initech.", {
      entities: [{ name: "Research Team", type: "GROUP" }, { name: "Initech", type: "ORG" }],
      relations: [{ from: "Research Team", to: "Initech", type: "tracks" }],
      shareWithTeam: "research",
    })

    const shared = await m.perspectives.shared([planner, critic])
    expect(shared).toEqual([{ from: "Research Team", type: "tracks", to: "Initech" }]) // the team fact, ONLY
    m.close()
  })

  test("a human user and an agent with the SAME name stay isolated", async () => {
    const m = mk()
    const humanAlice = m.user("alice")
    const agentAlice = m.agent("alice") // principal "agent:alice" - no collision with the human
    expect(agentAlice.userId).toBe("agent:alice")

    await humanAlice.remember("Alice's payroll notes: the raise cycle lands in June.")
    await agentAlice.remember("Scratchpad: the retry budget is three attempts.")

    expect(texts(await agentAlice.recall("payroll raise cycle"))).not.toContain("June") // agent can't see the human's
    expect(texts(await humanAlice.recall("retry budget attempts"))).not.toContain("retry budget") // human can't see the agent's
    expect(texts(await humanAlice.recall("payroll raise cycle"))).toContain("June") // each still recalls their own
    expect(texts(await agentAlice.recall("retry budget attempts"))).toContain("three attempts")
    m.close()
  })
})
