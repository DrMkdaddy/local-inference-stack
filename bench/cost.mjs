// Unit economics for local inference: tokens, watts, and cost per million
// tokens. Run each model, sample the GPU power draw while it generates, and
// turn that into Wh and dollars per 1M tokens.
//
//   node bench/cost.mjs
//
// Output: bench/cost.json plus a markdown table on stdout.
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const LLAMA = process.env.LLAMA_SERVER || `${process.env.HOME}/llama.cpp/llama-b11050/llama-server`;
const MODEL_DIR = process.env.MODEL_DIR || `${process.env.HOME}/models`;

// Cost inputs. These are assumptions, not measurements, and they are passed in
// so the output states them rather than burying them.
const ELECTRICITY_USD_KWH = Number(process.env.COST_KWH || 0.15);
const GPU_COST_USD = Number(process.env.COST_GPU_USD || 600);
const AMORTIZE_YEARS = Number(process.env.COST_AMORTIZE_YEARS || 3);
const HOURS_PER_YEAR = Number(process.env.COST_HOURS_PER_YEAR || 2000);

const MODELS = [
  { name: 'qwen3-4b', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', port: 8085, ctx: 4096 },
  { name: 'deepseek-r1-7b', file: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf', port: 8082, ctx: 4096 },
  { name: 'qwen3.8-9b', file: 'Qwen3.8-9B-heretic-uncensored.i1-Q6_K.gguf', port: 8081, ctx: 4096 },
];

// Long enough to hold the GPU in a steady state. A short answer finishes before
// the power reading settles, and the cost per token comes out wrong.
const PROMPT = 'Write a detailed technical explanation of how a B-tree index works: '
  + 'insertion and node splitting, how a database uses the tree for range scans, '
  + 'the difference from a hash index, and where each one wins. Aim for at least 800 words.';
const OUT_TOKENS = Number(process.env.COST_OUT_TOKENS || 1024);

function gpuPowerWatts() {
  const out = spawnSync('rocm-smi', ['--showpower'], { encoding: 'utf8' }).stdout || '';
  const m = out.match(/Average Graphics Package Power \(W\):\s*([\d.]+)/);
  return m ? Number(m[1]) : null;
}

function vramBytes() {
  const out = spawnSync('rocm-smi', ['--showmeminfo', 'vram'], { encoding: 'utf8' }).stdout || '';
  const m = out.match(/Total Used Memory \(B\):\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

async function waitForServer(port, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {}
    await sleep(1500);
  }
  return false;
}

async function measure(model) {
  const child = spawn(LLAMA, [
    '-m', `${MODEL_DIR}/${model.file}`,
    '-a', model.name,
    '-c', String(model.ctx),
    '-ngl', '99',
    '-t', '8',
    '--host', '127.0.0.1',
    '--port', String(model.port),
    '--jinja',
    '-fa', 'on',
    '-ctk', 'q8_0',
    '-ctv', 'q8_0',
    '--reasoning', 'off',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const ready = await waitForServer(model.port);
  if (!ready) {
    child.kill('SIGKILL');
    await sleep(2000);
    return null;
  }

  const vram = vramBytes();

  // Warm up: the first request pays for shader compilation and clocks the GPU
  // up. Measuring during that ramp reports watts that belong to an idle card.
  await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.name,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    }),
  });
  await sleep(1500);

  // Sample power while generating, so the average reflects loaded VRAM and
  // compute rather than the idle clock.
  const samples = [];
  const sampler = setInterval(() => {
    const w = gpuPowerWatts();
    if (w !== null) samples.push(w);
  }, 400);

  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.name,
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: OUT_TOKENS,
      min_tokens: Math.floor(OUT_TOKENS * 0.8),
      temperature: 0.7,
    }),
  });
  const json = await res.json();
  const elapsed = (performance.now() - started) / 1000;
  clearInterval(sampler);

  const usage = json.usage || {};
  const genTokens = usage.completion_tokens || 0;
  const tokPerSec = genTokens / elapsed;

  // Discard samples from the ramp. Anything under a third of the peak is the
  // card sitting idle between the warmup and the measured request.
  const peak = samples.length ? Math.max(...samples) : 0;
  const loaded = samples.filter((w) => w >= peak * 0.66);
  const avgWatts = loaded.length ? loaded.reduce((s, w) => s + w, 0) / loaded.length : null;

  // Wh per 1M generated tokens.
  const wattHoursPerMillion = avgWatts && tokPerSec ? (avgWatts / tokPerSec) * (1e6 / 3600) : null;
  // Wh to kWh before multiplying by a per-kWh rate.
  const electricityPerMillion = wattHoursPerMillion !== null ? (wattHoursPerMillion / 1000) * ELECTRICITY_USD_KWH : null;

  // Amortized hardware: purchase price spread over the useful life and the hours
  // it is actually used.
  const hardwarePerHour = GPU_COST_USD / (AMORTIZE_YEARS * HOURS_PER_YEAR);
  const amortizationPerMillion = tokPerSec ? (hardwarePerHour / tokPerSec) * (1e6 / 3600) : null;

  child.kill('SIGKILL');
  await sleep(2500);

  return {
    model: model.name,
    file: model.file,
    ctx: model.ctx,
    elapsed_s: Number(elapsed.toFixed(2)),
    prompt_tokens: usage.prompt_tokens || 0,
    gen_tokens: genTokens,
    tok_per_sec: Number(tokPerSec.toFixed(1)),
    vram_bytes: vram,
    power_samples: samples.length,
    loaded_watts: avgWatts ? Number(avgWatts.toFixed(1)) : null,
    watt_hours_per_1m_tokens: wattHoursPerMillion !== null ? Number(wattHoursPerMillion.toFixed(2)) : null,
    usd_electricity_per_1m_tokens: electricityPerMillion !== null ? Number(electricityPerMillion.toFixed(3)) : null,
    usd_amortized_per_1m_tokens: amortizationPerMillion !== null ? Number(amortizationPerMillion.toFixed(3)) : null,
  };
}

const results = [];
for (const m of MODELS) {
  process.stdout.write(`${m.name} ... `);
  const r = await measure(m);
  if (!r) {
    console.log('FAILED');
    continue;
  }
  console.log(`${r.tok_per_sec} tok/s, ${r.loaded_watts}W, ${r.watt_hours_per_1m_tokens} Wh/1M tok`);
  results.push(r);
}

const inputs = {
  electricity_usd_per_kwh: ELECTRICITY_USD_KWH,
  gpu_cost_usd: GPU_COST_USD,
  amortize_years: AMORTIZE_YEARS,
  hours_per_year: HOURS_PER_YEAR,
  measured_at: new Date().toISOString(),
};

fs.writeFileSync('bench/cost.json', JSON.stringify({ inputs, results }, null, 2) + '\n');

console.log('\n| model | tok/s | watts | VRAM | Wh / 1M tok | $ / 1M tok (power) | $ / 1M tok (amortized) |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const r of results) {
  console.log(
    `| ${r.model} | ${r.tok_per_sec} | ${r.loaded_watts} | ${r.vram_bytes ? (r.vram_bytes / 1e9).toFixed(1) + ' GB' : '-'} | ` +
    `${r.watt_hours_per_1m_tokens ?? '-'} | ${r.usd_electricity_per_1m_tokens ?? '-'} | ${r.usd_amortized_per_1m_tokens ?? '-'}`,
  );
}
console.log(`\ninputs: ${JSON.stringify(inputs)}`);
