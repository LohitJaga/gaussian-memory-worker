# Benchmark harness

These are the scripts behind the recall numbers in the main README. They are
here so the method is inspectable and so you can run it against your own store
rather than taking my numbers on faith.

## What is here

| Script | What it measures |
|---|---|
| `quality.mjs` | Retrieval recall and precision at k against a gold set, with an optional naive-cosine baseline |
| `contradiction.mjs` | How often a superseded memory is correctly kept out of results |
| `ablation.mjs` | Recall with individual scoring terms disabled, to see what each one is worth |
| `latency.mjs` | End-to-end retrieve latency, with a warm-up call to exclude cold start |

`lib/` holds the shared client, the metrics, and the two matching strategies
(text containment and ID-level). `tools/` holds one-off maintenance scripts.

## What is not here, and why

`bench/gold/` is gitignored and will stay that way.

The gold sets are not synthetic. They are real queries written against real
memory IDs in my own store, which is the point: a memory benchmark on invented
data measures nothing about how the system behaves on a corpus that actually
accumulated over months. That also means they contain a student ID, employer
names, client names, and a good deal of personal life. A stale release tag
served one of those files publicly once already before it was caught.

So the honest position is: the method is open, the corpus is not.

## Running it against your own store

```
node bench/quality.mjs --topk 8 --gold path/to/your_gold.json
```

A gold file is a list of queries, each with the memory IDs (or literal text
snippets) that a correct retrieval should surface:

```json
{
  "queries": [
    {
      "id": "q01",
      "query": "why did we move off the old database",
      "match_ids": ["<memory-uuid>"],
      "match_texts": ["zero egress fees"],
      "tags": ["exact"]
    }
  ]
}
```

Build one from your own `memory_list` output. Twenty to forty queries is enough
to see the shape; fewer than about ten and you are measuring noise, which is a
mistake I made and had to correct.

## What the numbers actually say

On the 53-query hand-labeled gold set, measured on the live deployment
(2026-10-09, about 10 memories returned by each system): recall 0.83 vs 0.62
for naive cosine, MRR 0.79 vs 0.43. By category: exact/paraphrased 0.96 vs
0.80, vague 0.92 vs 0.67 (12 queries, so directional), multi-fact 0.61 vs 0.36.

Multi-fact synthesis is still the weak spot. It is reported here because
leaving it out would make the other numbers mean less.

All of it is self-measured on one store. It is not a public benchmark and it
should not be read as one.
