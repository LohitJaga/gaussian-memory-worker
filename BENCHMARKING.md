# Gaussian Memory — Benchmarking Research

**Compiled:** June 15, 2026

---

## 1. What Benchmarks Exist for AI Memory Systems?

### LoCoMo (Long-Term Conversational Memory)

**Paper:** "Evaluating Very Long-Term Conversational Memory of LLM Agents" — ACL 2024
**Source:** https://github.com/snap-research/locomo — CC BY-NC 4.0, file is `data/locomo10.json`

**What it measures:**
- 10 annotated long-term conversations, each ~300 turns, ~9,000–16,000 tokens, spanning up to 32 sessions
- Three tasks: (1) question answering across four sub-types (single-hop, multi-hop, temporal, open-domain), (2) event summarization, (3) multimodal dialogue generation
- Metrics: **F1** and **BLEU-1** for QA; the field has also adopted a unifying **LLM-as-Judge** accuracy score

**How to run it:**
- Original repo has `scripts/evaluate_gpts.sh` and `scripts/evaluate_claude.sh`
- Cleaner wrapper: [EasyLocomo](https://github.com/playeriv65/EasyLocomo)
- Single-file reference: [SimpleMem test_locomo10.py](https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py)
- Pattern: ingest conversations → answer 1,540 QA pairs → score with LLM judge

**Published scores (human ceiling ~88%):**

| System | LLM-Judge % | Notes |
|---|---|---|
| Human | ~88 | |
| GPT-4 (4K ctx) | ~32 | |
| Mem0 | 92.5 | Disputed — see §7 |
| Zep | 75.14 / 94.7 | Disputed — see §7 |
| MemoryOS | +49% F1 over baseline | EMNLP 2025 oral |
| Memory-R1 | 45.0 F1 | +48% vs Mem0 baseline |
| Letta filesystem | 74.0 | GPT-4o-mini |

**Important caveat:** Active benchmark manipulation controversy between Mem0 and Zep. Scores are NOT comparable across papers unless evaluation protocol is identical.

---

### LongMemEval

**Paper:** arXiv:2410.10813, ICLR 2025
**Source:** https://github.com/xiaowu0162/longmemeval
**HuggingFace:** `xiaowu0162/longmemeval`

**What it measures:**
- 500 manually curated questions across five abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention
- Two test sizes: LongMemEval_S (~115K tokens/question, 40 sessions); LongMemEval_M (~1.5M tokens, 500 sessions)
- Metric: accuracy (LLM-as-judge via GPT-4o)

**How to run:**
```bash
export OPENAI_API_KEY=YOUR_KEY
python3 evaluate_qa.py gpt-4o your_hypothesis_file ../../data/longmemeval_oracle.json
```
Hypothesis file: JSONL with `question_id` and `hypothesis` fields.

**Published scores:** Zep: 63.8%; Mem0: 49.0% (independent evaluation with GPT-4o). Mem0's self-reported score is 94.4% — discrepancy is due to different backbone LLMs and evaluation setups.

---

### LongMemEval-V2

**Paper:** arXiv:2605.12493 (May 2026)
**Source:** https://github.com/xiaowu0162/LongMemEval-V2
**HuggingFace:** `xiaowu0162/longmemeval-v2`

**What it measures:**
- 451 manually curated questions + 1,870 web-agent task trajectories
- Tests whether memory helps agents become "experienced colleagues" — recalling interface affordances, recurring failure patterns
- Best system achieves 72.5%; best plain RAG achieves 48.5%
- Includes latency as a required reported metric

**Relevance:** Most directly relevant benchmark for a coding-assistant memory system.

---

### BEAM (Beyond a Million Tokens)

**Paper:** arXiv:2510.27246, ICLR 2026
**Source:** https://github.com/mohammadtavakoli78/BEAM
**HuggingFace:** `Mohammadta/BEAM` and `Mohammadta/BEAM-10M`

**What it measures:**
- 100 conversations at four scales (128K, 500K, 1M, 10M tokens), 2,000 human-validated questions
- 10 memory abilities: abstention, contradiction resolution, event ordering, extraction, instruction following, knowledge update, multi-session reasoning, preference following, summarization, temporal reasoning

**Mem0 April 2026 scores:**
- BEAM-1M: 64.1 (6,719 tokens/query)
- BEAM-10M: 48.6 (6,914 tokens/query)

**Note:** Not relevant for our use case (single-user BYOC at normal coding session scale). Skip for now.

---

### MemBench

**Paper:** ACL 2025 Findings
**Source:** https://github.com/import-myself/Membench

**What it measures:**
- Distinguishes factual vs reflective memory at two levels
- Three metric dimensions: **effectiveness** (accuracy), **efficiency** (memory operations), **capacity** (degradation as store grows)

**Why it matters:** Capacity metric directly maps to our σ decay + pruning. No other system publishes accuracy-vs-store-size curves.

---

### MemoryAgentBench

**Paper:** ICLR 2026
**Source:** https://github.com/HUST-AI-HYZ/MemoryAgentBench

**What it measures:**
- Four competencies: accurate retrieval (AR), test-time learning (TTL), long-range understanding (LRU), conflict resolution (CR)
- Includes EventQA and FactConsolidation datasets
- Conflict resolution (CR) directly maps to our contradiction surface rate metric

---

### MemGym

**Paper:** arXiv:2605.20833 (June 2026) — very new

**What it measures:**
- Five evaluation tracks: tool-use dialogue, coding (SWE-Gym + MemGym-CodeQA), web navigation, deep research
- The coding track is the only public benchmark specifically testing memory in coding contexts
- Too new for meaningful comparison baseline yet

---

## 2. How Have Mem0, Zep, and Letta Evaluated Their Systems?

### Mem0

**Primary paper:** arXiv:2504.19413 (ECAI 2025)
**Benchmarks repo:** https://github.com/mem0ai/memory-benchmarks
**Benchmark blog:** https://mem0.ai/blog/ai-memory-benchmarks-in-2026

**What they report:**
- Three-benchmark suite: LoCoMo, LongMemEval, BEAM
- Evaluation pipeline: Ingest → Search → Evaluate; LLM generates answers from retrieved memories; judge LLM scores
- April 2026 scores: LoCoMo 92.5 / LongMemEval 94.4 / BEAM-1M 64.1 at ~6,900 tokens/query
- Head-to-head comparison: https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up

**Credibility issue:** Zep filed a formal GitHub issue (zep-papers/issues/5) showing Mem0's Zep score was wrong due to role assignment errors. Letta independently reproduced LoCoMo and scored 74.0% vs Mem0's reported 68.5% for Mem0-graph. No independent verification of Mem0's self-reported numbers.

---

### Zep (Graphiti)

**Paper:** arXiv:2501.13956 (January 2025)
**Blog:** https://blog.getzep.com/state-of-the-art-agent-memory/
**Counter-blog:** https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

**What they report:**
- Primary: LongMemEval (500 QA pairs) and DMR (Deep Memory Retrieval)
- LongMemEval with GPT-4o: Zep 71.2% vs full-context baseline 63.8%; latency 2.58s vs 28.9s
- Latest self-reported: 94.7% on LoCoMo at 155ms p95, 5,760-token median context; 90.2% on LongMemEval
- Architecture: temporal knowledge graph (Graphiti) with `valid_from`/`valid_to` timestamps

**Credibility issue:** Zep's LoCoMo scores range from 58.44% to 94.7% depending on evaluator. Protocol sensitivity is massive.

---

### Letta / MemGPT

**Blog:** https://www.letta.com/blog/benchmarking-ai-agent-memory/

**What they report:**
- Filesystem-based agent (files + grep tools) vs Mem0 on LoCoMo
- Result: **74.0% accuracy** with GPT-4o-mini, vs Mem0's claimed 68.5%
- Conclusion: simple filesystem agent beats specialized memory systems with same backbone LLM
- No dedicated metrics paper; MemGPT's original DMR benchmark is now saturated by modern models

---

### OpenAI Memory
- No published paper; Mem0 head-to-head: LoCoMo 52.9%, ~5,000 tokens/query. Cloud-only.

### LangMem
- Mem0 head-to-head: LoCoMo 58.1%, ~130 tokens/query (retrieves almost nothing).

---

## 3. What Does the Community Actually Care About?

**Source threads:**
- HN: "Ask HN: Thinking about memory for AI coding agents" — https://news.ycombinator.com/item?id=46742800
- GitHub: Mem0 Issue #2066 (graph cost: 62 photo descriptions → >1 hour, 15x cost)
- GitHub: zep-papers/issues/5 (benchmark methodology dispute)

**Top complaints, ranked by frequency:**

1. **Noise injection / context bloat** — vague memories inject wrong signals; agents behave worse with memory than without on simple tasks. Confirmed quantitatively in Stompy coding benchmark.

2. **Hallucinated memories** — HaluMem benchmark found: 43% max recall rate, 62% accuracy, 74% omission rate on knowledge updates. Recall collapses from 43% to 3% at 1M tokens.

3. **Staleness / no decay** — "A memory about a user's employer is accurate until they change jobs." No system evaluates this. Our σ decay directly addresses this.

4. **Contradiction surface** — "When two stored memories contradict each other, which one wins?" No standard benchmark. Our `valid_from`/`valid_to` + σ model addresses this.

5. **Epistemic trust gap** — "LoCoMo tests did the agent recall the right thing. There's an entire evaluation dimension above that: should the agent trust what it recalled?" No existing benchmark covers confidence-weighted retrieval. This is Bhattacharyya.

6. **Write cost** — Mem0 graph variant prohibitively expensive at scale; Zep self-hosting requires graph infra.

7. **Duplicate accumulation** — requires manual curation. Our Kalman merge at cosine > 0.82 addresses this.

8. **EU compliance / data sovereignty** — all cloud systems fail EU AI Act data residency. Our BYOC model addresses this.

9. **Benchmark manipulation distrust** — The Mem0/Zep dispute has made developers skeptical of all published numbers.

---

## 4. LoCoMo Details + How to Run

**Yes, it can be run.** Dataset: `locomo10.json` — 10 conversations, 1,540 QA pairs.

**Easiest path:**
```bash
git clone https://github.com/playeriv65/EasyLocomo
# OR copy:
# https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py
```

**Evaluation protocol:**
1. For each of 10 conversations: ingest all turns session-by-session into the memory system
2. For each QA pair: retrieve relevant memories, generate answer using LLM
3. Score answer vs ground truth using LLM judge (GPT-4o or Claude 3.5 Haiku)
4. Report: overall accuracy + per-category (single-hop, multi-hop, temporal, open-domain)
5. Also report: tokens injected per query, p50/p95 latency

**Metrics:** LLM-Judge accuracy % (community standard for Mem0/Zep comparisons). Also report F1 for academic credibility. Include adversarial category — omitting it is how Mem0/Zep inflated scores.

**Time estimate:** ~2–4 hours of API calls for 1,540 QA pairs. Cost: <$20 with Claude 3.5 Haiku.

---

## 5. Quick Self-Hosted Retrieval Quality Benchmarks

### Option A: RAGAS Synthetic Testset

**Source:** https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/

```python
from ragas.testset import TestsetGenerator
generator = TestsetGenerator(llm=generator_llm, embedding_model=embeddings)
dataset = generator.generate_with_langchain_docs(memory_docs, testset_size=100)
```

Metrics: `context_recall`, `context_precision`, `faithfulness`, `answer_relevancy`. Can run locally with Ollama at zero API cost. Requires no external dataset — generates ground truth from your own memory store.

---

### Option B: Entity Graph Precision/Recall

1. Export all stored memories + entity links
2. For 50 seed memories, define expected related memories (via entity graph BFS)
3. Issue 50 queries, measure Precision@K and Recall@K on associated memory retrieval
4. Directly validates spreading activation and association fidelity

Time estimate: 2–4 hours to implement, <30 minutes to run.

---

### Option C: MemBench Capacity Test

Run MemBench to show accuracy vs memory store size — validates σ decay + nightly pruning. No other system publishes this curve.

---

## 6. What Is MemArchitect?

**Paper:** arXiv:2603.18330 — "MemArchitect: A Policy Driven Memory Governance Layer"

**Key claims:**
- Policy-driven approach to memory lifecycle management (what to store, when to evict, dependency tracking)
- Evaluated on **LoCoMo-10** — same `locomo10.json` from snap-research. No novel dataset.
- Compared against MemOS and SimpleMem

**Conclusion:** "MemArchitect's benchmark dataset" in our TODO means running against LoCoMo-10 and comparing per-category to their published scores. The exact per-category numbers are in the PDF (arXiv:2603.18330). Run same format: single-hop, temporal, multi-hop, open-domain.

---

## 7. The Benchmark Credibility Problem

The field has a serious credibility problem:

- Mem0 self-reports 92.5% on LoCoMo; independent researchers put correct-protocol scores at 58–75%
- Zep originally claimed 84%; corrected to 58.44% by Mem0; Zep counter-claimed 75.14%
- A simple filesystem agent with grep beats Mem0-graph on LoCoMo with identical backbone (74.0% vs 68.5%)
- [zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5) shows evaluation protocol matters more than the system

**Implication for us:** To be credible, publish the evaluation harness code, exact backbone LLM, top-k parameter, and include the adversarial category. Any blog post that omits these will be dismissed by practitioners who've followed the dispute.

**Our edge:** We can publish the eval harness in the same repo as the system. Full reproducibility is a differentiator.

---

## 8. Recommended Benchmarking Path

| Priority | Benchmark | Effort | Value | Target Date |
|---|---|---|---|---|
| 1 | LoCoMo-10 QA (all 4 categories) | 1 day | Table stakes — required for any comparison | June 20 |
| 2 | Latency p50/p95 vs Mem0 API | 0.5 day | Cloudflare edge is a hard differentiator | June 21 |
| 3 | Token efficiency per query | 0.5 day | Collected during LoCoMo run for free | June 21 |
| 4 | Contradiction surface rate | 1 day | Novel metric; no competing system publishes this | June 23 |
| 5 | RAGAS synthetic recall/precision | 1 day | Self-contained; validates hybrid retrieval | June 25 |
| 6 | LongMemEval_S (500 questions) | 2 days | Completes the Mem0/Zep comparison picture | June 28 |
| 7 | Identity coherence (50 queries) | 0.5 day | Differentiating qualitative metric | June 28 |

**July 1 ship** — schedule completes June 28, leaving 2 days to write the post.

### What NOT to run by July 1
- BEAM — requires 1M–10M token scale; not relevant for single-user BYOC
- LongMemEval_M — 500 sessions; too slow to run before July 1
- MemGym — released June 2026; comparison baselines not established yet
- AMA-Bench — complex multi-domain agentic setup; doesn't match our use case

---

## 9. Narrative Angle for the Blog Post

**The killer differentiator: epistemic governance.**

Every other system is evaluated on "did it retrieve the right thing." Gaussian Memory is the first to publish a metric for:
- "Should the agent trust what it retrieved?" — contradiction surface rate
- "Does confidence correlate with evidence quality?" — σ model (Bhattacharyya multiplier)
- "Does accuracy degrade as the store grows?" — capacity curve via MemBench

Frame LoCoMo as **parity with Mem0/Zep**, then show the metrics no one else publishes. The narrative: memory systems have been racing to optimize recall on a benchmark. We're optimizing for something harder — knowing what to trust.

---

## Key Sources

| Resource | URL |
|---|---|
| LoCoMo GitHub | https://github.com/snap-research/locomo |
| EasyLocomo | https://github.com/playeriv65/EasyLocomo |
| SimpleMem test_locomo10.py | https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py |
| LongMemEval GitHub | https://github.com/xiaowu0162/longmemeval |
| LongMemEval-V2 GitHub | https://github.com/xiaowu0162/LongMemEval-V2 |
| BEAM GitHub | https://github.com/mohammadtavakoli78/BEAM |
| MemGym arXiv | https://arxiv.org/abs/2605.20833 |
| MemBench GitHub | https://github.com/import-myself/Membench |
| MemoryAgentBench GitHub | https://github.com/HUST-AI-HYZ/MemoryAgentBench |
| AMA-Bench GitHub | https://github.com/AMA-Bench/AMA-Bench |
| Mem0 memory-benchmarks | https://github.com/mem0ai/memory-benchmarks |
| Mem0 ECAI 2025 paper | https://arxiv.org/pdf/2504.19413 |
| Mem0 benchmarks blog 2026 | https://mem0.ai/blog/ai-memory-benchmarks-in-2026 |
| Mem0 head-to-head comparison | https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up |
| Zep temporal KG paper | https://arxiv.org/abs/2501.13956 |
| Zep state-of-the-art blog | https://blog.getzep.com/state-of-the-art-agent-memory/ |
| Zep vs Mem0 dispute | https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ |
| Zep-papers benchmark issue | https://github.com/getzep/zep-papers/issues/5 |
| Letta benchmarking blog | https://www.letta.com/blog/benchmarking-ai-agent-memory/ |
| LoCoMo ACL 2024 paper | https://aclanthology.org/2024.acl-long.747/ |
| LongMemEval arXiv | https://arxiv.org/abs/2410.10813 |
| LongMemEval-V2 arXiv | https://arxiv.org/abs/2605.12493 |
| BEAM arXiv | https://arxiv.org/pdf/2510.27246 |
| MemArchitect arXiv | https://arxiv.org/pdf/2603.18330 |
| MemoryOS GitHub | https://github.com/BAI-LAB/MemoryOS |
| MemBench ACL 2025 | https://aclanthology.org/2025.findings-acl.989/ |
| RAGAS testset generation | https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/ |
| HN: AI coding agent memory | https://news.ycombinator.com/item?id=46742800 |
| AI memory crisis article | https://medium.com/@mohantaastha/the-ai-memory-crisis-why-62-of-your-ai-agents-memories-are-wrong-792d015b71a4 |
| 5 memory systems compared | https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3 |
