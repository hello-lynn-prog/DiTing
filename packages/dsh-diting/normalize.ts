/**
 * Some model providers serialize values for dsh `json` tool parameters as a
 * JSON-encoded string. Decode that extra layer at the plugin boundary, while
 * leaving malformed strings untouched so the tool's schema can reject them.
 */
export function normalizeJsonParameters(args: Record<string, unknown>, parameters: Record<string, { type?: string }>): Record<string, unknown> {
  const normalized = { ...args };
  for (const [key, definition] of Object.entries(parameters)) {
    const value = normalized[key];
    if (definition.type !== 'json' || typeof value !== 'string') continue;
    try { normalized[key] = JSON.parse(value); } catch { /* preserve invalid input for normal validation */ }
  }
  return normalized;
}
