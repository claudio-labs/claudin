/**
 * What a cut of Bash output keeps besides its head and tail: the lines around
 * the errors in it — the floor's one cut (`floor.ts`, `CLAUDIN_BASH_ONE_CUT`),
 * the only cut Bash output gets, so a failure in the middle of a long log
 * survives it. The windows are the ones the tool-result summarizer kept before
 * it stopped cutting (2026-10-10).
 */

/** Lines kept before and after each error line, as the summarizer did. */
export const ERROR_WINDOW_BEFORE = 5;
export const ERROR_WINDOW_AFTER = 10;

// Two-pass error detection. Split into two regexes so case-sensitive anchors
// (line-anchored `Exit code:`, all-caps `FAIL`/`FATAL` log markers that we
// don't want matching common words like "email"/"email failure") stay rigid
// while the primary error tokens are case-insensitive.
//
// Strict pass — case-sensitive, anchor-bearing:
// - `^Exit code: N$` requires the /m flag and a non-zero numeric code.
// - `\bFAIL(?:ED)?\b` stays uppercase-only to avoid matching "fail" inside
//   compound English (it's rare to see standalone "FAIL" outside CI logs).
// - `\bFATAL\b` (no colon) catches log4j-style level markers (`[FATAL]`,
//   `FATAL com.foo.Bar - oops`) which routinely appear without a colon.
const ERROR_REGEX_STRICT = /^Exit code: [1-9]\d*$|\bFAIL(?:ED)?\b|\bFATAL\b/m;

// Loose pass — case-insensitive, with deliberate FP-reduction shape.
// - `\b(?:error|exception|fatal|panic)(?:\[[^\]]+\])?:` requires `:` directly
//   after the token (or after an optional `[CODE]` block, e.g. Rust's
//   `error[E0308]:`). This drops "Graceful Exception handler installed" and
//   "no errors found" while keeping `gcc error:`, `cargo build` errors, and
//   server `ERROR:` log lines.
// - `Traceback \(most recent call last\):` is the canonical Python prefix.
// - `panicked at` covers Rust runtime panics
//   (`thread 'main' panicked at 'msg'`).
// - `undefined reference to` covers linker errors.
const ERROR_REGEX_LOOSE =
  /\b(?:error|exception|fatal|panic)(?:\[[^\]]+\])?:|Traceback \(most recent call last\):|panicked at|undefined reference to/i;

/** The first and last error lines, by index: two windows at most, so a log of errors cannot keep itself whole. */
export function findErrorIndices(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (ERROR_REGEX_STRICT.test(line) || ERROR_REGEX_LOOSE.test(line)) {
      out.push(i);
    }
  }
  if (out.length <= 2) return out;
  return [out[0]!, out[out.length - 1]!];
}

/** Which lines fall inside an error window. */
export function errorWindowMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  for (const idx of findErrorIndices(lines)) {
    const from = Math.max(0, idx - ERROR_WINDOW_BEFORE);
    const to = Math.min(lines.length, idx + ERROR_WINDOW_AFTER + 1);
    for (let i = from; i < to; i++) mask[i] = true;
  }
  return mask;
}
