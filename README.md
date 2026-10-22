# Local Inference Stack

**Self-hosted LLM inference on bare metal.** OpenAI-compatible API, MCP server for agents, Prometheus metrics, Nix-declarative deployment. Benchmarked on an AMD RX 9070 XT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why this exists

Most "AI infrastructure" is a `pip install` away from a cloud API. This is the other thing: a complete inference serving stack you own, running on your own GPU, with no external dependency. Every component is measurable, replaceable, and documented.

## Benchmarks

Measured on AMD RX 9070 XT (16GB VRAM, Vulkan), 4096 context, Q8_0 KV cache, Node 26.

| Model | Quant | Prompt tok/s | Gen tok/s | Avg latency | VRAM |
|---|---|---:|---:|---:|---:|
| Qwen3.8 9B | Q6_K | 23 | **60.1** | 1,065 ms | 12.1 / 16 GB |
| DeepSeek R1 Distill 7B | Q4_K_M | 14 | **97.2** | 659 ms | 10.0 / 16 GB |

Generation throughput is the metric that matters for serving. Both models leave headroom for larger context windows or a second model on the same card.

## Quick start

```bash
# 1. Start the inference backend
export LLAMA_SERVER=~/llama.cpp/llama-b11050/llama-server
export MODEL_DIR=~/models
$LLAMA_SERVER -m $MODEL_DIR/Qwen3.8-9B-heretic-uncensored.i1-Q6_K.gguf \
  --alias qwen3.8-9b --host 127.0.0.1 --port 8081 \
  --ctx-size 4096 --n-gpu-layers 99 -ctk q8_0 -ctv q8_0 --reasoning off

# 2. Start the API gateway
npm run gateway

# 3. Run the benchmark
npm run bench
```

## API

The gateway is OpenAI-compatible. Point any OpenAI client at `http://localhost:3000`.

```bash
# Health check
curl -s http://localhost:3000/health | jq
# {"status":"ok","upstream":"reachable","uptime_s":42}

# List models
curl -s http://localhost:3000/v1/models | jq '.data[].id'
# "qwen3.8-9b"

# Chat completion
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-9b",
    "messages": [{"role": "user", "content": "Explain what a hash table is in three sentences."}],
    "max_tokens": 128,
    "temperature": 0.7
  }' | jq '.choices[0].message.content'

# Prometheus metrics
curl -s http://localhost:3000/metrics
# inference_requests_total 12
# inference_tokens_generated_total 768
# inference_tokens_prompt_total 276
# inference_latency_ms_avg 1065.3
# process_uptime_seconds 120.0
```

Streaming is supported via `stream: true` in the request body (SSE).

## MCP server

Exposes the local model as a tool to LLM agents. Same transport pattern as [`@stanzaapi/mcp`](https://github.com/StanzaAPI): stdio and HTTP/SSE.

```bash
npm run mcp
```

Tools exposed:

| Tool | Description |
|---|---|
| `complete` | Run a completion against the local model. Args: `prompt`, `max_tokens`, `temperature` |
| `health` | Check whether the inference backend is reachable |

Drop it into any MCP client (Claude Desktop, Cursor, or a custom agent) and the local model becomes a callable tool.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Client    │────▶│  API Gateway │────▶│  llama-server │
│ (curl/MCP)  │     │  (Node.js)   │     │  (Vulkan)    │
└─────────────┘     └──────────────┘     └──────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │  Prometheus  │
                    │  /metrics    │
                    └──────────────┘
```

The gateway handles health checks, metrics, and request routing. The inference backend is llama.cpp compiled with Vulkan support for the RX 9070 XT. No cloud dependency at any layer.

## Optimization notes

What moves the numbers:

- **Vulkan offload** (`--n-gpu-layers 99`): all layers on GPU. CPU fallback is ~3x slower.
- **KV cache quantization** (`-ctk q8_0 -ctv q8_0`): halves KV cache memory with negligible quality loss, freeing VRAM for larger context.
- **Context window** (4096 default): larger contexts reduce throughput. 4096 is the sweet spot for single-user serving.
- **Batch-invariant inference** is off by default (NVIDIA-only). On AMD, results may vary slightly across batch sizes.
- **Reasoning mode** is disabled (`--reasoning off`) for the Qwen model. Enabling it burns tokens on chain-of-thought before producing content.

### VRAM budget

| Model | Quant | VRAM (model + KV) | Headroom |
|---|---|---:|---:|
| Qwen3.8 9B | Q6_K | 12.1 GB | 3.9 GB |
| DeepSeek R1 Distill 7B | Q4_K_M | 10.0 GB | 6.0 GB |

Both leave room for a larger context window or a second model on the same card. Qwen3.8 at Q4_K_M would drop to ~6GB, leaving room for a second model.

## Deployment

```bash
# Nix flake (reproducible)
nix run .#default

# Or with env overrides
LLAMA_SERVER=~/llama.cpp/llama-b11050/llama-server \
MODEL_DIR=~/models \
MODEL=DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf \
ALIAS=deepseek-r1-7b \
CTX=4096 \
nix run .#default
```

No systemd units. Each model is a command you run when you want it. Nix owns the wrapper scripts; weights and the llama.cpp build stay where they are.

## Stack

| Component | Technology |
|---|---|
| Inference engine | llama.cpp (Vulkan build, b11050) |
| Models | Qwen3.8 9B (Q6_K), Qwen 3 4B (Q4_K_M), DeepSeek R1 Distill 7B (Q4_K_M) |
| GPU | AMD RX 9070 XT, 16GB VRAM, Vulkan |
| API gateway | Node.js, OpenAI-compatible, zero dependencies |
| Agent protocol | Model Context Protocol (MCP) |
| Monitoring | Prometheus metrics, health checks |
| Deployment | Nix flake, declarative |
| OS | NixOS (flakes, declarative hosts) |

## License

MIT
EOF
echo "README written"; wc -l README.md