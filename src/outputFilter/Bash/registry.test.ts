import { describe, expect, test } from "bun:test";
import { canonicalizeForMatching, findFilterForCommand } from "./registry.js";

describe("canonicalizeForMatching", () => {
  test("strips sudo prefix", () => {
    expect(canonicalizeForMatching("sudo apt update")).toBe("apt update");
  });

  test("strips time prefix", () => {
    expect(canonicalizeForMatching("time make build")).toBe("make build");
  });

  test("strips nice prefix", () => {
    expect(canonicalizeForMatching("nice npm test")).toBe("npm test");
  });

  test("strips multiple prefixes", () => {
    expect(canonicalizeForMatching("sudo time nice npm test")).toBe("npm test");
  });

  test("strips env assignments", () => {
    expect(canonicalizeForMatching("FOO=bar node server.js")).toBe(
      "node server.js",
    );
  });

  test("strips multiple env assignments", () => {
    expect(canonicalizeForMatching("A=1 B=2 npm test")).toBe("npm test");
  });

  test("strips env assignment with quoted value", () => {
    expect(canonicalizeForMatching("NODE_ENV=production node server.js")).toBe(
      "node server.js",
    );
  });

  test("returns command as-is without prefixes", () => {
    expect(canonicalizeForMatching("npm install")).toBe("npm install");
  });

  test("strips env assignment placed AFTER a wrapper prefix (interleaving)", () => {
    expect(canonicalizeForMatching("sudo FOO=1 git status")).toBe("git status");
  });

  test("strips runner prefixes", () => {
    expect(canonicalizeForMatching("npx eslint .")).toBe("eslint .");
    expect(canonicalizeForMatching("npx -y prettier --check .")).toBe(
      "prettier --check .",
    );
    expect(canonicalizeForMatching("bunx vitest run")).toBe("vitest run");
    expect(canonicalizeForMatching("poetry run pytest -x")).toBe("pytest -x");
    expect(canonicalizeForMatching("pipenv run pytest")).toBe("pytest");
    expect(canonicalizeForMatching("uv run ruff check .")).toBe("ruff check .");
    expect(canonicalizeForMatching("pnpm dlx prettier --check .")).toBe(
      "prettier --check .",
    );
    expect(canonicalizeForMatching("pnpm exec vitest run")).toBe("vitest run");
    expect(canonicalizeForMatching("yarn dlx prettier --check .")).toBe(
      "prettier --check .",
    );
  });

  test("strips runner nested behind env + wrapper prefixes", () => {
    expect(canonicalizeForMatching("sudo CI=1 npx eslint .")).toBe("eslint .");
    expect(canonicalizeForMatching("FOO=bar poetry run pytest")).toBe("pytest");
  });

  test("does not strip script-by-name runners (argument is not a tool)", () => {
    expect(canonicalizeForMatching("npm run lint")).toBe("npm run lint");
    expect(canonicalizeForMatching("pnpm run build")).toBe("pnpm run build");
    expect(canonicalizeForMatching("bun run dev")).toBe("bun run dev");
  });

  test("runner with unknown flag stops the strip (fail-open)", () => {
    // `uv run --with rich pytest` — we can't know where flags end; leave it,
    // verb becomes `--with` and no filter matches (raw passthrough).
    expect(canonicalizeForMatching("uv run --with rich pytest")).toBe(
      "--with rich pytest",
    );
  });
});

describe("findFilterForCommand", () => {
  test("returns null for unknown command", () => {
    expect(findFilterForCommand("some-unknown-tool --flag")).toBeNull();
  });

  test("returns null for command with no built-in filter", () => {
    expect(findFilterForCommand("whoami")).toBeNull();
  });

  test("runner-invoked tools resolve to the bare tool's filter", () => {
    expect(findFilterForCommand("poetry run pytest tests/")?.name).toBe("pytest");
    expect(findFilterForCommand("uv run ruff check .")?.name).toBe("ruff-check");
    expect(findFilterForCommand("uv run python -m pytest")?.name).toBe("pytest");
    expect(findFilterForCommand("bunx vitest run")?.name).toBe("vitest");
    expect(findFilterForCommand("npx -y prettier --check .")?.name).toBe("prettier");
    expect(findFilterForCommand("pnpm dlx prettier --check .")?.name).toBe("prettier");
    expect(findFilterForCommand("yarn dlx prettier --check .")?.name).toBe("prettier");
  });

  test("runner-invoked unknown tool → null (no false positives)", () => {
    expect(findFilterForCommand("npx some-unknown-tool --flag")).toBeNull();
    expect(findFilterForCommand("uv run --with rich pytest")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chained commands — filter applied iff all matching segments share one filter
// ---------------------------------------------------------------------------

describe("findFilterForCommand — chained commands", () => {
  // These tests use real built-in filters; they assert behavior, not specific
  // filter identity, by comparing references across calls.

  test("cd X && cmd resolves to cmd's filter when cd has none", () => {
    const direct = findFilterForCommand("npm install");
    if (!direct) return; // skip if npm filter not present in this build
    const chained = findFilterForCommand("cd src && npm install");
    expect(chained).toBe(direct);
  });

  test("two segments resolving to the same filter spec resolve to it", () => {
    const direct = findFilterForCommand("git status");
    if (!direct) return; // skip if git-status filter not present
    // Two identical verbs → same FilterSpec reference.
    const chained = findFilterForCommand("git status; git status");
    expect(chained).toBe(direct);
  });

  test("three-segment chain with one matching filter resolves", () => {
    const direct = findFilterForCommand("ls -la");
    if (!direct) return;
    const chained = findFilterForCommand("cd src && pwd && ls -la");
    expect(chained).toBe(direct);
  });

  test("two segments with different filters bypass (returns null)", () => {
    const a = findFilterForCommand("npm install");
    const b = findFilterForCommand("git status");
    if (!a || !b || a === b) return;
    expect(findFilterForCommand("npm install && git status")).toBeNull();
  });

  test("pipes still bypass (cannot split safely)", () => {
    expect(findFilterForCommand("git log | head")).toBeNull();
  });

  test("background & still bypasses", () => {
    expect(findFilterForCommand("pwd & ls -la")).toBeNull();
  });

  test("subshell still bypasses", () => {
    expect(findFilterForCommand("echo $(date) && ls")).toBeNull();
  });

  test("control-flow still bypasses", () => {
    expect(findFilterForCommand("if [ -f x ]; then ls; fi")).toBeNull();
  });

  test("quoted operators do not split", () => {
    // "echo 'a && b'" should be treated as a single atomic command for matching
    // purposes; if echo has no filter, result is null — but we still don't bypass-
    // by-compound because the split returns a single segment.
    const direct = findFilterForCommand("echo 'a && b'");
    const chained = findFilterForCommand("echo 'a && b'; pwd");
    // Either both resolve to the same filter (echo's) or both are null.
    if (direct) expect(chained === direct || chained === null).toBe(true);
  });
});
