// API gateway: OpenAI-compatible proxy with health checks and Prometheus metrics.
// Sits in front of llama-server. Single file, no dependencies beyond node.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const LLAMA = process.env.LLAMA_URL || 'http://127.0.0.1:8081';
const PORT = Number(process.env.PORT || 3000);

const metrics = {
  requests: 0,
  tokensGenerated: 0,
  tokensPrompt: 0,
  totalLatencyMs: 0,
  errors: 0,
  startTime: Date.now(),
};

function proxy(res, upstream) {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
    'Cache-Control': 'no-cache',
  });
  upstream.body.pipe(res);
}

async function handle(req, res) {
  metrics.requests++;
  const started = performance.now();

  if (req.url === '/health' || req.url === '/healthz') {
    try {
      const r = await fetch(`${LLAMA}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', upstream: 'reachable', uptime_s: Math.round((Date.now() - metrics.startTime) / 1000) }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unavailable', error: err.message }));
    }
    return;
  }

  if (req.url === '/metrics') {
    const uptime = (Date.now() - metrics.startTime) / 1000;
    const body = [
      '# HELP inference_requests_total Total requests proxied.',
      '# TYPE inference_requests_total counter',
      `inference_requests_total ${metrics.requests}`,
      '# HELP inference_tokens_generated_total Tokens generated.',
      '# TYPE inference_tokens_generated_total counter',
      `inference_tokens_generated_total ${metrics.tokensGenerated}`,
      '# HELP inference_tokens_prompt_total Prompt tokens consumed.',
      '# TYPE inference_tokens_prompt_total counter',
      `inference_tokens_prompt_total ${metrics.tokensPrompt}`,
      '# HELP inference_errors_total Errors.',
      '# TYPE inference_errors_total counter',
      `inference_errors_total ${metrics.errors}`,
      '# HELP inference_latency_ms_avg Average request latency in ms.',
      '# TYPE inference_latency_ms_avg gauge',
      `inference_latency_ms_avg ${metrics.requests ? (metrics.totalLatencyMs / metrics.requests).toFixed(1) : 0}`,
      '# HELP process_uptime_seconds Uptime.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${uptime.toFixed(1)}`,
    ].join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(body);
    return;
  }

  if (req.url === '/v1/models') {
    try {
      const r = await fetch(`${LLAMA}/v1/models`);
      const body = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const upstream = await fetch(`${LLAMA}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const json = await upstream.json().catch(() => null);
      if (json?.usage) {
        metrics.tokensPrompt += json.usage.prompt_tokens || 0;
        metrics.tokensGenerated += json.usage.completion_tokens || 0;
      }
      metrics.totalLatencyMs += performance.now() - started;
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    } catch (err) {
      metrics.errors++;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', routes: ['/health', '/metrics', '/v1/models', '/v1/chat/completions'] }));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    metrics.errors++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(PORT, () => {
  console.log(`inference gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${LLAMA}`);
  console.log(`health:   http://127.0.0.1:${PORT}/health`);
  console.log(`metrics:  http://127.0.0.1:${PORT}/metrics`);
});
EOF
echo "gateway written"