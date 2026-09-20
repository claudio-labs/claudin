// gh family — the GitHub CLI list commands (pr / issue / run).
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import { applyBashFilterToStdout, planBashFilter } from "src/tools/shared/outputFilter/Bash/index.js";

// ---------------------------------------------------------------------------
// Phase 6.1.4 — gh rewrite specs
// ---------------------------------------------------------------------------

describe("phase 6.1.4 — ghPrList", () => {
  test("rewrite: gh pr list → canonical --json form", () => {
    const plan = planBashFilter("gh pr list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("number,title,state");
    expect(plan.rewrite?.to).toContain("headRefName");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh pr list --json number").rewrite).toBeNull();
    expect(planBashFilter("gh pr list --json number").filter).toBeNull();
  });

  test("chain resolves: gh pr list && echo done applies gh-pr-list", () => {
    // `echo done` has no filter, so the chain resolves to `gh-pr-list`.
    expect(planBashFilter("gh pr list && echo done").filter?.name).toBe(
      "gh-pr-list",
    );
  });

  test("match: gh-pr-list spec claims 'gh pr list'", () => {
    expect(findFilterForCommand("gh pr list")?.name).toBe("gh-pr-list");
  });

  test("ROI: gh-pr-list sample passes through without crashing", () => {
    const raw = loadSample("gh-pr-list");
    const plan = planBashFilter("gh pr list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("determinism: two runs yield same plan", () => {
    const a = planBashFilter("gh pr list");
    const b = planBashFilter("gh pr list");
    expect(a.rewrite?.to).toBe(b.rewrite?.to);
  });

  test("flag-forward: --repo owner/repo is preserved in rewrite", () => {
    const plan = planBashFilter("gh pr list --repo owner/repo");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--repo owner/repo");
  });

  test("flag-forward: --author and --state flags are preserved", () => {
    const plan = planBashFilter("gh pr list --author alice --state open");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--author alice");
    expect(plan.rewrite?.to).toContain("--state open");
  });
});

describe("phase 6.1.4 — ghIssueList", () => {
  test("rewrite: gh issue list → canonical --json form", () => {
    const plan = planBashFilter("gh issue list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("number,title,state");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh issue list --json number").rewrite).toBeNull();
  });

  test("match: gh-issue-list spec claims 'gh issue list'", () => {
    expect(findFilterForCommand("gh issue list")?.name).toBe("gh-issue-list");
  });

  test("ROI: gh-issue-list sample passes through without crashing", () => {
    const raw = loadSample("gh-issue-list");
    const plan = planBashFilter("gh issue list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("flag-forward: --assignee flag is preserved in rewrite", () => {
    const plan = planBashFilter("gh issue list --assignee bob --label bug");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--assignee bob");
    expect(plan.rewrite?.to).toContain("--label bug");
  });
});

describe("phase 6.1.4 — ghRunList", () => {
  test("rewrite: gh run list → canonical --json form", () => {
    const plan = planBashFilter("gh run list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("status,conclusion,name");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh run list --json status").rewrite).toBeNull();
  });

  test("match: gh-run-list spec claims 'gh run list'", () => {
    expect(findFilterForCommand("gh run list")?.name).toBe("gh-run-list");
  });

  test("ROI: gh-run-list sample passes through without crashing", () => {
    const raw = loadSample("gh-run-list");
    const plan = planBashFilter("gh run list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("flag-forward: --branch flag is preserved in rewrite", () => {
    const plan = planBashFilter("gh run list --branch main --limit 10");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--branch main");
    expect(plan.rewrite?.to).toContain("--limit 10");
  });
});
