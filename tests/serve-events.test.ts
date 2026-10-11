import { describe, expect, it } from "vitest";
import { newStreamState, parseSseBlock, projectEvent, splitSseBlocks } from "../src/lib/serve/events.js";

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
    const block = 'data: {"id":"evt_1","type":"message.part.delta",\n' +
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

const SES = "ses_1";
const partUpdated = (id: string, type: string, text = "") => ({
  type: "message.part.updated",
  properties: { sessionID: SES, part: { id, type, text } },
});
const deltaFor = (partID: string, delta: string) => ({
  type: "message.part.delta",
  properties: { sessionID: SES, partID, field: "text", delta },
});
const NONE = { delta: null, done: false, failed: null };

describe("projectEvent", () => {
  it("ignores events from another session and global events without a sessionID", () => {
    const s = newStreamState(SES);
    expect(projectEvent(s, { type: "message.part.delta", properties: { sessionID: "ses_other", partID: "p", field: "text", delta: "x" } })).toEqual(NONE);
    expect(projectEvent(s, { type: "server.connected", properties: {} })).toEqual(NONE);
  });

  it("emits the delta of a text part", () => {
    const s = newStreamState(SES);
    projectEvent(s, partUpdated("p1", "text"));
    expect(projectEvent(s, deltaFor("p1", "hello"))).toEqual({ delta: "hello", done: false, failed: null });
  });

  it("never emits a reasoning part's delta as answer content", () => {
    const s = newStreamState(SES);
    projectEvent(s, partUpdated("r1", "reasoning"));
    projectEvent(s, partUpdated("t1", "text"));
    expect(projectEvent(s, deltaFor("r1", "internal thinking")).delta).toBeNull();
    expect(projectEvent(s, deltaFor("t1", "1\n2\n3")).delta).toBe("1\n2\n3");
  });

  it("does not emit a delta for a part whose type is not yet known", () => {
    const s = newStreamState(SES);
    expect(projectEvent(s, deltaFor("unknown", "x")).delta).toBeNull();
  });

  it("marks done on session.idle for its own session only", () => {
    const s = newStreamState(SES);
    expect(projectEvent(s, { type: "session.idle", properties: { sessionID: "ses_other" } }).done).toBe(false);
    expect(projectEvent(s, { type: "session.idle", properties: { sessionID: SES } }).done).toBe(true);
  });

  it("reports a failure from a step.failed event", () => {
    const s = newStreamState(SES);
    const out = projectEvent(s, { type: "session.next.step.failed", properties: { sessionID: SES, error: { message: "boom" } } });
    expect(out.failed).toBe("boom");
  });

  it("does not treat message.updated as terminal (the user message fires it early)", () => {
    const s = newStreamState(SES);
    expect(projectEvent(s, { type: "message.updated", properties: { sessionID: SES, info: { role: "user" } } }).done).toBe(false);
  });
});
