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
- Server-sent events (SSE) for step-by-step streaming
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
the local wrapper key you configured above. The separate `x-opencode-key` header is optional and
passes an upstream OpenCode credential for a chat request; it never authenticates access to the
wrapper. This includes `/health` and `/models.dev.json`.

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

Context metadata comes from `opencode models --verbose`. Each model includes `context_length` and
the vLLM-compatible `max_model_len` (both represent the context limit),
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
key. The SDK sends this as the ingress Bearer credential. To pass a separate upstream OpenCode
credential for chat requests, add `x-opencode-key` with `defaultHeaders`:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: process.env.API_KEY!,
  // Add this only when sending a separate upstream OpenCode credential.
  ...(process.env.OPENCODE_API_KEY && {
    defaultHeaders: { "x-opencode-key": process.env.OPENCODE_API_KEY },
  }),
});

const response = await client.chat.completions.create({
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "Say hello" }],
});

console.log(response.choices[0]?.message.content);
```

## Configuration

`API_KEY` is the required wrapper ingress credential. Set it to a locally generated secret in
your ignored `.env` file; requests must send it as `Authorization: Bearer <API_KEY>`. Keep this
value private. The optional `x-opencode-key` request header carries a separate upstream OpenCode
credential for chat requests. It does not replace or authenticate the wrapper Bearer key. The
OpenAI SDK's `apiKey` configures the wrapper Bearer credential; use `defaultHeaders` separately
if you want to send `x-opencode-key`.

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `0.0.0.0` | Address the API listens on |
| `PORT` | `3000` | API port |
| `API_KEY` | required | Secret used to authenticate wrapper requests with `Authorization: Bearer <API_KEY>` |
| `OPENCODE_BIN` | `opencode` | OpenCode CLI command or path |
| `OPENCODE_TIMEOUT_MS` | `120000` | Timeout for a chat request, in milliseconds |
| `OPENCODE_MODELS_TTL_MS` | `300000` | How long to cache the model list, in milliseconds |
| `OPENCODE_MODELS_TIMEOUT_MS` | `30000` | Timeout for reading the model list, in milliseconds |
| `OPENCODE_PROXY_URL` | unset | Proxy URL applied to both HTTP and HTTPS for the spawned CLI |

## Outbound proxy

Only the spawned `opencode run` CLI makes outbound requests. Configure its proxy with a single
variable:

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_PROXY_URL` | unset | Proxy URL applied to both HTTP and HTTPS for the CLI. Leave unset to connect directly. |
| `NODE_EXTRA_CA_CERTS` | unset | Optional extra CA certificate file passed to the CLI. |

The wrapper sets the CLI's `HTTP_PROXY`/`HTTPS_PROXY` from `OPENCODE_PROXY_URL`, always bypasses
the proxy for loopback (`localhost,127.0.0.1,::1`), and ignores any ambient
`HTTP_PROXY`/`HTTPS_PROXY` — `OPENCODE_PROXY_URL` is the single source of truth.

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

For each request, the wrapper translates the API call into an OpenCode CLI run. It passes the
conversation as a single prompt, then returns the CLI's response in the OpenAI format. When
streaming is enabled, SSE delivers the response step by step.

## Requirements

Docker, and an OpenCode CLI login on the host for authenticated models.

## License

MIT. See the [LICENSE](LICENSE) file.
