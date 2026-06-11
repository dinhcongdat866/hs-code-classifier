/**
 * Eval harness: runs the dataset through a model+prompt combination and
 * reports top-1 / top-3 accuracy, latency, and cost per 1K SKUs.
 *
 * Usage:
 *   pnpm eval --model haiku --prompt v1 [--limit 20] [--concurrency 8]
 *
 * Writes per-item results + summary to results/<prompt>-<model>.json.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODELS, costUsd } from "../src/models.ts";
import { PROMPTS } from "../src/prompts.ts";
import type { DatasetRow, ItemResult, EvalRun } from "../src/types.ts";

// --- tiny .env loader (no dotenv dep needed) ---
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const Classification = z.object({
  candidates: z
    .array(
      z.object({
        heading: z.string().describe("4-digit HS heading, e.g. '6110'"),
        reason: z.string().describe("One short sentence"),
      }),
    )
    .describe("Exactly 3 candidates, most likely first"),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(`--${flag}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    model: get("model", "haiku")!,
    prompt: get("prompt", "v1")!,
    limit: Number(get("limit", "0")),
    concurrency: Number(get("concurrency", "8")),
    dataset: get("dataset", "data/dataset.json")!,
    tag: get("tag", ""),
  };
}

async function classifyOne(
  client: Anthropic,
  modelId: string,
  prompt: (typeof PROMPTS)[string],
  row: DatasetRow,
): Promise<ItemResult> {
  const start = performance.now();
  const base = {
    id: row.id,
    description: row.description,
    expected: row.heading,
  };
  try {
    const response = await client.messages.parse({
      model: modelId,
      max_tokens: 1024,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user(row.description) }],
      output_config: { format: zodOutputFormat(Classification) },
    });
    const latencyMs = performance.now() - start;
    const candidates = (response.parsed_output?.candidates ?? [])
      .map((c) => c.heading.replace(/\D/g, "").slice(0, 4))
      .slice(0, 3);
    return {
      ...base,
      candidates,
      top1Correct: candidates[0] === row.heading,
      top3Correct: candidates.includes(row.heading),
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
  } catch (err) {
    return {
      ...base,
      candidates: [],
      top1Correct: false,
      top3Correct: false,
      latencyMs: performance.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run tasks with bounded concurrency, preserving order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  const { model, prompt, limit, concurrency, dataset, tag } = parseArgs();
  const modelCfg = MODELS[model];
  const promptCfg = PROMPTS[prompt];
  if (!modelCfg) throw new Error(`Unknown model "${model}". Options: ${Object.keys(MODELS).join(", ")}`);
  if (!promptCfg) throw new Error(`Unknown prompt "${prompt}". Options: ${Object.keys(PROMPTS).join(", ")}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set. Put it in .env or the environment.");
  }

  let rows: DatasetRow[] = JSON.parse(readFileSync(dataset, "utf8"));
  if (limit > 0) rows = rows.slice(0, limit);

  const client = new Anthropic({ maxRetries: 5 });
  console.log(`Evaluating ${rows.length} items | model=${modelCfg.id} | prompt=${prompt} | concurrency=${concurrency}`);

  let done = 0;
  // First item runs alone so the cached system prompt (if any) is written
  // once before the parallel wave — concurrent first requests would all
  // pay the full uncached price.
  const first = await classifyOne(client, modelCfg.id, promptCfg, rows[0]);
  done++;
  const rest = await pool(rows.slice(1), concurrency, async (row) => {
    const r = await classifyOne(client, modelCfg.id, promptCfg, row);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length}`);
    return r;
  });
  const results = [first, ...rest];

  const ok = results.filter((r) => !r.error);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalInput = ok.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = ok.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheWrite = ok.reduce((s, r) => s + r.cacheWriteTokens, 0);
  const totalCacheRead = ok.reduce((s, r) => s + r.cacheReadTokens, 0);
  const totalCost = costUsd(modelCfg, totalInput, totalOutput, totalCacheWrite, totalCacheRead);

  const run: EvalRun = {
    summary: {
      model,
      modelId: modelCfg.id,
      prompt,
      timestamp: new Date().toISOString(),
      n: results.length,
      top1Accuracy: results.filter((r) => r.top1Correct).length / results.length,
      top3Accuracy: results.filter((r) => r.top3Correct).length / results.length,
      errors: results.length - ok.length,
      meanLatencyMs: latencies.reduce((s, l) => s + l, 0) / (latencies.length || 1),
      p95LatencyMs: percentile(latencies, 0.95) ?? 0,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: totalCost,
      costPer1kSkusUsd: (totalCost / (ok.length || 1)) * 1000,
    },
    results,
  };

  mkdirSync("results", { recursive: true });
  const outPath = `results/${prompt}-${model}${tag ? `-${tag}` : ""}.json`;
  writeFileSync(outPath, JSON.stringify(run, null, 2));

  const s = run.summary;
  console.log(`\n=== ${modelCfg.id} / ${prompt} ===`);
  console.log(`top-1 accuracy : ${(s.top1Accuracy * 100).toFixed(1)}%`);
  console.log(`top-3 accuracy : ${(s.top3Accuracy * 100).toFixed(1)}%`);
  console.log(`errors         : ${s.errors}`);
  console.log(`mean latency   : ${s.meanLatencyMs.toFixed(0)} ms (p95 ${s.p95LatencyMs.toFixed(0)} ms)`);
  console.log(`tokens         : ${s.totalInputTokens} in / ${s.totalOutputTokens} out (cache: ${totalCacheWrite} written, ${totalCacheRead} read)`);
  console.log(`total cost     : $${s.totalCostUsd.toFixed(4)}`);
  console.log(`cost / 1K SKUs : $${s.costPer1kSkusUsd.toFixed(2)}`);
  console.log(`\nSaved ${outPath}`);
}

main();
