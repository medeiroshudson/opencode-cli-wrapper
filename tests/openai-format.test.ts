import { describe, it, expect } from "vitest";
import {
  buildCompletionWithId,
  buildCompletion,
  buildChunk,
  sseEvent,
  SSE_DONE,
  buildSseBody,
  toOpenAIErrorBody,
} from "../src/lib/openai-format/index.js";
import type { TurnResult } from "../src/lib/openai-format/index.js";

describe("OpenAI format layer (P5)", () => {
  it("buildCompletionWithId produces exact fields for a fixed id/created", () => {
    const result: TurnResult = {
      content: "Hello world",
      finish_reason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      sessionId: "sess-1",
      toolCalls: [],
    };

    const out = buildCompletionWithId(result, "gpt-4", "chatcmpl-test-1", 1234567890);

    expect(out.id).toBe("chatcmpl-test-1");
    expect(out.object).toBe("chat.completion");
    expect(out.created).toBe(1234567890);
    expect(out.model).toBe("gpt-4");
    expect(out.choices).toHaveLength(1);
    expect(out.choices[0]?.message).toEqual({ role: "assistant", content: "Hello world" });
    expect(out.choices[0]?.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it("buildCompletion omits usage when null and uses seconds for created", () => {
    const out = buildCompletion(
      { content: "Hi", finish_reason: "stop", usage: null, sessionId: null, toolCalls: [] },
      "gpt-4",
    );

    expect(out.usage).toBeUndefined();
    expect(out.id.startsWith("chatcmpl-")).toBe(true);
    expect(out.created).toBeLessThan(10_000_000_000);
  });
});

describe("SSE helpers", () => {
  it("sseEvent formats a payload as a data frame", () => {
    expect(sseEvent({ a: 1 })).toBe(`data: ${JSON.stringify({ a: 1 })}\n\n`);
  });

  it("buildSseBody emits a content chunk, a final chunk, then DONE", () => {
    const body = buildSseBody(
      { content: "chunked", finish_reason: "stop", usage: null, sessionId: null, toolCalls: [] },
      "gpt-4",
    );

    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain('"content":"chunked"');
    expect(body.endsWith(SSE_DONE)).toBe(true);
  });

  it("SSE_DONE is the exact OpenAI terminator", () => {
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});

describe("OpenAI error body mapper", () => {
  const cases: Array<{ status: number; type: string; code: string | undefined }> = [
    { status: 400, type: "invalid_request_error", code: undefined },
    { status: 422, type: "invalid_request_error", code: undefined },
    { status: 404, type: "server_error", code: "opencode_error" },
    { status: 500, type: "server_error", code: "opencode_error" },
  ];

  for (const item of cases) {
    it(`maps ${item.status}`, () => {
      const res = toOpenAIErrorBody(new Error("boom"), item.status);

      expect(res.status).toBe(item.status);
      expect(res.body.error.message).toBe("boom");
      expect(res.body.error.type).toBe(item.type);
      expect(res.body.error.code).toBe(item.code);
      expect(res.body.error.param).toBeNull();
    });
  }

  it("does not leak stack traces", () => {
    const res = toOpenAIErrorBody(new Error("boom"), 500);

    expect(res.body.error.message).toBe("boom");
    expect(res.body.error.message).not.toContain("at ");
  });

  it("auto-detects a numeric status carried by the error object", () => {
    const err = Object.assign(new Error("boom"), { status: 404 });

    expect(toOpenAIErrorBody(err).status).toBe(404);
    expect(toOpenAIErrorBody(err).body.error.type).toBe("server_error");
  });

  it("buildChunk returns a valid chunk shape", () => {
    const chunk = buildChunk("chatcmpl-xyz", "gpt-4", 12345, { content: "a" }, null);

    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]?.delta).toEqual({ content: "a" });
    expect(chunk.choices[0]?.finish_reason).toBeNull();
  });
});
