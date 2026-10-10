# Migração do transporte: `opencode run` (CLI) → `opencode serve` (HTTP)

- **Data:** 2026-10-10
- **Status:** aprovado (aguardando revisão do spec)
- **Origem:** sessão de brainstorming (`superpowers:brainstorming`)
- **Substitui parcialmente:** premissas do `docs/plan.md` §2 e §3.5 (ver §3)

---

## 1. Objetivo

Trocar o transporte de comunicação do wrapper com o OpenCode: sair do spawn de
`opencode run` **por request** para um **cliente HTTP** de um `opencode serve`
supervisionado localmente. Preservar o contrato OpenAI atual e a promessa de
modelos free, ganhando:

- **streaming incremental real** (hoje é um blob único re-fatiado);
- **latência menor** (~2,6× medido);
- **suporte a tools** (hoje inexistente).

## 2. Contexto e motivação

Hoje cada request HTTP do wrapper spawna `opencode run --format json`, injeta o
histórico como prompt (prompt-embed) e reduz o NDJSON em uma resposta OpenAI.

Limitações medidas neste ambiente (`opencode 1.18.35`, modelo
`opencode/muse-spark-1.3-contributor-free`):

| Sintoma | Medição |
|---|---|
| Streaming é falso | 1 evento `text` no fim da geração, re-fatiado por nós |
| Overhead fixo por request | ~2,1 s de spawn + bootstrap |
| Latência end-to-end | ~7,3 s (CLI) vs ~2,8 s (serve), mesmo prompt |
| Tools | não suportadas (schema só aceita `model/messages/stream/temperature/max_tokens/variant`) |

O `opencode serve` é a interface oficial: publica **OpenAPI 3.1 em `/doc`** e
serve de base para o **SDK oficial** — logo, é uma interface estável e
versionada, não um detalhe interno.

## 3. Evidências (verificações feitas)

### 3.1 A promessa de free models é independente do transporte

| Teste | Resultado |
|---|---|
| Zen `GET /models` sem auth | **200** (catálogo público) |
| Zen `POST /chat/completions` sem auth | **403** `FreeTierError: "OpenCode's free tier can only be used from within OpenCode"` |
| Zen `POST /chat/completions` com Bearer inválido | **401** `AuthError` |
| Catálogo do CLI | provider `opencode` = **Zen** (84 modelos); **não existe** provider models.dev |
| `opencode serve` servindo free model | **funciona** |

**Conclusão:** a restrição do `plan.md` §2 é real — não se pode chamar o HTTP do
Zen direto. Mas ela é sobre **"ser o OpenCode"**, não sobre qual interface do
OpenCode. `opencode run` e `opencode serve` passam pelo mesmo portão de
atestação. **Trocar o transporte não afeta o acesso aos free models.** O risco
levantado durante o brainstorming **não se materializa**.

### 3.2 Sessões fazem recall (contradiz `plan.md` §3.5)

`opencode run -s <sessionID>` leu a mensagem anterior ("Your name is Hudson and
you like Rust"). A premissa "sessões não fazem recall" está **errada** hoje.
Ainda assim, mantemos o design **sem estado** (sessão nova por request) por
decisão de escopo — não usamos sessões reais nesta migração.

### 3.3 Superfície do serve (via `/doc` e chamadas reais)

- `GET /config/providers` → catálogo completo com `limit` (`context`/`output`),
  `cost`, `capabilities` (inclui `toolcall: true`), `variants`, `status`.
  **Dispensa a CLI para o catálogo.**
- `POST /session` → cria sessão (aceita `agent`, `model`, `title`).
- `POST /session/{id}/message` → aceita `model` (`{providerID,modelID}`),
  `system`, `variant`, `format`, `tools`, `parts` (obrigatório).
- `GET /api/session/{id}/event?after=<cursor>` → **SSE por sessão** com cursor.
- `GET /event`, `GET /global/event` → SSE global.
- `POST /session/{id}/abort` → aborta geração (limpeza sem matar processo).
- `DELETE /session/{id}` → remove sessão.
- `OutputFormatJsonSchema` = `{type:"json_schema", schema, retryCount}`.
- Evento `message.part.delta` = `{sessionID, messageID, partID, field, delta}`.

### 3.4 `tools` no serve ≠ tools do chamador

O campo `tools` do `POST /session/{id}/message` é `{nome: boolean}` — liga/desliga
as ferramentas **internas** do opencode. **Não** aceita schemas de função do
chamador. Tools definidas pelo cliente precisam ser **emuladas** (ver §7).

### 3.5 Confiabilidade de tool calling (baseline a superar)

Medido com instrução + fence (abordagem do repo de referência):

| `tool_choice` | tool_calls emitidos |
|---|---|
| `required` | 4/5 |
| função nomeada | 2/5 |
| `auto` | 5/5 |
| omitido | 5/5 |

Além disso, o repo de referência **vaza a fence no `content`** (3/3
reproduções) por causa do fallback `content || text` (Node) /
`if content.is_empty() { &text }` (Rust) quando a mensagem é só o bloco de tool
call. Nosso design corrige isso (§7.2).

## 4. Decisões (lock)

| Decisão | Valor |
|---|---|
| Transporte | Cliente HTTP de um `opencode serve` supervisionado |
| Alvo | **serve-only** — o caminho CLI é removido |
| Escopo de capacidade | Paridade + streaming real + tools |
| Estado | **Sem estado** — sessão nova por request, prompt-embed |
| Daemon | O wrapper supervisiona o `serve` (container único) |
| Credencial upstream | **Uma só** (auth do host); `x-opencode-key` é removido |
| Auth do wrapper | `Bearer API_KEY` mantém-se (inalterado) |
| Catálogo | `GET /config/providers` do serve |
| `system`/`model`/`variant` | Nativos no `POST /session/{id}/message` |
| `temperature`/`max_tokens` | Por ancoragem no prompt (sem knob nativo) |

## 5. Arquitetura e componentes

```
src/
  server.ts            # mantém: Fastify + hook de auth Bearer
  config/index.ts      # env (OPENCODE_BASE/PORT, timeouts); helpers de catálogo
  lib/
    serve/
      process.ts       # NOVO  supervisão: health → spawn → readiness → shutdown
      client.ts        # NOVO  cliente HTTP: health, providers, sessions, message, event
      events.ts        # NOVO  parser dos blocos SSE do serve
    opencode/
      models.ts        # REESCRITO  catálogo vindo do serve (fim do parse de texto da CLI)
      compose.ts       # MANTÉM  prompt-embed (com `system` nativo disponível)
      tools.ts         # NOVO  instrução + parsing de tool calls (ver §7)
      runner.ts        # REMOVIDO
    openai-format/     # ESTENDE  chunks com deltas de tool_call; mapeamento de usage
  routes/
    models.ts          # MANTÉM (fonte trocada)
    chat.ts            # REESCRITO  usa o client; SSE de verdade
tests/
  helpers/fake-serve.ts  # NOVO  substitui fake-opencode.ts (stub HTTP)
```

Três unidades novas, cada uma com propósito único e testável isolado:

- **`serve/process.ts`** — ciclo de vida do daemon. Interface:
  `ensureReady()`, `baseUrl()`, `shutdown()`. Se `OPENCODE_BASE` responde
  `healthy`, usa; senão spawna `opencode serve --hostname 127.0.0.1`, espera
  readiness (timeout configurável) e encerra no shutdown.
- **`serve/client.ts`** — transporte. Métodos finos sobre os endpoints de §3.3.
- **`serve/events.ts`** — parsing dos blocos SSE (`data:`/`[DONE]`) em eventos.

`runner.ts` (spawn por request) desaparece. O restante do wrapper fica intacto —
é uma troca de substrato, não uma reescrita.

## 6. Fluxo de dados

### 6.1 `stream: false`

1. Hook Bearer valida (inalterado).
2. `getCatalog()` → serve `/config/providers` (cache com TTL).
3. `resolveModel()` (semântica atual: `id` puro, `provider/id`, filtro free-only).
4. Compõe prompt (histórico embutido) + `system` nativo + instrução de tools (§7).
5. `ensureReady()` do daemon.
6. `POST /session` → `sessionID`.
7. `POST /session/{id}/message` (bufferizado) → `{info, parts}`.
8. `DELETE /session/{id}` (best-effort) → completion OpenAI.

### 6.2 `stream: true`

1. Passos 1–6 de §6.1.
2. Abre `GET /api/session/{id}/event` **antes** de postar a mensagem.
3. Posta a mensagem em paralelo (o serve a processa; deltas chegam pelo SSE).
4. Cada `message.part.delta` com `field:"text"` → chunk `delta.content`.
5. Ao terminar: emite `tool_calls` (§7) ou `finish_reason`; `[DONE]`; fecha o
   stream; `DELETE` a sessão.

**Efeito observável:** sai o blob único e entra streaming incremental (medido: 9
deltas no mesmo prompt). Latência cai de ~7,3 s para ~2,8 s.

## 7. Tools

### 7.1 Contrato (paridade OpenAI)

- Aceita `tools` e `tool_choice` (`none`/`auto`/`required`/`{function:{name}}`).
- Emite `tool_calls` + `finish_reason: "tool_calls"`.
- Aceita `role:"tool"` no histórico (resultados), renderizados no prompt-embed.

### 7.2 Emulação em dois modos, por `tool_choice`

| `tool_choice` | Mecanismo | Razão |
|---|---|---|
| `required` / nomeada | `format: json_schema` do serve (com `retryCount`) | constrange o modelo ao JSON → mais confiável que fence. O cliente **quer** uma chamada, então não há texto natural a streamar |
| `auto` / omitido | Instrução + parsing de fence | permite resposta em texto natural e streaming normal; aceita a flakiness residual |
| `none` | Instrução omitida (tools não renderizadas) | o cliente proíbe chamadas; não há o que emular |

**Correções sobre a referência:**
1. **Fim do vazamento de fence:** o parser devolve o `content` **sempre com o
   bloco removido** — nunca cai de volta no texto cru (não reproduz o
   `content || text`).
2. **Parser tolerante:** aceita bloco cercado *e* objeto JSON solto, e múltiplas
   chamadas.

### 7.3 Risco explícito

Não foi validado que os free models honram `format: json_schema` (não há flag de
capability explícita para isso). **Plano de contingência:** se não honrarem, o
modo `required`/nomeada cai para o modo instrução (§7.2, linha 2). A validação
ocorre na implementação.

## 8. Tratamento de erros

- **Daemon caído** → `ensureReady()` reergue; 1 retry.
- **Erro do upstream** → mapeia para formas OpenAI (429/502/500/404) reusando
  `toOpenAIErrorBody`.
- **Timeout** → `POST /session/{id}/abort` (não mata processo) — limpeza mais
  limpa que o `SIGKILL` atual.
- **Sessão órfã** → `DELETE` best-effort no `finally`.
- **Rate limit** → `429` (forma OpenAI).

## 9. Configuração (env)

| Env | Default | Nota |
|---|---|---|
| `OPENCODE_BASE` | `http://127.0.0.1:4100` | URL do serve; se saudável, usa |
| `OPENCODE_PORT` | `4100` | porta do serve spawnado |
| `OPENCODE_BIN` | `opencode` | binário para spawnar o serve |
| `OPENCODE_TIMEOUT_MS` | `120000` | timeout por request |
| `OPENCODE_MODELS_TTL_MS` | `300000` | TTL do cache de catálogo |
| `API_KEY` | — | auth do wrapper (inalterado) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | inalterado |

**Removido:** `x-opencode-key` (header) e o encaminhamento de credencial por
request; `OPENCODE_MODELS_TIMEOUT_MS` (o catálogo não usa mais a CLI). Atualizar
`README.md` e `docs/DEVELOPMENT.md`.

## 10. Testes

- **`tests/helpers/fake-serve.ts`** substitui `fake-opencode.ts`: servidor HTTP
  stub (ou client injetado) que devolve `/config/providers`, cria sessão, emite
  um stream de eventos e responde a mensagem. Testar deixa de ser "mockar
  `spawn`" e passa a ser "mockar HTTP".
- **Unitários novos:** parse do catálogo; parser de eventos SSE; parser de tools
  (**com teste de regressão do vazamento de fence**); mapeamento de erro;
  supervisão do daemon (health/spawn/readiness com processo falso).
- **Mantidos:** `auth`, `compose`, `openai-format`, `config`.
- **Harness de confiabilidade:** script que mede a taxa de acerto de
  `tool_choice` (o mesmo da avaliação) — sob demanda, não bloqueia CI.
- **Integração opcional:** contra um `serve` real, opt-in (precisa de auth/rede).

`runner.test.ts` vira `client.test.ts`.

## 11. Riscos e incertezas

1. **`format: json_schema` nos free models** — não validado (§7.3). Contingência
   definida.
2. **Confiabilidade de tool calling** — baseline fraca (§3.5); o modo
   `json_schema` deve melhorar, mas não é garantido.
3. **Custo de tokens por turno** — ~65–70 k `prompt_tokens` por request (system
   prompt de agente do opencode + replay do histórico). **Não** é resolvido nesta
   migração (exigiria sessões reais, fora de escopo).
4. **Supervisão do daemon** — órfãos/restart são responsabilidade nova do
   wrapper; mitigado isolando em `serve/process.ts`.

## 12. Fora de escopo

- Sessões reais / continuidade multi-turn (cortaria o replay de tokens).
- Multi-tenant / credencial por request.
- Suporte a serve externo (modo híbrido).
- Ferramentas nativas do opencode expostas ao chamador.

## 13. Migração (alto nível)

1. `serve/process.ts` + `serve/client.ts` + `serve/events.ts` (com testes).
2. Reescrever `opencode/models.ts` para `/config/providers`.
3. Reescrever `routes/chat.ts` para o client (não-stream primeiro, depois SSE).
4. `tools.ts` + integração no chat (modos `json_schema` e instrução).
5. Remover `runner.ts`, `x-opencode-key`, `fake-opencode.ts`.
6. Atualizar `README.md`, `docs/DEVELOPMENT.md`, `.env.example`.
7. Harness de confiabilidade de tools.

Detalhamento e ordem de execução ficam no plano de implementação
(`superpowers:writing-plans`).
