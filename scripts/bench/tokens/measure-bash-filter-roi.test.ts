/**
 * One-shot ROI measurement for the Bash output filter.
 *
 * Runs as a Bun test so the existing module-resolution context applies
 * (the bare-bun runner can't resolve some `src/...` imports that pull
 * in analytics). The ROI numbers are a REPORT — they print, they never fail.
 *
 * Usage:
 *   bun test scripts/bench/tokens/measure-bash-filter-roi.test.ts
 *
 * ## Every sample lands in exactly one bucket
 *
 * What DOES fail this test is a sample falling through the cracks. The table
 * used to have a third, silent category: a fixture with no `FIXTURE_MAP` entry
 * and a fixture whose entry named a filter that does not exist were printed
 * side by side as "Skipped (no mapping)" and the run stayed green. That is how
 * `curl-v` and `playwright-test` sat in the map for months naming specs that
 * have always been called `curl` and `playwright` — the report said 55 fixtures
 * and nothing said two of them were broken rather than absent.
 *
 * So every `.txt` in the samples directory must be either
 *
 *   - in `FIXTURE_MAP`, naming a registered filter, with a command that really
 *     routes to it, or
 *   - in `UNFILTERED`, with a one-line reason why no filter claims it,
 *
 * and anything else fails by name. `UNFILTERED` is not a skip list: a sample
 * belongs there when the registry deliberately declines it (`git diff --stat` is
 * already compact, `ls` without `-la` has no columns to drop) or when no spec
 * covers that command at all. Do not move a fixture there to make a number go
 * up — an entry there is a claim that filtering it would be wrong.
 *
 * Commands come from `SPEC_COMMANDS` wherever one fits, so this table and the
 * compound-coverage matrices cannot drift apart.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { REPO_ROOT } from "../../repoRoot";
import {
  applyBashFilterToStdout,
  planBashFilter,
} from "src/tools/shared/outputFilter/Bash/index.js";
import { builtInFilters } from "src/tools/shared/outputFilter/Bash/filters/index.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import { SPEC_COMMANDS } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/specCommands.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";

const SAMPLES_DIR = resolve(
  REPO_ROOT,
  "src/tools/shared/outputFilter/Bash/__fixtures__/samples",
);

/** The command `SPEC_COMMANDS` records for a spec — the default for its samples. */
function cmd(spec: string): string {
  const c = SPEC_COMMANDS[spec];
  if (!c) throw new Error(`SPEC_COMMANDS has no command for '${spec}'`);
  return c;
}

const FIXTURE_MAP: Record<string, [string, string]> = {
  // --- test runners ---------------------------------------------------------
  "bundle-install": ["bundle-install", cmd("bundle-install")],
  "pytest-real": ["pytest", cmd("pytest")],
  "pytest-clean": ["pytest", cmd("pytest")],
  rspec: ["rspec", "bundle exec rspec"],
  "go-test": ["go-test", "go test -v ./..."],
  "jest-clean": ["jest", cmd("jest")],
  "vitest-clean": ["vitest", cmd("vitest")],
  "bun-test": ["bun-test", cmd("bun-test")],
  "bun-test-clean": ["bun-test", cmd("bun-test")],
  "mocha-clean": ["mocha", cmd("mocha")],
  // The spec is `playwright`; this entry read `playwright-test` and silently skipped.
  "playwright-clean": ["playwright", cmd("playwright")],

  // --- compilers / typecheckers ---------------------------------------------
  "tsc-errors": ["tsc", cmd("tsc")],
  "tsc-truncated-50k": ["tsc", cmd("tsc")],

  // --- system inspection ----------------------------------------------------
  "ps-aux": ["ps-aux", cmd("ps-aux")],
  "top-bn1": ["top", cmd("top")],
  journalctl: ["journalctl", cmd("journalctl")],
  "ping-google": ["ping", "ping -c 50 google.com"],
  "rsync-incremental": ["rsync", "rsync -avP src/ dst/"],
  "tree-deep": ["tree", cmd("tree")],
  "ssh-vvv": ["ssh", "ssh -vvv host"],
  "df-h": ["df", "df -h"],
  df: ["df", "df"],
  "du-noisy": ["du", "du -sh /var/log"],
  du: ["du", "du -sh ."],
  "dmesg-long": ["dmesg", cmd("dmesg")],
  "dmesg-tail": ["dmesg", cmd("dmesg")],
  "stat-file": ["stat", cmd("stat")],
  "jq-pretty": ["jq", cmd("jq")],
  "jq-pretty-deep": ["jq", cmd("jq")],
  "json-sample": ["jq", cmd("jq")],
  "find-large": ["find", cmd("find")],
  find: ["find", cmd("find")],

  // --- linters --------------------------------------------------------------
  rubocop: ["rubocop", cmd("rubocop")],
  ruff: ["ruff-check", cmd("ruff-check")],
  "ruff-clean": ["ruff-check", cmd("ruff-check")],
  "ruff-format-clean": ["ruff-format", "ruff format --check ."],
  "ruff-format-diff": ["ruff-format", "ruff format --check ."],
  mypy: ["mypy", cmd("mypy")],
  "mypy-err": ["mypy", cmd("mypy")],
  "eslint-clean": ["eslint", "eslint ."],
  "eslint-errors": ["eslint", "eslint ."],
  "prettier-check": ["prettier", "prettier --check ."],
  "prettier-many": ["prettier", "prettier --check ."],
  shellcheck: ["shellcheck", "shellcheck script.sh"],
  yamllint: ["yamllint", "yamllint file.yaml"],
  markdownlint: ["markdownlint", cmd("markdownlint")],
  hadolint: ["hadolint", cmd("hadolint")],
  "pre-commit": ["pre-commit", cmd("pre-commit")],
  "golangci-lint": ["golangci-lint", cmd("golangci-lint")],

  // --- file listing / code search -------------------------------------------
  "ls-la": ["ls-la", cmd("ls-la")],
  rg: ["grep-rg", "rg foo"],
  "rg-relative": ["grep-rg", "rg foo"],
  grep: ["grep-rg", "grep -r foo ."],

  // --- git ------------------------------------------------------------------
  "git-log-default": ["git-log", cmd("git-log")],
  "git-status": ["git-status", cmd("git-status")],
  "git-blame": ["git-blame", cmd("git-blame")],
  "git-pull-synthetic": ["git-pull", cmd("git-pull")],
  "git-diff": ["git-diff", cmd("git-diff")],
  "git-show": ["git-show", cmd("git-show")],
  "git-show-full": ["git-show", cmd("git-show")],
  "git-add-dryrun": ["git-add", "git add --dry-run ."],
  "git-fetch": ["git-fetch", "git fetch"],
  "git-fetch-real": ["git-fetch", cmd("git-fetch")],
  "git-fetch-dryrun": ["git-fetch", "git fetch --dry-run"],
  "git-branch-a": ["git-branch", cmd("git-branch")],
  "git-stash": ["git-stash", cmd("git-stash")],
  "git-stash-list": ["git-stash", cmd("git-stash")],
  "git-worktree-list": ["git-worktree", cmd("git-worktree")],

  // --- other VCS / forges ---------------------------------------------------
  "gh-pr-list": ["gh-pr-list", cmd("gh-pr-list")],
  "gh-issue-list": ["gh-issue-list", cmd("gh-issue-list")],
  "gh-run-list": ["gh-run-list", cmd("gh-run-list")],
  "glab-pr-list": ["glab-list", cmd("glab-list")],
  "gt-log": ["gt", cmd("gt")],
  "jj-log": ["jj", cmd("jj")],

  // --- cargo ----------------------------------------------------------------
  "cargo-build": ["cargo-build", cmd("cargo-build")],
  "cargo-check": ["cargo-check", cmd("cargo-check")],
  "cargo-clippy": ["cargo-clippy", cmd("cargo-clippy")],
  "cargo-run": ["cargo-run", cmd("cargo-run")],
  "cargo-fmt-clean": ["cargo-fmt", "cargo fmt --check"],
  "cargo-fmt-diff": ["cargo-fmt", "cargo fmt --check"],
  "synthetic-cargo-warnings": ["cargo-build", cmd("cargo-build")],

  // --- go -------------------------------------------------------------------
  "go-build": ["go-build", cmd("go-build")],
  "go-build-error": ["go-build", cmd("go-build")],
  "go-vet": ["go-vet", cmd("go-vet")],

  // --- JS package managers --------------------------------------------------
  "npm-install": ["npm-install", cmd("npm-install")],
  "npm-install-warn": ["npm-install", cmd("npm-install")],
  "npm-test": ["npm-run", "npm test"],
  "pnpm-install": ["pnpm-install", cmd("pnpm-install")],
  "pnpm-run": ["pnpm-run", cmd("pnpm-run")],
  "yarn-install": ["yarn-install", cmd("yarn-install")],
  "prisma-generate": ["prisma-generate", "prisma generate"],
  "prisma-migrate": ["prisma-migrate", "prisma migrate dev"],

  // --- python packaging -----------------------------------------------------
  "pip-install": ["pip-install", "pip install -r requirements.txt"],

  // --- JVM build tools ------------------------------------------------------
  "gradle-build-cold": ["gradle", cmd("gradle")],
  "gradle-build-incremental": ["gradle", cmd("gradle")],
  "gradle-clean-build": ["gradle", "gradle clean build"],
  "gradle-compile-error": ["gradle", cmd("gradle")],
  "gradle-test-failure": ["gradle", "gradle test"],
  "mvn-build-success": ["mvn", cmd("mvn")],
  "mvn-clean-install": ["mvn", "mvn clean install"],
  "mvn-compile-error": ["mvn", "mvn compile"],
  "mvn-test-failure": ["mvn", "mvn test"],
  "mvn-test-success": ["mvn", "mvn test"],

  // --- infrastructure as code -----------------------------------------------
  "terraform-plan-changes": ["terraform", cmd("terraform")],
  "terraform-plan-nochanges": ["terraform", cmd("terraform")],
  "terraform-plan-error": ["terraform", cmd("terraform")],
  "terraform-apply-creating": ["terraform", "terraform apply"],

  // --- containers -----------------------------------------------------------
  "docker-ps": ["docker-ps", cmd("docker-ps")],
  "docker-images": ["docker-images", cmd("docker-images")],
  "docker-logs": ["docker-logs", cmd("docker-logs")],

  // --- network --------------------------------------------------------------
  // The spec is `curl`; this entry read `curl-v` and silently skipped.
  "curl-v": ["curl", cmd("curl")],
  "curl-plain": ["curl-plain", cmd("curl-plain")],
  dig: ["dig", cmd("dig")],
  wget: ["wget", cmd("wget")],
};

/**
 * Samples no filter claims, and why. Each line is a claim that filtering this
 * output would be WRONG — either the registry rejects the flag on purpose, or no
 * spec covers the command at all. Not a skip list.
 */
const UNFILTERED: Record<string, string> = {
  // The registry rejects these shapes deliberately: the output is already the
  // compact form the filter would have produced.
  "git-diff-stat": "git-diff rejects --stat — a stat table is already compact",
  "git-status-porcelain": "git-status rejects --porcelain — machine-readable already",
  "git-pull-dryrun": "git-pull rejects --dry-run — nothing transferred, nothing to strip",
  "git-push-dryrun": "git-push rejects --dry-run — no transfer progress to strip",
  "git-log-oneline": "git-log rejects --oneline — that IS the form its rewrite produces",
  // Was mapped to `cargo-test` and printed 0.0% for it: the filter name existed,
  // so the old skip-on-unknown check passed it through while planBashFilter
  // resolved nothing. CARGO_TEST_PASSTHROUGH names the reason in its own comment.
  "cargo-test-norun": "cargo-test rejects --no-run — a compile-only run has no test lines",
  "ls-plain": "ls-la needs both -l and -a; plain `ls` has no columns to drop",

  // No spec covers the command. Listed so a future spec has a fixture waiting.
  "bun-install": "no spec for `bun install`",
  "npm-ls": "no spec for `npm ls` — a dependency tree is all signal",
  "pnpm-list": "no spec for `pnpm list`",
  "pip-list": "no spec for `pip list`",
  "pip-outdated": "no spec for `pip list --outdated`",
  "git-clean-dryrun": "no spec for `git clean`",
  "git-config-list": "no spec for `git config --list`",
  "git-reflog": "no spec for `git reflog`",
  "git-remote-v": "no spec for `git remote -v`",
  "git-tag-list": "no spec for `git tag`",
  "ip-addr": "no spec for `ip addr`",
  nslookup: "no spec for `nslookup`",
  "ss-tln": "no spec for `ss`",
  "tar-error": "no spec for `tar`; the error IS the output",
  "tail-log": "no spec for `tail` — a log tail is what was explicitly asked for",
  date: "no spec for `date`; one line",
  env: "no spec for `env` — every line is a distinct variable",
  "env-filtered": "no spec for `env`",

  // Not command output at all.
  "code-file": "a source file read through `cat` — content, not command output",
  "synthetic-progress": "hand-written to exercise collapseDigitTemplates; no command",
  "synthetic-runs": "hand-written to exercise collapseRuns; no command",
};

function getFilter(name: string): FilterSpec | undefined {
  return builtInFilters.find((s) => s.name === name);
}

function samples(): string[] {
  return readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => basename(f, ".txt"))
    .sort();
}

/**
 * The integrity checks, split out from the report so a failure names the broken
 * invariant rather than "ROI report". These are the only assertions in this
 * file; the numbers below them never fail.
 */
describe("FIXTURE_MAP integrity", () => {
  test("every mapped filter name is registered", () => {
    const unknown = Object.entries(FIXTURE_MAP)
      .filter(([, [filterName]]) => !getFilter(filterName))
      .map(([fx, [filterName]]) => `${fx} → '${filterName}'`);
    expect(unknown).toEqual([]);
  });

  test("every mapped command routes to the filter it claims", () => {
    // The report resolves the filter from the COMMAND via planBashFilter, so a
    // mapping whose command routes elsewhere prints one filter's name over
    // another filter's numbers — the quiet version of the bug fixed above.
    const misrouted = Object.entries(FIXTURE_MAP)
      .map(([fx, [filterName, command]]) => {
        const actual = findFilterForCommand(command)?.name ?? "(none)";
        return actual === filterName
          ? null
          : `${fx}: '${command}' claims '${filterName}' but routes to '${actual}'`;
      })
      .filter((s): s is string => s !== null);
    expect(misrouted).toEqual([]);
  });

  test("every sample is either mapped or explicitly unfiltered", () => {
    const unaccounted = samples().filter(
      (fx) => !FIXTURE_MAP[fx] && !UNFILTERED[fx],
    );
    expect(unaccounted).toEqual([]);
  });

  test("no sample is in both buckets", () => {
    const both = samples().filter((fx) => FIXTURE_MAP[fx] && UNFILTERED[fx]);
    expect(both).toEqual([]);
  });

  test("no bucket entry names a sample that does not exist", () => {
    const present = new Set(samples());
    const ghosts = [
      ...Object.keys(FIXTURE_MAP).map((fx) => `FIXTURE_MAP: ${fx}`),
      ...Object.keys(UNFILTERED).map((fx) => `UNFILTERED: ${fx}`),
    ].filter((label) => !present.has(label.split(": ")[1] ?? ""));
    expect(ghosts).toEqual([]);
  });
});

test("Bash filter ROI report", () => {
  type Row = {
    fixture: string;
    filter: string;
    inBytes: number;
    outBytes: number;
    bytePct: number;
    inLines: number;
    outLines: number;
    linePct: number;
  };
  const rows: Row[] = [];
  const unfiltered: string[] = [];

  for (const fx of samples()) {
    const mapping = FIXTURE_MAP[fx];
    if (!mapping) {
      // Guaranteed by the integrity block above: unmapped means UNFILTERED.
      unfiltered.push(`${fx} — ${UNFILTERED[fx] ?? "?"}`);
      continue;
    }
    const [filterName, command] = mapping;
    const raw = readFileSync(resolve(SAMPLES_DIR, `${fx}.txt`), "utf8");
    // The real plan, so rewrite-bearing filters (gh-*, git-log, git-status) see
    // their effective command. It resolves the filter from the command; the
    // integrity block is what guarantees that is the filter named here.
    const plan = planBashFilter(command);
    const wrapped = applyBashFilterToStdout(raw, false, plan);
    // Strip the <bash-output-filtered …>BODY</bash-output-filtered> marker
    // so the % reduction reflects body shrinkage, not wrapper overhead.
    const m = wrapped.match(
      /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/,
    );
    const out = m ? m[1]! : wrapped;
    const inBytes = Buffer.byteLength(raw, "utf8");
    const outBytes = Buffer.byteLength(out, "utf8");
    const inLines = raw.split("\n").length;
    const outLines = out.split("\n").length;
    rows.push({
      fixture: fx,
      filter: filterName,
      inBytes,
      outBytes,
      bytePct: inBytes === 0 ? 0 : (1 - outBytes / inBytes) * 100,
      inLines,
      outLines,
      linePct: inLines === 0 ? 0 : (1 - outLines / inLines) * 100,
    });
  }

  rows.sort((a, b) => b.bytePct - a.bytePct);

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const padR = (s: string | number, n: number) => String(s).padStart(n);

  const header =
    pad("fixture", 26) +
    pad("filter", 18) +
    padR("in B", 8) +
    padR("out B", 8) +
    padR("byte%", 8) +
    padR("in L", 7) +
    padR("out L", 7) +
    padR("line%", 8);
  console.log("\n" + header);
  console.log("-".repeat(90));

  for (const r of rows) {
    console.log(
      pad(r.fixture, 26) +
        pad(r.filter, 18) +
        padR(r.inBytes, 8) +
        padR(r.outBytes, 8) +
        padR(r.bytePct.toFixed(1) + "%", 8) +
        padR(r.inLines, 7) +
        padR(r.outLines, 7) +
        padR(r.linePct.toFixed(1) + "%", 8),
    );
  }

  const totalIn = rows.reduce((s, r) => s + r.inBytes, 0);
  const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);
  const totalPct = totalIn === 0 ? 0 : (1 - totalOut / totalIn) * 100;
  console.log("-".repeat(90));
  console.log(
    `${rows.length} fixtures · total ${totalIn} B → ${totalOut} B · ${totalPct.toFixed(1)}% saved`,
  );
  if (unfiltered.length > 0) {
    console.log(
      `\n${unfiltered.length} unfiltered by design (no filter claims them):`,
    );
    for (const line of unfiltered) console.log(`  ${line}`);
  }
});
