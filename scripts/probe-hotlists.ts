/** One-shot live diagnostic for all native hotlist endpoints. Calls each origin once, max 3 concurrent; it never writes to the database. */
import { fetchSourceText, sources } from '../packages/collectors/hotlists.js';

const results: Array<{ source: string; state: string; count: number; metricRows: number; error?: string }> = [];
const requested = new Set(process.argv.slice(2));
const selected = requested.size ? sources.filter(source => requested.has(source.id)) : sources;
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const source = selected[cursor++];
    try {
      const response = await fetchSourceText(source);
      const items = source.parse(response).filter(item => item.title.trim()).slice(0, 200);
      if (!items.length) throw new Error('HTTP 成功但解析结果为空/结构不匹配');
      results.push({ source: `${source.provider}:${source.id}`, state: 'succeeded', count: items.length, metricRows: items.filter(item => item.heat !== null || item.heat_label !== null).length });
    } catch (error) {
      results.push({ source: `${source.provider}:${source.id}`, state: 'failed', count: 0, metricRows: 0, error: (error instanceof Error ? error.message : '未知错误').slice(0, 200) });
    }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
results.sort((a, b) => a.source.localeCompare(b.source));
for (const row of results) console.log(`${row.state}\t${row.source}\titems=${row.count}\tmetric_rows=${row.metricRows}${row.error ? `\terror=${row.error}` : ''}`);
console.log(`SUMMARY\tpassed=${results.filter(r => r.state === 'succeeded').length}\tfailed=${results.filter(r => r.state === 'failed').length}\ttotal=${results.length}`);
