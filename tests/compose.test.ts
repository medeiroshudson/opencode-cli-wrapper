import { describe, it, expect } from "vitest";
import { applyAnchors, buildAnchorLine, composePrompt, normalizeContent } from "../src/lib/opencode/compose.js";
import type { ChatMessage } from "../src/lib/opencode/compose.js";

describe("composePrompt (P4)", () => {
  it("throws on an empty array", () => {
    expect(() => composePrompt([])).toThrow(Error);
  });

  it("merges system/developer and places the last message after Question", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "developer", content: "dev" },
      { role: "user", content: "42" },
      { role: "assistant", content: "" },
      { role: "tool", content: "" },
      { role: "user", content: "Question end?" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt).toContain("System: sys\ndev");
    expect(prompt).toContain("User: 42");
    expect(prompt).toContain("Assistant: ");
    expect(prompt).toContain("Tool: ");
    expect(prompt).toContain("Question: Question end?");
    expect(prompt.endsWith("Question end?")).toBe(true);
  });

  it("keeps every non-terminal message exactly once", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt.match(/one/g)).toHaveLength(1);
    expect(prompt.match(/two/g)).toHaveLength(1);
    expect(prompt.match(/three/g)).toHaveLength(1);
  });

  it("handles a single user message", () => {
    const prompt = composePrompt([{ role: "user", content: "Hello" }]);

    expect(prompt).toContain("Question: Hello");
    expect(prompt.endsWith("Hello")).toBe(true);
  });

  it("title-cases unknown roles in history", () => {
    const messages: ChatMessage[] = [
      { role: "custom", content: "hey" },
      { role: "user", content: "What?" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt).toContain("Custom: hey");
    expect(prompt).toContain("Question: What?");
  });

  it("renders assistant tool_calls so the replayed history shows the request", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "What is the weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Paris"}' } },
        ],
      },
      { role: "tool", content: '{"temperature":18}' },
      { role: "user", content: "And in Lisbon?" },
    ];

    const prompt = composePrompt(messages);
    const assistantLine = prompt.split("\n").find((line) => line.startsWith("Assistant:")) ?? "";

    expect(assistantLine).not.toBe("Assistant:");
    expect(assistantLine).toContain('{"tool_calls":');
    expect(assistantLine).toContain("get_weather");
    expect(assistantLine).toContain("call_1");
    expect(prompt).toContain("Tool: {\"temperature\":18}");
  });

  it("normalizes content values", () => {
    expect(normalizeContent(null)).toBe("");
    expect(normalizeContent(undefined)).toBe("");
    expect(normalizeContent(42)).toBe("42");
    expect(normalizeContent("x")).toBe("x");
  });

  it("flattens Anthropic-style content blocks", () => {
    expect(
      normalizeContent([
        { type: "text", text: "" },
        { type: "text", text: "You are " },
        { type: "text", text: "an agent." },
      ]),
    ).toBe("You are an agent.");
    expect(normalizeContent([])).toBe("");
    expect(normalizeContent(["a", "b"])).toBe("ab");
    // A non-text block has no text representation and must not leak as "[object Object]".
    expect(normalizeContent([{ type: "image", source: {} }])).toBe("");
  });

  it("composes a system message whose content is a block array", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "" }, { type: "text", text: "be terse" }] },
      { role: "user", content: "hi" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt).toContain("System: be terse");
    expect(prompt).toContain("Question: hi");
  });

  it("answers the last user turn even when a later system turn follows", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "How do I add TTS?" },
      { role: "system", content: "SessionStart hook: superpowers enabled" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt.endsWith("Question: How do I add TTS?")).toBe(true);
    expect(prompt).toContain("System: SessionStart hook: superpowers enabled");
    expect(prompt).not.toContain("Question: SessionStart hook");
  });

  it("keeps intervening turns in history when the question is not last", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "system", content: "trailing hook" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt).toContain("User: first");
    expect(prompt.endsWith("Question: second")).toBe(true);
  });

  it("falls back to the last message when there is no user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hi there" },
    ];

    const prompt = composePrompt(messages);

    expect(prompt.endsWith("Question: hi there")).toBe(true);
  });
});

describe("prompt anchors", () => {
  const base = "You are an expert assistant.\n\nQuestion: Hi";

  it("is a no-op when no anchors are provided", () => {
    expect(applyAnchors(base, {})).toBe(base);
  });

  it("appends temperature and max_tokens hints", () => {
    const anchored = applyAnchors(base, { temperature: 0, maxTokens: 100 });

    expect(anchored.startsWith(base)).toBe(true);
    expect(anchored).toContain("precise");
    expect(anchored).toContain("100 tokens");
  });

  it("maps temperature ranges to distinct hints", () => {
    expect(buildAnchorLine({ temperature: 0.2 })).toContain("precise");
    expect(buildAnchorLine({ temperature: 0.7 })).toContain("Balance");
    expect(buildAnchorLine({ temperature: 1.5 })).toContain("creative");
  });

  it("ignores non-positive max_tokens", () => {
    expect(buildAnchorLine({ maxTokens: 0 })).toBeNull();
  });
});
