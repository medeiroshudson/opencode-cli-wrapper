// Tool-choice reliability harness. This is NOT part of CI: it needs the wrapper
// running. For each tool_choice variant it fires N requests at
// POST /v1/chat/completions with a single `get_weather` tool and counts how many
// responses actually produced tool calls. Run it with `npm run tools:reliability`.
//
// Environment:
//   API_KEY      required; sent as `Authorization: Bearer <API_KEY>`
//   WRAPPER_URL  optional; wrapper base URL (default http://127.0.0.1:3000)
//   MODEL        optional; model id to exercise (default mimo-v2.6-flash-free)
//   ATTEMPTS     optional; requests per variant (default 5)
//   TIMEOUT_MS   optional; per-request timeout (default 120000)

const BASE_URL = (process.env.WRAPPER_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;
const MODEL = process.env.MODEL ?? "mimo-v2.6-flash-free";
const ATTEMPTS = Number.parseInt(process.env.ATTEMPTS ?? "5", 10) || 5;
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS ?? "120000", 10) || 120_000;

// The exact variants the wrapper must honor; `undefined` sends no tool_choice field.
const CHOICES = [
  { label: "required", value: "required" },
  { label: "function:get_weather", value: { type: "function", function: { name: "get_weather" } } },
  { label: "auto", value: "auto" },
  { label: "unset", value: undefined },
];

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
};

const MESSAGES = [{ role: "user", content: "What is the weather in Paris right now?" }];

async function fireOnce(choice) {
  const body = { model: MODEL, messages: MESSAGES, tools: [TOOL] };
  if (choice.value !== undefined) body.tool_choice = choice.value;

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = await response.json();
  const calls = json?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

async function main() {
  if (!API_KEY) {
    console.error("API_KEY is not set. Export the wrapper key before running.");
    process.exit(1);
  }

  const rows = [];
  for (const choice of CHOICES) {
    let hits = 0;
    let failures = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        if (await fireOnce(choice)) hits++;
      } catch (error) {
        failures++;
        if (failures === 1) console.error(`  ! ${choice.label}: ${error.message}`);
      }
    }
    rows.push({ label: choice.label, hits, failures });
  }

  const labelWidth = Math.max("choice".length, ...rows.map((row) => row.label.length));
  const hitsWidth = Math.max("hits".length, ...rows.map((row) => `${row.hits}/${ATTEMPTS}`.length));

  console.log(`\nTool-call reliability -> ${BASE_URL} (model ${MODEL}, ${ATTEMPTS} attempts each)\n`);
  console.log(`${"choice".padEnd(labelWidth)} | ${"hits".padStart(hitsWidth)}`);
  console.log(`${"-".repeat(labelWidth)}-+-${"-".repeat(hitsWidth)}`);
  for (const row of rows) {
    console.log(`${row.label.padEnd(labelWidth)} | ${`${row.hits}/${ATTEMPTS}`.padStart(hitsWidth)}`);
  }

  const totalFailures = rows.reduce((sum, row) => sum + row.failures, 0);
  if (totalFailures > 0) {
    console.log(`\n${totalFailures} request(s) failed; see stderr above.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});