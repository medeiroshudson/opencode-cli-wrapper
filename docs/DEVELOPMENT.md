# OpenCode OpenAI-Compatible API

An OpenAI-compatible HTTP API (`/v1/models`, `/v1/chat/completions`, SSE) that proxies the model
catalog and chat turns served by a supervised `opencode serve` daemon. Each chat request opens a
session on that daemon and sends the whole conversation as a single prompt ("prompt-embed").

> Design rationale and spike evidence: [`docs/plan.md`](plan.md).
> Ordered build plan: [`.omo/plans/opencode-openai-api.md`](../.omo/plans/opencode-openai-api.md).

## Why the serve API

Earlier revisions shelled out to `opencode run` per request. The wrapper now drives a single
supervised `opencode serve` daemon instead: it forwards real incremental text deltas, keeps one warm
process instead of paying a spawn cost per request, and centralizes upstream authentication in the
daemon.

## Requirements

- Node.js >= 22 (Docker image uses `node:22-alpine`)
- The `opencode` CLI on `PATH` (used to spawn `opencode serve`; pinned to `1.18.31` in Docker)

## Quick start (Docker)

```bash
docker compose up --build
```

The API is then available at `http://localhost:3000`.

### Docker: OpenCode credentials

`docker compose` already mounts the host's OpenCode CLI state so the container can reach the
free models:

- `${HOME}/.config/opencode` and `${HOME}/.cache/opencode` are mounted read-only.
- `${HOME}/.local/share/opencode/auth.json` is mounted read-only.
- OpenCode's writable state lives in the named volumes `opencode-data` / `opencode-state`, so
  your host database is never modified.

The service runs as `root` so it can write those named volumes. This assumes you have run
`opencode` on the host at least once so the config and `auth.json` exist; otherwise
`/v1/models`, validation and error mapping still work but `opencode serve` fails upstream.

## Quick start (local)

```bash
npm install
cp .env.example .env
npm run dev        # or: npm run build && npm start
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BIN` | `opencode` | Path/command used to spawn `opencode serve` |
| `OPENCODE_PORT` | `4100` | Loopback port the supervised daemon listens on |
| `OPENCODE_BASE` | unset | Base URL of an existing serve API; overrides `OPENCODE_PORT` |
| `OPENCODE_TIMEOUT_MS` | `120000` | Per-request timeout for a serve HTTP call |
| `OPENCODE_SERVE_READY_TIMEOUT_MS` | `20000` | How long to wait for the daemon to become healthy |
| `OPENCODE_MODELS_TTL_MS` | `300000` | How long to cache the discovered model catalog |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | HTTP bind address |

## Usage

### List models

`GET /v1/models` returns the model catalog discovered from the serve API and cached by TTL. Every
request requires `Authorization: Bearer <API_KEY>`; with a single upstream credential the whole
catalog is always visible.

```bash
curl -s http://localhost:3000/v1/models \
  -H 'Authorization: Bearer your-api-key'
```

```json
{ "object": "list", "data": [{ "id": "mimo-v2.6-flash-free", "object": "model", "owned_by": "opencode", "context_length": 200000, "max_model_len": 200000 }] }
```

When published by the serve catalog API, each model also includes `max_output_tokens` and
`max_input_tokens`; unavailable limit fields are omitted. `max_model_len` mirrors the model's
context limit for vLLM-compatible metadata discovery.

### Model metadata discovery plugin

`GET /models.dev.json` returns the full catalog as a flat models.dev-schema object keyed by bare
model id. Like every wrapper endpoint it requires `Authorization: Bearer <API_KEY>`. For
[`opencode-models-discovery`](https://github.com/yuhp/opencode-models-discovery), configure the
vLLM enricher to read `max_model_len` from `/v1/models` (no separate metadata URL):

```json
"provider": {
  "<id>": {
    "options": {
      "modelsDiscovery": { "enabled": true, "modelInfoFormat": "vllm" }
    }
  }
}
```

To use its models.dev enricher instead, point it at the separate endpoint:

```json
"provider": {
  "<id>": {
    "options": {
      "modelsDiscovery": {
        "enabled": true,
        "modelInfoFormat": "models.dev",
        "modelInfoEndpoint": "http://127.0.0.1:3000/models.dev.json"
      }
    }
  }
}
```

### Chat completion

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Olá, quem é você?"}]}'
```

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1790375466,
  "model": "mimo-v2.6-flash-free",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 32921, "completion_tokens": 9, "total_tokens": 32930 }
}
```

### Streaming

```bash
curl -sN http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Olá"}],"stream":true}'
```

Returns `text/event-stream` (`chat.completion.chunk` frames carrying incremental text deltas)
terminated by `data: [DONE]`.

### OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: process.env.API_KEY! });

const completion = await client.chat.completions.create({
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "Olá, quem é você?" }],
});
```

## Errors

| Situation | Status | `error.type` / `error.code` |
|---|---|---|
| Invalid body | `400` | `invalid_request_error` |
| Model not in the visible model catalog | `404` | `server_error` / `opencode_error` |
| Upstream/model error | `500` | `server_error` / `opencode_error` |

## Known limitations (by design)

- **No cross-turn recall.** Each turn opens a fresh OpenCode session, so the entire `messages[]`
  history is embedded into one prompt on every request.
- **`temperature` / `max_tokens` are soft-anchored** into the prompt (the serve turn carries no
  sampling flags), so they act as hints, not guarantees.
- **Model availability may change.** The API discovers models from the serve catalog; what is
  available depends on the host's OpenCode providers and credentials.
- **Docker needs the host's OpenCode credentials.** `docker compose` mounts your host OpenCode
  config/cache/auth (read-only) and keeps writable state in named volumes. If the host has never
  run `opencode`, `opencode serve` fails upstream while `/v1/models`, validation and error mapping
  still work.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest, offline-safe
INTEGRATION=1 npm test   # also runs real `opencode` calls
npm run build       # emits dist/
```

## Architecture

```
src/
  config/index.ts              # env resolution, catalog visibility/resolution, listModels/resolveModel/modelsDevMetadata
  lib/opencode/compose.ts      # messages[] -> single prompt (prompt-embed)
  lib/opencode/turn.ts         # one chat turn against the serve API (session per turn)
  lib/opencode/models.ts       # catalog fetched from the serve API, cached by TTL
  lib/opencode/tools.ts        # tool-call extraction + JSON schema
  lib/serve/client.ts          # HTTP client for `opencode serve` (catalog, sessions, SSE)
  lib/serve/events.ts          # serve SSE event -> text delta / finish parsing
  lib/serve/process.ts         # supervises the daemon: spawn, wait for health, kill on shutdown
  lib/serve/runtime.ts         # process-wide client + supervisor singletons
  lib/openai-format/index.ts   # buildCompletion / SSE / toOpenAIErrorBody
  routes/models.ts             # GET /v1/models and GET /models.dev.json
  routes/chat.ts               # POST /v1/chat/completions
  server.ts                    # Fastify wiring, Bearer auth, error mapping, onClose shutdown hook
```

On the first request, `getServeSupervisor().ensureReady()` starts a local `opencode serve` daemon
(or reuses the one at `OPENCODE_BASE`) and waits for it to become healthy before the catalog is
fetched; the `onClose` hook stops it when the server shuts down.
