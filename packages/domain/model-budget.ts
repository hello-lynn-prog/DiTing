/**
 * Reserve a conservative upper bound before sending a model request. UTF-8
 * bytes overestimate token counts for the supported Chinese/English prompts;
 * a small fixed allowance covers provider/tool framing omitted by the caller.
 * Reservations are replaced by measured usage when the provider replies.
 */
export function reserveModelCost(
  prompt: unknown,
  maxOutputTokens: number,
  rates: { input: number; cache: number; output: number },
  framingAllowanceTokens = 8192,
) {
  const serialized = typeof prompt === 'string' ? prompt : JSON.stringify(prompt) ?? '';
  const inputUpperBound = Buffer.byteLength(serialized, 'utf8') + framingAllowanceTokens;
  const outputUpperBound = Math.max(0, Math.ceil(maxOutputTokens));
  return (inputUpperBound * Math.max(rates.input, rates.cache) + outputUpperBound * rates.output) / 1_000_000;
}
