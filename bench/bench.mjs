// Benchmark: measure prompt throughput, generation throughput, and latency.
// Runs N requests against the gateway or directly against llama-server.
import { performance } from 'node:perf_hooks';

const URL = process.env.BENCH_URL || 'http://127.0.0.1:8081/v1/chat/completions';
const MODEL = process.env.BENCH_MODEL || 'qwen3.8-9b';
const N = Number(process.env.BENCH_N || 3);
const PROMPT = process.env.BENCH_PROMPT || 'Explain what a hash table is in three sentences.';

const results = [];

for (let i = 0; i < N; i++) {
  const started = performance.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 64, temperature: 0.7 }),
  });
  const json = await res.json();
  const elapsed = performance.now() - started;
  const usage = json.usage || {};
  results.push({
    index: i + 1,
    elapsed_ms: Math.round(elapsed),
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    tokens_per_sec: usage.completion_tokens ? ((usage.completion_tokens / elapsed) * 1000).toFixed(1) : 'n/a',
  });
  console.log(`run ${i + 1}: ${Math.round(elapsed)}ms, ${usage.prompt_tokens || 0} prompt, ${usage.completion_tokens || 0} gen, ${results[i].tokens_per_sec} tok/s`);
}

const avgLatency = results.reduce((s, r) => s + r.elapsed_ms, 0) / results.length;
const avgTps = results.reduce((s, r) => s + (parseFloat(r.tokens_per_sec) || 0), 0) / results.length;
const totalGen = results.reduce((s, r) => s + r.completion_tokens, 0);

console.log(`\nsummary: ${N} runs, avg ${Math.round(avgLatency)}ms, ${avgTps.toFixed(1)} tok/s avg, ${totalGen} tokens total`);
console.log(JSON.stringify(results, null, 2));
