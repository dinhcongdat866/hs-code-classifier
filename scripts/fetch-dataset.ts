/**
 * Builds the eval dataset from US Customs CROSS rulings (rulings.cbp.gov).
 *
 * Each CROSS ruling is a binding classification decision by CBP: a product
 * description plus the HTS code CBP assigned. That makes it real ground truth,
 * not synthetic labels.
 *
 * Filtering rules (each one exists because of a failure mode seen in the raw data):
 *  - categories must include "Classification" (Origin/Marking rulings have no tariffs)
 *  - drop chapter 98/99 tariff lines (Section 301 etc. — trade remedies, not product codes)
 *  - keep only rulings where all remaining tariff lines share one 4-digit heading,
 *    so the eval is single-label
 *  - rulings from 2017+ only (older rulings may use retired HS editions)
 *  - subject must yield a usable product description after stripping boilerplate
 *  - cap per-heading count so a few popular headings don't dominate accuracy
 */

import { mkdirSync, writeFileSync } from "node:fs";

const SEARCH_TERMS = [
  // apparel & footwear
  "hoodie", "t-shirt", "jeans", "dress", "jacket", "socks", "sneakers",
  "sandals", "baseball cap", "leather gloves",
  // electronics
  "bluetooth speaker", "headphones", "smart watch", "phone case",
  "battery charger", "LED lamp", "computer keyboard", "webcam", "drone",
  "power bank",
  // home & kitchen
  "ceramic mug", "frying pan", "kitchen knife", "cutting board", "pillow",
  "blanket", "curtain", "vacuum cleaner", "storage box", "picture frame",
  // toys, sports & outdoor
  "plush toy", "board game", "yoga mat", "bicycle", "dumbbell",
  "fishing rod", "camping tent", "skateboard",
  // accessories
  "backpack", "wallet", "sunglasses", "umbrella", "necklace", "wristwatch",
  // beauty & misc
  "shampoo", "scented candle", "water bottle", "dog collar", "tumbler",
  "essential oil",
];

const PAGE_SIZE = 30;
const MAX_PER_HEADING = 3;
const MIN_YEAR = 2017;

interface CrossRuling {
  rulingNumber: string;
  subject: string;
  categories: string;
  rulingDate: string;
  collection: string;
  tariffs: string[];
}

export interface DatasetRow {
  id: string;
  description: string;
  heading: string; // 4-digit ground truth
  chapter: string; // 2-digit, derived
  htsCodes: string[]; // full codes from the ruling, for reference
  rulingDate: string;
  sourceUrl: string;
  searchTerm: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchRulings(term: string): Promise<CrossRuling[]> {
  const url = `https://rulings.cbp.gov/api/search?term=${encodeURIComponent(
    term,
  )}&collection=ny&pageSize=${PAGE_SIZE}&page=1&sortBy=DATE_DESC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CROSS search failed for "${term}": ${res.status}`);
  const body = (await res.json()) as { rulings: CrossRuling[] };
  return body.rulings ?? [];
}

/** Strip CBP boilerplate so the input reads like a product description. */
function extractDescription(subject: string): string | null {
  let s = subject.trim();
  // skip administrative rulings
  if (/revocation|modification|protest|reconsideration|correction|country of origin|marking|applicability/i.test(s)) {
    return null;
  }
  s = s.replace(/^(the\s+)?tariff classification(\s+of)?\s+/i, "");
  s = s.replace(/\s+from\s+(the\s+)?[A-Z][A-Za-z ,'()-]*\.?\s*$/u, ""); // " from China." etc.
  s = s.replace(/\.\s*$/, "").trim();
  // FTA-eligibility subjects ("...and status under DR-CAFTA of X") have messy
  // structure; drop anything that still carries administrative language
  if (/eligibility|status under|country.of.origin|made in/i.test(s)) return null;
  // too vague to classify ("various articles", "four devices", "footwear", ...)
  if (s.length < 12 || /^various|^assorted|\bdevices$|\barticles$|\bitems$/i.test(s)) {
    return null;
  }
  // single-word or article+noun subjects ("footwear", "a tablet") carry no signal
  const words = s.replace(/^(a|an|the)\s+/i, "").split(/\s+/);
  if (words.length < 2) return null;
  return s;
}

/** Returns the single 4-digit heading if all product-level codes agree, else null. */
function singleHeading(tariffs: string[]): { heading: string; codes: string[] } | null {
  const product = tariffs
    .map((t) => t.replace(/[^0-9.]/g, ""))
    .filter((t) => /^\d{4}/.test(t) && !/^9[89]/.test(t));
  if (product.length === 0) return null;
  const headings = new Set(product.map((t) => t.slice(0, 4)));
  if (headings.size !== 1) return null;
  return { heading: [...headings][0], codes: product };
}

async function main() {
  const byHeading = new Map<string, number>();
  const seenRulings = new Set<string>();
  const seenDescriptions = new Set<string>();
  const rows: DatasetRow[] = [];
  const stats = { fetched: 0, admin: 0, multiHeading: 0, noTariff: 0, old: 0, dupe: 0, capped: 0 };

  for (const term of SEARCH_TERMS) {
    const rulings = await searchRulings(term);
    stats.fetched += rulings.length;

    for (const r of rulings) {
      if (seenRulings.has(r.rulingNumber)) { stats.dupe++; continue; }
      if (!r.categories?.includes("Classification")) { stats.admin++; continue; }
      if (new Date(r.rulingDate).getFullYear() < MIN_YEAR) { stats.old++; continue; }

      const desc = extractDescription(r.subject);
      if (!desc) { stats.admin++; continue; }
      const descKey = desc.toLowerCase().replace(/^(a|an|the)\s+/, "");
      if (seenDescriptions.has(descKey)) { stats.dupe++; continue; }

      const h = singleHeading(r.tariffs ?? []);
      if (!h) {
        if (r.tariffs?.length) stats.multiHeading++; else stats.noTariff++;
        continue;
      }

      const count = byHeading.get(h.heading) ?? 0;
      if (count >= MAX_PER_HEADING) { stats.capped++; continue; }

      seenRulings.add(r.rulingNumber);
      seenDescriptions.add(descKey);
      byHeading.set(h.heading, count + 1);
      rows.push({
        id: r.rulingNumber,
        description: desc,
        heading: h.heading,
        chapter: h.heading.slice(0, 2),
        htsCodes: h.codes,
        rulingDate: r.rulingDate.slice(0, 10),
        sourceUrl: `https://rulings.cbp.gov/ruling/${r.rulingNumber}`,
        searchTerm: term,
      });
    }
    await sleep(250); // be polite to the public API
    process.stdout.write(`${term}: ${rows.length} rows total\n`);
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/dataset.json", JSON.stringify(rows, null, 2));

  const csv = [
    "id,description,heading,chapter,rulingDate,searchTerm",
    ...rows.map((r) =>
      [r.id, `"${r.description.replaceAll('"', '""')}"`, r.heading, r.chapter, r.rulingDate, r.searchTerm].join(","),
    ),
  ].join("\n");
  writeFileSync("data/dataset.csv", csv);

  console.log("\n--- summary ---");
  console.log(`rows: ${rows.length}`);
  console.log(`unique headings: ${byHeading.size}`);
  console.log(`unique chapters: ${new Set(rows.map((r) => r.chapter)).size}`);
  console.log("drops:", stats);
}

main();
