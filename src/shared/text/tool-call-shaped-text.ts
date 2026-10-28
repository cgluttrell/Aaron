import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";

type ToolCallShapedTextDetection = {
  kind: "json_tool_call" | "xml_tool_call" | "bracketed_tool_call" | "react_action";
  toolName?: string;
};

const TOOL_TEXT_PREFILTER_RE =
  /(?:tool[_\s-]?calls?|function[_\s-]?call|["'](?:name|tool_name|function|arguments|args|input|parameters|tool_calls)["']|<\s*tool_call\b|Action\s*:|\[END_TOOL_REQUEST\])/i;
const MAX_SCAN_CHARS = 20_000;
const MAX_JSON_CANDIDATES = 20;
const MAX_JSON_CANDIDATE_CHARS = 8_000;

function readToolName(record: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(record.name) ??
    readTrimmedString(record.tool_name) ??
    readTrimmedString(record.tool) ??
    readTrimmedString(record.function_name)
  );
}

function hasToolArgs(record: Record<string, unknown>): boolean {
  return "arguments" in record || "args" in record || "input" in record || "parameters" in record;
}

function classifyJsonValue(value: unknown): ToolCallShapedTextDetection | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detection = classifyJsonValue(item);
      if (detection) {
        return detection;
      }
    }
    return null;
  }

  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }

  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls)) {
    return classifyJsonValue(toolCalls) ?? { kind: "json_tool_call" };
  }

  const functionRecord = asOptionalRecord(record.function);
  if (functionRecord) {
    const toolName = readToolName(functionRecord);
    if (toolName && hasToolArgs(functionRecord)) {
      return { kind: "json_tool_call", toolName };
    }
  }

  const toolName = readToolName(record);
  if (toolName && hasToolArgs(record)) {
    return { kind: "json_tool_call", toolName };
  }

  const type = readTrimmedString(record.type)?.toLowerCase();
  if (
    toolName &&
    (type === "tool_call" ||
      type === "toolcall" ||
      type === "tooluse" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "functioncall")
  ) {
    return { kind: "json_tool_call", toolName };
  }

  return null;
}

function findBalancedJsonEnd(text: string, start: number): number | null {
  const stack = [text[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    // Cap candidate size so diagnostic scans cannot spend unbounded time on prose
    // that happens to contain many braces.
    if (index - start > MAX_JSON_CANDIDATE_CHARS) {
      return null;
    }
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.at(-1) !== ch) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function* iterateJsonCandidates(text: string): Generator<string> {
  // Fenced candidates take precedence even when balanced JSON appears earlier.
  const fenceRe = /```(?:json|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const candidate = match[1]?.trim();
    if (candidate && candidate.length <= MAX_JSON_CANDIDATE_CHARS) {
      yield candidate;
    }
  }

  let count = 0;
  for (let index = 0; index < text.length && count < MAX_JSON_CANDIDATES; index += 1) {
    const ch = text[index];
    if (ch !== "{" && ch !== "[") {
      continue;
    }
    const end = findBalancedJsonEnd(text, index);
    if (end === null) {
      continue;
    }
    const candidate = text.slice(index, end).trim();
    if (candidate.length > 1) {
      count += 1;
      yield candidate;
    }
    index = end - 1;
  }
}

function detectJsonToolCall(text: string): ToolCallShapedTextDetection | null {
  for (const candidate of iterateJsonCandidates(text)) {
    try {
      const detection = classifyJsonValue(JSON.parse(candidate));
      if (detection) {
        return detection;
      }
    } catch {
      // Text only needs to be diagnostic-grade; malformed JSON stays text.
    }
  }
  return null;
}

function detectXmlToolCall(text: string): ToolCallShapedTextDetection | null {
  if (!/<\s*tool_call\b/i.test(text)) {
    return null;
  }
  if (!/<\s*function=/i.test(text) && !/["']name["']\s*:\s*["'][^"']{1,120}["']/i.test(text)) {
    return null;
  }
  const toolName =
    /<\s*function=([A-Za-z0-9_.:-]{1,120})\b/i.exec(text)?.[1] ??
    /["']name["']\s*:\s*["']([^"']{1,120})["']/i.exec(text)?.[1]?.trim();
  return { kind: "xml_tool_call", ...(toolName ? { toolName } : {}) };
}

const LEGACY_TOOL_CALL_OPEN_RE = /\[\s*TOOL_CALL\s*\]\s*{/gi;
const LEGACY_TOOL_NAME_RE = /\btool\s*=>\s*["']([A-Za-z_][A-Za-z0-9_.:-]{0,119})["']/gi;
const LEGACY_ARGS_RE = /\bargs\s*=>/gi;
const LEGACY_FIELD_GAP_CHARS = 8_000;

// `[TOOL_CALL] { tool => "name", args => ... }`: the leftmost opener whose first
// `tool =>` within 8,000 characters is followed by `args =>` within another 8,000.
// Matches of each part never overlap, so both passes only move forward.
function findLegacyBracketedToolName(text: string): string | undefined {
  const argsStarts = Array.from(text.matchAll(LEGACY_ARGS_RE), (match) => match.index);
  const callable: Array<{ start: number; name: string }> = [];
  let nextArgs = 0;
  for (const match of text.matchAll(LEGACY_TOOL_NAME_RE)) {
    const end = match.index + match[0].length;
    while (nextArgs < argsStarts.length && argsStarts[nextArgs]! < end) {
      nextArgs += 1;
    }
    if (nextArgs < argsStarts.length && argsStarts[nextArgs]! - end <= LEGACY_FIELD_GAP_CHARS) {
      callable.push({ start: match.index, name: match[1]! });
    }
  }
  let nextCallable = 0;
  for (const opener of text.matchAll(LEGACY_TOOL_CALL_OPEN_RE)) {
    const end = opener.index + opener[0].length;
    while (nextCallable < callable.length && callable[nextCallable]!.start < end) {
      nextCallable += 1;
    }
    const tool = callable[nextCallable];
    if (!tool) {
      return undefined;
    }
    if (tool.start - end <= LEGACY_FIELD_GAP_CHARS) {
      return tool.name;
    }
  }
  return undefined;
}

function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
  const legacyToolName = findLegacyBracketedToolName(text);
  if (legacyToolName) {
    return { kind: "bracketed_tool_call", toolName: legacyToolName };
  }

  const match =
    /^\s*\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\]\s+[\s\S]*?\[END_TOOL_REQUEST\]\s*$/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  return { kind: "bracketed_tool_call", toolName: match[1] };
}

function detectReactAction(text: string): ToolCallShapedTextDetection | null {
  const match =
    /(?:^|\n)[^\S\n]*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})[^\S\n]*\n\s*Action Input\s*:/i.exec(
      text,
    );
  if (!match?.[1]) {
    return null;
  }
  return { kind: "react_action", toolName: match[1] };
}

/** Detects assistant-visible text that looks like an unexecuted tool call instead of prose. */
export function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null {
  const trimmed = text.slice(0, MAX_SCAN_CHARS).trim();
  if (!trimmed || !TOOL_TEXT_PREFILTER_RE.test(trimmed)) {
    return null;
  }
  return (
    detectBracketedToolCall(trimmed) ??
    detectXmlToolCall(trimmed) ??
    detectJsonToolCall(trimmed) ??
    detectReactAction(trimmed)
  );
}
