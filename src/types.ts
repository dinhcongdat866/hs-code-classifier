export interface DatasetRow {
  id: string;
  description: string;
  heading: string;
  chapter: string;
  htsCodes: string[];
  rulingDate: string;
  sourceUrl: string;
  searchTerm: string;
}

export interface ItemResult {
  id: string;
  description: string;
  expected: string;
  /** top-3 candidate headings, best first; empty on parse failure */
  candidates: string[];
  top1Correct: boolean;
  top3Correct: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  error?: string;
}

export interface EvalSummary {
  model: string;
  modelId: string;
  prompt: string;
  timestamp: string;
  n: number;
  top1Accuracy: number;
  top3Accuracy: number;
  errors: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  costPer1kSkusUsd: number;
}

export interface EvalRun {
  summary: EvalSummary;
  results: ItemResult[];
}
