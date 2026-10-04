/**
 * Fork guard (originally 4257cedf389, re-expressed for v2026.9.6): an "update" proposal
 * replaces the whole SKILL.md, so a proposal body that is patch instructions ("... Update
 * Proposal", or Proposed Changes + Evidence Plan + Scope Guard sections) would overwrite a
 * working skill with its own change request. Refuse it before any file is written.
 */
export function assertUpdateProposalContainsFullSkillBody(
  kind: string,
  skillContent: string,
): void {
  if (kind !== "update") {
    return;
  }
  const normalized = skillContent.replace(/\r\n/g, "\n");
  const firstHeading =
    normalized
      .match(/^#\s+(.+)$/m)?.[1]
      ?.trim()
      .toLowerCase() ?? "";
  const hasPatchInstructionHeadings =
    /^##\s+Proposed Changes\s*$/im.test(normalized) && /^##\s+Evidence Plan\s*$/im.test(normalized);
  const hasScopeGuard = /^##\s+Scope Guard\s*$/im.test(normalized);
  if (firstHeading.endsWith("update proposal") || (hasPatchInstructionHeadings && hasScopeGuard)) {
    throw new Error(
      "Update proposal appears to contain patch instructions instead of a full replacement SKILL.md body; revise the proposal with the complete desired skill content before applying.",
    );
  }
}
