import { describe, expect, it } from "vitest";
import { buildToolJsonSchema, extractToolDefs, parseToolCalls, toolChoiceMode, toolInstruction } from "../src/lib/opencode/tools.js";

const body = {
  tools: [
    { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
  ],
};

describe("extractToolDefs", () => {
  it("extracts function tools and ignores others", () => {
    expect(extractToolDefs(body).map((t) => t.name)).toEqual(["get_weather"]);
    expect(extractToolDefs({})).toEqual([]);
  });
});

describe("toolChoiceMode", () => {
  it("classifies each choice form", () => {
    expect(toolChoiceMode("required")).toBe("required");
    expect(toolChoiceMode("none")).toBe("none");
    expect(toolChoiceMode("auto")).toBe("auto");
    expect(toolChoiceMode(undefined)).toBe("auto");
    expect(toolChoiceMode({ type: "function", function: { name: "get_weather" } })).toEqual({ name: "get_weather" });
  });
});

describe("toolInstruction", () => {
  it("mentions every tool and forbids text when required", () => {
    const s = toolInstruction(extractToolDefs(body), "required") ?? "";
    expect(s).toContain("get_weather");
    expect(s.toLowerCase()).toContain("must");
  });

  it("returns null when there are no tools or choice is none", () => {
    expect(toolInstruction([], "required")).toBeNull();
    expect(toolInstruction(extractToolDefs(body), "none")).toBeNull();
  });
});

describe("buildToolJsonSchema", () => {
  it("produces a oneOf of call objects", () => {
    const schema = buildToolJsonSchema(extractToolDefs(body)) as { oneOf: Array<{ properties: { name: { const: string } } }> };
    expect(schema.oneOf[0]?.properties.name.const).toBe("get_weather");
  });
});

describe("parseToolCalls", () => {
  it("extracts a fenced call and strips the block from content", () => {
    const text = "Let me check.\n```tool_call\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}\n```";
    const { content, calls } = parseToolCalls(text, new Set(["get_weather"]));
    expect(content).toBe("Let me check.");
    expect(calls).toEqual([{ name: "get_weather", arguments: "{\"city\":\"Paris\"}" }]);
  });

  it("does not leak the fence into content when the message is only the block", () => {
    const text = "```tool_call\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}\n```";
    const { content, calls } = parseToolCalls(text, new Set(["get_weather"]));
    expect(content).toBe("");
    expect(content).not.toContain("tool_call");
    expect(calls).toHaveLength(1);
  });

  it("parses bare JSON objects and supports multiple calls", () => {
    const text = '{"name":"a","arguments":{}}\n{"name":"b","arguments":{"x":1}}';
    const { calls } = parseToolCalls(text, new Set(["a", "b"]));
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("ignores unknown tool names and invalid JSON", () => {
    expect(parseToolCalls("```tool_call\n{\"name\":\"nope\",\"arguments\":{}}\n```", new Set(["a"])).calls).toEqual([]);
    expect(parseToolCalls("```tool_call\nnot json\n```", new Set(["a"])).calls).toEqual([]);
  });
});
