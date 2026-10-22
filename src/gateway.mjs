// API gateway and cost-aware router.
//
// One process in front of several local llama-server instances. Routes each
// request to the cheapest model that satisfies the request, tracks tokens and
// spend per model, and exposes the unit economics over HTTP.
//
// Routing:
//   "model": "qwen3.8-9b"   -> that exact model
//   "model": "quality"       -> cheapest model at or above the requested tier
//   "model": "auto"          -> cheapest model that is currently healthy
//   "max_cost_per_1m": 0.5   -> ceiling; a model that cannot meet it is not used
//
// Env:
//   MODELS_FILE  path to the model registry (default models.json)
//   PORT         gateway port (default 3000)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const MODELS_FILE = process.env.MODELS_FILE || 'models.json';
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'auto';

const registry = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
const MODELS = Object.entries(registry.models || {}).map(([name, m]) => ({
  name,
  url: m.url || `http://127.0.0.1:${m.port || 8081}`,
  tier: m.tier || 'balanced',
  params: m.params || null,
  context: m.context || 4096,
  quantization: m.quantization || null,
  usd_per_1m_tokens: m.usd_per_1m_tokens != null ? Number(m.usd_per_1m_tokens) : null,
  usd_per_1m_tokens_amortized: m.usd_per_1m_tokens_amortized != null ? Number(m.usd_per_1m_tokens_amortized) : null,
  usd_per_1m_prompt_tokens: m.usd_per_1m_prompt_tokens != null ? Number(m.usd_per_1m_prompt_tokens) : null,
}));

const TIER_ORDER = { fast: 0, balanced: 1, quality: 2 };

const metrics = {
  requests: 0,
  errors: 0,
  totalLatencyMs: 0,
  tokensPrompt: 0,
  tokensGenerated: 0,
  costUsd: 0,
  startTime: Date.now(),
  byModel: new Map(),
};

function modelStats(name) {
  if (!metrics.byModel.has(name)) {
    metrics.byModel.set(name, { requests: 0, tokensPrompt: 0, tokensGenerated: 0, costUsd: 0, latencyMs: 0 });
  }
  return metrics.byModel.get(name);
}

async function healthy(model) {
  try {
    const res = await fetch(`${model.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick a model. Exact names win. A tier name picks the cheapest model at or
 * above that tier. A cost ceiling filters candidates first.
 *
 * Selection uses the amortized cost per token, not the electricity figure. On a
 * card you already own, the cost of a token is the hardware spread over its
 * useful life; the power draw is the marginal cost on top, reported separately.
 * Comparing a ceiling against the power cost would price every model out.
 */
function unitCost(m) {
  return m.usd_per_1m_tokens_amortized ?? m.usd_per_1m_tokens;
}

async function select(body) {
  const requested = body.model || DEFAULT_MODEL;
  const ceiling = body.max_cost_per_1m != null ? Number(body.max_cost_per_1m) : null;

  const withinCeiling = (m) => {
    if (ceiling === null) return true;
    const cost = unitCost(m);
    return cost !== null && cost <= ceiling;
  };

  if (requested !== 'auto' && TIER_ORDER[requested] === undefined) {
    const exact = MODELS.find((m) => m.name === requested);
    if (exact && withinCeiling(exact)) return exact;
    if (exact) return null;
  }

  const tier = TIER_ORDER[requested] !== undefined ? TIER_ORDER[requested] : 0;
  const candidates = MODELS
    .filter(withinCeiling)
    .filter((m) => TIER_ORDER[m.tier] >= tier)
    .filter((m) => unitCost(m) !== null)
    .sort((a, b) => unitCost(a) - unitCost(b));

  for (const c of candidates) {
    if (await healthy(c)) return c;
  }
  return null;
}

function costOf(model, promptTokens, genTokens) {
  if (!model) return { total: 0, marginal: 0 };
  const unit = unitCost(model) || 0;
  const marginalUnit = model.usd_per_1m_tokens || 0;
  const promptUnit = model.usd_per_1m_prompt_tokens ?? unit;
  return {
    total: ((promptTokens / 1e6) * promptUnit) + ((genTokens / 1e6) * unit),
    marginal: ((promptTokens / 1e6) * marginalUnit) + ((genTokens / 1e6) * marginalUnit),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    const states = await Promise.all(MODELS.map(async (m) => ({ name: m.name, up: await healthy(m) })));
    const anyUp = states.some((s) => s.up);
    res.writeHead(anyUp ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: anyUp ? 'ok' : 'unavailable', models: states, uptime_s: Math.round((Date.now() - metrics.startTime) / 1000) }));
    return;
  }

  if (url.pathname === '/v1/models') {
    const list = MODELS.map((m) => ({
      id: m.name,
      object: 'model',
      owned_by: 'local',
      context: m.context,
      tier: m.tier,
      quantization: m.quantization,
      usd_per_1m_tokens: m.usd_per_1m_tokens,
      usd_per_1m_tokens_amortized: m.usd_per_1m_tokens_amortized,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: list }));
    return;
  }

  // Unit economics report: spend, tokens, and cost per 1k tokens by model.
  if (url.pathname === '/cost') {
    const rows = [...metrics.byModel.entries()].map(([name, s]) => ({
      model: name,
      requests: s.requests,
      tokens_prompt: s.tokensPrompt,
      tokens_generated: s.tokensGenerated,
      cost_usd: Number(s.costUsd.toFixed(6)),
      usd_per_1k_tokens: s.tokensGenerated ? Number(((s.costUsd / s.tokensGenerated) * 1000).toFixed(6)) : 0,
      avg_latency_ms: s.requests ? Math.round(s.latencyMs / s.requests) : 0,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total_requests: metrics.requests,
      total_cost_usd: Number(metrics.costUsd.toFixed(6)),
      total_tokens_generated: metrics.tokensGenerated,
      usd_per_1k_tokens_all: metrics.tokensGenerated ? Number(((metrics.costUsd / metrics.tokensGenerated) * 1000).toFixed(6)) : 0,
      by_model: rows,
      inputs: { electricity_usd_per_kwh: registry.inputs?.electricity_usd_per_kwh, gpu_cost_usd: registry.inputs?.gpu_cost_usd },
    }, null, 2));
    return;
  }

  if (url.pathname === '/metrics') {
    const uptime = (Date.now() - metrics.startTime) / 1000;
    const lines = [
      '# HELP inference_requests_total Total requests routed.',
      '# TYPE inference_requests_total counter',
      `inference_requests_total ${metrics.requests}`,
      '# HELP inference_errors_total Errors.',
      '# TYPE inference_errors_total counter',
      `inference_errors_total ${metrics.errors}`,
      '# HELP inference_tokens_prompt_total Prompt tokens.',
      '# TYPE inference_tokens_prompt_total counter',
      `inference_tokens_prompt_total ${metrics.tokensPrompt}`,
      '# HELP inference_tokens_generated_total Generated tokens.',
      '# TYPE inference_tokens_generated_total counter',
      `inference_tokens_generated_total ${metrics.tokensGenerated}`,
      '# HELP inference_cost_usd_total Estimated spend.',
      '# TYPE inference_cost_usd_total counter',
      `inference_cost_usd_total ${metrics.costUsd.toFixed(6)}`,
      '# HELP inference_latency_ms_avg Average request latency.',
      '# TYPE inference_latency_ms_avg gauge',
      `inference_latency_ms_avg ${metrics.requests ? (metrics.totalLatencyMs / metrics.requests).toFixed(1) : 0}`,
      '# HELP process_uptime_seconds Uptime.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${uptime.toFixed(1)}`,
    ];
    for (const [name, s] of metrics.byModel) {
      lines.push(`inference_model_requests_total{model="${name}"} ${s.requests}`);
      lines.push(`inference_model_tokens_generated_total{model="${name}"} ${s.tokensGenerated}`);
      lines.push(`inference_model_cost_usd_total{model="${name}"} ${s.costUsd.toFixed(6)}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    metrics.requests++;
    const started = performance.now();
    let raw = '';
    for await (const chunk of req) raw += chunk;

    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }

    const model = await select(body);
    if (!model) {
      metrics.errors++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no model satisfies the request', requested: body.model || DEFAULT_MODEL }));
      return;
    }

    const upstreamBody = { ...body, model: model.name };
    try {
      const upstream = await fetch(`${model.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
      });
      const json = await upstream.json().catch(() => null);
      const usage = json?.usage || {};
      const promptTokens = usage.prompt_tokens || 0;
      const genTokens = usage.completion_tokens || 0;
      const cost = costOf(model, promptTokens, genTokens);

      metrics.tokensPrompt += promptTokens;
      metrics.tokensGenerated += genTokens;
      metrics.costUsd += cost.total;
      metrics.totalLatencyMs += performance.now() - started;

      const s = modelStats(model.name);
      s.requests++;
      s.tokensPrompt += promptTokens;
      s.tokensGenerated += genTokens;
      s.costUsd += cost.total;
      s.latencyMs += performance.now() - started;

      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...json,
        model: model.name,
        x_local: {
          tier: model.tier,
          usd_per_1m_tokens: unitCost(model),
          estimated_cost_usd: Number(cost.total.toFixed(8)),
          estimated_marginal_cost_usd: Number(cost.marginal.toFixed(8)),
        },
      }));
    } catch (err) {
      metrics.errors++;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', routes: ['/health', '/v1/models', '/v1/chat/completions', '/cost', '/metrics'] }));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    metrics.errors++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(PORT, () => {
  console.log(`inference gateway on http://127.0.0.1:${PORT}`);
  console.log(`models: ${MODELS.map((m) => `${m.name} (${m.tier}, $${m.usd_per_1m_tokens}/1M)`).join(', ')}`);
  console.log(`routes: /health /v1/models /v1/chat/completions /cost /metrics`);
});
