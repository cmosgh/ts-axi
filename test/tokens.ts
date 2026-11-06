/** ~4 characters per token: a stable, dependency-free estimate (tracks BPE counts closely enough for regressions). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
