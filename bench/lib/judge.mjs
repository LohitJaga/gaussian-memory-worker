// Reusable LLM-judge tier, calling the worker's /bench/generate endpoint (Workers AI,
// no external API). Generic on purpose — the LoCoMo eval uses it, and the existing
// gold-set benchmarks (ablation.mjs) can adopt it later instead of one-off judge calls.
//
// Model choice: Kimi (K2.6 by default) — picked over GPT-4o/Claude and over Llama 3.3 70B
// on real evidence, not convenience. Per arXiv:2606.19544 (June 2026 LLM-as-judge
// reliability study): Kimi K2.5 scored κ=0.720 on JudgeBench and κ=0.461 on MT-Bench,
// beating GPT-4o (κ=0.309 / 0.451) on both, while Llama 3.3 70B — the model already used
// for GM's own production memory_judge — was the least reliable of the four compared
// (κ=0.283 on JudgeBench, a large swing from its own MT-Bench rank). See BENCHMARKING.md
// for the full comparison table.
//
// Judging is a reasoning task, unlike generation — Kimi's hidden reasoning_content
// overhead (confirmed live: ~90-150 completion tokens even on simple cases) is a
// reasonable cost here, unlike in generation where it bought nothing (see eval.mjs).

const JUDGE_MODEL = '@cf/moonshotai/kimi-k2.6';

const NORMAL_SYSTEM = `You are grading a question-answering system. You will see a question, the correct answer, and the system's generated answer. Decide if the generated answer is CORRECT — it doesn't need to match word-for-word, paraphrases, different date formats, and "about X" vs "X" all count as correct as long as the core fact matches. If the generated answer is missing, vague, or states a different fact, it's INCORRECT.

Respond with exactly one line: "VERDICT: CORRECT" or "VERDICT: INCORRECT", then a one-sentence reason on the next line.`;

// Category 5 (adversarial): there is no true answer — the question presupposes something
// false or unstated. Correct system behavior is declining/expressing uncertainty, NOT
// confidently stating a specific fact (whether or not it happens to match the dataset's
// "adversarial_answer" — any confident, specific claim is wrong here, since nothing in
// the source conversation actually supports one).
const ADVERSARIAL_SYSTEM = `You are grading a question-answering system on an ADVERSARIAL question — one where the conversation does not actually contain a supported answer (the question presupposes something unstated or false). The CORRECT behavior is for the system to decline, express uncertainty, or say the information isn't available. It is INCORRECT if the system confidently states a specific fact as if it were supported by the conversation, regardless of what that fact is.

Respond with exactly one line: "VERDICT: CORRECT" or "VERDICT: INCORRECT", then a one-sentence reason on the next line.`;

function parseVerdict(text) {
  text = String(text ?? ''); // defend against non-string model responses, same as eval.mjs
  const m = text.match(/VERDICT:\s*(CORRECT|INCORRECT)/i);
  const verdict = m ? m[1].toUpperCase() : null;
  const reason = text.split('\n').slice(1).join(' ').trim();
  return { verdict, reason, raw: text };
}

export async function judgeAnswer({ question, groundTruth, generatedAnswer, category }, env, model = JUDGE_MODEL) {
  const isAdversarial = category === 5;
  const system = isAdversarial ? ADVERSARIAL_SYSTEM : NORMAL_SYSTEM;
  const userContent = isAdversarial
    ? `Question: ${question}\nSystem's generated answer: ${generatedAnswer || '(empty)'}`
    : `Question: ${question}\nCorrect answer: ${groundTruth}\nSystem's generated answer: ${generatedAnswer || '(empty)'}`;

  const t0 = performance.now();
  const resp = await fetch(new URL('/bench/generate', env.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.token}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      // 2048, not 1024: confirmed live (2026-07-13) that 1024 truncates mid-reasoning on
      // harder/more-hedged comparisons — finish_reason "length" at exactly 1024 completion
      // tokens, empty text, verdict lost entirely. 10/105 LoCoMo questions hit this on the
      // first full run, silently dropped from the scored denominator (not neutral misses —
      // at least one confirmed CORRECT verdict was lost this way, not INCORRECT).
      max_tokens: 2048,
      debug: true,
    }),
  });
  const json = await resp.json();
  const latencyMs = performance.now() - t0;
  if (json.error) return { verdict: null, reason: `judge error: ${json.error}`, latencyMs, usage: undefined, raw: null };
  const { verdict, reason, raw } = parseVerdict(json.text ?? '');
  return { verdict, reason, raw, latencyMs, usage: json._raw?.usage, isAdversarial };
}
