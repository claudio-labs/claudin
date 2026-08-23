/**
 * Compound-body preservation matrix.
 *
 * `compoundRouting.test.ts` pins which SPEC a compound command resolves to.
 * This one pins what happens to the OUTPUT, and it exists for one failure mode:
 * a stage that reshapes the whole body swallowing a neighbouring segment. Two
 * stages can do that, and both are new or newly reachable —
 *
 *  - `matchOutput` replaces the entire body with a sentinel, so `echo "===" &&
 *    bun test` on a clean run would come back as `✓ bun test: all tests passed`
 *    and the echo would be gone. `allowShortCircuit: !plan.isCompound` is what
 *    stops it (`index.ts`), and until `runCompoundBody` existed no family test
 *    could reach that branch at all — the harness built its plans by hand and
 *    never set `isCompound`.
 *  - `renderBody` reshapes a diff into a stat table. `git status --porcelain &&
 *    git diff` resolves to `git-diff` (the `--porcelain` half opts out, so the
 *    segments do not disagree) and is among the largest results in the recorded
 *    corpus. Handing the whole body to `renderDiff` drops the porcelain lines
 *    silently, because `summarizeDiffFiles` keeps only what parses as a file
 *    section. `renderDiffTail` splices instead — see `filters/git.ts`.
 *
 * The assertions are on `preserves` strings surviving, never on byte equality:
 * the generic floor now legitimately collapses identical runs, folds digit
 * templates and caps unmatched output at 60 lines. Where the cap DOES remove
 * something, that is asserted as the cap working rather than quietly excluded —
 * see "the cap cuts the middle" below.
 *
 * Every `preserves` string is lifted from `reductionFloors.test.ts`; none is
 * invented here, since those were chosen as the critical content of each sample.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCompoundBody } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";

const SAMPLES_DIR = resolve(import.meta.dir, "__fixtures__/samples");

function load(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.txt`), "utf8");
}

const OMIT_MARKER_RE = /lines omitted/;
const HUNK_RE = /^@@/m;

// ---------------------------------------------------------------------------
// 1. Chains whose heads disagree — no spec resolves, the generic floor runs
// ---------------------------------------------------------------------------

type Pair = {
  commandA: string;
  sampleA: string;
  commandB: string;
  sampleB: string;
  /** From the reduction-floor rows: segment A's, then segment B's. */
  preserves: string[];
};

const DISAGREEING_PAIRS: Pair[] = [
  {
    commandA: "eslint .",
    sampleA: "eslint-errors",
    commandB: "go build ./...",
    sampleB: "go-build-error",
    preserves: ["no-unused-vars", "error", "undefined"],
  },
  {
    commandA: "shellcheck script.sh",
    sampleA: "shellcheck",
    commandB: "mypy src/",
    sampleB: "mypy-err",
    preserves: ["SC2086", "error"],
  },
  {
    commandA: "npm install",
    sampleA: "npm-install-warn",
    commandB: "cargo run",
    sampleB: "cargo-run",
    preserves: ["deprecated", "Hello"],
  },
  {
    commandA: "pip install -r requirements.txt",
    sampleA: "pip-install",
    commandB: "go vet ./...",
    sampleB: "go-vet",
    preserves: ["Successfully installed", "Sprintf"],
  },
  {
    commandA: "yamllint file.yaml",
    sampleA: "yamllint",
    commandB: "hadolint Dockerfile",
    sampleB: "hadolint",
    preserves: ["error", "warning", "DL"],
  },
  {
    commandA: "pre-commit run --all-files",
    sampleA: "pre-commit",
    commandB: "git stash list",
    sampleB: "git-stash",
    preserves: ["Failed", "stash@{0}"],
  },
];

describe("a chain whose segments disagree keeps both segments", () => {
  for (const pair of DISAGREEING_PAIRS) {
    const command = `${pair.commandA} && ${pair.commandB}`;
    test(`${pair.sampleA} && ${pair.sampleB}`, () => {
      // The premise: two different specs, so the registry bypasses and the
      // generic floor is what runs. If either half ever stops resolving, this
      // test would silently become a single-spec test instead.
      expect(findFilterForCommand(pair.commandA)).not.toBeNull();
      expect(findFilterForCommand(pair.commandB)).not.toBeNull();
      expect(findFilterForCommand(command)).toBeNull();

      const raw = load(pair.sampleA) + load(pair.sampleB);
      const body = runCompoundBody(command, raw);
      for (const needle of pair.preserves) {
        expect(body, `"${needle}" must survive ${command}`).toContain(needle);
      }
      // All six pairs are well under the 60-line cap, so nothing here is
      // load-bearing on the head/tail split. The cap gets its own case below.
      expect(raw.split("\n").length).toBeLessThan(60);
      expect(body).not.toMatch(OMIT_MARKER_RE);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The cap cuts the middle, and that is the point
// ---------------------------------------------------------------------------

describe("a long chain is capped, head and tail kept", () => {
  const COMMAND = "ps aux && ls -la";
  // A `[kworker/10:2-cgroup_free]` row from the middle of the 442-line sample.
  // It is NOT expected to survive, and saying so here is the honest form of the
  // assertion: a head/tail cap that kept it would not be capping.
  const MIDDLE_ROW = "[kworker/10:2-cgroup_free]";

  test("keeps the header, drops the middle, and says how much", () => {
    expect(findFilterForCommand(COMMAND)).toBeNull();
    const raw = load("ps-aux");
    expect(raw).toContain(MIDDLE_ROW);

    const body = runCompoundBody(COMMAND, raw);
    expect(body).toContain("USER");
    expect(body).toContain("PID");
    expect(body).toMatch(OMIT_MARKER_RE);
    expect(body).not.toContain(MIDDLE_ROW);
    expect(body.split("\n").length).toBeLessThan(raw.split("\n").length / 10);
  });
});

// ---------------------------------------------------------------------------
// 3. `echo "=== label" && cmd` — one spec resolves, with a prefix in front
// ---------------------------------------------------------------------------

type Labelled = { command: string; sample: string; spec: string; preserves: string[] };

const LABELLED: Labelled[] = [
  { command: "npm install", sample: "npm-install-warn", spec: "npm-install", preserves: ["deprecated"] },
  { command: "eslint .", sample: "eslint-errors", spec: "eslint", preserves: ["no-unused-vars", "error"] },
  { command: "shellcheck script.sh", sample: "shellcheck", spec: "shellcheck", preserves: ["SC2086"] },
  { command: "go build ./...", sample: "go-build-error", spec: "go-build", preserves: ["undefined"] },
  { command: "pip install -r requirements.txt", sample: "pip-install", spec: "pip-install", preserves: ["Successfully installed"] },
  { command: "git stash list", sample: "git-stash", spec: "git-stash", preserves: ["stash@{0}"] },
  { command: "git branch -a", sample: "git-branch-a", spec: "git-branch", preserves: ["main"] },
  { command: "git fetch", sample: "git-fetch", spec: "git-fetch", preserves: ["From "] },
  { command: "pre-commit run --all-files", sample: "pre-commit", spec: "pre-commit", preserves: ["Failed"] },
  { command: "ps aux", sample: "ps-aux", spec: "ps-aux", preserves: ["USER"] },
];

describe("an echo separator survives the spec that claims the chain", () => {
  for (const row of LABELLED) {
    const label = `=== ${row.sample}`;
    const command = `echo "${label}" && ${row.command}`;
    test(`${row.spec} × ${row.sample}`, () => {
      // `echo` matches no spec, so the chain agrees on the other segment's.
      expect(findFilterForCommand(command)?.name).toBe(row.spec);
      const body = runCompoundBody(command, `${label}\n${load(row.sample)}`);
      expect(body, `the separator must survive ${row.spec}`).toContain(label);
      for (const needle of row.preserves) {
        expect(body, `"${needle}" must survive ${row.spec}`).toContain(needle);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Sentinel suppression, per family
// ---------------------------------------------------------------------------

/** Specs whose `matchOutput` replaces the whole body on a clean run. */
const SENTINEL_FAMILIES: { command: string; sample: string; sentinel: string }[] = [
  { command: "bun test", sample: "bun-test-clean", sentinel: "✓ bun test" },
  { command: "jest", sample: "jest-clean", sentinel: "✓ jest" },
  { command: "vitest run", sample: "vitest-clean", sentinel: "✓ vitest" },
  { command: "pytest", sample: "pytest-clean", sentinel: "✓ pytest" },
  { command: "go test ./...", sample: "go-test", sentinel: "✓ go test" },
];

describe("a sentinel replaces the body alone, never a sibling segment", () => {
  for (const family of SENTINEL_FAMILIES) {
    const label = `=== ${family.sample}`;
    test(family.sample, () => {
      const raw = load(family.sample);

      // Atomic: the sentinel is armed and fires, replacing everything.
      const atomic = runCompoundBody(family.command, raw);
      expect(atomic).toContain(family.sentinel);

      // Compound: the same sentinel is suppressed, because firing it would
      // delete output the echo produced and the spec knows nothing about.
      const compound = runCompoundBody(
        `echo "${label}" && ${family.command}`,
        `${label}\n${raw}`,
      );
      expect(compound, "the sibling segment must survive").toContain(label);
      expect(compound).not.toBe(family.sentinel);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. The diff splice — the case the whole matrix was written for
// ---------------------------------------------------------------------------

describe("a rendered diff keeps the segment that ran before it", () => {
  const PORCELAIN_ROW = "M  src/components/StartupScreen.ts";
  const BRANCH_ROW = "## main...origin/main";

  test("git status --porcelain && git show HEAD", () => {
    const command = "git status --porcelain && git show HEAD";
    expect(findFilterForCommand(command)?.name).toBe("git-show");
    const raw = load("git-status-porcelain") + load("git-show-full");
    const body = runCompoundBody(command, raw);

    expect(body).toContain(BRANCH_ROW);
    expect(body).toContain(PORCELAIN_ROW);
    // 7 files and ~10 KB — past both pivots, so the hunks become a stat table.
    expect(body).not.toMatch(HUNK_RE);
    expect(body.length).toBeLessThan(raw.length / 4);
  });

  test("git status --porcelain && git diff, over the pivot", () => {
    const command = "git status --porcelain && git diff";
    expect(findFilterForCommand(command)?.name).toBe("git-diff");
    // The sample is 3 files and 3.2 KB, under both pivots on its own. Doubling
    // it clears them (6 files, 6.4 KB) without inventing a fixture.
    const raw = load("git-status-porcelain") + load("git-diff") + load("git-diff");
    const body = runCompoundBody(command, raw);

    expect(body).toContain(BRANCH_ROW);
    expect(body).toContain(PORCELAIN_ROW);
    expect(body).not.toMatch(HUNK_RE);
    expect(body.length).toBeLessThan(raw.length / 4);
  });

  test("a diff small enough to read is declined, hunks and all", () => {
    const command = "git status --porcelain && git diff";
    const raw = load("git-status-porcelain") + load("git-diff");
    const body = runCompoundBody(command, raw);

    expect(body).toContain(BRANCH_ROW);
    expect(body).toContain(PORCELAIN_ROW);
    // Under the pivot with nothing to elide, `renderDiff` declines rather than
    // strip context the model can simply read.
    expect(body).toMatch(HUNK_RE);
  });
});

// ---------------------------------------------------------------------------
// 6. Match-line grouping reaches the chains the grep spec never sees
// ---------------------------------------------------------------------------

describe("grep output in an unmatched chain is grouped by file", () => {
  const COMMAND = "grep -r foo . && ls -la";

  test("hoists the repeated path", () => {
    expect(findFilterForCommand(COMMAND)).toBeNull();
    const raw = load("grep");
    const body = runCompoundBody(COMMAND, raw);

    expect(body.length).toBeLessThan(raw.length);
    // Every match survives; only the repeated prefix is gone.
    expect(body).toContain("1909:        const isAbortError =");
    expect(body).toContain("1919:        if (isAbortError) {");
    expect(body).toContain("export function isAbortError");
  });

  test("declines output that carries no line numbers", () => {
    // `rg` without `-n` prints `path:text`, which has no line number to split
    // on — grouping it would have to guess where the path ends.
    const raw = load("rg-relative");
    expect(runCompoundBody(COMMAND, raw)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// 7. What the floor must NOT do to a compound's output
// ---------------------------------------------------------------------------

// Three losses found by review, each reproduced here against the shipped
// pipeline rather than against the stage in isolation — the stage was innocent
// in all three, the fence around it was not.
describe("the floor declines where a stage would corrupt rather than shorten", () => {
  // The registry protects `bunx tsc --noEmit` and protects nothing when the
  // same compiler runs behind a wrapper, which is how most of it arrives.
  // Before the diagnostics fence this returned ONE line marked `(98 updates)`.
  const DIAGNOSTICS = Array.from(
    { length: 98 },
    (_, i) =>
      `src/f${i}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`,
  ).join("\n");

  test("98 diagnostics behind a wrapper script survive whole", () => {
    const command = "./scripts/check.sh 1";
    expect(findFilterForCommand(command)).toBeNull();
    const body = runCompoundBody(command, DIAGNOSTICS);

    expect(body.split("\n").filter(l => l.includes("error TS"))).toHaveLength(98);
    expect(body).toContain("src/f97.ts(98,5)");
  });

  test("a page of grep hits is reshaped but never digit-collapsed", () => {
    // The chain has to be one the registry declines — `cd src && rg -n Accept`
    // resolves to `grep-rg`, and a matched spec never sees the floor's lossy
    // stages at all, so it would pass this without exercising anything.
    const command = "grep -rn Accept . && ls -la";
    expect(findFilterForCommand(command)).toBeNull();
    const raw = Array.from(
      { length: 40 },
      (_, i) => `src/http.ts:${i + 1}:const accept = 1`,
    )
      .concat(["src/other.ts:9:const accept = 2"])
      .join("\n");
    const body = runCompoundBody(command, raw);

    expect(body).toContain("src/http.ts");
    expect(body).not.toContain("updates)");
    expect(body.split("\n").filter(l => /^\d+:/.test(l))).toHaveLength(41);
  });

  // `echo` has no spec, so `git diff && echo …` resolves to `git-diff` and the
  // whole body went to `renderDiff`, which above the pivot rebuilds its output
  // from the parsed file list — deleting anything that was not part of a file.
  test("output printed after a budgeted diff is not deleted with it", () => {
    const command = "git diff && echo BUILD-OK";
    // Seven files crosses `DIFF_PIVOT_FILES`, which is where `renderDiff` stops
    // splicing hunks and rebuilds a stat table from the file list instead — the
    // branch that used to take the echo with it. The shipped `git-diff` sample
    // sits under the pivot and declines, so it cannot reach this.
    const raw = `${Array.from({ length: 7 }, (_, n) =>
      [
        `diff --git a/f${n}.ts b/f${n}.ts`,
        `--- a/f${n}.ts`,
        `+++ b/f${n}.ts`,
        "@@ -1,3 +1,3 @@",
        ...Array.from({ length: 5 }, (_, i) => `+f${n} line ${i}`),
      ].join("\n"),
    ).join("\n")}\nBUILD-OK`;
    const body = runCompoundBody(command, raw);

    expect(body.length).toBeLessThan(raw.length / 2);
    expect(body).toContain("BUILD-OK");
  });
});
