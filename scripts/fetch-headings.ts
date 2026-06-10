/**
 * Builds data/headings.json — all 4-digit HS headings with their official
 * titles, from the open harmonized-system dataset (WCO HS nomenclature).
 * Used by prompt v3 to ground the model in the real taxonomy.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const URL =
  "https://raw.githubusercontent.com/datasets/harmonized-system/master/data/harmonized-system.csv";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).slice(1);

  const headings: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const [, hscode, description, , level] = parseCsvLine(line);
    if (level === "4") headings[hscode] = description;
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/headings.json", JSON.stringify(headings, null, 2));
  console.log(`Wrote ${Object.keys(headings).length} headings to data/headings.json`);
}

main();
