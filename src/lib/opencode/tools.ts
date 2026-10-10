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

const FENCE_START = "```tool_call";

// The earliest index at which `text` could still be the beginning of a fence
// opening: a trailing fragment that a later delta could complete into FENCE_START.
function partialFenceStart(text: string): number | null {
  const max = Math.min(FENCE_START.length - 1, text.length);
  for (let length = max; length >= 1; length--) {
    if (FENCE_START.startsWith(text.slice(text.length - length))) return text.length - length;
  }
  return null;
}

export interface FenceGuard {
  // Appends a raw delta and returns the text that is safe to emit as content.
  push(chunk: string): string;
  // Returns the remaining safe content at end of stream; an unterminated fence is
  // dropped, never emitted as content.
  flush(): string;
}

// Streaming cannot un-emit a delta, so a ```tool_call fence must be held back until
// it is known to be one. Text before a possible fence start is released immediately;
// the fence (and its body) never reaches the caller as content — the call itself is
// parsed out of the assembled text at the end of the turn.
export function createFenceGuard(): FenceGuard {
  let pending = "";
  let insideFence = false;

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      if (insideFence) {
        const close = pending.indexOf("```");
        if (close < 0) {
          if (final) pending = "";
          return out;
        }
        pending = pending.slice(close + 3);
        insideFence = false;
        continue;
      }

      const marker = pending.indexOf(FENCE_START);
      const partial = partialFenceStart(pending);
      const limit = Math.min(
        marker < 0 ? Number.POSITIVE_INFINITY : marker,
        partial ?? Number.POSITIVE_INFINITY,
      );
      if (limit === Number.POSITIVE_INFINITY) {
        out += pending;
        pending = "";
        return out;
      }

      out += pending.slice(0, limit);
      pending = pending.slice(limit);
      if (pending.startsWith(FENCE_START)) {
        pending = pending.slice(FENCE_START.length);
        insideFence = true;
        continue;
      }
      // Only an ambiguous fragment is left: hold it until more text arrives.
      if (final) pending = "";
      return out;
    }
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
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
