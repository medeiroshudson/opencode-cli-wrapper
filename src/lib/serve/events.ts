// PHASE S2 — parsing of the opencode serve SSE event stream.

export interface ServeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

export function parseSseBlock(block: string): ServeEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return null;
  if (data.trim() === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      type: record.type,
      properties:
        typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

export function textDelta(ev: ServeEvent): string | null {
  if (ev.type !== "message.part.delta") return null;
  if (ev.properties.field !== "text") return null;
  const delta = ev.properties.delta;
  return typeof delta === "string" ? delta : null;
}

export function partText(ev: ServeEvent): string | null {
  if (ev.type !== "message.part.updated") return null;
  const part = ev.properties.part;
  if (typeof part !== "object" || part === null) return null;
  const record = part as Record<string, unknown>;
  if (record.type !== "text") return null;
  return typeof record.text === "string" ? record.text : null;
}

export function isFinish(ev: ServeEvent): boolean {
  return ev.type === "session.idle" || ev.type === "message.updated";
}
