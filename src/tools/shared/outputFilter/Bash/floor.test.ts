import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { getGlobalConfig, saveGlobalConfig } from "src/platform/config/config.js";
import { maybeSummarizeToolResult } from "src/agent/tools/toolResultSummarizer.js";
import { BASH_TOOL_NAME } from "src/tools/BashTool/toolName.js";
import {
  applyBashFilterToStdout,
  planBashFilter,
} from "src/tools/shared/outputFilter/Bash/index.js";
import { stripOutputMarkers } from "src/tools/shared/outputFilter/Bash/markers.js";
import {
  BOUNDED_READ_MAX_LINES,
  ERROR_FLOOR,
  FLOOR_CAP_LINES,
  GENERIC_FLOOR,
  isCapKeepBoundedEnabled,
  isCappableBody,
  isFloorCapEnabled,
  isPathLine,
  looksLikeDiagnostics,
  looksLikeLocationList,
  MAX_KEPT_PATH_LINES,
  withGenericFloor,
} from "src/tools/shared/outputFilter/Bash/floor.js";
import { builtInFilters } from "src/tools/shared/outputFilter/Bash/filters/index.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";

const BARE: FilterSpec = { name: "bare", matchCommand: /^bare\b/ };

describe("withGenericFloor", () => {
  test("with no spec, returns the floor itself", () => {
    expect(withGenericFloor(null)).toBe(GENERIC_FLOOR);
  });

  test("fills the gaps of a spec that sets neither stage", () => {
    const merged = withGenericFloor(BARE);
    expect(merged.stripAnsi).toBe(true);
    expect(merged.collapseRuns).toBe(true);
  });

  test("keeps the spec's identity and its own stages", () => {
    const spec: FilterSpec = {
      name: "keeps",
      matchCommand: /^keeps\b/,
      maxLines: 40,
      dedupGlobal: true,
    };
    const merged = withGenericFloor(spec);
    expect(merged.name).toBe("keeps");
    expect(merged.matchCommand).toBe(spec.matchCommand);
    expect(merged.maxLines).toBe(40);
    expect(merged.dedupGlobal).toBe(true);
  });

  test("an explicit false is a decision, not a gap", () => {
    const merged = withGenericFloor({
      name: "opted-out",
      matchCommand: /^opted-out\b/,
      stripAnsi: false,
      collapseRuns: false,
    });
    expect(merged.stripAnsi).toBe(false);
    expect(merged.collapseRuns).toBe(false);
  });

  test("does not mutate the spec it was given", () => {
    const before = { ...BARE };
    withGenericFloor(BARE);
    expect(BARE).toEqual(before);
  });

  // The floor carries the two stages that are safe on output nobody has looked
  // at. `dedupGlobal` destroys a table whose column repeats and `truncateLineAt`
  // shreds a one-line JSON document, so neither may drift into it — a spec opts
  // into those because its author knows the format.
  test("the floor carries only the two stages that are always safe", () => {
    expect(GENERIC_FLOOR.stripAnsi).toBe(true);
    expect(GENERIC_FLOOR.collapseRuns).toBe(true);
    expect(GENERIC_FLOOR.dedupGlobal).toBeUndefined();
    expect(GENERIC_FLOOR.truncateLineAt).toBeUndefined();
    expect(GENERIC_FLOOR.collapseDigitTemplates).toBeUndefined();
    expect(GENERIC_FLOOR.maxLines).toBeUndefined();
    expect(GENERIC_FLOOR.headLines).toBeUndefined();
    expect(GENERIC_FLOOR.tailLines).toBeUndefined();
    expect(GENERIC_FLOOR.matchOutput).toBeUndefined();
    expect(GENERIC_FLOOR.rewriteCommand).toBeUndefined();
  });

  // The floor is applied directly by applyBashFilterToStdout. If the registry
  // could ever resolve it by command it would shadow a real spec, and the
  // marker would name a filter the user cannot configure.
  test("the registry never resolves the floor", () => {
    expect(builtInFilters).not.toContain(GENERIC_FLOOR);
    for (const command of ["", " ", "generic-floor", "ls", "git status"]) {
      expect(findFilterForCommand(command)).not.toBe(GENERIC_FLOOR);
    }
  });

  // ERROR_FLOOR is `collapseRuns` and nothing else, and until 2026-08-24 that
  // was a set of arguments with no number behind it. There is one now, from
  // `scripts/bench/tokens/measure-bash-error-floor.test.ts` over 491 recorded
  // failing commands (408,799 chars):
  //
  //   collapseRuns (today)       0.1%  — the control; it already ran in production
  //   + collapseDigitTemplates   0.3%  — fenced as the success floor fences it
  //   + stripAnsi                0.2%  — matches the figure its rejection cited
  //   + cap 60                   8.1%  — 23 of 326 eligible entries, 33,176 chars
  //
  // Three of those four are settled by their own numbers. The cap is NOT: 8.1%
  // of this lane is real, and the body fence already refuses the dangerous
  // bodies (11 entries reading as diagnostics hold 101,241 chars and are
  // vetoed). What keeps it out is not the measurement but the READER — an error
  // string is printed verbatim to the USER's terminal by the error renderers,
  // so a cap here removes the middle of what a human is reading to find out
  // what broke, which is a different trade from the success lane. Changing that
  // is a product decision; this test is what makes it a deliberate one.
  test("the error floor carries collapseRuns and nothing else", () => {
    expect(ERROR_FLOOR.collapseRuns).toBe(true);
    expect(ERROR_FLOOR.stripAnsi).toBeUndefined();
    expect(ERROR_FLOOR.collapseDigitTemplates).toBeUndefined();
    expect(ERROR_FLOOR.maxLines).toBeUndefined();
    expect(ERROR_FLOOR.headLines).toBeUndefined();
    expect(ERROR_FLOOR.tailLines).toBeUndefined();
    expect(ERROR_FLOOR.keepLinesMatching).toBeUndefined();
    expect(ERROR_FLOOR.matchOutput).toBeUndefined();
    expect(ERROR_FLOOR.renderBody).toBeUndefined();
  });

  // The two floors are separate objects on purpose: `withGenericFloor` merges
  // GENERIC_FLOOR into every matched spec, and if the error lane read the same
  // object it would inherit `stripAnsi` the moment one was added there.
  test("the error floor is not the generic floor", () => {
    expect(ERROR_FLOOR).not.toBe(GENERIC_FLOOR);
    expect(builtInFilters).not.toContain(ERROR_FLOOR);
  });

  test("every registered spec survives the merge with its name intact", () => {
    for (const spec of builtInFilters) {
      expect(withGenericFloor(spec).name).toBe(spec.name);
    }
  });

  // The lossy stages reach unmatched output only. A spec that matched already
  // encodes its author's decision about what to keep, and `jq` is the worked
  // example: its 800-line pretty-printed JSON is ONE digit template, so a floor
  // that folded it would return three lines and call that a saving.
  describe("the lossy stages never reach a matched spec", () => {
    for (const opts of [
      { groupMatches: true },
      { collapseTemplates: true },
      { cap: true },
      { groupMatches: true, collapseTemplates: true, cap: true },
    ]) {
      test(`with ${JSON.stringify(opts)}`, () => {
        const merged = withGenericFloor(BARE, opts);
        expect(merged.collapseDigitTemplates).toBeUndefined();
        expect(merged.maxLines).toBeUndefined();
        expect(merged.renderBody).toBeUndefined();
      });
    }
  });

  describe("unmatched output takes the lossy stages the caller allowed", () => {
    test("collapseTemplates alone adds the digit collapse and no cap", () => {
      const merged = withGenericFloor(null, { collapseTemplates: true });
      expect(merged.collapseDigitTemplates).toBe(true);
      expect(merged.maxLines).toBeUndefined();
      expect(merged.renderBody).toBeUndefined();
    });

    // These two were ONE option until a review found they want opposite answers
    // on a page of `path:line:` — the reshape's best input is the collapse's
    // worst — so each has to be reachable without the other.
    test("groupMatches alone adds the reshape and no digit collapse", () => {
      const merged = withGenericFloor(null, { groupMatches: true });
      expect(merged.renderBody).toBeDefined();
      expect(merged.collapseDigitTemplates).toBeUndefined();
      expect(merged.maxLines).toBeUndefined();
    });

    test("cap alone adds the cap and no digit collapse", () => {
      const merged = withGenericFloor(null, { cap: true });
      expect(merged.maxLines).toBe(FLOOR_CAP_LINES);
      expect(merged.collapseDigitTemplates).toBeUndefined();
      expect(merged.renderBody).toBeUndefined();
    });

    test("neither leaves the bare floor untouched", () => {
      expect(
        withGenericFloor(null, {
          groupMatches: false,
          collapseTemplates: false,
          cap: false,
        }),
      ).toBe(GENERIC_FLOOR);
    });
  });
});

// A cut through the middle of these yields something the model can neither read
// nor repair, which is worse than handing over the whole thing.
describe("isCappableBody", () => {
  test("refuses a body with no middle to remove", () => {
    expect(isCappableBody("one line, no newline")).toBe(false);
    expect(isCappableBody("one line, trailing newline\n")).toBe(false);
    expect(isCappableBody("")).toBe(false);
  });

  test("refuses JSON, however it is indented", () => {
    expect(isCappableBody('{\n  "a": 1\n}')).toBe(false);
    expect(isCappableBody("[\n  1,\n  2\n]")).toBe(false);
    expect(isCappableBody('\n\n  {\n  "a": 1\n}')).toBe(false);
  });

  test("accepts ordinary multi-line output", () => {
    expect(isCappableBody("line one\nline two\n")).toBe(true);
    expect(isCappableBody("src/a.ts:1:x\nsrc/b.ts:2:y")).toBe(true);
  });
});

// The two body reads that decide the lossy stages. `isCappableBody` alone was
// the whole fence until a review replayed 98 lines of `tsc` output through a
// wrapper script: no spec resolved, the lines differ only in their digits, and
// the floor returned ONE of them marked `(98 updates)`.
describe("looksLikeDiagnostics", () => {
  const TSC = Array.from(
    { length: 8 },
    (_, i) => `src/f${i}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable.`,
  ).join("\n");

  test("accepts compiler output in the shapes the toolchains print", () => {
    expect(looksLikeDiagnostics(TSC)).toBe(true);
    expect(
      looksLikeDiagnostics(
        "error[E0308]: mismatched types\nerror[E0425]: cannot find value\nerror[E0433]: failed to resolve",
      ),
    ).toBe(true);
    expect(
      looksLikeDiagnostics(
        "src/a.ts:1:1: warning: unused\nsrc/b.ts:2:1: warning: unused\nsrc/c.ts:3:1: warning: shadowed",
      ),
    ).toBe(true);
  });

  test("one stray error line does not make a log a diagnostic dump", () => {
    const log = [
      "starting",
      "connecting",
      "error: retrying once",
      "connected",
      "done",
    ].join("\n");
    expect(looksLikeDiagnostics(log)).toBe(false);
  });

  test("the plural is not the word — 'no errors found' is not a diagnostic", () => {
    expect(looksLikeDiagnostics("no errors found\nno errors found\n")).toBe(false);
  });
});

describe("looksLikeLocationList", () => {
  test("accepts a page of grep hits and a file enumeration", () => {
    expect(looksLikeLocationList("a/x.ts:1:hit\na/y.ts:2:hit\na/z.ts:3:hit")).toBe(
      true,
    );
    expect(
      looksLikeLocationList("src/a.ts(1,5)\nsrc/b.ts(2,5)\nsrc/c.ts(3,5)"),
    ).toBe(true);
  });

  test("declines prose and progress output, which is what the collapse is for", () => {
    expect(looksLikeLocationList("[1/9] Compiling\n[2/9] Compiling\n[3/9] Compiling")).toBe(
      false,
    );
    expect(looksLikeLocationList("total 12\ndrwxr-xr-x 2 u u 4096 Aug 23 .\n")).toBe(
      false,
    );
  });
});

// The cap is the only stage with a user-facing switch, and it has two: the env
// var and this key. Only the config arm is testable here — `CAP_DISABLED` is
// read once at module load, so a test that set the variable would be asserting
// on whatever the process started with.
describe("isFloorCapEnabled", () => {
  let saved: boolean | undefined;

  beforeEach(() => {
    saved = getGlobalConfig().bashOutputFilterCapEnabled;
  });

  afterEach(() => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: saved }));
  });

  test("an unset key leaves the cap on — it ships default-on", () => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: undefined }));
    expect(isFloorCapEnabled()).toBe(true);
  });

  test("an explicit true leaves the cap on", () => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: true }));
    expect(isFloorCapEnabled()).toBe(true);
  });

  test("false turns the cap off", () => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: false }));
    expect(isFloorCapEnabled()).toBe(false);
  });

  // The switch has to reach the stage, not just the predicate: `floorOptionsFor`
  // is the only caller and a cap it still allowed would ship the cut anyway.
  test("with the cap off, unmatched output keeps every line", () => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: false }));
    // Adjacent lines differ by a LETTER, so the digit collapse cannot fire and
    // the only stage that could shorten this is the cap under test.
    const body = Array.from(
      { length: FLOOR_CAP_LINES * 2 },
      (_, i) => `${"abcdefghij"[i % 10]}-item-${i}`,
    ).join("\n");
    const plan = planBashFilter("some-unregistered-command", { allowRewrite: false });
    const out = applyBashFilterToStdout(body, false, plan);
    for (const i of [0, FLOOR_CAP_LINES, FLOOR_CAP_LINES * 2 - 1]) {
      expect(out).toContain(`${"abcdefghij"[i % 10]}-item-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// CLAUDIN_CAP_KEEP_PATHS — the cut keeps the path lines of the middle
// ---------------------------------------------------------------------------

describe("isPathLine", () => {
  test("accepts a bare path, and a count before one as wc -l and du print it", () => {
    for (const line of [
      "src/a.ts",
      "./b/",
      "/abs/c.json",
      ".gitignore",
      "README.md",
      "data/carts/basic-us.json",
      "   54 src/regions.ts",
      "4.0K\tsrc/",
    ]) {
      expect(isPathLine(line)).toBe(true);
    }
  });

  test("declines prose, markup, JSON, a wc total and URLs", () => {
    for (const line of [
      "",
      "Prices a shopping cart for the storefront: catalog prices, then coupons, then",
      "| `src/regions.ts` | currency, tax rates and shipping rules per region |",
      '  "name": "pricing-engine",',
      " 1119 total",
      "e.g. this",
      "https://bun.sh/docs",
      "[1/9] Compiling",
      "node_modules",
    ]) {
      expect(isPathLine(line)).toBe(false);
    }
  });
});

describe("CLAUDIN_CAP_KEEP_PATHS — the cut keeps the listing", () => {
  const FLAG = "CLAUDIN_CAP_KEEP_PATHS";
  // The command claudindev opened most bench sessions with, and what it printed
  // on the pristine session-cache-ab project: 143 lines.
  const COMMAND = "git ls-files && cat README.md package.json && wc -l $(git ls-files | grep -E '\\.(ts|json)$')";
  const ORIENTATION = readFileSync(
    resolve(import.meta.dir, "__fixtures__/samples/orientation-ls-files-cat-wc.txt"),
    "utf8",
  );
  const LINES = ORIENTATION.split("\n");
  // `git ls-files` printed everything above the README's title.
  const LISTED = LINES.slice(0, LINES.indexOf("# pricing-engine"));
  let savedFlag: string | undefined;
  let savedCap: boolean | undefined;

  const filter = (body: string, command = COMMAND): string =>
    applyBashFilterToStdout(body, false, planBashFilter(command, { allowRewrite: false }));

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    savedCap = getGlobalConfig().bashOutputFilterCapEnabled;
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: true }));
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: savedCap }));
  });

  test("the capture is the listing it claims to be", () => {
    expect(LINES.length - 1).toBe(143);
    expect(LISTED).toHaveLength(29);
    expect(LISTED[0]).toBe(".gitignore");
    expect(LISTED.at(-1)).toBe("test/tax.test.ts");
    expect(LISTED.every(isPathLine)).toBe(true);
  });

  test("off (=0): the plain cut hides src/regions.ts, the file the bench sessions read late", () => {
    process.env[FLAG] = "0";
    const out = filter(ORIENTATION);
    expect(out).toContain("lines omitted");
    expect(out).not.toContain("src/regions.ts");
  });

  test("unset, the default: every listed path and every wc -l line survive, and the prose is still cut", () => {
    delete process.env[FLAG];
    const out = filter(ORIENTATION);
    for (const path of LISTED) expect(out).toContain(path);
    expect(out).toContain("   54 src/regions.ts");
    expect(out).toContain("lines omitted");
    // README.md's prose and package.json sit in the middle and stay cut, so a
    // later Patch on README.md still finds it read by the Read that follows.
    expect(out).not.toContain("currency, tax rates and shipping rules per region");
    expect(out).not.toContain('"name": "pricing-engine"');
    expect(stripOutputMarkers(out).length).toBeLessThan(ORIENTATION.length);
  });

  test("on: past the path budget, the plain 15+15 cut", () => {
    delete process.env[FLAG];
    const paths = Array.from({ length: MAX_KEPT_PATH_LINES + 50 }, (_, i) => `src/dir${i % 7}/file${i}.ts`);
    const out = filter(["intro line one", ...paths, "closing line"].join("\n"), "find src -name '*.ts'");
    expect(out).toContain("lines omitted");
    expect(out).not.toContain(`src/dir${100 % 7}/file100.ts`);
  });

  test("on: a middle made only of paths within the budget comes back whole", () => {
    delete process.env[FLAG];
    const paths = Array.from({ length: FLOOR_CAP_LINES * 2 }, (_, i) => `lib/mod${i % 5}/part${i}.rs`);
    const out = filter(paths.join("\n"), "find lib -name '*.rs'");
    expect(out).not.toContain("lines omitted");
    for (const path of paths) expect(out).toContain(path);
  });

  test("on: one prose line between two paths stays itself — its marker would be no shorter", () => {
    delete process.env[FLAG];
    const head = Array.from({ length: 15 }, (_, i) => `head line ${"abcdefghijklmno"[i]}`);
    const tail = Array.from({ length: 15 }, (_, i) => `tail line ${"abcdefghijklmno"[i]}`);
    const middle = [
      "src/a.ts",
      "one lonely sentence",
      "src/b.ts",
      ...Array.from({ length: 40 }, (_, i) => `prose ${"abcdefghij"[i % 10]} number ${i}`),
    ];
    const out = filter([...head, ...middle, ...tail].join("\n"), "some-unregistered-command");
    expect(out).toContain("src/a.ts\none lonely sentence\nsrc/b.ts\n…40 lines omitted…");
  });

  test("a matched spec never gets it, and the floor gets it only with the cap", () => {
    delete process.env[FLAG];
    expect(withGenericFloor(BARE, { cap: true }).keepLines).toBeUndefined();
    expect(withGenericFloor(null, { groupMatches: true }).keepLines).toBeUndefined();
    expect(withGenericFloor(null, { cap: true }).keepLines?.max).toBe(MAX_KEPT_PATH_LINES);
    process.env[FLAG] = "0";
    expect(withGenericFloor(null, { cap: true }).keepLines).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLAUDIN_BASH_FILE_READ_PASSTHROUGH — see fileReadShape.ts
// ---------------------------------------------------------------------------

type BashFilter = typeof import("src/tools/shared/outputFilter/Bash/index.js");

const PASSTHROUGH_FLAG = "CLAUDIN_BASH_FILE_READ_PASSTHROUGH";

/**
 * The flag is read once at module load, like the cap's kill-switch, so setting
 * it here would reach nothing already loaded. Each arm gets its own instance of
 * the module, loaded with the variable set the way that arm needs it — which
 * also means the flag-off arm holds even when the developer's shell exports it.
 */
async function loadFilter(passthrough: boolean): Promise<BashFilter> {
  const prior = process.env[PASSTHROUGH_FLAG];
  if (passthrough) process.env[PASSTHROUGH_FLAG] = "1";
  else delete process.env[PASSTHROUGH_FLAG];
  try {
    return await import(
      `src/tools/shared/outputFilter/Bash/index.js?passthrough=${passthrough}-${Date.now()}`
    );
  } finally {
    if (prior === undefined) delete process.env[PASSTHROUGH_FLAG];
    else process.env[PASSTHROUGH_FLAG] = prior;
  }
}

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

/**
 * What `for f in …; do echo "=== $f"; cat -n $f; done` prints: a header per
 * file, then its lines numbered the way `cat -n` numbers them. Adjacent lines
 * differ by a word and not only by their digits, so neither collapse can fire
 * and the only stage that could shorten this is the cap.
 */
function loopOutput(files: number, linesPerFile: number, padding: number): string {
  const out: string[] = [];
  for (let f = 0; f < files; f++) {
    out.push(`=== src/file${f}.ts`);
    for (let n = 1; n <= linesPerFile; n++) {
      const word = WORDS[(n + f) % WORDS.length];
      out.push(`${String(n).padStart(6)}\texport const ${word} = '${word}${"-".repeat(padding)}'`);
    }
  }
  return `${out.join("\n")}\n`;
}

describe("CLAUDIN_BASH_FILE_READ_PASSTHROUGH — a pure file read keeps every line", () => {
  // 20260923-062408 claudindev r3, verbatim: 665 lines and 27,651 chars, of
  // which the model received 30 lines.
  const LOOP =
    'for f in src/*.ts package.json data/catalog.json data/carts/*.json; do echo "=== $f"; cat -n $f; done';
  // 19 files × (header + 34 lines) = 665 lines, either side of 28k chars.
  const UNDER = loopOutput(19, 34, 3);
  const OVER = loopOutput(19, 34, 12);

  let on: BashFilter;
  let off: BashFilter;

  beforeAll(async () => {
    on = await loadFilter(true);
    off = await loadFilter(false);
  });

  const planFor = (filter: BashFilter, command: string) =>
    filter.planBashFilter(command, { allowRewrite: false });

  test("the fixtures are the size they claim", () => {
    expect(UNDER.trimEnd().split("\n")).toHaveLength(665);
    expect(UNDER.length).toBeLessThan(28_000);
    expect(OVER.trimEnd().split("\n")).toHaveLength(665);
    expect(OVER.length).toBeGreaterThan(28_000);
  });

  // The wrapper names what the output is. The `<bash-output-filtered
  // reduction="0%">` it replaced said the filter had been through a read it
  // had left alone.
  test("under 28k chars the read comes back whole, in the read wrapper", () => {
    expect(on.applyBashFilterToStdout(UNDER, false, planFor(on, LOOP))).toBe(
      `<bash-output-read>${UNDER}</bash-output-read>`,
    );
  });

  // Above it the whole read would cross Bash's 30k result cap and be saved to a
  // file with a 2 KB preview, which is worse than the cut.
  test("over 28k chars it is still cut to 30 lines", () => {
    const out = on.applyBashFilterToStdout(OVER, false, planFor(on, LOOP));
    expect(out).toStartWith('<bash-output-filtered original="" lines="30/665"');
    // The same count the bench's rep 3 was shown for its 665 lines.
    expect(out).toContain("…636 lines omitted…");
  });

  test("with the flag off, the read is cut exactly like any other output", () => {
    const loop = off.applyBashFilterToStdout(UNDER, false, planFor(off, LOOP));
    expect(loop).toStartWith('<bash-output-filtered original="" lines="30/665"');
    expect(loop).toBe(
      off.applyBashFilterToStdout(UNDER, false, planFor(off, "some-unregistered-command")),
    );
  });

  // Under the summarizer's 8k the wrapper protects nothing from it, and it is
  // kept anyway: it is what tells the model the output is a read.
  test("under the summarizer's 8k the read comes back whole, wrapped all the same", () => {
    const small = loopOutput(4, 34, 3);
    expect(small.trimEnd().split("\n").length).toBeGreaterThan(FLOOR_CAP_LINES);
    expect(small.length).toBeLessThan(8_000);
    expect(on.applyBashFilterToStdout(small, false, planFor(on, LOOP))).toBe(
      `<bash-output-read>${small}</bash-output-read>`,
    );
    // …which the cap would have cut, flag off.
    expect(off.applyBashFilterToStdout(small, false, planFor(off, LOOP))).toStartWith(
      '<bash-output-filtered original="" lines="30/140"',
    );
  });

  test("a read the cap never reached keeps the same bytes, inside the wrapper", () => {
    const short = loopOutput(2, 20, 3);
    const offOutput = off.applyBashFilterToStdout(short, false, planFor(off, LOOP));
    // Flag off, a read this short leaves the filter untouched and bare…
    expect(offOutput).toBe(short);
    // …and flag on, those same bytes come back wrapped.
    expect(on.applyBashFilterToStdout(short, false, planFor(on, LOOP))).toBe(
      `<bash-output-read>${offOutput}</bash-output-read>`,
    );
  });

  // Python puts two blank lines between top-level definitions, a data file
  // repeats a row, a fixture holds an escape. The floor folds and strips all
  // three — a saving on a log, a corruption of a file the model will edit.
  describe("the read is the file's bytes, not the floor's", () => {
    const COMMAND = "cat src/rows.py";
    const EXACT =
      [
        "import os",
        "",
        "",
        "def a():",
        "    return 1",
        "",
        "",
        "ROWS = [",
        "    'row',",
        "    'row',",
        "    'row',",
        "]",
        "RED = '\u001b[31mred\u001b[0m'",
      ].join("\n") + "\n";

    test("flag on: blank-line runs, repeated lines and escapes all stay", () => {
      expect(on.applyBashFilterToStdout(EXACT, false, planFor(on, COMMAND))).toBe(
        `<bash-output-read>${EXACT}</bash-output-read>`,
      );
    });

    test("flag off: the floor folds and strips them, as it always has", () => {
      const floored = off.applyBashFilterToStdout(EXACT, false, planFor(off, COMMAND));
      expect(floored).not.toContain("import os\n\n\ndef a():");
      expect(floored).toContain("    'row', (×3)");
      expect(floored).not.toContain("\u001b[31m");
    });

    // A `cd` before the cat, or a head or tail in place of it, is a pure read
    // all the same (fileReadShape.ts).
    const READ_SHAPES = ["cd src && cat rows.py", "head -n 40 src/rows.py", "tail -n +1 src/rows.py"];

    test("flag on: after a cd, or through head or tail, the bytes stay too", () => {
      for (const command of READ_SHAPES) {
        expect(on.applyBashFilterToStdout(EXACT, false, planFor(on, command))).toBe(
          `<bash-output-read>${EXACT}</bash-output-read>`,
        );
      }
    });

    test("flag off: after a cd, or through head or tail, the floor folds and strips as always", () => {
      for (const command of READ_SHAPES) {
        const floored = off.applyBashFilterToStdout(EXACT, false, planFor(off, command));
        expect(floored).not.toContain("<bash-output-read>");
        expect(floored).not.toContain("import os\n\n\ndef a():");
        expect(floored).toContain("    'row', (×3)");
        expect(floored).not.toContain("\u001b[31m");
      }
    });
  });

  // The two calls of the 5-arm A/B (20260924-212723) the grammar refused and
  // the cap cut to 30 lines: a read after a `cd` (catread r5, 345 lines), and
  // one with a `head -c` among its cats (catread r2, 568 lines, 23,977 chars).
  describe("the A/B's two misses: a read after a cd, one with a head among its cats", () => {
    const CD_READ =
      "cd src && cat catalog.ts cli.ts discounts.ts errors.ts money.ts quote.ts receipt.ts";
    const HEAD_READ =
      'cat -n src/types.ts; head -c 1500 data/catalog.json; echo; cat data/carts/basic-us.json; for f in test/*.ts; do echo "=== $f"; cat -n $f; done';

    test("flag on: under 28k each comes back whole, in the read wrapper", () => {
      for (const command of [CD_READ, HEAD_READ]) {
        expect(on.applyBashFilterToStdout(UNDER, false, planFor(on, command))).toBe(
          `<bash-output-read>${UNDER}</bash-output-read>`,
        );
      }
    });

    test("flag off: each is cut to 30 lines, as the A/B's were", () => {
      for (const command of [CD_READ, HEAD_READ]) {
        expect(off.applyBashFilterToStdout(UNDER, false, planFor(off, command))).toStartWith(
          '<bash-output-filtered original="" lines="30/665"',
        );
      }
    });

    // Over 28k a read that prints part of a file keeps the cap, as one with
    // a listing does: the whole-file fit has no whole file to place for it.
    test("flag on, over 28k: still cut to 30 lines", () => {
      for (const command of [CD_READ, HEAD_READ]) {
        expect(on.applyBashFilterToStdout(OVER, false, planFor(on, command))).toStartWith(
          '<bash-output-filtered original="" lines="30/665"',
        );
      }
    });
  });

  test("with the flag on, a chain that is not a pure read is still capped", () => {
    const chain = `git status && ${LOOP}`;
    expect(on.applyBashFilterToStdout(UNDER, false, planFor(on, chain))).toStartWith(
      '<bash-output-filtered original="" lines="30/665"',
    );
  });

  // Past 28k, BashTool cuts a read that only prints files down to its whole
  // files (fitWholeFiles, BashTool/creditShownFiles.ts) before this filter
  // runs. This is what tells it to.
  describe("overBudgetFileRead — what BashTool fits to whole files", () => {
    const LOOP_READS = [
      { text: "src/*.ts", glob: true },
      { text: "package.json", glob: false },
      { text: "data/catalog.json", glob: false },
      { text: "data/carts/*.json", glob: true },
    ];

    test("a read that only prints files, over 28k: the files it names", () => {
      expect(on.overBudgetFileRead(OVER, planFor(on, LOOP), false)).toEqual(LOOP_READS);
    });

    test("under 28k there is nothing to fit — the pass-through shows it whole", () => {
      expect(on.overBudgetFileRead(UNDER, planFor(on, LOOP), false)).toBeNull();
    });

    // A spill leaves stdout holding the first 30 KB, whatever its length in chars.
    test("spilled to disk, at any length", () => {
      expect(on.overBudgetFileRead(UNDER, planFor(on, LOOP), true)).toEqual(LOOP_READS);
    });

    test("a read with a listing segment keeps the cap", () => {
      for (const command of [`ls -R .claudin; ${LOOP}`, `git ls-files && ${LOOP}`, `wc -l src/*.ts; ${LOOP}`]) {
        expect(on.overBudgetFileRead(OVER, planFor(on, command), true)).toBeNull();
      }
    });

    test("a command that is not a pure read", () => {
      expect(on.overBudgetFileRead(OVER, planFor(on, `git status && ${LOOP}`), true)).toBeNull();
    });

    // Part of a file is no whole file to fit: a head or tail keeps the cap.
    test("a read with a head or tail segment keeps the cap", () => {
      for (const command of [`head -c 1500 data/catalog.json; echo; ${LOOP}`, `${LOOP}; tail -n 5 README.md`]) {
        expect(on.overBudgetFileRead(OVER, planFor(on, command), true)).toBeNull();
      }
    });

    // BashTool resolves each word from where the command started, through
    // the directory the `cd` names.
    test("after a cd, the files it names carry the cd's directory", () => {
      expect(on.overBudgetFileRead(OVER, planFor(on, `cd pkg && ${LOOP}`), false)).toEqual(
        LOOP_READS.map((word) => ({ ...word, dir: "pkg" })),
      );
    });

    test("with the flag off, never", () => {
      expect(off.overBudgetFileRead(OVER, planFor(off, LOOP), false)).toBeNull();
      expect(off.overBudgetFileRead(OVER, planFor(off, LOOP), true)).toBeNull();
    });
  });

  test("with the flag on, a command that is not a pure read does not change", () => {
    const command = "some-unregistered-command";
    expect(on.applyBashFilterToStdout(UNDER, false, planFor(on, command))).toBe(
      off.applyBashFilterToStdout(UNDER, false, planFor(off, command)),
    );
  });

  // The reason the wrapper stays when nothing was cut. Uncapping these reads
  // WITHOUT it measured +79% tool-result chars and +19% cost in the same bench:
  // a 11-28 KB loop crossed the 8k Bash threshold, came back as a
  // `<tool-result-summary>` with a saved file, and the model read that again.
  describe("the wrapper keeps the tool-result summarizer away", () => {
    let savedEnabled: boolean;
    let savedKillSwitch: string | undefined;

    beforeEach(() => {
      savedEnabled = getGlobalConfig().toolResultSummarizerEnabled;
      saveGlobalConfig((c) => ({ ...c, toolResultSummarizerEnabled: true }));
      savedKillSwitch = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
      delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
    });

    afterEach(() => {
      saveGlobalConfig((c) => ({ ...c, toolResultSummarizerEnabled: savedEnabled }));
      if (savedKillSwitch === undefined) delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
      else process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = savedKillSwitch;
    });

    test("a wrapped 20k read passes through untouched", () => {
      const raw = loopOutput(15, 34, 3);
      expect(raw.length).toBeGreaterThan(20_000);
      const content = on.applyBashFilterToStdout(raw, false, planFor(on, LOOP));
      expect(stripOutputMarkers(content)).toBe(raw);

      const block: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: "toolu_passthrough",
        content,
      };
      expect(maybeSummarizeToolResult(block, BASH_TOOL_NAME)).toBe(block);

      // The control that keeps this from being a tautology: the same body
      // without the wrapper is over the threshold, and it IS summarized.
      const bare: ToolResultBlockParam = { ...block, content: raw.trimEnd() };
      expect(String(maybeSummarizeToolResult(bare, BASH_TOOL_NAME).content)).toStartWith(
        "<tool-result-summary",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// CLAUDIN_CAP_KEEP_BOUNDED — see lineBound.ts
// ---------------------------------------------------------------------------

/**
 * `count` lines of source as `sed -n` or `grep -n` would print them. Adjacent
 * lines differ by a word, not only by their digits, so neither collapse can
 * fire: the only stage that could shorten this is the cap.
 */
function sourceLines(count: number, width = 40, prefix = ""): string {
  return `${Array.from({ length: count }, (_, i) => {
    const word = WORDS[i % WORDS.length];
    return `${prefix}export const ${word}${i} = '${word}${"-".repeat(width)}'`;
  }).join("\n")}\n`;
}

describe("CLAUDIN_CAP_KEEP_BOUNDED — a read the command bounded keeps every line", () => {
  const FLAG = "CLAUDIN_CAP_KEEP_BOUNDED";
  // 90 lines: inside the band where the corpus saw the re-reads (61-100).
  const RANGE = "sed -n 40,129p src/permissions/permissions.ts";
  const BODY = sourceLines(90);
  let savedFlag: string | undefined;
  let savedCap: boolean | undefined;

  const filter = (body: string, command: string): string =>
    applyBashFilterToStdout(body, false, planBashFilter(command, { allowRewrite: false }));

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    delete process.env[FLAG];
    savedCap = getGlobalConfig().bashOutputFilterCapEnabled;
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: true }));
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: savedCap }));
  });

  test("the fixture is the size it claims, and on by default", () => {
    expect(BODY.trimEnd().split("\n")).toHaveLength(90);
    expect(isCapKeepBoundedEnabled()).toBe(true);
  });

  test("a range read comes back whole, byte for byte, in the read wrapper", () => {
    expect(filter(BODY, RANGE)).toBe(`<bash-output-read>${BODY}</bash-output-read>`);
  });

  test("a search into a bound comes back whole too, its path prefixes not hoisted", () => {
    const hits = sourceLines(90, 20, "src/permissions/permissions.ts:");
    const command = 'grep -n "export const" src/permissions/permissions.ts | head -90';
    expect(filter(hits, command)).toBe(`<bash-output-read>${hits}</bash-output-read>`);
  });

  // The surviving surface: the rule must not become "90 lines of anything".
  test.each([
    ["a whole file", "cat src/permissions/permissions.ts"],
    ["any other producer into a bound", "bun test | head -100"],
    ["a listing and a file", "git ls-files && cat README.md"],
    ["a range read beside an unbounded one", `${RANGE}; cat src/a.ts`],
  ])("the same 90 lines from %s are still cut", (_, command) => {
    const out = filter(BODY, command);
    expect(out).toContain("lines omitted");
    expect(out).not.toStartWith("<bash-output-read>");
  });

  test("=0: the plain cut", () => {
    process.env[FLAG] = "0";
    expect(isCapKeepBoundedEnabled()).toBe(false);
    expect(filter(BODY, RANGE)).toContain("lines omitted");
  });

  test("a bound past the ceiling takes the cut, however little it printed", () => {
    expect(filter(BODY, `sed -n 40,${40 + BOUNDED_READ_MAX_LINES}p src/permissions/permissions.ts`)).toContain(
      "lines omitted",
    );
    expect(filter(BODY, `sed -n 40,${39 + BOUNDED_READ_MAX_LINES}p src/permissions/permissions.ts`)).toStartWith(
      "<bash-output-read>",
    );
  });

  test("the printed lines are held to the ceiling too, not only the declaration", () => {
    const over = sourceLines(BOUNDED_READ_MAX_LINES + 1);
    expect(filter(over, "sed -n 1,100p src/a.ts; echo done")).toContain("lines omitted");
  });

  test("past the pass-through's 28k chars, the cut — Bash would persist it", () => {
    const wide = sourceLines(120, 240);
    expect(wide.length).toBeGreaterThan(28_000);
    expect(filter(wide, "sed -n 1,120p src/a.ts")).toContain("lines omitted");
  });

  test("where the cap would not cut, nothing changes", () => {
    const short = sourceLines(FLOOR_CAP_LINES - 10);
    const on = filter(short, RANGE);
    process.env[FLAG] = "0";
    expect(on).toBe(filter(short, RANGE));
    expect(on).not.toStartWith("<bash-output-read>");
  });

  test("with the cap off, there is no cut to spare it from", () => {
    saveGlobalConfig((c) => ({ ...c, bashOutputFilterCapEnabled: false }));
    const out = filter(BODY, RANGE);
    expect(out).not.toStartWith("<bash-output-read>");
    expect(out).not.toContain("lines omitted");
  });

  test("a structured body is not the cap's, so not this rule's", () => {
    const json = `[\n${sourceLines(90).trimEnd().split("\n").map((l) => `  ${JSON.stringify(l)},`).join("\n")}\n]\n`;
    expect(filter(json, "sed -n 1,92p data.json")).not.toStartWith("<bash-output-read>");
  });

  test("a matched spec keeps its own say", () => {
    const plan = { ...planBashFilter(RANGE, { allowRewrite: false }), filter: BARE };
    expect(applyBashFilterToStdout(BODY, false, plan)).not.toStartWith("<bash-output-read>");
  });

  test("a caller that budgets the result itself gets it unwrapped", () => {
    const plan = planBashFilter(RANGE, { allowRewrite: false, callerBudgets: true });
    expect(applyBashFilterToStdout(BODY, false, plan)).not.toStartWith("<bash-output-read>");
  });

  test("a failing command keeps the error floor", () => {
    const plan = planBashFilter(RANGE, { allowRewrite: false });
    expect(applyBashFilterToStdout(BODY, true, plan)).not.toContain("<bash-output-read>");
  });

  describe("the wrapper keeps the tool-result summarizer away", () => {
    let savedEnabled: boolean;
    let savedKillSwitch: string | undefined;

    beforeEach(() => {
      savedEnabled = getGlobalConfig().toolResultSummarizerEnabled;
      saveGlobalConfig((c) => ({ ...c, toolResultSummarizerEnabled: true }));
      savedKillSwitch = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
      delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
    });

    afterEach(() => {
      saveGlobalConfig((c) => ({ ...c, toolResultSummarizerEnabled: savedEnabled }));
      if (savedKillSwitch === undefined) delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER;
      else process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = savedKillSwitch;
    });

    test("a 140-line range past the 8k threshold reaches the model whole", () => {
      const raw = sourceLines(140);
      expect(raw.length).toBeGreaterThan(8_000);
      const content = filter(raw, "sed -n 1,140p src/a.ts");
      const block: ToolResultBlockParam = { type: "tool_result", tool_use_id: "toolu_bounded", content };
      expect(maybeSummarizeToolResult(block, BASH_TOOL_NAME)).toBe(block);
      expect(stripOutputMarkers(content)).toBe(raw);

      // Not a tautology: the same body without the wrapper IS summarized.
      const bare: ToolResultBlockParam = { ...block, content: raw.trimEnd() };
      expect(String(maybeSummarizeToolResult(bare, BASH_TOOL_NAME).content)).toStartWith("<tool-result-summary");
    });
  });
});
