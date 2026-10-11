// PHASE S2 — turn the opencode serve SSE event stream into text deltas.
//
// Streaming reads the GLOBAL `/event` stream: the per-session
// `/api/session/{id}/event` endpoint is silent on 1.18.35, so events are filtered
// by sessionID here instead. Two traps the stream carries:
//   - `message.part.delta` fires for BOTH the reasoning part and the answer part,
//     each with `field: "text"`, so a delta is only answer text if its partID was
//     first seen on a `message.part.updated` part of type "text".
//   - `message.updated` fires for the user's own message seconds before the answer,
//     so it is NOT terminal; `session.idle` is.

export interface ServeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface StreamState {
  readonly sessionId: string;
  readonly textParts: Set<string>;
}

export interface Projection {
  delta: string | null;
  done: boolean;
  failed: string | null;
}

const NOTHING: Projection = { delta: null, done: false, failed: null };

export function newStreamState(sessionId: string): StreamState {
  return { sessionId, textParts: new Set() };
}

function failureMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "upstream turn failed";
}

export function projectEvent(state: StreamState, ev: ServeEvent): Projection {
  const props = ev.properties;
  // Everything we care about carries the session it belongs to; anything else
  // (server.connected, heartbeats, other sessions' traffic) is not ours.
  if (props.sessionID !== state.sessionId) return NOTHING;

  if (ev.type === "message.part.updated") {
    const part = props.part;
    if (typeof part !== "object" || part === null) return NOTHING;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.id === "string") state.textParts.add(record.id);
    return NOTHING;
  }

  if (ev.type === "message.part.delta") {
    const { partID, field, delta } = props;
    if (field !== "text" || typeof partID !== "string" || !state.textParts.has(partID)) return NOTHING;
    return { delta: typeof delta === "string" ? delta : "", done: false, failed: null };
  }

  if (ev.type === "session.next.step.failed") {
    return { delta: null, done: true, failed: failureMessage(props.error) };
  }

  if (ev.type === "session.idle") {
    return { delta: null, done: true, failed: null };
  }

  return NOTHING;
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
