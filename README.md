# HS Code Classification — an eval-driven study

Can an LLM classify messy e-commerce product descriptions into 4-digit HS headings —
and how do you know how accurate it is, and what it costs at scale?

This repo is a complete eval harness answering that question against **real ground
truth**: 248 binding classification rulings issued by US Customs (CROSS), across 140
headings and 44 chapters.

## Results

248 products, 3 candidate headings per request (one API call), accuracy measured
against the heading CBP actually assigned.

| Model | Prompt | Top-1 | Top-3 | Cost / 1K SKUs | Mean latency |
|---|---|---:|---:|---:|---:|
| Haiku 4.5 | v1 baseline | 36.7% | 55.2% | $0.93 | 6.6 s |
| Haiku 4.5 | v2 +rules | 40.7% | 59.3% | $1.38 | 6.8 s |
| Haiku 4.5 | v3 +taxonomy | 50.0% | 67.7% | $4.53 | 7.6 s |
| Haiku 4.5 | two-stage | 48.4% | 67.3% | $5.73 | 11.1 s |
| Sonnet 4.6 | v1 baseline | 54.8% | 73.4% | $2.95 | 7.8 s |
| Sonnet 4.6 | **v2 +rules** | 54.4% | **79.0%** | **$4.40** | 9.1 s |
| Sonnet 4.6 | v3 +taxonomy | 56.0% | 76.6% | $14.31 | 14.3 s |
| Sonnet 4.6 | two-stage | **58.9%** | 77.0% | $11.36 | 14.9 s |

*Total API spend for this entire study, including dirty-run reruns: ≈ $14.*

**Headline findings**

- **Top-3 is the metric that matters for production.** Fully-automated top-1 tops out
  at 56%, but "AI proposes 3, a human picks" reaches 79% — and the gap between the two
  numbers is exactly the value of a human-in-the-loop review queue.
- **Taxonomy grounding is worth +9pt to a small model, almost nothing to a large one.**
  Embedding all 1,229 valid headings (prompt-cached) took Haiku from 40.7% → 50.0%
  top-1; Sonnet, which already knows the taxonomy from pretraining, gained 1.6pt while
  cost tripled.
- **At the same price point, the bigger model with the cheaper prompt wins.** Sonnet v2
  ($4.40/1K) beats Haiku v3 ($4.53/1K) by 4.4pt top-1 and 11.3pt top-3.
- **Two-stage classification (chapter → heading) is accuracy-bounded by stage 1 and
  cost-bounded by cache economics.** Pipeline accuracy ≈ chapter recall × in-chapter
  accuracy: Sonnet picks the right chapter (top-2) 83.9% of the time and, given the
  right chapter, hits 89.9% top-3 — so stage 1, not stage 2, is the lever. It yields
  the best fully-automated number (58.9% top-1) and is the natural architecture for
  going to 6 digits. But it's *not* cheaper than the monolith: its short dynamic
  prompts can't use the prompt cache (below Haiku's 4,096-token cacheable minimum,
  and stage 2 varies per request), while v3's 40K-token list reads at 0.1× — "shorter
  prompt = cheaper" inverts under caching.
- Recommended configuration today: **Sonnet 4.6 + v2 prompt** — 79% top-3 at $4.40 per
  1,000 SKUs. For a fully-automated path, Sonnet two-stage at 58.9% top-1.

## Dataset: real rulings, not synthetic labels

`scripts/fetch-dataset.ts` builds the eval set from the
[US CBP CROSS](https://rulings.cbp.gov) public API. Each row is a product description
from a binding ruling plus the HTS code Customs assigned — legally authoritative ground
truth.

Getting it clean required handling several failure modes found while validating:

- **Answer leakage** — the full ruling text contains the assigned code, so inputs use
  only the cleaned subject line.
- **Trade-remedy codes** — chapter 98/99 lines (Section 301 tariffs) are not product
  classifications and are stripped.
- Administrative rulings (origin, corrections, FTA eligibility), multi-heading rulings,
  unclassifiable one-word descriptions ("footwear"), and duplicates are filtered out.
- Max 3 samples per heading, so a few popular headings can't dominate accuracy.

## Method

- TypeScript harness ([scripts/run-eval.ts](scripts/run-eval.ts)), Anthropic SDK with
  **structured outputs** (`messages.parse` + Zod) — every response is schema-valid
  JSON with exactly 3 ranked candidates, so top-3 costs no extra API calls.
- Bounded-concurrency pool with SDK retry on 429s; every run records per-item results
  (`results/*.json`) for error analysis.
- Cost is computed from actual token usage at list prices, including prompt-cache
  writes (1.25×) and reads (0.1×). The v3 heading list (~40K tokens) is cached and
  pre-warmed before the parallel wave.

## Prompt iterations — the actual loop

**v1 → v2: error analysis → discrimination rules.** v1's misses clustered on HS rules
the model knows but doesn't reliably apply: knitted (ch. 61) vs woven (ch. 62)
garments, t-shirts (6109) vs sweatshirts (6110), festive costumes (9505, not apparel),
vacuum-insulated tumblers (9617, not 7323). v2 encodes these as explicit rules.
Result: +4pt top-1 for Haiku, +5.6pt top-3 for Sonnet.

**v2 → v3: ground the model in the real taxonomy.** Remaining errors concentrated in
dense chapters (84/85/90 — machinery, electronics, instruments) where the model picks
a plausible-but-wrong neighbor among dozens of similar headings. v3 embeds all 1,229
valid 4-digit headings with official titles in the cached system prompt. Result: the
big Haiku jump (+9.3pt), marginal for Sonnet.

**v3 → two-stage: decompose the decision.** `run-eval-twostage.ts` asks for the top-2
chapters first (96 options), then chooses 3 headings among only those chapters' ~20-60
codes. Per-item results record which stage failed, so the pipeline decomposes cleanly:

| | Chapter recall (top-2) | Top-3 given right chapter | End-to-end top-3 |
|---|---:|---:|---:|
| Haiku 4.5 | 80.2% | 83.4% | 67.3% |
| Sonnet 4.6 | 83.9% | 89.9% | 77.0% |

Stage 1 is the bottleneck for both models — widening it to top-3 chapters is the
obvious next experiment. An operational lesson surfaced here too: rate-limited
requests (429s) silently count as failures and skewed two runs by up to 3.6pt until
rerun cleanly; production evals need retry budgets and error accounting, not just
accuracy.

## Limitations (read before quoting the numbers)

- **These are upper-bound numbers.** CROSS subject lines are written by customs
  attorneys; real marketplace titles ("Cute Cat Hoodie Soft Warm Winter XL Gift") are
  noisier. A production eval needs real merchant data.
- 4-digit headings only. Full 6/10-digit classification is a harder problem — but it
  decomposes naturally: heading first, then a constrained choice among its
  subheadings.
- Prompt rules were derived from error analysis on this same eval set. With more data
  I'd hold out a test split; at n=248 I prioritized statistical mass per cell.
- Some descriptions are genuinely ambiguous at this granularity ("a girls' jacket" —
  knit or woven?). Human brokers would ask for material composition; an LLM can't.
  That ceiling is part of why top-1 plateaus around 56%.

## What I'd do next in production

1. **Extend two-stage to 6 digits**: stage 1 already picks chapters; widen it to
   top-3 chapters (the measured bottleneck), then add a third stage choosing among a
   heading's subheadings — each stage stays a small constrained choice.
2. **Confidence-based routing**: Haiku first; escalate to Sonnet (or a human) when
   candidates disagree or confidence is low — most of Sonnet's accuracy at a fraction
   of the cost.
3. **Ask-for-missing-attributes loop**: when the deciding attribute is absent
   (material, knit/woven), surface a targeted question to the merchant instead of
   guessing.
4. **Batch API** for non-urgent volume — 50% off all token costs.
5. **Continuous eval**: every prompt/model change runs against the eval set in CI;
   accuracy regressions block deploys.

## Run it

```bash
pnpm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

pnpm fetch-dataset                      # rebuild eval set from CROSS API
pnpm tsx scripts/fetch-headings.ts      # rebuild heading list (v3)
pnpm eval --model haiku --prompt v1     # any of: haiku|sonnet × v1|v2|v3
pnpm tsx scripts/run-eval-twostage.ts --model sonnet   # two-stage pipeline
```

Flags: `--limit N` (subset), `--concurrency N` (default 8; use 3 on low API tiers).
