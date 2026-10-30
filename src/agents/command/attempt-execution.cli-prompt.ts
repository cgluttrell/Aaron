import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  injectTimestamp,
  timestampOptsFromConfig,
} from "../../gateway/server-methods/agent-timestamp.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import {
  resizeExecApprovalContinuationPrompt,
  type ExecApprovalContinuationPromptRange,
} from "../bash-tools.exec-approval-output.js";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "../tool-result-limits.js";
import { resolveFallbackRetryPrompt } from "./attempt-execution.helpers.js";

/**
 * Builds the CLI-backend prompt, transcript prompt, and continuation body.
 *
 * Exec-approval continuations resize the approved output to the live tool-result
 * budget before the retry/provenance decoration the shared path already
 * applied to `effectivePrompt`; inter-session prompts skip the
 * timestamp because their provenance annotation already frames them.
 */
export function resolveCliAttemptPrompts(params: {
  cfg: OpenClawConfig;
  body: string;
  promptRange: ExecApprovalContinuationPromptRange | undefined;
  transcriptBody: string | undefined;
  transcriptPromptRange: ExecApprovalContinuationPromptRange | undefined;
  isFallbackRetry: boolean;
  sessionHasHistory: boolean | undefined;
  priorContextPrelude: string;
  inputProvenance: InputProvenance | undefined;
  effectivePrompt: string;
}): { continuationBody: string; transcriptPrompt: string | undefined; prompt: string } {
  const continuationBody = params.promptRange
    ? resizeExecApprovalContinuationPrompt({
        prompt: params.body,
        range: params.promptRange,
        maxOutputUtf16Units: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
      })
    : params.body;
  const effectivePrompt = params.promptRange
    ? annotateInterSessionPromptText(
        resolveFallbackRetryPrompt({
          body: continuationBody,
          isFallbackRetry: params.isFallbackRetry,
          sessionHasHistory: params.sessionHasHistory,
          priorContextPrelude: params.priorContextPrelude,
        }),
        params.inputProvenance,
      )
    : params.effectivePrompt;
  const transcriptPrompt =
    params.transcriptBody === undefined || !params.transcriptPromptRange
      ? params.transcriptBody
      : resizeExecApprovalContinuationPrompt({
          prompt: params.transcriptBody,
          range: params.transcriptPromptRange,
          maxOutputUtf16Units: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
        });
  const prompt =
    params.inputProvenance?.kind === "inter_session"
      ? effectivePrompt
      : injectTimestamp(effectivePrompt, timestampOptsFromConfig(params.cfg));
  return { continuationBody, transcriptPrompt, prompt };
}
