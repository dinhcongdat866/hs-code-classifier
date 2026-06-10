/**
 * Versioned prompts. Each version is kept verbatim so every eval run is
 * reproducible and the README can show accuracy per prompt iteration.
 */

export interface PromptVersion {
  name: string;
  system: string;
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

export const PROMPTS: Record<string, PromptVersion> = { v1 };
