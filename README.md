# OpenCode CLI Wrapper

Use OpenCode models through the OpenAI API you already know.

[![GHCR image](https://img.shields.io/badge/GHCR-available-blue?style=flat&logo=docker)](https://github.com/medeiroshudson/opencode-cli-wrapper/pkgs/container/opencode-cli-wrapper)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)

## What is this?

OpenCode CLI Wrapper exposes the models available through the OpenCode CLI as a standard
OpenAI-compatible API. Existing OpenAI clients and tools can connect to it without changes.
Run the API in a container and keep using the models and workflows you already have.

## Features

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` endpoints
- Server-sent events (SSE) streaming of model output
- Works with existing OpenAI SDKs and compatible tools
- Free models available out of the box
- Container-first setup with a published GHCR image

## Quick start

Set a local wrapper key in `.env` before starting the published image. Generate a strong value
for `API_KEY` and keep it secret. The local `.env` file is ignored by Git and should not be
committed or shared. Your host OpenCode files are shared with the container through read-only
mounts, while writable state stays in Docker volumes, so your host setup is never modified.

For Docker Compose, set `API_KEY` in the local `.env` file before running `docker compose up`.
For `docker run`, export `API_KEY` from that file in your shell and pass it with `-e API_KEY`.

```bash
docker run --rm \
  -p 3000:3000 \
  --user root -e HOME=/home/node \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-state:/home/node/.local/state \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -v "$HOME/.cache/opencode:/home/node/.cache/opencode:ro" \
  -v "$HOME/.local/share/opencode/auth.json:/home/node/.local/share/opencode/auth.json:ro" \
  -e API_KEY \
  ghcr.io/medeiroshudson/opencode-cli-wrapper:latest
```

The API is available at `http://localhost:3000`. Run `opencode` on your host at least once so
its configuration and authentication file exist. Without them, listing and validating models
still works, but model requests fail upstream.

### Nix

Run the API directly with Nix:

```bash
API_KEY=your-local-secret nix run github:mausch/opencode-cli-wrapper
```

The flake includes Node.js and OpenCode, so no separate installation is required. Your
normal OpenCode configuration and login are used. The server reads `.env` from the current
directory and listens on port `3000` by default; set `HOST`, `PORT`, or the other
configuration variables below as needed.

The `opencode` flake input defaults to the locked `nixpkgs` input. Override it to select
OpenCode from another nixpkgs revision or from OpenCode's own flake:

```bash
API_KEY=your-local-secret nix run github:mausch/opencode-cli-wrapper \
  --override-input opencode 'github:NixOS/nixpkgs/<revision>'

API_KEY=your-local-secret nix run github:mausch/opencode-cli-wrapper \
  --override-input opencode 'github:anomalyco/opencode/<revision>'
```

The source must export `packages.<system>.opencode`, `packages.<system>.default`, or
`legacyPackages.<system>.opencode` (in that order of preference). To reuse an input from
your own flake, set `inputs.wrapper.inputs.opencode.follows = "opencode"`, where `wrapper`
is your input for this repository and `opencode` is your existing source input.

The selected package takes precedence over `opencode` on your host `PATH`. To use an
already-installed executable instead, set `OPENCODE_BIN` to its absolute path:

```bash
API_KEY=your-local-secret OPENCODE_BIN="$(command -v opencode)" \
  nix run github:mausch/opencode-cli-wrapper
```

## Usage

Every request to the wrapper must include `Authorization: Bearer ${API_KEY}`, where `API_KEY` is
the local wrapper key you configured above. Model requests run through a supervised `opencode serve`
daemon that authenticates with the host's OpenCode credentials, so there is a single upstream
credential and no per-request OpenCode key header. This includes `/health` and `/models.dev.json`.

List available models:

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer ${API_KEY}"
```

```json
{
  "object": "list",
  "data": [{
    "id": "mimo-v2.6-flash-free",
    "object": "model",
    "owned_by": "opencode",
    "context_length": 200000,
    "max_model_len": 200000,
    "max_output_tokens": 32000
  }]
}
```

Context metadata comes from the `opencode serve` catalog API. Each model includes `context_length`
and the vLLM-compatible `max_model_len` (both represent the context limit),
`max_output_tokens`, and (when published) `max_input_tokens`; unavailable fields are omitted.

### Metadata for opencode-models-discovery

`GET /models.dev.json` returns the full catalog as a flat models.dev-schema object keyed by each
bare model id. Like every wrapper endpoint, it requires `Authorization: Bearer ${API_KEY}`.
Configure [`opencode-models-discovery`](https://github.com/yuhp/opencode-models-discovery) with
either enricher format:

```json
"provider": {
  "<id>": {
    "options": {
      "modelsDiscovery": { "enabled": true, "modelInfoFormat": "vllm" }
    }
  }
}
```

The vLLM format reads `max_model_len` from `/v1/models`; it does not use `modelInfoEndpoint`.
For models.dev, use the separate metadata endpoint. The client must support sending a custom
`Authorization: Bearer ${API_KEY}` header when requesting it. Configure that header according to
the client's own documentation; this example does not specify plugin header configuration syntax.

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

If your client version cannot attach custom headers to metadata requests, it cannot access this
protected endpoint directly. The endpoint is not public.

Send a chat completion:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Say hello"}]}'
```

```json
{
  "object": "chat.completion",
  "choices": [{ "message": { "role": "assistant", "content": "Hello!" } }]
}
```

Use the OpenAI SDK by pointing its `baseURL` at the local API and setting `apiKey` to the wrapper
key; the SDK sends it as the ingress Bearer credential. Upstream OpenCode authentication is handled
by the supervised daemon, so no extra header is needed.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: process.env.API_KEY!,
});

const response = await client.chat.completions.create({
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "Say hello" }],
});

console.log(response.choices[0]?.message.content);
```

### Tool reliability harness

`npm run tools:reliability` measures how often each `tool_choice` mode actually produces tool
calls. It fires five requests per mode (`required`, a named function, `auto`, and unset) at
`/v1/chat/completions` with a `get_weather` tool and prints a `choice | hits` table. It is an
on-demand diagnostic, not part of the test suite: it requires the wrapper to be running and
`API_KEY` to be set in the environment. Point it at a different base URL with `WRAPPER_URL`
(default `http://127.0.0.1:3000`).

```bash
API_KEY=your-wrapper-key npm run tools:reliability
```

## Configuration

`API_KEY` is the required wrapper ingress credential. Set it to a locally generated secret in
your ignored `.env` file; requests must send it as `Authorization: Bearer <API_KEY>`. Keep this
value private. Model requests run through a supervised `opencode serve` daemon that authenticates
with the host's OpenCode credentials, so there is a single upstream credential and no per-request
OpenCode key header. The OpenAI SDK's `apiKey` configures the wrapper Bearer credential.

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `0.0.0.0` | Address the API listens on |
| `PORT` | `3000` | API port |
| `API_KEY` | required | Secret used to authenticate wrapper requests with `Authorization: Bearer <API_KEY>` |
| `OPENCODE_BIN` | `opencode` | OpenCode CLI command or path used to spawn the `opencode serve` daemon |
| `OPENCODE_PORT` | `4100` | Port the wrapper spawns its own `opencode serve` daemon on; ignored when `OPENCODE_BASE` names a port on a loopback host |
| `OPENCODE_BASE` | unset | Base URL of the `opencode serve` API to use. A loopback URL makes the wrapper supervise the daemon on that URL's port (so `OPENCODE_PORT` does not apply); a non-loopback URL is used as-is and never spawned locally |
| `OPENCODE_TIMEOUT_MS` | `120000` | Timeout for a chat request served over the serve API, in milliseconds |
| `OPENCODE_SERVE_READY_TIMEOUT_MS` | `20000` | How long to wait for the supervised daemon to become healthy, in milliseconds |
| `OPENCODE_MODELS_TTL_MS` | `300000` | How long to cache the model list, in milliseconds |
| `OPENCODE_PROXY_URL` | unset | Proxy URL applied to both HTTP and HTTPS for the supervised daemon |

## Outbound proxy

The supervised `opencode serve` daemon makes the outbound model requests. Configure its proxy with
a single variable:

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_PROXY_URL` | unset | Proxy URL applied to both HTTP and HTTPS for the daemon. Leave unset to connect directly. |
| `NODE_EXTRA_CA_CERTS` | unset | Optional extra CA certificate file for the daemon. |

Loopback addresses (`localhost,127.0.0.1,::1`) are always bypassed. `OPENCODE_PROXY_URL` is the
single source of truth for the proxy; ambient `HTTP_PROXY`/`HTTPS_PROXY` variables are ignored.

For local development:

```bash
OPENCODE_PROXY_URL=http://127.0.0.1:8080 npm run dev
```

For Docker with a proxy running on the host:

```bash
OPENCODE_PROXY_URL=http://host.docker.internal:8080 docker compose up
```

SOCKS5 proxies are not supported by Bun. Proxy configuration through `opencode.json` is also
unavailable; upstream PR #10856 closed without merging, so configure the proxy with
`OPENCODE_PROXY_URL` only.

## How it works

On the first request, the wrapper starts and supervises a local `opencode serve` daemon, waiting
until it is healthy before serving traffic. `OPENCODE_BASE` changes which daemon that is: a
loopback URL makes the wrapper supervise (and spawn, if needed) the daemon on that URL's port,
while an off-host URL is used as-is and is never replaced by a local process — if such a server is
unhealthy the wrapper fails the request with a clear startup error instead. Each request
translates the API call into a session on that daemon: the conversation is sent as a single prompt,
and the response is returned in the OpenAI format. When streaming is enabled, SSE forwards the
daemon's incremental text deltas. The daemon is stopped when the wrapper shuts down.

## Requirements

Docker, and an OpenCode CLI login on the host for authenticated models.

## License

MIT. See the [LICENSE](LICENSE) file.
