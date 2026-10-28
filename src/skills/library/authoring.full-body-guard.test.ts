import { describe, expect, it } from "vitest";
import { assertUpdateContainsFullSkillBody } from "./authoring.js";

describe("fork skill update full-body guard", () => {
  it("accepts a full replacement", () => {
    expect(() =>
      assertUpdateContainsFullSkillBody("# My Skill\n\n## Steps\n1. Do it.\n"),
    ).not.toThrow();
  });

  it("rejects update-proposal patch instructions", () => {
    expect(() =>
      assertUpdateContainsFullSkillBody("# My Skill Update Proposal\n\nChange step 2.\n"),
    ).toThrow(/patch instructions/);
    expect(() =>
      assertUpdateContainsFullSkillBody(
        "# My Skill\n\n## Proposed Changes\n- x\n\n## Evidence Plan\n- y\n\n## Scope Guard\n- z\n",
      ),
    ).toThrow(/patch instructions/);
  });
});
