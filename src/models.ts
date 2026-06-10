export interface ModelConfig {
  id: string;
  /** USD per million tokens */
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODELS: Record<string, ModelConfig> = {
  haiku: { id: "claude-haiku-4-5", inputPerMTok: 1.0, outputPerMTok: 5.0 },
  sonnet: { id: "claude-sonnet-4-6", inputPerMTok: 3.0, outputPerMTok: 15.0 },
};

export function costUsd(m: ModelConfig, inputTokens: number, outputTokens: number): number {
  return (inputTokens * m.inputPerMTok + outputTokens * m.outputPerMTok) / 1_000_000;
}
