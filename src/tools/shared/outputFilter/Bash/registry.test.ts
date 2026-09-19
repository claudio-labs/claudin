import { describe, expect, test } from "bun:test";
import { canonicalizeForMatching, findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";

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

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: batch-1 specs unaffected
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 6.1.5 — Regression: all batch-1 + 6.1.4 specs still match
// ---------------------------------------------------------------------------

describe("regression 6.1.5 — batch-1 specs still match after batch-2 added", () => {
  const cases: [string, string][] = [
    ["pytest",          "pytest src/"],
    ["rspec",           "rspec spec/"],
    ["go-test",         "go test ./..."],
    ["bundle-install",  "bundle install"],
    ["ps-aux",          "ps aux"],
    ["top",             "top -bn1"],
    ["rubocop",         "rubocop app/"],
    ["ruff-check",      "ruff check src/"],
    ["ls-la",           "ls -la"],
    ["grep-rg",         "rg foo src/"],
    ["cargo-test",      "cargo test"],
    ["cargo-clippy",    "cargo clippy"],
    ["cargo-check",     "cargo check"],
    ["cargo-build",     "cargo build"],
    ["git-log",         "git log"],
    ["git-status",      "git status"],
    ["gh-pr-list",      "gh pr list"],
    ["gh-issue-list",   "gh issue list"],
    ["gh-run-list",     "gh run list"],
  ];
  for (const [name, cmd] of cases) {
    test(`${name} still matches '${cmd}'`, () => {
      expect(findFilterForCommand(cmd)?.name).toBe(name);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — Regression: reject guards for new specs
// ---------------------------------------------------------------------------

describe("regression 6.1.5 — reject guards for batch-2 specs", () => {
  // gitBlame rejects
  test("git blame --porcelain → no match", () => expect(findFilterForCommand("git blame --porcelain")).toBeNull());
  test("git blame -p → no match",           () => expect(findFilterForCommand("git blame -p README.md")).toBeNull());
  // gitPull rejects
  test("git pull --dry-run → no match",    () => expect(findFilterForCommand("git pull --dry-run")).toBeNull());
  test("git pull --no-ff → no match",      () => expect(findFilterForCommand("git pull --no-ff")).toBeNull());
  // gitAdd rejects
  test("git add -i → no match",            () => expect(findFilterForCommand("git add -i")).toBeNull());
  test("git add --patch → no match",       () => expect(findFilterForCommand("git add --patch")).toBeNull());
  // gitCommit rejects
  test("git commit --dry-run → no match",  () => expect(findFilterForCommand("git commit --dry-run")).toBeNull());
  // gitPush rejects
  test("git push --dry-run → no match",    () => expect(findFilterForCommand("git push --dry-run")).toBeNull());
  // dockerPs rejects
  test("docker ps --format → no match",    () => expect(findFilterForCommand("docker ps --format '{{.Names}}'")).toBeNull());
  test("docker ps -q → no match",          () => expect(findFilterForCommand("docker ps -q")).toBeNull());
  test("docker ps --no-trunc → no match",  () => expect(findFilterForCommand("docker ps --no-trunc")).toBeNull());
  // dockerImages rejects
  test("docker images --format → no match", () => expect(findFilterForCommand("docker images --format '{{.ID}}'")).toBeNull());
  test("docker images -q → no match",       () => expect(findFilterForCommand("docker images -q")).toBeNull());
  // dockerLogs rejects
  test("docker logs -f → no match",         () => expect(findFilterForCommand("docker logs -f myapp")).toBeNull());
  test("docker logs --follow → no match",   () => expect(findFilterForCommand("docker logs --follow myapp")).toBeNull());
  test("docker logs --timestamps=false → no match", () => expect(findFilterForCommand("docker logs --timestamps=false myapp")).toBeNull());
  // curlV rejects
  test("curl -s → no match",                () => expect(findFilterForCommand("curl -s https://api.example.com")).toBeNull());
  test("curl --silent → no match",          () => expect(findFilterForCommand("curl --silent https://api.example.com")).toBeNull());
  test("curl -I → no match",                () => expect(findFilterForCommand("curl -I https://example.com")).toBeNull());
  test("curl --head → no match",            () => expect(findFilterForCommand("curl --head https://example.com")).toBeNull());
  // dig rejects
  test("dig +short → no match",             () => expect(findFilterForCommand("dig +short example.com")).toBeNull());
  test("dig +nocomments → no match",        () => expect(findFilterForCommand("dig +nocomments example.com")).toBeNull());
  // journalctl rejects
  test("journalctl --output=json → no match", () => expect(findFilterForCommand("journalctl --output=json")).toBeNull());
  test("journalctl -o json → no match",       () => expect(findFilterForCommand("journalctl -o json")).toBeNull());
  test("journalctl -f → no match",            () => expect(findFilterForCommand("journalctl -f")).toBeNull());
  test("journalctl --machine=host1 → no match", () => expect(findFilterForCommand("journalctl --machine=host1")).toBeNull());
});

// ---------------------------------------------------------------------------

describe("regression 6.1.4 — batch-1 specs still match after new specs added", () => {
  const cases: [string, string][] = [
    ["pytest",          "pytest src/"],
    ["rspec",           "rspec spec/"],
    ["go-test",         "go test ./..."],
    ["bundle-install",  "bundle install"],
    ["ps-aux",          "ps aux"],
    ["top",             "top -bn1"],
    ["rubocop",         "rubocop app/"],
    ["ruff-check",      "ruff check src/"],
    ["ls-la",           "ls -la"],
    ["grep-rg",         "rg foo src/"],
    ["cargo-test",      "cargo test"],
    ["cargo-clippy",    "cargo clippy"],
    ["cargo-check",     "cargo check"],
    ["cargo-build",     "cargo build"],
  ];
  for (const [name, cmd] of cases) {
    test(`${name} still matches '${cmd}'`, () => {
      expect(findFilterForCommand(cmd)?.name).toBe(name);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: reject guards
// ---------------------------------------------------------------------------

describe("regression 6.1.4 — reject guards", () => {
  // gitLog rejects
  test("git log --oneline → no match",      () => expect(findFilterForCommand("git log --oneline")).toBeNull());
  test('git log --format="%H" → no match',  () => expect(findFilterForCommand('git log --format="%H"')).toBeNull());
  test("git log -p → no match",             () => expect(findFilterForCommand("git log -p")).toBeNull());
  test("git log --patch → no match",        () => expect(findFilterForCommand("git log --patch")).toBeNull());
  test("git log -5 → no match (single-digit)", () => expect(findFilterForCommand("git log -5")).toBeNull());
  // gitStatus rejects
  test("git status --porcelain → no match", () => expect(findFilterForCommand("git status --porcelain")).toBeNull());
  test("git status --short → no match",     () => expect(findFilterForCommand("git status --short")).toBeNull());
  test("git status -s → no match",           () => expect(findFilterForCommand("git status -s")).toBeNull());
  test("git status -sb → no match",          () => expect(findFilterForCommand("git status -sb")).toBeNull());
  test("git log --pretty oneline → no match",() => expect(findFilterForCommand("git log --pretty oneline")).toBeNull());
  // gh rejects
  test("gh pr list --json → no match",      () => expect(findFilterForCommand("gh pr list --json number")).toBeNull());
  test("gh issue list --json → no match",   () => expect(findFilterForCommand("gh issue list --json number")).toBeNull());
  test("gh run list --json → no match",     () => expect(findFilterForCommand("gh run list --json status")).toBeNull());
  test("gh pr list --format → no match",    () => expect(findFilterForCommand("gh pr list --format '{{.number}}'")).toBeNull());
  test("gh pr list --template → no match",  () => expect(findFilterForCommand("gh pr list --template '{{.number}}'")).toBeNull());
  test("gh issue list --format → no match", () => expect(findFilterForCommand("gh issue list --format '{{.number}}'")).toBeNull());
  test("gh run list --format → no match",   () => expect(findFilterForCommand("gh run list --format '{{.name}}'")).toBeNull());
  // compound: bypass when filters disagree, resolve when only one segment matches
  test("git log && echo done → resolves to git-log (echo has no filter)", () => expect(findFilterForCommand("git log && echo done")?.name).toBe("git-log"));
  test("git status || true → resolves to git-status (only matching segment)", () => expect(findFilterForCommand("git status || true")?.name).toBe("git-status"));
  test("gh pr list && echo done → resolves to gh-pr-list (echo has no filter)", () => expect(findFilterForCommand("gh pr list && echo done")?.name).toBe("gh-pr-list"));
  test("git log | head → no match (pipe — cannot split)", () => expect(findFilterForCommand("git log | head")).toBeNull());
  test("cd src && git status → resolves to git-status", () => expect(findFilterForCommand("cd src && git status")?.name).toBe("git-status"));
  // P3: --format with space (not only --format=)
  test("git log --format '%H' → no match (space form)", () => expect(findFilterForCommand("git log --format '%H'")).toBeNull());
  test("git log --format=%H → no match (= form)",    () => expect(findFilterForCommand("git log --format=%H")).toBeNull());
  // P4: --web flag opens browser, must not be rewritten
  test("gh pr list --web → no match",                () => expect(findFilterForCommand("gh pr list --web")).toBeNull());
  test("gh issue list --web → no match",             () => expect(findFilterForCommand("gh issue list --web")).toBeNull());
  test("gh run list --web → no match",               () => expect(findFilterForCommand("gh run list --web")).toBeNull());
});

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: -[1-9]\b boundary
// ---------------------------------------------------------------------------

describe("regression 6.1.4 — -N boundary for git log", () => {
  test("git log -10 is NOT rejected (multi-digit safe)", () => {
    expect(findFilterForCommand("git log -10")?.name).toBe("git-log");
  });
  test("git log -1 IS rejected (single-digit)", () => {
    expect(findFilterForCommand("git log -1")).toBeNull();
  });
  test("git log -9 IS rejected (single-digit)", () => {
    expect(findFilterForCommand("git log -9")).toBeNull();
  });
  test("git log -20 is NOT rejected (multi-digit)", () => {
    expect(findFilterForCommand("git log -20")?.name).toBe("git-log");
  });
});
