// Routing demo: sends the same request to the gateway under different
// constraints and shows which model the router picks and what it cost.
//
//   node bench/route-demo.mjs
import fs from 'node:fs';

const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const registry = JSON.parse(fs.readFileSync('models.json', 'utf8'));

const cases = [
  { label: 'auto', body: { model: 'auto' } },
  { label: 'tier fast', body: { model: 'fast' } },
  { label: 'tier balanced', body: { model: 'balanced' } },
  { label: 'tier quality', body: { model: 'quality' } },
  { label: 'balanced, ceiling $0.30/1M', body: { model: 'balanced', max_cost_per_1m: 0.30 } },
  { label: 'quality, ceiling $0.30/1M', body: { model: 'quality', max_cost_per_1m: 0.30 } },
  { label: 'quality, ceiling $0.20/1M', body: { model: 'quality', max_cost_per_1m: 0.20 } },
  { label: 'explicit qwen3-4b', body: { model: 'qwen3-4b' } },
];

const prices = Object.entries(registry.models)
  .map(([name, m]) => `${name} $${m.usd_per_1m_tokens_amortized}/1M (${m.tier})`)
  .join(', ');

console.log(`registry: ${prices}\n`);

for (const c of cases) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...c.body,
      messages: [{ role: 'user', content: 'Say hi in one sentence.' }],
      max_tokens: 16,
    }),
  });
  const json = await res.json();
  if (json.error) {
    console.log(`  ${c.label.padEnd(30)} refused: ${json.error}`);
  } else {
    console.log(
      `  ${c.label.padEnd(30)} -> ${String(json.model).padEnd(16)} tier ${String(json.x_local?.tier).padEnd(9)} $${json.x_local?.estimated_cost_usd}`,
    );
  }
}

const report = await (await fetch(`${GATEWAY}/cost`)).json();
console.log(`\nspend so far: $${report.total_cost_usd} over ${report.total_requests} requests, ${report.total_tokens_generated} tokens generated`);
for (const row of report.by_model) {
  console.log(`  ${row.model.padEnd(16)} ${String(row.requests).padStart(3)} req  ${String(row.tokens_generated).padStart(6)} tok  $${row.cost_usd}  $${row.usd_per_1k_tokens}/1k`);
}
