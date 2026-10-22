// Build the gateway's model registry from the measured cost data, so the
// routing prices come from bench/cost.json rather than a hand-typed table.
//
//   node bench/make-registry.mjs
import fs from 'node:fs';

const cost = JSON.parse(fs.readFileSync('bench/cost.json', 'utf8'));

const PORT_BY_NAME = {
  'qwen3-4b': 8085,
  'deepseek-r1-7b': 8082,
  'qwen3.8-9b': 8081,
};

const TIER_BY_NAME = {
  'qwen3-4b': 'fast',
  'deepseek-r1-7b': 'balanced',
  'qwen3.8-9b': 'quality',
};

const PARAMS_BY_NAME = {
  'qwen3-4b': '4B',
  'deepseek-r1-7b': '7B',
  'qwen3.8-9b': '9B',
};

const QUANT_BY_NAME = {
  'qwen3-4b': 'Q4_K_M',
  'deepseek-r1-7b': 'Q4_K_M',
  'qwen3.8-9b': 'Q6_K',
};

const models = {};
for (const r of cost.results) {
  models[r.model] = {
    port: PORT_BY_NAME[r.model] || 8081,
    tier: TIER_BY_NAME[r.model] || 'balanced',
    params: PARAMS_BY_NAME[r.model] || null,
    quantization: QUANT_BY_NAME[r.model] || null,
    context: r.ctx,
    tok_per_sec: r.tok_per_sec,
    loaded_watts: r.loaded_watts,
    usd_per_1m_tokens: r.usd_electricity_per_1m_tokens,
    usd_per_1m_tokens_amortized: r.usd_amortized_per_1m_tokens,
    usd_per_1m_prompt_tokens: r.usd_electricity_per_1m_tokens,
  };
}

const registry = {
  generated_from: 'bench/cost.json',
  inputs: cost.inputs,
  models,
};

fs.writeFileSync('models.json', JSON.stringify(registry, null, 2) + '\n');
console.log('wrote models.json');
for (const [name, m] of Object.entries(models)) {
  console.log(`  ${name.padEnd(16)} ${m.tier.padEnd(9)} $${m.usd_per_1m_tokens}/1M tok  ($${m.usd_per_1m_tokens_amortized} amortized)  ${m.tok_per_sec} tok/s`);
}
