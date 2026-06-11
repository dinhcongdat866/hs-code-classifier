# HS Code Classification — an eval-driven study

A TypeScript backend that **measures how well LLMs classify products into customs
(HS) codes** — against real ground truth from US Customs rulings — then **improves
the setup iteration by iteration** and records what each change was worth.

**The takeaway in one line:** you don't pick a *model* — you measure a
**model × prompt × architecture** combination, because the best one is not the one
intuition picks.

## Results

248 real products. Each request returns 3 ranked candidate headings; accuracy is
checked against the code US Customs actually assigned.

| Model | Setup | Top-1 | Top-3 | Cost / 1K SKUs |
|---|---|---:|---:|---:|
| Haiku 4.5 | v1 baseline | 36.7% | 55.2% | $0.93 |
| Haiku 4.5 | v2 +rules | 40.7% | 59.3% | $1.38 |
| Haiku 4.5 | v3 +taxonomy | 50.0% | 67.7% | $4.53 |
| Haiku 4.5 | two-stage | 48.4% | 67.3% | $5.73 |
| Sonnet 4.6 | v1 baseline | 54.8% | 73.4% | $2.95 |
| Sonnet 4.6 | **v2 +rules** | 54.4% | **79.0%** | **$4.40** |
| Sonnet 4.6 | v3 +taxonomy | 56.0% | 76.6% | $14.31 |
| Sonnet 4.6 | two-stage | **58.9%** | 77.0% | $11.36 |

*Entire study: ≈ $14 in API credits.*

## What the numbers taught us

- **Top-3 is the production metric, not top-1.** Full automation tops out at 59%,
  but "AI proposes 3, a human picks one" reaches **79%** — that 20-point gap is the
  measured value of a human-review queue.

- **The same prompt improvement is worth +9pt on one model and nothing on another.**
  Giving the model the full list of 1,229 valid headings (v3) lifted Haiku
  40.7% → 50.0%, but lifted Sonnet only +1.6pt **while tripling cost** — Sonnet
  already knows the taxonomy.

- **At the same price, the bigger model with the cheaper prompt wins.** Sonnet v2
  ($4.40/1K) beats Haiku v3 ($4.53/1K) on every metric. "Save money with the small
  model" is not automatically true.

- **"Shorter prompt = cheaper" inverts under prompt caching.** The two-stage
  pipeline's short dynamic prompts cost *more* per request than v3's 40K-token
  heading list, because the list is cached (reads at 0.1×) and the short prompts
  are too small to cache at all.

- **In a pipeline, accuracy multiplies — find the weak stage.** Two-stage accuracy
  ≈ chapter recall × in-chapter accuracy. Measurement showed stage 1 (picking the
  chapter, 80-84%) is the bottleneck, not stage 2 (84-90%) — so we know exactly
  where to work next.

## The evaluation, step by step

**Step 0 — build ground truth.** 248 product descriptions from binding US Customs
rulings ([CROSS](https://rulings.cbp.gov)), each paired with the HS heading Customs
legally assigned. Filtered for answer leakage, trade-remedy codes, duplicates, and
unclassifiable one-liners (`scripts/fetch-dataset.ts`).

**Step 1 — naive baseline (v1).** Just ask the model to classify.
→ Sonnet 54.8% top-1. Now we know where we stand.

**Step 2 — read the failures, teach the rules (v2).** The misses clustered on
classification *rules* the model fails to apply: knitted vs woven apparel, Halloween
costumes ≠ clothing, vacuum tumblers ≠ kitchenware. Wrote ~10 such rules into the
prompt. → Sonnet top-3 **73.4% → 79.0%**.

**Step 3 — ground it in the real taxonomy (v3).** Remaining misses were
"plausible-but-wrong neighbor" picks in dense chapters (machinery, electronics).
Embedded all 1,229 valid headings in a cached system prompt: "choose only from this
list." → Haiku **+9.3pt**; Sonnet barely moved at 3× the cost.

**Step 4 — decompose the decision (two-stage).** First pick the *chapter* (2-digit,
97 options), then pick the heading among only that chapter's ~20-60 codes.
→ Best fully-automated score (Sonnet **58.9%** top-1), and per-stage metrics that
show precisely which stage to improve.

> **The punchline:** every step changed the answer to "which setup should we ship?"
> Human-in-the-loop → Sonnet v2. Full automation → Sonnet two-stage. Tight budget →
> Haiku v3. None of these choices were predictable without measuring — and the whole
> measurement cost $14.

## Honest caveats

- Ruling descriptions are written by customs attorneys — **cleaner than real
  marketplace titles**, so these numbers are an upper bound.
- 4-digit headings only (6/10-digit decomposes naturally via the two-stage
  architecture).
- Prompt rules were tuned on this same eval set; production would hold out a test
  split.

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
