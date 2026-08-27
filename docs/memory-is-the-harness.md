# Memory Is the Harness: Why AI Coding Assistants Need Probabilistic State

I told Claude the cron job was fixed. Three weeks earlier I'd told it the job was broken. It stored both, weighted them identically, and handed back whichever one happened to sit closer in vector space to my next prompt.

That's the state of memory in developer tools. It isn't that coding agents have amnesia. It's that they remember every statement equally, forever, with no concept of time, contradiction, or decay.

**Gaussian Memory** is an MCP server that gives Claude Code, Cursor, OpenCode and Zed persistent memory across sessions — running entirely inside your own Cloudflare account, on the free tier. It treats a memory not as a row in a document store but as an observation with a confidence distribution that moves.

Here's what it puts into context on a prompt as vague as "where was I":

```
[1.72] (cloudflare-project ↑/decision) 2mo ago ● Use Workers + D1 + Vectorize. Alternatives considered: Supabase, Railway, self-hosted Postgres
[1.50] (benchmark-project ↑/decision) 2w ago ● Retrieve hook 3.5-4.2s on Windows, blocks UserPromptSubmit. Cause still unidentified
```

That is real output from my own store. Nothing prompted the second line, and nobody tagged it as open. It is the landmine you'd otherwise step on at 2am.

## The bottleneck moved

Base model intelligence is commoditizing into a utility. Whether the thing in your editor is Claude, a hosted GLM, or a quantized Llama running under an open harness, the frontier model is no longer what separates a good agent session from a useless one.

The bottleneck is state: giving an agent an accurate, evolving model of your system across hundreds of sessions without stuffing the context window with garbage.

Your repository is a complete record of what your code does and a terrible record of why. It contains nothing about:

- the migration that is 60% done and breaks if anything touches it
- the fix you tried in March that failed in production
- the trade-off you settled at 2am and can still recite but never wrote down

Some of that reaches a commit message. Most of it lived in a terminal session that no longer exists. So every few days I typed it out again.

You can push the whole repo into context instead, if you feel like paying for it. That still only tells the model what the code *is*, and it never contains the March dead end.

## Why "just add RAG" doesn't finish the job

That was the first version. It half-worked.

Semantic search is good when you know what you're asking. "What did I decide about session storage" retrieves correctly, because the query and the stored text share most of their meaning.

Real sessions don't open that way. They open with "where was I" or "what's left on the auth thing." Four words, no semantic anchor. Against a store of four thousand memories, those four words are roughly equidistant from everything you have ever worked on. Cosine similarity there isn't weak signal — it's noise.

So something other than the embedding has to do the ranking.

## Modeling memory as uncertainty

Every memory carries a confidence spread: one σ per memory, stored as a diagonal over the embedding. Retrieval computes an ordinary hybrid score first:

```
base = 0.50·cosine + 0.15·bm25 + 0.27·recency + 0.08·access_frequency
```

Dense vector search and FTS5 keyword search run in parallel and are fused by reciprocal rank fusion (k=60) before any of that is scored. A few smaller terms sit on top — entity overlap, cluster cohesion, a temporal boost — but that's the shape of it.

The part that isn't ordinary is what happens next. The base score is multiplied by a **Bhattacharyya term**, clamped to `[0.70, 1.40]`, that compares the sharpness of the query's distribution against each candidate memory's. A memory the system is still confident about gets boosted by up to 40%. The clamp's lower bound is 0.70, though across the range the inputs actually reach it bottoms out nearer 0.87, so in practice it acts as a boost rather than a penalty.

Three things move that distribution:

**Reinforcement.** Retrieve and confirm a memory and its σ contracts toward a floor. The floor is adaptive: sparse domains hold a wider floor, so a handful of memories about a brand-new project can't collapse into false certainty.

**Decay.** A nightly job widens σ across the store. The step is divided by a stability term, `1 + ln(access_count + 1)`, so things you reference constantly barely move. A memory that has never been retrieved at all, and was stored more than seven days ago, takes that step three times over. Past a threshold it's dropped entirely.

**Merging.** When two memories are close enough in distribution space, they combine via a Kalman update instead of sitting as duplicates. Two independent observations of the same fact produce higher combined confidence than either had alone.

This is why the mechanism matters exactly where it matters. On a precise query with strong word overlap, cosine and BM25 dominate and the multiplier is a rounding error. On "where was I," cosine is flat across the corpus and the confidence term is the only signal left with an opinion. It is bounded, though: it can lift a score by at most 40%, and the hard σ ceiling applied above the scoring ends up doing more of the work than the multiplier does.

## Contradictions get resolved, not accumulated

A plain store keeps both versions of the cron job and lets them fight it out on wording. This one adjudicates.

A cheap pass flags candidate pairs — a negation flip, or a resolved/unresolved flip, between two memories that are already highly similar. It's tuned for recall and over-flags on purpose. A model call then judges the flagged pair: `supersedes`, `conflicts_with`, `extends`, or `compatible`, with a confidence and a written reason.

The verdict is stored as a relation between the two memories, with the reason attached. Neither text is rewritten and nothing is deleted, though a `supersedes` verdict stamps `valid_to` on the older memory, which retires it from retrieval. The row stays where it was, next to the verdict that replaced it. That beats a system that silently drops things and never tells you.

Zep and Mem0 both handle contradiction. Zep tracks validity intervals on graph edges and invalidates contradicted facts; Mem0 runs an add/update/delete pass at write time. The difference here is that confidence is continuous and lives inside the ranking function, rather than acting as a boolean validity flag applied at write time.

## Reading the block

```
[1.72] (cloudflare-project ↑/decision) 2mo ago ● Use Workers + D1 + Vectorize
```

`1.72` is the final fused score — cosine, keyword, recency and access, already multiplied by the confidence term, which is why it can exceed 1. It's relevance with confidence folded in, and it's why a shaky memory can't rank high just by matching your words.

`cloudflare-project` is the project the memory formed in; memories stay scoped to their project unless you ask across projects. `↑` is the confidence band — sharp, holding, or fading. `decision` is the memory type: choices and why, as against `procedural`, how things work around here.

The whole injected block runs around 700 tokens. It's a precision top-up, not a transcript dump.

## Edge-native, and yours

Giving an assistant persistent memory shouldn't mean shipping your session transcripts to someone else's server.

Gaussian Memory deploys as a single Worker into your own Cloudflare account. D1 holds the memories, access metadata and confidence history. Vectorize handles dense search over 768-dimension BGE embeddings, fused with D1's FTS5 index for keyword search. Workers AI runs the embeddings, the extraction, and the judge. No third-party API sits anywhere in that path, there's no key to hand anyone, and nothing routes through me.

Capture is filtered before storage rather than after: read-only commands, git plumbing, installs and deploys are dropped, and it attempts to redact anything credential-shaped on the way in — bearer tokens, provider API keys, JWTs, URLs with inline credentials, `KEY=value` secrets, PEM blocks. That is pattern matching, not a guarantee; treat it as a safety net rather than a reason to be careless. Everything it kept is listable, editable and deletable.

## Get it

One MCP server, same behavior in Claude Code, Cursor, OpenCode and Zed.

```
git clone https://github.com/LohitJaga/gaussian-memory-worker
cd gaussian-memory-worker && npm install
npx gaussian-memory init
```

The model in your editor will be a different model in six months. What carries over is whether it starts each session knowing your system or asking you to describe it again. I built this because I was tired of reintroducing myself to my own tools — and it's the only thing on my machine that remembers March.

https://github.com/LohitJaga/gaussian-memory-worker
