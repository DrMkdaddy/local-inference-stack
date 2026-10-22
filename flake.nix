{
  description = "Local LLM inference serving stack: OpenAI-compatible API, MCP server, benchmarks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_22;
      in
      {
        apps.default = {
          type = "app";
          program = "${pkgs.writeShellScript "start" ''
            export LLAMA_SERVER=''${LLAMA_SERVER:-$HOME/llama.cpp/llama-b11050/llama-server}
            export MODEL_DIR=''${MODEL_DIR:-$HOME/models}
            export HOST=''${HOST:-127.0.0.1}
            export PORT=''${PORT:-8081}
            export CTX=''${CTX:-4096}
            export NGL=''${NGL:-99}
            export KV=''${KV:-q8_0}
            export MODEL=''${MODEL:-Qwen3.8-9B-heretic-uncensored.i1-Q6_K.gguf}
            export ALIAS=''${ALIAS:-qwen3.8-9b}

            echo "Starting llama-server on $HOST:$PORT with $MODEL"
            exec "$LLAMA_SERVER" \
              -m "$MODEL_DIR/$MODEL" \
              --alias "$ALIAS" \
              --host "$HOST" \
              --port "$PORT" \
              --ctx-size "$CTX" \
              --n-gpu-layers "$NGL" \
              -ctk "$KV" -ctv "$KV" \
              --reasoning off
          ''}";
        };

        apps.bench = {
          type = "app";
          program = "${nodejs}/bin/node ${self}/bench/bench.mjs";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ nodejs pkgs.curl ];
        };
      }
    );
}
