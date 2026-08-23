import { describe, expect, test } from "bun:test";
import { groupMatchLines } from "src/tools/shared/outputFilter/Bash/groupMatchLines.js";

const GREP = [
  "src/a.ts:12:const x = 1",
  "src/a.ts:40:const y = 2",
  "src/b.ts:7:const z = 3",
  "",
].join("\n");

describe("groupMatchLines", () => {
  test("hoists the repeated path and keeps every match in order", () => {
    expect(groupMatchLines(GREP)).toBe(
      ["src/a.ts", "12:const x = 1", "40:const y = 2", "src/b.ts", "7:const z = 3"].join(
        "\n",
      ),
    );
  });

  test("keeps ripgrep's context lines, separator and all", () => {
    const raw = [
      "src/a.ts-11-// leading context",
      "src/a.ts:12:const x = 1",
      "src/a.ts-13-// trailing context",
      "src/b.ts:7:const z = 3",
    ].join("\n");
    const out = groupMatchLines(raw);
    expect(out).toContain("11-// leading context");
    expect(out).toContain("12:const x = 1");
    expect(out).toContain("13-// trailing context");
  });

  // The lazy path capture slides past the drive letter's colon, which is not
  // followed by digits — so this needs no special case, only a test saying so.
  test("groups a Windows path by its whole drive-qualified name", () => {
    const raw = [
      "C:\\src\\a.ts:12:const x = 1",
      "C:\\src\\a.ts:40:const y = 2",
      "C:\\src\\b.ts:7:const z = 3",
    ].join("\n");
    expect(groupMatchLines(raw)).toBe(
      [
        "C:\\src\\a.ts",
        "12:const x = 1",
        "40:const y = 2",
        "C:\\src\\b.ts",
        "7:const z = 3",
      ].join("\n"),
    );
  });

  test("a path containing a dash is not split at the dash", () => {
    const raw = [
      "src/my-file.ts:12:const x = 1",
      "src/my-file.ts:40:const y = 2",
      "src/other.ts:7:const z = 3",
    ].join("\n");
    expect(groupMatchLines(raw)).toContain("src/my-file.ts\n12:const x = 1");
  });

  // The dash case above passes for a reason that does NOT generalise: `file` is
  // not digits, so there was only ever one reading. Put digits between the
  // dashes and the shortest reading becomes `docs/rfc` at line 7231 — a citation
  // to a file that does not exist. Found by review; the colon preference is what
  // fixes it, so deleting that line fails this test.
  test("a filename with a dash-wrapped NUMBER still groups by the whole name", () => {
    const raw = [
      "docs/rfc-7231-headers.md:42:Accept",
      "docs/rfc-7231-headers.md:99:Accept-Encoding",
      "src/http.ts:7:Accept",
    ].join("\n");
    expect(groupMatchLines(raw)).toBe(
      [
        "docs/rfc-7231-headers.md",
        "42:Accept",
        "99:Accept-Encoding",
        "src/http.ts",
        "7:Accept",
      ].join("\n"),
    );
  });

  // A context line has no colon to prefer, so the tie is broken by a path an
  // earlier line already established.
  test("a context line follows the file its match line named", () => {
    const raw = [
      "docs/rfc-7231-headers.md:42:Accept",
      "docs/rfc-7231-headers.md-43-Accept-Charset",
      "src/http.ts:7:Accept",
      "src/http.ts:9:Accept",
    ].join("\n");
    const out = groupMatchLines(raw);
    expect(out).toContain("docs/rfc-7231-headers.md\n42:Accept\n43-Accept-Charset");
    expect(out).not.toContain("docs/rfc\n");
  });

  test("file order and match order both follow the input", () => {
    const raw = [
      "z.ts:9:third file first",
      "a.ts:2:second file",
      "a.ts:1:out of numeric order on purpose",
      "z.ts:1:back to the first file",
    ].join("\n");
    expect(groupMatchLines(raw)).toBe(
      [
        "z.ts",
        "9:third file first",
        "1:back to the first file",
        "a.ts",
        "2:second file",
        "1:out of numeric order on purpose",
      ].join("\n"),
    );
  });

  describe("declines", () => {
    // Anything unaccounted for aborts the whole reshape: grouping what was
    // recognised and passing the rest through would move lines past each other.
    test("on a line that is not a match line", () => {
      expect(groupMatchLines(`${GREP}Binary file src/c.bin matches\n`)).toBeNull();
    });

    // Each of the two remaining guards gets an input the OTHER one accepts, so
    // deleting either is caught. An earlier version had three guards and three
    // inputs that any of them would have refused, so two of the three were dead
    // and the tests said nothing.
    test("with only one file, however many matches", () => {
      expect(groupMatchLines("a.ts:1:x\na.ts:2:y\na.ts:3:z")).toBeNull();
    });

    test("when no file repeats — there is no prefix to hoist", () => {
      expect(groupMatchLines("a.ts:1:x\nb.ts:2:y\nc.ts:3:z")).toBeNull();
    });

    test("on JSON, which has colons but no line numbers after them", () => {
      expect(groupMatchLines('{\n  "key_0": 0,\n  "key_1": 1\n}')).toBeNull();
    });

    test("on an empty body", () => {
      expect(groupMatchLines("")).toBeNull();
    });
  });

  // The reason there is no "decline unless it came out shorter" guard: with a
  // repeated path the arithmetic makes that impossible. Pinned over the shortest
  // paths and the smallest repeats, where the margin is thinnest.
  test("an accepted body is always strictly shorter", () => {
    for (const raw of [
      "a:1:x\na:2:y\nb:3:z",
      "a:1:\na:2:\nb:3:",
      ["a:1:x", "a:2:y", "bb:3:z", "bb:4:w"].join("\n"),
      GREP,
    ]) {
      const out = groupMatchLines(raw);
      expect(out).not.toBeNull();
      expect((out ?? "").length).toBeLessThan(raw.length);
    }
  });
});
