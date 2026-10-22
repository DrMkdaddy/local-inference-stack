# Local Inference Stack

Self-hosted LLM inference on bare metal. OpenAI-compatible API, MCP server for agents, Prometheus metrics, Nix-declarative deploy. Runs on an AMD RX 9070 XT.

## Numbers

RX 9070 XT, 16 GB VRAM, Vulkan. 4096 context, Q8_0 KV cache, all layers offloaded to device. Three runs, no warm-up, same prompt each time.

| Model | Quant | Gen tok/s | Prompt tok/s | Latency | VRAM |
|---|---|---:|---:|---:|---:|
| Qwen3.8 9B | Q6_K | **60.1** | 23 | 1,065 ms | 12.1 GB |
| DeepSeek R1 Distill 7B | Q4_K_M | **97.2** | 14 | 659 ms | 10.0 GB |

7B hits nearly 100 tok/s because Q4_K_M is 4.5 GB against 16 GB of VRAM, leaving the KV cache room to stay out of the spill path. The 9B at Q6_K is a much tighter fit at 12.1 GB, and the difference is the price of the higher precision.

## Running it

```bash
$LLAMA_SERVER -m $MODEL_DIR/Qwen3.8-9B-heretic-uncensored.i1-Q6_K.gguf \
  --alias qwen3.8-9b --host 127.0.1 --port 8081 \
  --ctx-size 4096 --n-gpu-layers 99 -ctk q8_0 -ctv q8_0 --reasoning off

npm run gateway
```

The gateway is OpenAI-compatible. Any client that speaks `/v1` works against it.

```bash
curl -s http://localhost:3000/health | jq
# {"status":"ok","upstream":"reachable","uptime_s":42}

curl -s http://localhost:3000/v1/models | jq '.data[].id'
# "qwen3.8-9b"

curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-9b",
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

`stream: true` in the request body gets you SSE.

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

**Offload everything.** `--n-gpu-layers 99` puts every layer on the device. CPU fallback is roughly 3x slower and drops throughput into the single digits.

**Quantize the KV cache.** `-ctk q8_0 -ctv q8_0` halves KV memory for a quality cost that is not visible in practice. Without it the 9B does not fit at 4096 context.

**Context is the throughput knob.** 4096 is the sweet spot for single-user serving. Every doubling costs both tokens/sec and headroom for a second resident model.

**Quantization buys resident models.** Qwen3.8 9B at Q4_K_M lands near 6 GB, which leaves room to keep a second model on the same card and route between them.

**Reasoning mode is a budget decision.** The Qwen model is a thinking model. `--reasoning off` stops it burning tokens on chain-of-thought before producing content. On, it roughly triples the token cost of a short answer.

**Batch-invariant inference is NVIDIA-only.** On AMD, output can shift slightly across batch compositions. Noted in the code rather than papered over.

## Operations

- `/health` gates on the backend actually answering, not just the process being up
- `/metrics` is Prometheus-format and counts tokens in both directions, not just requests
- No systemd units. Each model is a command you run when you want it, and Nix owns the wrapper scripts
- Weights and the llama.cpp build stay where they are; the flake only describes how to launch them

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
| Deployment | Nix flake |
| Host OS | NixOS, declarative hosts and firewall |

## License

MIT
