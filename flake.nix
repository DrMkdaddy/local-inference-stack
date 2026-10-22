{
  description = "Local LLM inference serving stack: OpenAI-compatible API, MCP server, benchmarks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      models = import ./models.nix;
      names = nixpkgs.lib.concatStringsSep " " (builtins.attrNames models);

      # Runtime overrides: env vars win. The llama.cpp build stays local, because
      # a Vulkan release binary is what works on the 9070 XT here.
      defaultLlamaServer = "$HOME/llama.cpp/llama-b11050/llama-server";
      defaultModelDir = "$HOME/models";
      stateDir = "$HOME/.local/state/local-inference";

      tools =
        pkgs:
        let
          lib = pkgs.lib;

          # Generic server entry point. Per-model values arrive as env vars, so
          # a model is just data (see models.nix).
          server = pkgs.writeShellApplication {
            name = "inference-server";
            runtimeInputs = with pkgs; [ coreutils ];
            text = ''
              : "''${MODEL_FILE:?MODEL_FILE is required}"
              : "''${MODEL_ALIAS:?MODEL_ALIAS is required}"
              : "''${PORT:?PORT is required}"

              LLAMA_SERVER="''${LLAMA_SERVER:-${defaultLlamaServer}}"
              MODEL_DIR="''${MODEL_DIR:-${defaultModelDir}}"
              HOST="''${HOST:-127.0.0.1}"
              CTX="''${CTX:-4096}"
              NGL="''${NGL:-99}"
              KV="''${KV:-q8_0}"
              FA="''${FA:-on}"

              if [ ! -x "$LLAMA_SERVER" ]; then
                echo "llama-server not found: $LLAMA_SERVER" >&2
                echo "set LLAMA_SERVER to your llama.cpp build (needs Vulkan for the 9070 XT)" >&2
                exit 1
              fi

              model="$MODEL_DIR/$MODEL_FILE"
              if [ ! -f "$model" ]; then
                echo "model not found: $model" >&2
                echo "set MODEL_DIR, or put the .gguf in $MODEL_DIR" >&2
                exit 1
              fi

              exec "$LLAMA_SERVER" \
                -m "$model" \
                -a "$MODEL_ALIAS" \
                -c "$CTX" \
                -ngl "$NGL" \
                --host "$HOST" \
                --port "$PORT" \
                --jinja \
                -fa "$FA" \
                -ctk "$KV" \
                -ctv "$KV" \
                "$@"
            '';
          };

          # `nix run .#<name>`: pins one model's settings.
          mkRunner =
            name: cfg:
            let
              modelArgs = lib.concatStringsSep " " (map lib.escapeShellArg (cfg.args or [ ]));
            in
            pkgs.writeShellApplication {
              name = "run-${name}";
              text = ''
                export MODEL_FILE=${lib.escapeShellArg cfg.file}
                export MODEL_ALIAS=${lib.escapeShellArg cfg.alias}
                export PORT=${toString cfg.port}
                export CTX=${toString (cfg.ctx or 4096)}
                export NGL=${toString (cfg.ngl or 99)}
                export KV=${lib.escapeShellArg (cfg.kv or "q8_0")}
                export FA=${lib.escapeShellArg (cfg.fa or "on")}
                exec ${server}/bin/inference-server ${modelArgs} "$@"
              '';
            };

          runners = lib.mapAttrs mkRunner models;

          caseArms = lib.concatStringsSep "\n" (
            lib.mapAttrsToList (
              name: drv:
              "      ${name}) RUNNER=${drv}/bin/run-${name}; PORT=${toString models.${name}.port}; ALIAS=${
                      lib.escapeShellArg models.${name}.alias
                    } ;;"
            ) runners
          );

          padRight = w: s: s + lib.strings.replicate (lib.max 0 (w - lib.stringLength s)) " ";
          row =
            name: cfg:
            "  ${padRight 10 name} ${padRight 5 (toString cfg.port)} ${padRight 18 cfg.alias} ${cfg.file}";
          headerRow = "  ${padRight 10 "name"} ${padRight 5 "port"} ${padRight 18 "alias"} file";
          modelEchoes = lib.concatMapStringsSep "\n" (l: "echo ${lib.escapeShellArg l}") (
            [ headerRow ] ++ lib.mapAttrsToList row models
          );

          listApp = pkgs.writeShellApplication {
            name = "inference-list";
            runtimeInputs = with pkgs; [ coreutils ];
            text = ''
              echo "Local inference models"
              echo
              ${modelEchoes}
              echo
              echo "run:    nix run .#<name>"
              echo "start:  nix run .#start -- <name>    (background; logs in ${stateDir})"
              echo "stop:   nix run .#stop -- [name]"
              echo "status: nix run .#status"
            '';
          };

          startApp = pkgs.writeShellApplication {
            name = "inference-start";
            runtimeInputs = with pkgs; [ coreutils ];
            text = ''
                            if [ "$#" -lt 1 ]; then
                              echo "usage: nix run .#start -- <name>   (one of: ${names})" >&2
                              exit 1
                            fi
                            name="$1"
                            shift

                            RUNNER=""
                            PORT=""
                            ALIAS=""
                            case "$name" in
              ${caseArms}
                              *)
                                echo "unknown model: $name (one of: ${names})" >&2
                                exit 1
                                ;;
                            esac

                            STATE="${stateDir}"
                            mkdir -p "$STATE"
                            pidfile="$STATE/$name.pid"
                            log="$STATE/$name.log"

                            if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
                              echo "$name already running (pid $(cat "$pidfile")) on port $PORT"
                              exit 0
                            fi

                            echo "starting $name ($ALIAS) on port $PORT ..."
                            nohup "$RUNNER" "$@" >"$log" 2>&1 &
                            echo $! > "$pidfile"
                            sleep 1
                            if kill -0 "$(cat "$pidfile")" 2>/dev/null; then
                              echo "up: pid $(cat "$pidfile"), port $PORT, log $log"
                            else
                              echo "failed to start; last log lines:" >&2
                              tail -n 20 "$log" >&2 || true
                              rm -f "$pidfile"
                              exit 1
                            fi
            '';
          };

          stopApp = pkgs.writeShellApplication {
            name = "inference-stop";
            runtimeInputs = with pkgs; [ coreutils ];
            text = ''
              STATE="${stateDir}"

              stop_one() {
                local n="$1"
                local pf="$STATE/$n.pid"
                if [ -f "$pf" ]; then
                  local pid
                  pid="$(cat "$pf")"
                  if kill -0 "$pid" 2>/dev/null; then
                    kill "$pid" 2>/dev/null || true
                    echo "stopped $n (pid $pid)"
                  else
                    echo "$n not running"
                  fi
                  rm -f "$pf"
                else
                  echo "$n not running"
                fi
              }

              if [ "$#" -ge 1 ] && [ -n "$1" ]; then
                stop_one "$1"
              else
                for n in ${names}; do stop_one "$n"; done
              fi
            '';
          };

          statusBody = lib.concatStringsSep "\n" (
            lib.mapAttrsToList (name: cfg: ''
              printf '%-10s ' "${name}"
              if curl -fsS --max-time 2 "http://127.0.0.1:${toString cfg.port}/v1/models" >/dev/null 2>&1; then
                printf 'UP    port %s  (%s)\n' "${toString cfg.port}" "${cfg.alias}"
              else
                printf 'down  port %s  (%s)\n' "${toString cfg.port}" "${cfg.alias}"
              fi
            '') models
          );

          statusApp = pkgs.writeShellApplication {
            name = "inference-status";
            runtimeInputs = with pkgs; [
              coreutils
              curl
            ];
            text = ''
              echo "Local inference servers"
              ${statusBody}
              if command -v rocm-smi >/dev/null 2>&1; then
                echo
                rocm-smi --showmeminfo vram 2>/dev/null | grep -i 'used' | head -1 || true
              fi
            '';
          };

        in
        {
          inherit
            runners
            listApp
            startApp
            stopApp
            statusApp
            ;
        };
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          t = tools pkgs;

          # Same helper as the apps, so `nix build .#gateway` works.
          mkNodeApp =
            name: script:
            pkgs.writeShellApplication {
              name = name;
              runtimeInputs = with pkgs; [ nodejs_22 ];
              text = ''
                cd ${self}
                if [ ! -d node_modules ]; then
                  echo "node_modules missing: run 'npm install' in the repo root first" >&2
                  exit 1
                fi
                export LLAMA_URL="''${LLAMA_URL:-http://127.0.0.1:8081}"
                exec node ${script} "$@"
              '';
            };
        in
        t.runners
        // {
          default = t.listApp;
          gateway = mkNodeApp "inference-gateway" "src/gateway.mjs";
          mcp = mkNodeApp "inference-mcp" "src/mcp-server.mjs";
          bench = mkNodeApp "inference-bench" "bench/bench.mjs";
          cost = mkNodeApp "inference-cost" "bench/cost.mjs";
          route = mkNodeApp "inference-route" "bench/route-demo.mjs";
        }
      );

      apps = forAllSystems (
        pkgs:
        let
          t = tools pkgs;

          # One app per Node entry point. node_modules has to exist first:
          # `npm install` in the repo root. Env vars pass through to the Node
          # process, which is where the defaults live.
          mkNodeApp =
            name: script:
            pkgs.writeShellApplication {
              name = name;
              runtimeInputs = with pkgs; [ nodejs_22 ];
              text = ''
                cd ${self}
                if [ ! -d node_modules ]; then
                  echo "node_modules missing: run 'npm install' in the repo root first" >&2
                  exit 1
                fi
                export LLAMA_URL="''${LLAMA_URL:-http://127.0.0.1:8081}"
                exec node ${script} "$@"
              '';
            };
        in
        nixpkgs.lib.mapAttrs (name: drv: {
          type = "app";
          program = "${drv}/bin/run-${name}";
        }) t.runners
        // {
          start = {
            type = "app";
            program = "${t.startApp}/bin/inference-start";
          };
          stop = {
            type = "app";
            program = "${t.stopApp}/bin/inference-stop";
          };
          status = {
            type = "app";
            program = "${t.statusApp}/bin/inference-status";
          };
          list = {
            type = "app";
            program = "${t.listApp}/bin/inference-list";
          };
          gateway = {
            type = "app";
            program = "${mkNodeApp "inference-gateway" "src/gateway.mjs"}/bin/inference-gateway";
          };
          mcp = {
            type = "app";
            program = "${mkNodeApp "inference-mcp" "src/mcp-server.mjs"}/bin/inference-mcp";
          };
          bench = {
            type = "app";
            program = "${mkNodeApp "inference-bench" "bench/bench.mjs"}/bin/inference-bench";
          };
          cost = {
            type = "app";
            program = "${mkNodeApp "inference-cost" "bench/cost.mjs"}/bin/inference-cost";
          };
          route = {
            type = "app";
            program = "${mkNodeApp "inference-route" "bench/route-demo.mjs"}/bin/inference-route";
          };
          default = {
            type = "app";
            program = "${t.listApp}/bin/inference-list";
          };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            coreutils
            curl
            jq
            git
            nodejs_22
            nixfmt
          ];
        };
      });

      checks = forAllSystems (pkgs: {
        flake = pkgs.runCommand "flake-check" { } ''
          touch $out
        '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
