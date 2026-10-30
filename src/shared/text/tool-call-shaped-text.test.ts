// Tool-call shaped text tests cover detection of text that resembles tool calls.
import { describe, expect, it } from "vitest";
import { detectToolCallShapedText } from "./tool-call-shaped-text.js";

describe("detectToolCallShapedText", () => {
  it.each(["", '{"name":"earlier","arguments":{}}\n'])(
    "prefers fenced tool_calls JSON after %j",
    (prefix) => {
      expect(
        detectToolCallShapedText(
          prefix +
            '```json\n{"tool_calls":[{"function":{"name":"web_search","arguments":{"query":"x"}}}]}\n```',
        ),
      ).toEqual({ kind: "json_tool_call", toolName: "web_search" });
    },
  );

  it("detects XML and ReAct-style tool text", () => {
    expect(
      detectToolCallShapedText(
        "<tool_call><function=read><parameter=path>README.md</parameter></function></tool_call>",
      ),
    ).toEqual({ kind: "xml_tool_call", toolName: "read" });
    expect(detectToolCallShapedText('Action: exec\nAction Input: {"command":"pwd"}')).toEqual({
      kind: "react_action",
      toolName: "exec",
    });
  });

  it("detects legacy uppercase TOOL_CALL assistant text", () => {
    expect(
      detectToolCallShapedText(
        '[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}}[/TOOL_CALL]',
      ),
    ).toEqual({ kind: "bracketed_tool_call", toolName: "web_search" });
  });

  it("ignores normal JSON and prose mentions", () => {
    expect(detectToolCallShapedText('{"status":"ok","message":"done"}')).toBeNull();
    expect(detectToolCallShapedText("Use tool_call tags only in examples.")).toBeNull();
    expect(detectToolCallShapedText("Use <tool_call> to invoke tools.")).toBeNull();
  });

  it("names the tool in a legacy bracketed call", () => {
    const legacy = '[TOOL_CALL]{tool => "read", args => {"path":"proof.txt"}}[/TOOL_CALL]';
    expect(detectToolCallShapedText(`note ${legacy}`)).toEqual({
      kind: "bracketed_tool_call",
      toolName: "read",
    });
    expect(detectToolCallShapedText('[TOOL_CALL]{tool => "read"}')).toBeNull();
  });

  // Each reply shape below took seconds on the former single-regex checks.
  it.each([
    ["repeated legacy openers", `{${'[TOOL_CALL]{TOOL=>"G"'.repeat(950)}a`],
    ["an Action line before blank lines", `Action: x${"\n".repeat(2_000)}y`],
  ])("returns promptly for %s", (_label, text) => {
    const started = performance.now();
    expect(detectToolCallShapedText(text)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
