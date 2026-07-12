# Launch runbook

The goal of a launch is one thing: **enough star velocity in one 24-48h window to trip
GitHub Trending**, which then compounds on its own. Trending ranks by stars-gained-recently,
not total stars. ~150-300 stars inside a day is typically enough for the language page;
the front page cascades from there. Everything below is engineered toward that single spike.

Assets already in this folder: [show-hn.md](show-hn.md) (post body + 3 title options),
[twitter-thread.md](twitter-thread.md), [reddit-localllama.md](reddit-localllama.md),
[comparison.md](comparison.md) (sourced competitor table).

---

## T-7 to T-2: line up the fuel

A launch with no pre-arranged amplification is a coin flip. Do these before picking a date:

- [ ] **Record the two demo clips.** (1) `./examples/agent-memory/run.sh` - the
      "it remembered across sessions" terminal moment. (2) `chitta graph --open` on a real
      store - screen-record the graph settling, 15-30s. These are the retweetable artifacts;
      the thread has `[ATTACH]` placeholders for exactly these.
- [ ] **Pitch 3-4 AI newsletters** (TLDR AI, Ben's Bites, The Rundown, AlphaSignal). Short
      email: one-line pitch + the graph GIF + repo link + "launching Thursday". Newsletters
      need 2-5 days of lead time; one placement is tens of thousands of dev impressions.
- [ ] **DM 5-10 mid-size dev accounts** who post AI-tooling content. Not "please share" -
      offer early access: "shipping this Thursday, thought you'd want a look first."
      One genuine "this is cool" quote-tweet on launch day changes the trajectory.
- [ ] **Prepare your own network**: 3-5 friends/colleagues who will genuinely try it and
      comment/upvote early (NOT vote rings - real users, real comments; HN detects and
      punishes coordinated voting).
- [ ] **Dry-run the install** on a clean machine: `bunx @100xprompt/chitta install` in a
      fresh tool, then the two demos. The launch-day crowd does zero troubleshooting -
      anything that fails once costs the star.
- [ ] **Freeze the repo surface**: README renders correctly, `bun test` green in CI, issues
      #4-#7 (good first issues) open, npm package current.

## Picking the day

- **Tuesday-Thursday**, post HN at **6:00-8:00 AM Pacific** (max US+EU overlap on the
  new page).
- If a bigger wave appears (a Karpathy-tier post about agent memory, a Claude Code memory
  announcement, a hot "agents forget everything" thread) - **ride it within 24h** even if
  imperfect. Graphify shipped 19 hours after Karpathy's knowledge-base tweet. Timing beats
  polish.

## Launch day: hour by hour

**T+0 (6-8 AM PT) - Hacker News.**
Post from [show-hn.md](show-hn.md) (pick one of the 3 titles; the "I got tired of
re-explaining my project to Claude every morning" one is the most HN-native).
Text post, link to the repo. Then **stay at the keyboard for 6 hours**.

**T+15min - X/Twitter.** Fire the thread from [twitter-thread.md](twitter-thread.md) with
both clips attached. Pin it. Link the HN discussion in a reply (never in the tweet body;
the algorithm downranks external links less in replies).

**T+30min - Reddit.** Post [reddit-localllama.md](reddit-localllama.md) to r/LocalLLaMA.
Cross-post variants to r/ClaudeAI and r/cursor an hour apart (each subreddit hates
copy-paste; retune the first paragraph to each community).

**T+1h - the pre-arranged amplifiers.** Ping the accounts/friends from T-7: "it's live,
here's the HN link." Their window to matter is the first 3 hours.

**T+0 through T+8h - work the comments.** This is the actual job of launch day:

- Answer every HN comment within minutes. Technical, honest, zero marketing voice.
- The winning comment style: concede real limitations, explain design decisions with
  numbers, link code. HN converts on the author being *present and credible*.
- Prepared answers you will need: "how is this different from mem0/Zep?" (point to
  [comparison.md](comparison.md) - zero-token + local + the ACL model), "zero tokens, so
  what does extraction?" (deterministic extractor + local embeddings + reranker; be direct
  that LLM-free extraction is shallower on casual prose and that benchmark mode exists),
  "why Bun?" (bun:sqlite + in-process vector index, no native build steps).
- Someone will benchmark-fight. Do not claim victory on contested metrics; the honest
  "we publish zero-token recall, they publish with-LLM QA accuracy, different scales"
  answer wins the thread.

**T+8h - Product Hunt scheduling (optional).** If HN went well, schedule PH for the next
morning; it reuses the same assets and catches a second audience.

## The Trending checklist

- [ ] 150+ stars in the first 24h (HN front page alone usually clears this)
- [ ] Topics set (done: `claude-code`, `cursor`, `agent-memory`, `persistent-memory`, ...)
- [ ] Star velocity spread over hours, not one burst (stagger the channel posts - already
      built into the schedule above)
- [ ] Check github.com/trending/typescript that evening; if listed, screenshot and post
      "Chitta is trending" to X - trending begets trending.

## T+1 to T+14: keep the flywheel fed

- **Ship something visible every 2-3 days** and say so (a release note is a post). The
  good-first-issue PRs that come in are content too: "first community PR merged."
- **Answer every issue within 24h.** Early responsiveness converts stargazers to users to
  contributors.
- **Post the artifacts separately.** The graph video alone (no launch framing, just
  "my agent's memory as a graph, one command") is a second X post a week later.
- **Write the technical deep-dive** ("how retrieval stays O(1) in graph size" or "why
  zero-token extraction") for HN round two ~2 weeks later. Engineering posts re-launch
  the repo without looking like a re-launch.

## What NOT to do

- No "please star" anywhere, ever. No star-for-star exchanges. No vote rings.
- No arguing with hostile comments; concede, cite numbers, move on.
- No launching into a news vacuum you can't check (holiday weekends, big-model launch
  days when all oxygen is gone - unless the launch IS about that model).
- No fabricated comparisons: everything public must trace to [comparison.md](comparison.md)'s
  sources. One caught exaggeration costs more than ten features earn.
