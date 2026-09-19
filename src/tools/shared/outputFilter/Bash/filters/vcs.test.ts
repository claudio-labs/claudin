// vcs family — the non-git version-control CLIs (glab / Graphite / Jujutsu).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runFilterBody,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

describe("phase 12.3 — glab-list", () => {
  test("safety: MR ids and titles preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "glab-pr-list.txt"), "utf8");
    const body = runFilterBody("glab-list", "glab mr list", raw);
    expect(body).toContain("!142");
    expect(body).toContain("Phase 12.1");
  });

  test("match: glab pr|mr|issue list ✓; --output json rejects", () => {
    expect(findFilterForCommand("glab pr list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab mr list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab issue list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab mr list --output json")?.name).not.toBe(
      "glab-list",
    );
  });
});

describe("phase 12.3 — gt (Graphite)", () => {
  test("safety: stack lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "gt-log.txt"), "utf8");
    const body = runFilterBody("gt", "gt log", raw);
    expect(body).toContain("feat/bash-filters-expansion");
    expect(body).toContain("main");
  });

  test("match: gt log/ls/submit/sync/restack ✓; gt create not matched", () => {
    expect(findFilterForCommand("gt log")?.name).toBe("gt");
    expect(findFilterForCommand("gt ls")?.name).toBe("gt");
    expect(findFilterForCommand("gt submit")?.name).toBe("gt");
    expect(findFilterForCommand("gt sync")?.name).toBe("gt");
    expect(findFilterForCommand("gt restack")?.name).toBe("gt");
    expect(findFilterForCommand("gt create")?.name).not.toBe("gt");
  });
});

describe("phase 12.3 — jj (Jujutsu)", () => {
  test("safety: change ids and commit lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "jj-log.txt"), "utf8");
    const body = runFilterBody("jj", "jj log", raw);
    expect(body).toContain("qpvuntsm");
    expect(body).toContain("Phase 12.1");
  });

  test("match: jj log/st/status/diff ✓; jj new not matched", () => {
    expect(findFilterForCommand("jj log")?.name).toBe("jj");
    expect(findFilterForCommand("jj st")?.name).toBe("jj");
    expect(findFilterForCommand("jj status")?.name).toBe("jj");
    expect(findFilterForCommand("jj diff")?.name).toBe("jj");
    expect(findFilterForCommand("jj new")?.name).not.toBe("jj");
  });
});
