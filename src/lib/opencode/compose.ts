// PHASE P4 — prompt-embed composer.
// Flattens the OpenAI messages[] into one prompt for a single `opencode run`,
// because OpenCode sessions do not recall previous turns (docs/plan.md §3.5-§3.6).

// An OpenAI assistant turn may carry tool calls with `content: null`; the tool result
// comes back on a later `role: "tool"` message.
export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role: string;
  content: string | null | unknown[];
  tool_calls?: ChatToolCall[];
}

// A caller may send content as Anthropic-style blocks (`[{type:"text",text:"…"}]`)
// instead of a bare string. Concatenate the text blocks (dropping empty ones);
// non-text blocks have no text representation in this pipeline and are ignored.
function textFromBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (typeof block !== "object" || block === null) return "";
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function normalizeContent(content: unknown): string {
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content.map(textFromBlock).filter((part) => part.length > 0).join("");
  }
  return String(content);
}

// The turn answers the last USER message, not necessarily the last message: a
// trailing system turn (e.g. a hook reminder appended after the conversation) would
// otherwise become the question and the real ask would be buried in history. Falls
// back to the last message when the conversation has no user turn at all.
function questionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (typeof role === "string" && role.toLowerCase() === "user") return i;
  }
  return messages.length - 1;
}

export function composePrompt(messages: ChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("composePrompt expects a non-empty array of messages");
  }

  const target = questionIndex(messages);
  const systemContents: string[] = [];
  const history: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (i === target) continue;
    const message = messages[i];
    const role = message && message.role ? String(message.role) : "";
    const content = normalizeContent(message?.content);

    if (role.toLowerCase() === "system" || role.toLowerCase() === "developer") {
      systemContents.push(content);
    } else {
      const label = role ? toTitleCase(role) : "Unknown";
      // Without the calls, an assistant turn that only called a tool renders as an
      // empty line and the model sees a tool result with no visible request.
      const calls = role.toLowerCase() === "assistant" ? renderToolCalls(message?.tool_calls) : "";
      history.push(`${label}: ${[content, calls].filter((part) => part.length > 0).join(" ")}`);
    }
  }

  const systemJoined = systemContents.join("\n");
  const historySection = history.join("\n");
  const lastContent = normalizeContent(messages[target]?.content);

  const lines: string[] = [
    "You are an expert assistant. Below is a conversation with a user.",
    "Reply to the final message. Do not reference that this is a conversation.",
  ];
  if (systemJoined) lines.push("", `System: ${systemJoined}`);
  if (historySection) lines.push(historySection);
  lines.push("", `Question: ${lastContent}`);

  return lines.join("\n");
}

export interface PromptAnchors {
  temperature?: number;
  maxTokens?: number;
}

export function buildAnchorLine(anchors: PromptAnchors): string | null {
  const hints: string[] = [];
  if (typeof anchors.temperature === "number") {
    if (anchors.temperature <= 0.3) hints.push("Be precise and deterministic.");
    else if (anchors.temperature >= 1.2) hints.push("Be highly creative and exploratory.");
    else hints.push("Balance accuracy and creativity.");
  }
  if (typeof anchors.maxTokens === "number" && anchors.maxTokens > 0) {
    hints.push(`Keep the answer under roughly ${anchors.maxTokens} tokens.`);
  }
  return hints.length > 0 ? hints.join(" ") : null;
}

export function applyAnchors(prompt: string, anchors: PromptAnchors): string {
  const line = buildAnchorLine(anchors);
  return line ? `${prompt}\n\n${line}` : prompt;
}

function renderToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return JSON.stringify({ tool_calls: toolCalls });
}

function toTitleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
