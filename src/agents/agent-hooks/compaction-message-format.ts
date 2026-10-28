/** Summarize non-text blocks so preserved context records their presence without payload data. */
export function formatCompactionNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = Reflect.get(block, "type");
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type !== "text") {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}
