// PHASE S6 — caller-defined tool emulation (serve has no native caller tools).

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractToolDefs(body: unknown): ToolDef[] {
  const record = asRecord(body);
  const tools = record && Array.isArray(record.tools) ? record.tools : [];
  const out: ToolDef[] = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    const fn = tool ? asRecord(tool.function) : null;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

export function toolChoiceMode(choice: unknown): "none" | "required" | "auto" | { name: string } {
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  const record = asRecord(choice);
  const fn = record ? asRecord(record.function) : null;
  if (record?.type === "function" && fn && typeof fn.name === "string") return { name: fn.name };
  return "auto";
}

export function toolInstruction(tools: ToolDef[], choice: unknown): string | null {
  if (tools.length === 0) return null;
  const mode = toolChoiceMode(choice);
  if (mode === "none") return null;

  const catalog = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");

  const rule =
    typeof mode === "object"
      ? `You MUST call the tool named "${mode.name}".`
      : mode === "required"
        ? "You MUST call exactly one of the tools."
        : "Call a tool only if it is needed to answer.";

  return [
    "You have access to these tools (OpenAI function format):",
    catalog,
    `RULES: ${rule} Reply with the tool call as a fenced block, nothing inside but JSON:`,
    "```tool_call",
    '{"name":"<tool name>","arguments":{...}}',
    "```",
    "Use only the listed tool names. arguments must be a JSON object matching the schema. Put any explanation OUTSIDE the block.",
  ].join("\n");
}

export function buildToolJsonSchema(tools: ToolDef[]): Record<string, unknown> {
  return {
    type: "object",
    oneOf: tools.map((tool) => ({
      type: "object",
      properties: {
        name: { const: tool.name },
        arguments: (asRecord(tool.parameters) ?? { type: "object" }) as Record<string, unknown>,
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    })),
  };
}

export interface ParsedCall {
  name: string;
  arguments: string;
}

const FENCE = /```tool_call\s*([\s\S]*?)```/g;

function tryParseCall(raw: string, known: ReadonlySet<string> | undefined): ParsedCall | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    const record = asRecord(parsed);
    if (!record || typeof record.name !== "string") return null;
    if (known && !known.has(record.name)) return null;
    const args = asRecord(record.arguments) ?? {};
    return { name: record.name, arguments: JSON.stringify(args) };
  } catch {
    return null;
  }
}

// Finds top-level {...} spans, tracking string literals so braces inside
// strings do not confuse the depth counter. Handles multi-line objects.
function scanJsonObjects(text: string): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push({ start, end: i + 1, raw: text.slice(start, i + 1) });
        start = -1;
      }
    }
  }
  return out;
}

export function parseToolCalls(
  text: string,
  known?: ReadonlySet<string>,
): { content: string; calls: ParsedCall[] } {
  const calls: ParsedCall[] = [];
  let content = text.replace(FENCE, (full, inner: string) => {
    const parsed = tryParseCall(inner, known);
    if (!parsed) return full;
    calls.push(parsed);
    return "";
  });

  if (calls.length === 0) {
    // No fenced calls: accept bare JSON object(s) in the message.
    let removed = 0;
    for (const span of scanJsonObjects(content)) {
      const parsed = tryParseCall(span.raw, known);
      if (!parsed) continue;
      calls.push(parsed);
      content = content.slice(0, span.start - removed) + content.slice(span.end - removed);
      removed += span.end - span.start;
    }
  }

  return { content: content.trim(), calls };
}
