/** Native agent and Gateway error surfaces can retain only the assertion text. */
export function isSessionTranscriptTurnMismatchErrorMessage(
  message: string | undefined,
): message is string {
  const text = message?.replace(/^Error: /, "") ?? "";
  return (
    /^Session transcript keyed user is outside the current turn: \S/.test(text) ||
    text === "Model prompt projection lost its canonical user turn"
  );
}
