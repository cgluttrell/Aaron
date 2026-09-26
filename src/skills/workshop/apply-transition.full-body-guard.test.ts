import { describe, expect, it } from "vitest";
import { assertUpdateProposalContainsFullSkillBody } from "./apply-transition.js";

describe("assertUpdateProposalContainsFullSkillBody (fork guard)", () => {
  it("allows a full replacement skill body on update", () => {
    expect(() =>
      assertUpdateProposalContainsFullSkillBody(
        "update",
        "# My Skill\n\nDo the thing.\n\n## Steps\n1. a\n",
      ),
    ).not.toThrow();
  });

  it("refuses an update whose body is titled as an update proposal", () => {
    expect(() =>
      assertUpdateProposalContainsFullSkillBody(
        "update",
        "# My Skill Update Proposal\n\nChange step 2.\n",
      ),
    ).toThrow(/patch instructions/);
  });

  it("refuses an update made of patch-instruction sections", () => {
    const body =
      "# My Skill\n\n## Proposed Changes\n- x\n\n## Evidence Plan\n- y\n\n## Scope Guard\n- z\n";
    expect(() => assertUpdateProposalContainsFullSkillBody("update", body)).toThrow(
      /patch instructions/,
    );
  });

  it("never applies to create proposals", () => {
    expect(() =>
      assertUpdateProposalContainsFullSkillBody("create", "# Something Update Proposal\n"),
    ).not.toThrow();
  });
});
