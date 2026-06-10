/**
 * Two-stage eval: chapter (2-digit) first, then heading (4-digit) chosen
 * only among that chapter's headings.
 *
 * Stage 1 sees the 96 chapter titles (small, cached) and returns the top-2
 * chapters. Stage 2 sees only the headings of those chapters (~20-60 codes)
 * plus the v2 rules, and returns 3 ranked headings.
 *
 * Hypothesis vs v3 (full 1,229-heading list): similar grounding benefit at a
 * fraction of the cached-read cost, since stage 2's list is ~30x smaller.
 *
 * Usage: pnpm tsx scripts/run-eval-twostage.ts --model haiku [--limit N] [--concurrency 3]
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODELS, costUsd } from "../src/models.ts";
import { PROMPTS } from "../src/prompts.ts";
import type { DatasetRow, EvalRun, ItemResult } from "../src/types.ts";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const chapters: Record<string, string> = JSON.parse(readFileSync("data/chapters.json", "utf8"));
const headings: Record<string, string> = JSON.parse(readFileSync("data/headings.json", "utf8"));

const ChapterPick = z.object({
  chapters: z
    .array(
      z.object({
        chapter: z.string().describe("2-digit HS chapter, e.g. '61'"),
        reason: z.string().describe("One short sentence"),
      }),
    )
    .describe("Exactly 2 chapters, most likely first"),
});

const HeadingPick = z.object({
  candidates: z
    .array(
      z.object({
        heading: z.string().describe("4-digit HS heading from the provided list"),
        reason: z.string().describe("One short sentence"),
      }),
    )
    .describe("Exactly 3 candidates, most likely first"),
});

const chapterList = Object.entries(chapters)
  .map(([code, title]) => `${code} ${title}`)
  .join("\n");

const stage1System: Anthropic.TextBlockParam[] = [
  {
    type: "text",
    text:
      "You are a customs tariff classification expert. Given an e-commerce product description, " +
      "identify the 2 most likely HS chapters (2-digit), most likely first. " +
      "The complete list of chapters:\n\n" +
      chapterList,
    cache_control: { type: "ephemeral" },
  },
];

// v2's discrimination rules carry over to stage 2
const stage2Rules = PROMPTS.v2.system as string;

interface TwoStageItem extends ItemResult {
  pickedChapters: string[];
  chapterRecall: boolean; // expected chapter among the 2 picked
}

async function classifyTwoStage(
  client: Anthropic,
  modelId: string,
  row: DatasetRow,
): Promise<TwoStageItem> {
  const start = performance.now();
  const base = { id: row.id, description: row.description, expected: row.heading };
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  try {
    const s1 = await client.messages.parse({
      model: modelId,
      max_tokens: 512,
      system: stage1System,
      messages: [{ role: "user", content: `Product: ${row.description}` }],
      output_config: { format: zodOutputFormat(ChapterPick) },
    });
    usage.input += s1.usage.input_tokens;
    usage.output += s1.usage.output_tokens;
    usage.cacheWrite += s1.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += s1.usage.cache_read_input_tokens ?? 0;

    const picked = (s1.parsed_output?.chapters ?? [])
      .map((c) => c.chapter.replace(/\D/g, "").padStart(2, "0").slice(0, 2))
      .slice(0, 2);

    const candidateHeadings = Object.entries(headings)
      .filter(([code]) => picked.includes(code.slice(0, 2)))
      .map(([code, title]) => `${code} ${title}`)
      .join("\n");

    const s2 = await client.messages.parse({
      model: modelId,
      max_tokens: 1024,
      system:
        stage2Rules +
        "\n\nThe product belongs to one of these headings. " +
        "Every heading you return MUST come from this list:\n\n" +
        candidateHeadings,
      messages: [{ role: "user", content: `Product: ${row.description}` }],
      output_config: { format: zodOutputFormat(HeadingPick) },
    });
    usage.input += s2.usage.input_tokens;
    usage.output += s2.usage.output_tokens;
    usage.cacheWrite += s2.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += s2.usage.cache_read_input_tokens ?? 0;

    const candidates = (s2.parsed_output?.candidates ?? [])
      .map((c) => c.heading.replace(/\D/g, "").slice(0, 4))
      .slice(0, 3);

    return {
      ...base,
      candidates,
      pickedChapters: picked,
      chapterRecall: picked.includes(row.chapter),
      top1Correct: candidates[0] === row.heading,
      top3Correct: candidates.includes(row.heading),
      latencyMs: performance.now() - start,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheWriteTokens: usage.cacheWrite,
      cacheReadTokens: usage.cacheRead,
    };
  } catch (err) {
    return {
      ...base,
      candidates: [],
      pickedChapters: [],
      chapterRecall: false,
      top1Correct: false,
      top3Correct: false,
      latencyMs: performance.now() - start,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheWriteTokens: usage.cacheWrite,
      cacheReadTokens: usage.cacheRead,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(`--${flag}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const model = get("model", "haiku")!;
  const limit = Number(get("limit", "0"));
  const concurrency = Number(get("concurrency", "3"));
  const modelCfg = MODELS[model];
  if (!modelCfg) throw new Error(`Unknown model "${model}"`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  let rows: DatasetRow[] = JSON.parse(readFileSync("data/dataset.json", "utf8"));
  if (limit > 0) rows = rows.slice(0, limit);

  const client = new Anthropic({ maxRetries: 5 });
  console.log(`Two-stage eval: ${rows.length} items | model=${modelCfg.id} | concurrency=${concurrency}`);

  let done = 0;
  const first = await classifyTwoStage(client, modelCfg.id, rows[0]); // warm stage-1 cache
  done++;
  const rest = await pool(rows.slice(1), concurrency, async (row) => {
    const r = await classifyTwoStage(client, modelCfg.id, row);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length}`);
    return r;
  });
  const results = [first, ...rest];

  const ok = results.filter((r) => !r.error);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totals = ok.reduce(
    (s, r) => ({
      input: s.input + r.inputTokens,
      output: s.output + r.outputTokens,
      cw: s.cw + r.cacheWriteTokens,
      cr: s.cr + r.cacheReadTokens,
    }),
    { input: 0, output: 0, cw: 0, cr: 0 },
  );
  const totalCost = costUsd(modelCfg, totals.input, totals.output, totals.cw, totals.cr);

  const run: EvalRun & { summary: { chapterRecall: number } } = {
    summary: {
      model,
      modelId: modelCfg.id,
      prompt: "two-stage",
      timestamp: new Date().toISOString(),
      n: results.length,
      top1Accuracy: results.filter((r) => r.top1Correct).length / results.length,
      top3Accuracy: results.filter((r) => r.top3Correct).length / results.length,
      chapterRecall: results.filter((r) => r.chapterRecall).length / results.length,
      errors: results.length - ok.length,
      meanLatencyMs: latencies.reduce((s, l) => s + l, 0) / (latencies.length || 1),
      p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(0.95 * latencies.length))] ?? 0,
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCostUsd: totalCost,
      costPer1kSkusUsd: (totalCost / (ok.length || 1)) * 1000,
    },
    results,
  };

  mkdirSync("results", { recursive: true });
  const outPath = `results/twostage-${model}.json`;
  writeFileSync(outPath, JSON.stringify(run, null, 2));

  const s = run.summary;
  console.log(`\n=== ${modelCfg.id} / two-stage ===`);
  console.log(`top-1 accuracy : ${(s.top1Accuracy * 100).toFixed(1)}%`);
  console.log(`top-3 accuracy : ${(s.top3Accuracy * 100).toFixed(1)}%`);
  console.log(`chapter recall : ${(s.chapterRecall * 100).toFixed(1)}% (expected chapter in top-2)`);
  console.log(`errors         : ${s.errors}`);
  console.log(`mean latency   : ${s.meanLatencyMs.toFixed(0)} ms (p95 ${s.p95LatencyMs.toFixed(0)} ms)`);
  console.log(`tokens         : ${s.totalInputTokens} in / ${s.totalOutputTokens} out (cache: ${totals.cw} written, ${totals.cr} read)`);
  console.log(`total cost     : $${s.totalCostUsd.toFixed(4)}`);
  console.log(`cost / 1K SKUs : $${s.costPer1kSkusUsd.toFixed(2)}`);
  console.log(`\nSaved ${outPath}`);
}

main();
