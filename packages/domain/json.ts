/** Canonical JSON: object keys stay sorted, while optional values follow JSON semantics. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('顶层数据必须可序列化为 JSON');
  const stable = (item: any): string => Array.isArray(item)
    ? `[${item.map(stable).join(', ')}]`
    : item !== null && typeof item === 'object'
      ? `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}: ${stable(item[key])}`).join(', ')}}`
      : JSON.stringify(item);
  return stable(JSON.parse(serialized));
}

/** Repair the old encoder's bare undefined tokens; never change quoted source text. */
export function repairLegacyJson(raw: string): string | null {
  let quoted = false, escaped = false, result = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (raw.startsWith('undefined', i) && /[\s:,\[]/.test(raw[i - 1] || '') && /[\s,}\]]/.test(raw[i + 9] || '')) {
      result += 'null'; i += 8;
    } else result += char;
  }
  if (result === raw) return null;
  try { return canonicalJson(JSON.parse(result)); } catch { return null; }
}
