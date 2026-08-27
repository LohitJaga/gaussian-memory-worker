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

The headline figures are 92% recall on exact-phrasing queries, 100% on
paraphrased, 83% on vague. The comparison that matters is the vague set, where
a naive-cosine baseline on the same corpus scores 0.38.

Multi-fact synthesis queries score 0.33 across 20 queries. That is the weak
spot and it is reported here because leaving it out would make the other three
numbers mean less.

All of it is self-measured on one store. It is not a public benchmark and it
should not be read as one.
