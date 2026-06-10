/**
 * Versioned prompts. Each version is kept verbatim so every eval run is
 * reproducible and the README can show accuracy per prompt iteration.
 */

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

export interface PromptVersion {
  name: string;
  system: string | Anthropic.TextBlockParam[];
  user: (description: string) => string;
}

/** v1 — naive baseline: just ask for the heading. */
const v1: PromptVersion = {
  name: "v1",
  system:
    "You are a customs tariff classification assistant. " +
    "Given an e-commerce product description, classify it into the Harmonized System (HS) nomenclature. " +
    "Return the 3 most likely 4-digit HS headings, ordered from most to least likely.",
  user: (description) => `Product: ${description}`,
};

/**
 * v2 — adds a reasoning procedure and discrimination rules for the confusion
 * patterns found in v1 error analysis (knit/woven, t-shirt/pullover, festive
 * costumes, vacuum vessels, footwear material splits, machinery headings).
 */
const v2: PromptVersion = {
  name: "v2",
  system:
    "You are a customs tariff classification expert. Given an e-commerce product description, " +
    "classify it into the Harmonized System (HS 2022) nomenclature and return the 3 most likely " +
    "4-digit headings, ordered from most to least likely.\n\n" +
    "Procedure: first identify (a) what the product IS (function), (b) its material or construction, " +
    "(c) who/what it is for. Then choose the heading. Classify by the product's essential character, " +
    "not by accessory features. A specific heading always beats a general one.\n\n" +
    "Rules that are frequently misapplied:\n" +
    "- Knitted/crocheted garments go in chapter 61; woven (non-knit) garments in chapter 62. " +
    "'Jersey', 'knit', 'sweatshirt', 'leggings' signal chapter 61; 'denim', 'woven', 'poplin' signal 62.\n" +
    "- T-shirts, singlets and tank tops (knit) are 6109; sweaters, pullovers, sweatshirts and hoodies (knit) are 6110.\n" +
    "- Festive, carnival and Halloween costumes (flimsy, non-durable) are 9505, not chapters 61/62.\n" +
    "- Vacuum-insulated flasks, tumblers and bottles are 9617, not 7323 or 7615.\n" +
    "- Footwear splits by material: rubber/plastic uppers 6402, leather uppers 6403, textile uppers 6404, other 6405. " +
    "Sports footwear and waterproof footwear have their own headings (6401-6404 subdivisions).\n" +
    "- Bags, cases, wallets, backpacks and similar containers are 4202 regardless of material.\n" +
    "- Machines with an individual mechanical function are chapter 84; electrical machines and apparatus chapter 85; " +
    "measuring, medical and optical instruments chapter 90. Check whether a more specific heading exists before " +
    "defaulting to a residual one (8479, 8543, 9031).\n" +
    "- Parts: classify in the parts heading of the parent machine only if no specific heading covers the part itself.",
  user: (description) => `Product: ${description}`,
};

/**
 * v3 — grounds the model in the actual taxonomy: the full list of 4-digit
 * HS headings with official titles goes into the (cached) system prompt.
 * Targets the v2 residual errors: picking plausible-but-nonexistent or
 * wrong-neighborhood headings in dense chapters (84/85/90).
 */
function buildV3(): PromptVersion {
  const headings: Record<string, string> = JSON.parse(
    readFileSync("data/headings.json", "utf8"),
  );
  const list = Object.entries(headings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, title]) => `${code} ${title}`)
    .join("\n");
  return {
    name: "v3",
    system: [
      {
        type: "text",
        text:
          (v2.system as string) +
          "\n\nThe complete list of valid 4-digit HS headings follows. " +
          "Every heading you return MUST come from this list.\n\n" +
          list,
        // the heading list is identical across all requests — cache it
        cache_control: { type: "ephemeral" },
      },
    ],
    user: (description) => `Product: ${description}`,
  };
}

export const PROMPTS: Record<string, PromptVersion> = { v1, v2, v3: buildV3() };
