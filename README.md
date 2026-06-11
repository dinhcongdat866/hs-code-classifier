# HS Code Classification — an eval-driven study

A TypeScript (Node.js) backend that **measures speed, accuracy, and cost** of AI
models classifying products into customs (HS) codes.

The experiment:

- Give the model **248 real product descriptions** and ask for the HS code. The
  correct answers come from official US Customs rulings.
- Score two ways: **top-1** = the model's first suggestion is correct.
  **top-3** = the correct code is among its 3 suggestions, and a human picks it.
- Compare two models and four setups on accuracy, speed, and cost — then improve
  the setup step by step and measure what each change was worth.

**The takeaway in one line:** you don't pick a *model* — you measure a
**model × prompt × architecture** combination, because the best one is not the one
intuition picks.

## Results

| Model | Setup | Top-1 | Top-3 | Cost / 1K SKUs | Latency |
|---|---|---:|---:|---:|---:|
| Haiku 4.5 | v1 baseline | 36.7% | 55.2% | $0.93 | 6.6 s |
| Haiku 4.5 | v2 +rules | 40.7% | 59.3% | $1.38 | 6.8 s |
| Haiku 4.5 | v3 +taxonomy | 50.0% | 67.7% | $4.53 | 7.6 s |
| Haiku 4.5 | two-stage | 48.4% | 67.3% | $5.73 | 11.1 s |
| Sonnet 4.6 | v1 baseline | 54.8% | 73.4% | $2.95 | 7.8 s |
| Sonnet 4.6 | **v2 +rules** | 54.4% | **79.0%** | **$4.40** | 9.1 s |
| Sonnet 4.6 | v3 +taxonomy | 56.0% | 76.6% | $14.31 | 14.3 s |
| Sonnet 4.6 | two-stage | **58.9%** | 77.0% | $11.36 | 14.9 s |

*Entire study: ≈ $14 in API credits.*

## What the numbers taught us

- **Top-3 beats top-1 by 20 points — that gap is the value of a human reviewer.**
  In this study the best top-1 score is 59%; the best top-3 score is **79%**. So
  "AI suggests 3, a human picks one" is the realistic way to ship this today.

- **The same prompt improvement helped the small model a lot and the big model
  almost not at all.** Pasting the full code list into the prompt lifted Haiku by
  **+9 points**. It lifted Sonnet by only 1.6 points **at 3× the cost** — Sonnet
  already knows these codes.

- **The small model is not always the cheaper option.** At the same price
  (~$4.50 per 1K products), Sonnet with a simple prompt beats Haiku with an
  expensive prompt on every metric.

- **A shorter prompt is not always cheaper.** Our 40K-token code list is cached by
  the API and re-read at 10% of the normal price. The two-stage pipeline's short
  prompts are too small to be cached, so they pay full price every time — and end
  up costing more.

- **Splitting one hard question into two easy ones gives the best top-1 score —
  and shows you which half is failing.** Two-stage asks "which chapter?" then
  "which code inside that chapter?". Measuring each step separately showed the
  chapter step is the weak one (80-84% correct), not the code step (84-90%). Now we
  know exactly what to fix next.

## The evaluation, step by step

**Step 0 — get real answers to grade against.** 248 product descriptions from
official US Customs rulings ([CROSS](https://rulings.cbp.gov)), each with the HS
code Customs legally assigned. Cleaned of rulings that leak the answer, duplicate
items, and descriptions too vague to classify (`scripts/fetch-dataset.ts`).

**Step 1 — no customization (v1).** Just ask the model: "classify this product."
→ Sonnet gets 54.8% right on the first suggestion. Now we know our starting point.

**Step 2 — study the wrong answers, add rules (v2).** The model kept breaking the
same customs rules: knitted vs woven clothing go in different chapters, Halloween
costumes don't count as clothing, vacuum tumblers don't count as kitchenware.
We wrote ~10 of these rules into the prompt.
→ Sonnet's top-3 score: **73.4% → 79.0%**.

**Step 3 — paste the full code list into the prompt (v3).** The model kept picking
codes that *sound* right but don't exist, or near-miss neighbors. So we gave it all
1,229 valid codes and said: only choose from this list.
→ Haiku **+9.3 points**. Sonnet: almost no change, at 3× the cost.

**Step 4 — split one question into two (two-stage).** First ask "which chapter?"
(97 options), then "which code inside that chapter?" (~20-60 options).
→ The best top-1 score in the study (Sonnet **58.9%**), plus separate scores for
each step so we know which one to improve.

> **The punchline:** balancing speed, accuracy, and cost at scale is not about
> picking the "best model" — it's about measuring. Every step above changed the
> answer to "which setup should we ship?": best top-3 (human picks) → Sonnet v2;
> best top-1 (no human) → Sonnet two-stage; tight budget → Haiku v3. None of this
> was predictable without measuring — and all of it cost $14.

## Honest caveats

- The product descriptions in customs rulings are **cleaner than real marketplace
  titles** ("Cute Cat Hoodie Soft Warm Winter XL Gift"). Real-world accuracy will
  be lower than these numbers.
- This study classifies to 4-digit codes. Full 6/10-digit classification is harder,
  but the two-stage approach extends to it naturally.
- We improved the prompt by studying the same 248 products we score on, so the
  prompt may be over-fitted to them. The clean way: improve prompts on one set of
  products, then measure on a *different* set the prompt has never seen. With only
  248 samples we chose not to split them — a production eval should.

## What I'd build next in production

1. **Extend two-stage to 6 digits** — widen stage 1 to top-3 chapters (the measured
   bottleneck), add a subheading stage.
2. **Confidence-based routing** — cheap model first; escalate to the big model or a
   human only when candidates disagree.
3. **Ask-for-missing-attributes loop** — when the deciding fact is absent (material,
   knit/woven), ask the merchant instead of guessing.
4. **Batch API** for non-urgent volume (50% off) and **continuous eval in CI** so
   accuracy regressions block deploys.

## Run it

```bash
pnpm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

pnpm fetch-dataset                                     # rebuild dataset from CROSS
pnpm tsx scripts/fetch-headings.ts                     # rebuild heading list
pnpm eval --model sonnet --prompt v2                   # haiku|sonnet × v1|v2|v3
pnpm tsx scripts/run-eval-twostage.ts --model sonnet   # two-stage pipeline
```

Per-item results land in `results/*.json` for offline error analysis. Use
`--limit N` for a cheap smoke test and `--concurrency 3` on low API tiers.
