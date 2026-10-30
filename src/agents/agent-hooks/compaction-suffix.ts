import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { capCompactionSummary } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { appendSummarySection } from "./compaction-safeguard-quality.js";

export const CONTEXT_TRUNCATED_MARKER =
  "\n\n[Earlier compaction context truncated to fit budget]\n\n";

export type CompactionLoss =
  | "summary-tail"
  | "suffix-head"
  | "split-turn-head"
  | "split-turn-tail"
  | "preserved-turn-head";

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  truncatedLoss?: CompactionLoss;
};

export type CompactionSuffix = {
  text: string;
  contextRanges: Array<{ start: number; end: number; segmentStarts: number[] }>;
  reservedChars?: number;
};

export function assembleCompactionSuffix(
  parts: {
    splitTurnSection?: ContextSection;
    generatedSplitTurnSection?: string;
    preservedTurnsSection?: ContextSection;
    toolFailureSection?: string;
    fileOpsSummary?: string;
    workspaceContext?: string;
  },
  reserveSplitTurn = false,
): CompactionSuffix {
  let text = "";
  let reservedChars = 0;
  const contextRanges: CompactionSuffix["contextRanges"] = [];
  for (const [name, part] of Object.entries(parts)) {
    const section = typeof part === "string" ? part : part?.text;
    if (!section) {
      continue;
    }
    const leadingTrim = text ? 0 : section.length - section.trimStart().length;
    const appended = leadingTrim > 0 ? section.slice(leadingTrim) : section;
    const start = text.length;
    text = appendSummarySection(text, section);
    if (reserveSplitTurn && name === "generatedSplitTurnSection") {
      reservedChars = text.length;
    }
    if (typeof part !== "string") {
      contextRanges.push({
        start,
        end: start + appended.length,
        segmentStarts: part.segmentStarts
          .filter((segmentStart) => segmentStart >= leadingTrim)
          .map((segmentStart) => start + segmentStart - leadingTrim),
      });
    }
  }
  if (text && !/^\s/.test(text)) {
    text = `\n\n${text}`;
    reservedChars += reservedChars > 0 ? 2 : 0;
    for (const range of contextRanges) {
      range.start += 2;
      range.end += 2;
      range.segmentStarts = range.segmentStarts.map((segmentStart) => segmentStart + 2);
    }
  }
  return { text, contextRanges, ...(reservedChars > 0 ? { reservedChars } : {}) };
}

function resolveSuffixTailStart(suffix: CompactionSuffix, tailBudget: number): number {
  const desiredStart = Math.max(0, suffix.text.length - tailBudget);
  const containingRange = suffix.contextRanges.find(
    (range) => desiredStart > range.start && desiredStart < range.end,
  );
  return containingRange
    ? (containingRange.segmentStarts.find((start) => start >= desiredStart) ?? containingRange.end)
    : desiredStart;
}

export function capCompactionSuffix(suffix: CompactionSuffix, maxChars: number): string {
  if (suffix.text.length <= maxChars) {
    return suffix.text;
  }
  if (maxChars <= 0) {
    return "";
  }
  const reserved = suffix.reservedChars ?? 0;
  if (reserved > 0) {
    if (reserved >= maxChars) {
      return capCompactionSummary(suffix.text.slice(0, reserved), maxChars);
    }
    const rest: CompactionSuffix = {
      text: suffix.text.slice(reserved),
      contextRanges: suffix.contextRanges
        .filter((range) => range.start >= reserved)
        .map((range) => ({
          start: range.start - reserved,
          end: range.end - reserved,
          segmentStarts: range.segmentStarts.map((start) => start - reserved),
        })),
    };
    return `${suffix.text.slice(0, reserved)}${capCompactionSuffix(rest, maxChars - reserved)}`;
  }
  if (maxChars < CONTEXT_TRUNCATED_MARKER.length) {
    return sliceUtf16Safe(suffix.text, resolveSuffixTailStart(suffix, maxChars));
  }
  const tailBudget = maxChars - CONTEXT_TRUNCATED_MARKER.length;
  const start = resolveSuffixTailStart(suffix, tailBudget);
  return tailBudget > 0
    ? `${CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(suffix.text, start)}`
    : CONTEXT_TRUNCATED_MARKER;
}
