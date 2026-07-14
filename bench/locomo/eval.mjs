// LoCoMo QA eval: for each question, retrieve (frozen, scoped to the conversation's
// project+domain) -> generate an answer from retrieved context -> judge vs ground truth.
// Requires ingest.mjs to have already run for the target conversation(s).
//
// Generation model: Llama-4-Scout, not Kimi. Confirmed live (pilot, 3 representative
// questions): both matched Kimi's accuracy while using ~24x fewer completion tokens and
// running ~8x faster (Kimi's hidden reasoning_content overhead buys nothing on a mostly-
// extractive task). Judging uses Kimi separately (see judge.mjs) — reasoning is a
// reasonable cost there, evidence-backed by real judge-reliability numbers.
//
// --project overrides which corpus to score against — 'locomo-eval' (real, merge-enabled)
// by default, or 'locomo-eval-nomerge' (the ingest.mjs --no-merge counterfactual) to run
// the same eval against the unmerged corpus for the merge-ablation comparison.
//
// Checkpointed: results accumulate in a stable file (bench/locomo/results-{project}-c{N}.json,
// no timestamp) instead of the timestamped one-shot file, and every already-scored question
// (keyed by sample_id + its index in the filtered question list) is skipped on the next run —
// per-question, not per-conversation, after a live crash (2026-07-13, non-string model
// response) killed a run mid-conversation and lost ~100 already-scored-but-uncheckpointed
// questions under the old per-conversation granularity. Safe to stop (Ctrl-C, laptop closed,
// crash) and re-run the exact same command later — nothing already scored gets re-billed.
//
// Usage: node bench/locomo/eval.mjs --conversations conv-30 [--project locomo-eval-nomerge] [--limit N] [--category 1,2,3,4,5]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, retrieveStructured } from '../lib/client.mjs';
import { judgeAnswer } from '../lib/judge.mjs';

const GENERATION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const TOP_K = 8;

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const ONLY_CONVS = arg('--conversations', null)?.split(',').map(s => s.trim());
const LIMIT = Number(arg('--limit', Infinity));
const ONLY_CATS = arg('--category', null)?.split(',').map(Number);
const PROJECT = arg('--project', 'locomo-eval');
const CHUNK_SIZE = Number(arg('--chunk-size', 4)); // must match the ingest.mjs run being scored
const RESULTS_PATH = join(import.meta.dirname, `results-${PROJECT}-c${CHUNK_SIZE}.json`);

function loadExistingResults() {
  if (!existsSync(RESULTS_PATH)) return [];
  try { return JSON.parse(readFileSync(RESULTS_PATH, 'utf8')).results ?? []; } catch { return []; }
}

async function generateAnswer(question, contextRows, env) {
  const context = contextRows.map(r => r.text).join('\n---\n');
  const t0 = performance.now();
  const resp = await fetch(new URL('/bench/generate', env.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.token}` },
    body: JSON.stringify({
      model: GENERATION_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Answer the question using ONLY the provided conversation excerpts. Be concise — a short phrase or sentence, no preamble. If the excerpts do not contain enough information to answer confidently, say "I don\'t know" rather than guessing.',
        },
        { role: 'user', content: `Conversation excerpts:\n${context}\n\nQuestion: ${question}` },
      ],
      max_tokens: 1024,
      debug: true,
    }),
  });
  const json = await resp.json();
  // String() not a bare ?? '': confirmed live (2026-07-13) that json.text can come back
  // non-string for some model responses, crashing .trim() and killing the whole run —
  // this is a long unattended job over thousands of real network calls, so defend against
  // whatever shape shows up rather than assuming the happy-path type.
  return { text: String(json.text ?? '').trim(), latencyMs: performance.now() - t0, usage: json._raw?.usage, error: json.error };
}

function tokensOf(text) {
  // Rough estimate (~4 chars/token), consistent with bench/lib/textmatch.mjs's approach
  // elsewhere in this harness — good enough for relative cost comparison, not billing.
  return Math.ceil((text?.length ?? 0) / 4);
}

async function evalConversation(conv, env, allResults, doneKeys, save) {
  const { sample_id, qa } = conv;
  const domain = CHUNK_SIZE === 4 ? `locomo-${sample_id}` : `locomo-${sample_id}-c${CHUNK_SIZE}`;
  let questions = ONLY_CATS ? qa.filter(q => ONLY_CATS.includes(q.category)) : qa;
  questions = questions.slice(0, LIMIT);

  const misses = [];
  let scoredThisRun = 0;
  for (let i = 0; i < questions.length; i++) {
    const key = `${sample_id}#${i}`;
    if (doneKeys.has(key)) continue; // already scored in a prior run — mid-conversation resume
    const q = questions[i];
    const { rows } = await retrieveStructured(q.question, { top_k: TOP_K, project: PROJECT, domain, strict_project: true }, env);
    const contextTokens = rows.reduce((s, r) => s + tokensOf(r.text), 0);
    const gen = await generateAnswer(q.question, rows, env);
    const judged = await judgeAnswer(
      { question: q.question, groundTruth: q.answer, generatedAnswer: gen.text, category: q.category },
      env
    );
    const result = {
      sample_id,
      qIndex: i,
      question: q.question,
      category: q.category,
      groundTruth: q.answer ?? null,
      generatedAnswer: gen.text,
      verdict: judged.verdict,
      reason: judged.reason,
      judgeRawOnFailure: judged.verdict === null ? judged.raw : undefined,
      judgeCompletionTokens: judged.usage?.completion_tokens ?? null,
      retrievedCount: rows.length,
      contextTokens,
      genCompletionTokens: gen.usage?.completion_tokens ?? null,
      genLatencyMs: Math.round(gen.latencyMs),
      judgeLatencyMs: Math.round(judged.latencyMs),
    };
    allResults.push(result);
    doneKeys.add(key);
    save(); // checkpoint after every question — see file header for why per-conversation wasn't enough
    if (result.verdict === 'INCORRECT') misses.push(result);
    scoredThisRun++;
  }
  return { sample_id, misses, scoredThisRun, total: questions.length };
}

function summarize(allResults) {
  const byCat = {};
  let correct = 0, total = 0, judgeFailed = 0;
  for (const r of allResults) {
    if (r.verdict === null) { judgeFailed++; continue; }
    const cat = byCat[r.category] ??= { correct: 0, total: 0 };
    cat.total++;
    total++;
    if (r.verdict === 'CORRECT') { cat.correct++; correct++; }
  }
  return { overallAccuracy: total ? correct / total : 0, total, judgeFailed, byCat };
}

async function main() {
  const env = loadEnv();
  const datasetPath = join(import.meta.dirname, 'data', 'locomo10.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  let convs = ONLY_CONVS ? dataset.filter(c => ONLY_CONVS.includes(c.sample_id)) : dataset;

  const allResults = loadExistingResults();
  const doneKeys = new Set(allResults.map(r => `${r.sample_id}#${r.qIndex}`));
  const save = () => writeFileSync(RESULTS_PATH, JSON.stringify({ summary: summarize(allResults), results: allResults }, null, 2));

  console.log(`Evaluating, generation=${GENERATION_MODEL}, judge=kimi-k2.6`);
  console.log(`${allResults.length} question(s) already scored (${RESULTS_PATH}), resuming per-question where needed\n`);

  const t0 = performance.now();
  for (const conv of convs) {
    const t1 = performance.now();
    const { sample_id, misses, scoredThisRun, total } = await evalConversation(conv, env, allResults, doneKeys, save);
    if (scoredThisRun === 0) continue; // fully done in a prior run, nothing new to report
    console.log(`  ${sample_id}: ${scoredThisRun}/${total} question(s) scored this run, ${Math.round(performance.now() - t1)}ms`);
    for (const m of misses) {
      console.log(`    MISS [cat ${m.category}] "${m.question}"`);
      console.log(`      expected: "${m.groundTruth}"  got: "${m.generatedAnswer}"`);
      console.log(`      judge: ${m.reason}`);
    }
  }
  const summary = summarize(allResults);
  console.log(`\n=== Summary (${allResults.length} total questions across ${convs.length} conversations) ===`);
  console.log(`Overall accuracy: ${(summary.overallAccuracy * 100).toFixed(1)}% (${summary.total} scored, ${summary.judgeFailed} judge failures)`);
  for (const [cat, s] of Object.entries(summary.byCat)) {
    console.log(`  category ${cat}: ${(s.correct / s.total * 100).toFixed(1)}% (${s.correct}/${s.total})`);
  }
  console.log(`This run's time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\nFull results written to ${RESULTS_PATH}`);
}

main();
