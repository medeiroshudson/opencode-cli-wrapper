import { describe, expect, it } from "vitest";
import { parseSseBlock, partText, splitSseBlocks, textDelta } from "../src/lib/serve/events.js";

describe("splitSseBlocks", () => {
  it("splits complete blocks and keeps the trailing partial one", () => {
    expect(splitSseBlocks("data: a\n\ndata: b\n\ndata: par")).toEqual({
      blocks: ["data: a", "data: b"],
      rest: "data: par",
    });
  });

  it("returns no blocks when only a partial block is buffered", () => {
    expect(splitSseBlocks("data: only")).toEqual({ blocks: [], rest: "data: only" });
  });
});

describe("parseSseBlock", () => {
  it("joins multi-line data fields and parses the JSON event", () => {
    const block =
      'data: {"id":"evt_1","type":"message.part.delta",\n' +
      'data: "properties":{"field":"text","delta":"hi"}}';
    expect(parseSseBlock(block)).toEqual({
      id: "evt_1",
      type: "message.part.delta",
      properties: { field: "text", delta: "hi" },
    });
  });

  it("returns null for [DONE], heartbeats and invalid payloads", () => {
    expect(parseSseBlock("data: [DONE]")).toBeNull();
    expect(parseSseBlock(": keep-alive")).toBeNull();
    expect(parseSseBlock("data: not json")).toBeNull();
    expect(parseSseBlock("")).toBeNull();
  });
});

describe("textDelta", () => {
  it("extracts a text delta only for the text field", () => {
    expect(
      textDelta({ type: "message.part.delta", properties: { field: "text", delta: "abc" } }),
    ).toBe("abc");
    expect(
      textDelta({ type: "message.part.delta", properties: { field: "reasoning", delta: "x" } }),
    ).toBeNull();
    expect(textDelta({ type: "message.updated", properties: {} })).toBeNull();
  });
});

describe("partText", () => {
  it("extracts text from a completed text part", () => {
    expect(
      partText({ type: "message.part.updated", properties: { part: { type: "text", text: "done" } } }),
    ).toBe("done");
    expect(partText({ type: "message.part.updated", properties: { part: { type: "tool" } } })).toBeNull();
  });
});
