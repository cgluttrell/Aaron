/** Prompt shape and cache affinity for isolated cron execution. */
import { createHash } from "node:crypto";
import type { CronJob } from "../types.js";

const COMMAND_STYLE_CRON_PREFIX =
  /^(?:(?:[A-Z_][A-Z0-9_]*=\S+\s+)+)?(?:cd\s+\S+|(?:\.{1,2}|~)?\/\S+|[A-Za-z]:[\\/]\S+|(?:bash|bun|cargo|deno|docker|gh|git|go|make|node|npm|npx|pnpm|python|python3|ruby|sh|tsx|uv|zsh)\b)/u;

export function resolveIsolatedCronPromptCacheKey(params: {
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  provider: string;
  model: string;
}): string | undefined {
  if (params.job.sessionTarget !== "isolated") {
    return undefined;
  }
  const material = JSON.stringify({
    version: 1,
    kind: "isolated-cron",
    jobId: params.job.id,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    provider: params.provider,
    model: params.model,
  });
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  // Isolated cron rotates transcript/session ids per run; keep cache affinity
  // on stable job identity without sending raw local session labels upstream.
  return `openclaw-cron-${digest}`;
}

/** Detects single-line cron prompts that look like shell commands or command invocations. */
export function isCommandStyleCronMessage(message: string): boolean {
  return !message.trim().includes("\n") && COMMAND_STYLE_CRON_PREFIX.test(message.trim());
}
