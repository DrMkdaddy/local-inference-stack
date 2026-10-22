# Local Inference Stack

A self-hosted LLM inference serving stack running on bare metal: an OpenAI-compatible API gateway, an MCP server for agent tooling, and Prometheus metrics, all backed by llama.cpp on an AMD RX 9070 XT (Vulkan).

## What it demonstrates

- **Inference serving** on consumer GPU hardware (AMD RX 9070 XT, 16GB VRAM, Vulkan)
- **OpenAI-compatible API** (`/v1/chat/completions`, `/v1/models`) with streaming (SSE)
- **MCP server** exposing the local model as a tool to LLM agents (stdio + HTTP/SSE)
- **Observability**: Prometheus metrics (tokens/sec, latency, queue depth, VRAM)
- **Health checks** with model readiness gates
- **Nix flake** for reproducible deployment
- **Benchmarked**: throughput and latency measured on real hardware

## Note on DeepSeek's inference framework

DeepSeek's published inference framework (DeepInfer) targets NVIDIA SM100 (Blackwell) GPUs
and requires CUDA 13. This stack runs on consumer AMD hardware (RX 9070 XT, 16GB VRAM,
Vulkan) using llama.cpp as the inference engine, with DeepSeek R1 Distill (Qwen 7B) as
one of the served models. The skills demonstrated are the same: model serving, API design,
agent tooling (MCP), observability, and bare-metal operations.

## Stack

| Component | Technology |
|---|---|
| Inference engine | llama.cpp (Vulkan build, b11050) |
| Models | Qwen3.8 9B (Q6_K), Qwen 3 4B (Q4_K_M), DeepSeek R1 Distill (Qwen 7B) |
| GPU | AMD RX 9070 XT, 16GB VRAM, Vulkan |
| API gateway | Node.js, OpenAI-compatible |
| Agent protocol | Model Context Protocol (MCP) |
| Monitoring | Prometheus + Grafana |
| Deployment | Nix flake, declarative |
| OS | NixOS (flakes, declarative hosts) |

## Quick start

```bash
# Start the inference server
nix run .#qwen

# Or directly
LLAMA_SERVER=~/llama.cpp/llama-b11050/llama-server \
MODEL_DIR=~/models \
nix run .#qwen

# Start the API gateway
npm start

# Benchmark
npm run bench
```

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

## Benchmarks

Measured on AMD RX 9070 XT, 16GB VRAM, Vulkan, Node 26.

| Model | Quant | Context | Tok/s (prompt) | Tok/s (gen) | VRAM |
|---|---|---|---|---|---|
| Qwen3.8 9B | Q6_K | 4096 | 60.1 | ~1065 | 12.1 / 16 |
| Qwen 3 4B | Q4_K_M | 4096 | _TBD_ | _TBD_ | _TBD_ |
| DeepSeek R1 Distill 7B | Q4_K_M | 4096 | 97.2 | ~659 | 10.0 / 16 |

## License

MIT
