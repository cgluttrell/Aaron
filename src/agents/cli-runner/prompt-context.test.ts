import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../cli-session.js";
import { prependCliSessionResumeUserContext } from "./prompt-context.js";

const currentInboundContext = { text: "Conversation info" };

describe("CLI resume user context", () => {
  it("puts the drift note before the resumed prompt", () => {
    expect(
      prependCliSessionResumeUserContext(currentInboundContext, {
        mode: "reuse-with-drift",
        sessionId: "native-bound",
        drift: { reasons: ["system-prompt"] },
      }),
    ).toEqual({
      text: [buildCliSessionDriftNote(["system-prompt"]), "Conversation info"].join("\n\n"),
    });
    expect(
      prependCliSessionResumeUserContext(undefined, { mode: "reuse", sessionId: "native-bound" }),
    ).toBeUndefined();
  });

  it("leaves a fresh session to recover from saved history", () => {
    expect(
      prependCliSessionResumeUserContext(currentInboundContext, {
        mode: "invalidate",
        invalidatedReason: "mcp",
      }),
    ).toBe(currentInboundContext);
  });
});
