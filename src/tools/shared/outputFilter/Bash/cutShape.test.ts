import { describe, expect, test } from "bun:test";
import {
  ERROR_WINDOW_AFTER,
  ERROR_WINDOW_BEFORE,
  errorWindowMask,
  findErrorIndices,
} from "src/tools/shared/outputFilter/Bash/cutShape.js";

const lines = (count: number, at: Record<number, string> = {}): string[] =>
  Array.from({ length: count }, (_, i) => at[i] ?? `step ${i} ok`);

describe("findErrorIndices", () => {
  test("finds the strict and the loose markers, and nothing in ordinary prose", () => {
    const log = lines(10, { 2: "Exit code: 2", 5: "error[E0308]: mismatched types", 7: "no errors found" });
    expect(findErrorIndices(log)).toEqual([2, 5]);
  });

  test("keeps only the first and the last of many", () => {
    const log = lines(10, { 1: "FAIL a", 4: "FAIL b", 8: "FAIL c" });
    expect(findErrorIndices(log)).toEqual([1, 8]);
  });
});

describe("errorWindowMask", () => {
  test("marks the window around each error, clipped to the output", () => {
    const log = lines(100, { 50: "error: x is not a function" });
    const mask = errorWindowMask(log);
    expect(mask.filter(Boolean)).toHaveLength(ERROR_WINDOW_BEFORE + 1 + ERROR_WINDOW_AFTER);
    expect(mask[50 - ERROR_WINDOW_BEFORE]).toBe(true);
    expect(mask[50 - ERROR_WINDOW_BEFORE - 1]).toBe(false);
    expect(mask[50 + ERROR_WINDOW_AFTER]).toBe(true);
    expect(mask[50 + ERROR_WINDOW_AFTER + 1]).toBe(false);
    expect(errorWindowMask(lines(3, { 0: "FATAL boom" })).every(Boolean)).toBe(true);
  });

  test("a clean log marks nothing", () => {
    expect(errorWindowMask(lines(50)).some(Boolean)).toBe(false);
  });
});
