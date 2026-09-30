import { describe, expect, it, vi } from "vitest";
import { securityReviewRollout } from "../../scripts/github/security-review-rollout.mjs";

const rolloutPath = "/repos/cgluttrell/Aaron/pulls/152415";
const pullRequest = { created_at: "2026-09-01T00:00:00Z", head: { sha: "a".repeat(40) } };

describe("security review rollout lookup", () => {
  it("treats a missing configured rollout PR as inactive", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const request = vi.fn().mockRejectedValue(error);

    await expect(
      securityReviewRollout({ api: { request }, owner: "cgluttrell", repo: "Aaron", pullRequest }),
    ).resolves.toEqual({ mode: "inactive" });
    expect(request).toHaveBeenCalledExactlyOnceWith(rolloutPath);
  });

  it("still fails when the rollout lookup has another API error", async () => {
    const error = Object.assign(new Error("GitHub unavailable"), { status: 500 });
    const request = vi.fn().mockRejectedValue(error);

    await expect(
      securityReviewRollout({ api: { request }, owner: "cgluttrell", repo: "Aaron", pullRequest }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledExactlyOnceWith(rolloutPath);
  });
});
