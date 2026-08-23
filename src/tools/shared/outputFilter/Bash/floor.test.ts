import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getGlobalConfig, saveGlobalConfig } from "src/platform/config/config.js";
import {
  applyBashFilterToStdout,
  planBashFilter,
} from "src/tools/shared/outputFilter/Bash/index.js";
import {
  FLOOR_CAP_LINES,
  GENERIC_FLOOR,
  isCappableBody,
  isFloorCapEnabled,
  looksLikeDiagnostics,
  looksLikeLocationList,
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
