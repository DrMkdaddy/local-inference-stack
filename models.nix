# Model registry. The flake turns each entry into `nix run .#<name>`.
#
# Fields:
#   file  - .gguf filename inside MODEL_DIR (default ~/models)
#   alias - name the API reports for the loaded model
#   port  - HTTP port for llama-server
#   ctx   - context window
#   ngl   - layers offloaded to GPU (99 = all)
#   kv    - KV cache quantization (q8_0)
#   fa    - flash attention (on)
#   args  - extra llama-server flags
#
# Notes:
# The 7B at Q4_K_M is the fast path: 4.5 GB of weights leaves the KV cache
# room to stay off the spill path on a 16 GB card. The 9B at Q6_K is the
# quality path and lands at 12.1 GB, which is why it needs the larger context
# budget traded against it.
{
  qwen = {
    file = "Qwen3.8-9B-heretic-uncensored.i1-Q6_K.gguf";
    alias = "qwen3.8-9b";
    port = 8081;
    ctx = 4096;
    ngl = 99;
    kv = "q8_0";
    fa = "on";
    args = [
      "--reasoning"
      "off"
    ];
  };

  deepseek = {
    file = "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf";
    alias = "deepseek-r1-7b";
    port = 8082;
    ctx = 4096;
    ngl = 99;
    kv = "q8_0";
    fa = "on";
    args = [
      "--reasoning"
      "off"
    ];
  };

  # A small model, for the case where two need to be resident at once, and for
  # the cheap tier the router prefers.
  qwen4b = {
    file = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
    alias = "qwen3-4b";
    port = 8085;
    ctx = 4096;
    ngl = 99;
    kv = "q8_0";
    fa = "on";
    args = [
      "--reasoning"
      "off"
    ];
  };
}
