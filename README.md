# opencode-llamacpp-auto

OpenCode plugin that turns a local [`llama-server`](https://github.com/ggml-org/llama.cpp) into a **zero-config provider**.

You start llama.cpp, OpenCode shows the model. You switch models, OpenCode follows. No editing `opencode.json` per model, no restarting the app, no hardcoded context sizes.

```
llama.cpp (local)
  └── Qwen3.5-9B-MTP       131072 ctx · text,image,video
        ├── none
        └── thinking
```

## Why

Most llama.cpp plugins ask you to pin a `baseURL` in `opencode.json`, hardcode the context window, or always advertise text-only input. This one reads the running server instead:

| Signal | Source | Used for |
|---|---|---|
| Loaded model | `GET /v1/models` | model list and IDs |
| Display name | `GET /props` → `model_alias` | readable picker entry |
| Context window | `/props` → `default_generation_settings.n_ctx` | compaction and limits |
| Vision / video | `/props` → `modalities` | `capabilities.input` |
| Tool calling | `/props` → `chat_template_caps.supports_tool_calls` | `capabilities.tools` |
| Reasoning | `/props` → `chat_template_caps.reasoning_effort_levels` | model variants |

## Install

```sh
opencode plugin add opencode-llamacpp-auto
```

Or as a local directory — OpenCode loads every package directory under `~/.config/opencode/plugins/` automatically, no config entry needed:

```
~/.config/opencode/plugins/llamacpp-auto/
├── index.ts
└── package.json
```

## Usage

Start llama.cpp however you normally do:

```sh
llama-server -m model.gguf --alias Qwen3.5-9B --ctx-size 131072 --port 8080 --jinja
```

Then pick `llama.cpp (local)` in `/models`. On the CLI:

```sh
opencode run -m "llamacpp/Qwen3.5-9B" "hello"
opencode run -m "llamacpp/Qwen3.5-9B#thinking" "hello"
```

Switch to another model or restart the server on another port: the provider refreshes within 15 seconds, keeping its name in the picker.

## How it works

1. Every 15 s the plugin probes `8080`, `9931`, `1234`, `8000` (or `LLAMACPP_BASE_URL`) and requires `/health` to return `ok`.
2. It reads `/props` and `/v1/models`, then registers the `llamacpp` provider through `ctx.provider.transform`.
3. Reasoning variants come from the model's chat template:
   - `reasoning_effort_levels: ["low", "medium", "high"]` → one variant per level, sent as `reasoning_effort`
   - a template that only exposes `enable_thinking` → `none` / `thinking`, sent as `chat_template_kwargs`
   - otherwise → no variants
4. If nothing answers for 5 minutes (20 misses), the provider is removed so the picker does not keep a dead entry.

While a model is loading, `/health` returns `503`; the plugin keeps the last known inventory instead of flapping.

## Configuration

None required.

| Variable | Default | Description |
|---|---|---|
| `LLAMACPP_BASE_URL` | auto-detect | Force a single endpoint, e.g. `http://127.0.0.1:8080` |

## Requirements

- OpenCode v2 (plugin API `@opencode/plugin` 2.2+).
- A `llama-server` build that exposes `/health`, `/props` and `/v1/models`.

## Limitations

- Only the models the server currently reports are published. llama-server serves one loaded model per process unless you use `--models-preset`.
- Reasoning variants describe what the template accepts; the server still decides the default via `--reasoning` and `--reasoning-format`.

## License

MIT
