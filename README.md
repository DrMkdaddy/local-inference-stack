# Local Inference Stack

Self-hosted LLM inference on bare metal. OpenAI-compatible API, MCP server for agents, Prometheus metrics, Nix-declarative deploy. Runs on an AMD RX 9070 XT.

## Numbers

RX 9070 XT, 16 GB VRAM, Vulkan. DeepSeek R1 Distill 7B at Q4_K_M, 4096 context, Q8_0 KV cache, all layers on device. Three runs, no warm-up.

| Measurement | Value |
|---|---|
| Generation | **101 tok/s** (256 output tokens, 2,527 ms) |
| Prefill | **2,400 tok/s** (981 prompt tokens, 405 ms) |
| Aggregate, 4 concurrent requests | **286 tok/s** (4 parallel slots) |
| Time to first token | 161 ms on a cached prefix, 405 ms cold |
| VRAM | 9.9 GB of 16 GB |

Qwen3.8 9B at Q6_K runs at 60 tok/s and 12.1 GB. The 7B is the faster path: 4.5 GB of weights leaves the KV cache off the spill path, and the difference is the price of Q6_K precision.

## Running it

```bash
$LLAMA_SERVER -m $MODEL_DIR/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf \
  --alias deepseek-r1-7b --host 127.0.0.1 --port 8082 \
  --ctx-size 4096 --n-gpu-layers 99 -ctk q8_0 -ctv q8_0 --reasoning off

npm run gateway
```

The gateway is OpenAI-compatible. Any client that speaks `/v1` works against it.

```bash
curl -s http://localhost:3000/health | jq
# {"status":"ok","upstream":"reachable","uptime_s":42}

curl -s http://localhost:3000/v1/models | jq '.data[].id'
# "deepseek-r1-7b"

curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-r1-7b",
    "messages": [{"role": "user", "content": "Explain what a hash table is in three sentences."}],
    "max_tokens": 128,
    "temperature": 0.7
  }' | jq '.choices[0].message.content'

curl -s http://localhost:3000/metrics
# inference_requests_total 12
# inference_tokens_generated_total 768
# inference_tokens_prompt_total 276
# inference_latency_ms_avg 1065.3
# process_uptime_seconds 120.0
```

`stream: true` in the request body gets SSE.

## MCP

The local model, exposed to agents as a tool. Same transport as [`@stanzaapi/mcp`](https://github.com/StanzaAPI): stdio and HTTP/SSE.

```bash
npm run mcp
```

| Tool | Args |
|---|---|
| `complete` | `prompt`, `max_tokens`, `temperature` |
| `health` | — |

Point Claude Desktop, Cursor, or your own agent at it and the local model is callable.

## Shape

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Client    │────▶│  API Gateway │────▶│  llama-server │
│ (curl/MCP)  │     │  (Node.js)   │     │  (Vulkan)    │
└─────────────┘     └──────────────┘     └──────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │  Prometheus  │
                    └──────────────┘
```

Gateway owns health, metrics, routing. Backend is llama.cpp with Vulkan. Nothing leaves the box.

## Tuning

Sweep results are in `bench/results.json`. Reproduce with `node bench/sweep.mjs`.

**Parallel slots are the throughput lever.** Four concurrent requests on one slot: 103 tok/s aggregate, 4,977 ms wall. Two slots: 184 tok/s, 2,790 ms. Four slots: 286 tok/s, 1,792 ms. 2.8x aggregate from `-np 4`, and per-request latency stays under 1.8 s because the scheduler batches the slots together. Single-user serving does not need this; anyone serving a team does.

| Parallel slots | Aggregate tok/s | Wall time, 4 requests |
|---:|---:|---:|
| 1 | 102.9 | 4,977 ms |
| 2 | 183.5 | 2,790 ms |
| 4 | 285.7 | 1,792 ms |

**KV cache quantization is not worth it at this model size.** At 8192 context, f16 costs 10.2 GB and runs at 96 tok/s. q8_0 saves 300 MB and runs at 91 tok/s. q4_0 saves 400 MB and runs at 93 tok/s. The cache is a rounding error next to 4.5 GB of weights, so quantizing it trades 5% of throughput for 2% of VRAM. It pays off on a larger model or a much longer context, not here.

| KV type | VRAM at 8192 | Gen tok/s |
|---|---:|---:|
| f16 | 10.2 GB | 96.2 |
| q8_0 | 9.9 GB | 90.6 |
| q4_0 | 9.8 GB | 92.8 |

**Context length costs VRAM, not speed.** The same 981-token prompt prefills in 405 ms at 2048 context, 405 ms at 4096, 410 ms at 8192. VRAM moves 9.8 to 10.0 GB across that range. The KV cache is allocated up front, so a larger window reserves memory whether or not you use it.

**Prefix cache reuse cuts repeat latency in half.** `--cache-reuse 256` on a repeated 981-token prompt: 405 ms cold, 161 ms warm. System prompts and few-shot examples are the same on every call, so this is the cheapest win in the stack.

**Offload every layer.** `--n-gpu-layers 99`. CPU fallback drops throughput into the single digits.

**Reasoning mode is a budget decision.** The Qwen model is a thinking model. `--reasoning off` stops it spending tokens on chain-of-thought before the answer. On, it roughly triples the token cost of a short reply.

**Batch-invariant inference is NVIDIA-only.** On AMD, output can shift slightly across batch compositions.

## Operations

- `/health` gates on the backend answering `/v1/models`, not just the process being up
- `/metrics` is Prometheus format and counts tokens in both directions, not just requests
- No systemd units. Each model is a command you run when you want it, and Nix owns the wrapper scripts
- Weights and the llama.cpp build stay where they are; the flake only describes how to launch them
- `nix run .#status` checks every registered model and prints VRAM

```bash
nix run .#list
nix run .#start -- deepseek
nix run .#status
nix run .#stop -- deepseek
```

Env overrides for any of it:

```bash
LLAMA_SERVER=~/llama.cpp/llama-b11050/llama-server \
MODEL_DIR=~/models \
MODEL=DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf \
ALIAS=deepseek-r1-7b \
CTX=4096 \
nix run .#default
```

## Stack

| | |
|---|---|
| Inference | llama.cpp, Vulkan build b11050 |
| GPU | AMD RX 9070 XT, 16 GB, Vulkan |
| API gateway | Node.js, OpenAI-compatible, zero dependencies |
| Agent protocol | Model Context Protocol, stdio + HTTP/SSE |
| Monitoring | Prometheus metrics, health checks |
| Deployment | Nix flake, one app per model |
| Host OS | NixOS, declarative hosts and firewall |

## License

MIT
