// Agentic benchmark against a RUNNING wrapper instance.
// Usage: BASE_URL=http://127.0.0.1:55394 node scripts/agentic-bench.mjs
//
// Scenarios:
//   A  baseline non-stream chat (no tools)
//   B  agentic non-stream: tool loop (tool_choice auto)
//   C  agentic streaming: same loop, SSE — measures TTFB and delta cadence
//   D  forced tool call (tool_choice required, non-stream)
//
// Tools are deterministic local stubs, so every round is comparable.

import OpenAI from "openai";
import { config } from "dotenv";

config();

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:55394";
const MODEL = process.env.BENCH_MODEL ?? "deepseek-flash";
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

if (!process.env.API_KEY) throw new Error("API_KEY missing (.env)");
const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: `${BASE_URL}/v1`,
  maxRetries: 0,
  timeout: 180_000,
});

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Current local time for a timezone (IANA name)",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string" } },
        required: ["timezone"],
      },
    },
  },
];

function executeTool(name, args) {
  if (name === "get_weather") return JSON.stringify({ city: args.city, temp_c: 24, sky: "parcialmente nublado" });
  if (name === "get_time") return JSON.stringify({ timezone: args.timezone, iso: "2026-10-11T14:00:00-03:00" });
  return JSON.stringify({ error: `unknown tool ${name}` });
}

const AGENTIC_PROMPT =
  "Qual é o tempo em São Paulo e que horas são lá agora? Você DEVE usar as ferramentas para responder. Depois responda em uma frase.";
const BASELINE_PROMPT = "Responda em uma única frase: o que é o protocolo SSE?";

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
const ms = (v) => `${v.toFixed(0)}ms`;

async function baselineOnce() {
  const t0 = performance.now();
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: BASELINE_PROMPT }],
  });
  const total = performance.now() - t0;
  return {
    total,
    content: res.choices[0]?.message?.content ?? "",
    usage: res.usage,
    finish: res.choices[0]?.finish_reason,
  };
}

async function agenticOnce({ stream }) {
  const messages = [{ role: "user", content: AGENTIC_PROMPT }];
  const rounds = [];
  let ttfb = null;
  let deltas = 0;
  const t0 = performance.now();

  for (let round = 1; round <= 6; round += 1) {
    const rt0 = performance.now();
    if (!stream) {
      const res = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 500,
      });
      rounds.push(performance.now() - rt0);
      const msg = res.choices[0]?.message;
      const calls = msg?.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          rounds, total: performance.now() - t0, ttfb, deltas,
          answer: msg?.content ?? "", usage: res.usage, finish: res.choices[0]?.finish_reason,
        };
      }
      messages.push(msg);
      for (const c of calls) {
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: executeTool(c.function.name, JSON.parse(c.function.arguments || "{}")),
        });
      }
      continue;
    }

    // streaming: consume the whole turn, collecting deltas and any tool_calls
    const s = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      stream: true,
      max_tokens: 500,
    });
    let content = "";
    const calls = [];
    let lastChunkAt = null;
    for await (const chunk of s) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const now = performance.now();
      if (ttfb === null) ttfb = now - t0;
      lastChunkAt = now;
      const d = choice.delta;
      if (d?.content) {
        content += d.content;
        deltas += 1;
      }
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: undefined, name: "", arguments: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
    rounds.push(performance.now() - rt0);
    if (calls.length === 0 || calls.every((c) => !c || !c.name)) {
      return { rounds, total: performance.now() - t0, ttfb, deltas, answer: content, usage: null, finish: null };
    }
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id ?? `call_${c.name}`, type: "function", function: { name: c.name, arguments: c.arguments } })),
    });
    for (const c of calls) {
      messages.push({ role: "tool", tool_call_id: c.id ?? `call_${c.name}`, content: executeTool(c.name, JSON.parse(c.arguments || "{}")) });
    }
  }
  throw new Error("agentic loop exceeded 6 rounds");
}

async function forcedOnce() {
  const t0 = performance.now();
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: "Que horas são em Tokyo?" }],
    tools: TOOLS,
    tool_choice: "required",
    max_tokens: 200,
  });
  return { total: performance.now() - t0, toolCalls: res.choices[0]?.message?.tool_calls ?? [], usage: res.usage };
}

const report = (label, rows) => {
  const totals = stats(rows.map((r) => r.total));
  const out = { scenario: label, total: { min: ms(totals.min), p50: ms(totals.p50), mean: ms(totals.mean), p95: ms(totals.p95), max: ms(totals.max) } };
  if ("rounds" in rows[0] && rows[0].rounds) {
    out.roundsPerRun = rows.map((r) => r.rounds.length);
    const allRounds = rows.flatMap((r) => r.rounds);
    out.meanRound = ms(allRounds.reduce((a, b) => a + b, 0) / Math.max(1, allRounds.length));
  }
  if ("ttfb" in rows[0]) {
    const t = stats(rows.map((r) => r.ttfb ?? 0));
    out.ttfb = { p50: ms(t.p50), mean: ms(t.mean) };
    out.deltasPerRun = rows.map((r) => r.deltas);
  }
  const u = rows[0].usage;
  if (u) {
    out.tokensPerRequest = {
      prompt_min: Math.min(...rows.map((r) => r.usage?.prompt_tokens ?? 0)),
      prompt_max: Math.max(...rows.map((r) => r.usage?.prompt_tokens ?? 0)),
      completion_mean: Math.round(rows.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0) / rows.length),
    };
  }
  return out;
};

console.error(`bench: ${BASE_URL} model=${MODEL} runs=${RUNS}`);

// warm-up (also surfaces the supervised daemon's state)
const warm = await baselineOnce();
console.error(`warmup: ${ms(warm.total)} finish=${warm.finish} prompt_tokens=${warm.usage?.prompt_tokens}`);

const A = [];
for (let i = 0; i < RUNS; i += 1) A.push(await baselineOnce());
console.log(JSON.stringify(report("A baseline non-stream", A)));

const B = [];
for (let i = 0; i < RUNS; i += 1) {
  const r = await agenticOnce({ stream: false });
  console.error(`B#${i}: rounds=${r.rounds.length} total=${ms(r.total)} finish=${r.finish}`);
  B.push(r);
}
console.log(JSON.stringify(report("B agentic non-stream", B)));
console.error(`B sample answer: ${B[0].answer.slice(0, 120)}`);

const C = [];
for (let i = 0; i < RUNS; i += 1) {
  const r = await agenticOnce({ stream: true });
  console.error(`C#${i}: rounds=${r.rounds.length} total=${ms(r.total)} ttfb=${ms(r.ttfb ?? 0)} deltas=${r.deltas}`);
  C.push(r);
}
console.log(JSON.stringify(report("C agentic stream", C)));
console.error(`C sample answer: ${C[0].answer.slice(0, 120)}`);

const D = [];
for (let i = 0; i < 3; i += 1) D.push(await forcedOnce());
console.log(JSON.stringify(report("D tool_choice=required", D)));
console.error(`D sample call: ${JSON.stringify(D[0].toolCalls?.[0])}`);
