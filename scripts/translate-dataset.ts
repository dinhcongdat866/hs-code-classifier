/**
 * Translates the dataset's product descriptions into Japanese (via Haiku) to
 * test whether classification accuracy survives Japanese-language input —
 * the language SWIP-like customers' product data actually arrives in.
 *
 * Writes data/dataset-ja.json: same rows, `description` in Japanese,
 * original kept as `descriptionEn`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { DatasetRow } from "../src/types.ts";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function translate(client: Anthropic, text: string): Promise<string> {
  const res = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system:
      "Translate the e-commerce product description into natural Japanese, " +
      "the way it would appear in a Japanese marketplace listing. " +
      "Return ONLY the Japanese translation, nothing else.",
    messages: [{ role: "user", content: text }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : text;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const rows: DatasetRow[] = JSON.parse(readFileSync("data/dataset.json", "utf8"));
  const client = new Anthropic({ maxRetries: 5 });

  const out: (DatasetRow & { descriptionEn: string })[] = new Array(rows.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < rows.length) {
      const i = next++;
      const ja = await translate(client, rows[i].description);
      out[i] = { ...rows[i], description: ja, descriptionEn: rows[i].description };
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));

  writeFileSync("data/dataset-ja.json", JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} rows to data/dataset-ja.json`);
  console.log("samples:");
  for (const r of out.slice(0, 3)) console.log(`  ${r.descriptionEn}  ->  ${r.description}`);
}

main();
