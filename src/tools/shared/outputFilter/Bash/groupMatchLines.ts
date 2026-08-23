/**
 * Hoists the repeated `path:` prefix out of grep/ripgrep-shaped output.
 *
 *   src/a.ts:12:const x = 1          src/a.ts
 *   src/a.ts:40:const y = 2    →     12:const x = 1
 *   src/b.ts:7:const z = 3           40:const y = 2
 *                                    src/b.ts
 *                                    7:const z = 3
 *
 * Nothing is lost: every match line survives, in its original order, and which
 * file it belongs to is still on screen. That is what earns it a place among the
 * lossless stages rather than beside the cap.
 *
 * ## Why it is triggered by the OUTPUT and not by the command
 *
 * The obvious home for this is the `grep-rg` spec, and that is where it is
 * worth almost nothing. `scripts/bench/tokens/measure-bash-filter-replay.test.ts`
 * computes the reason on its `grep-rg routing` line rather than asserting it
 * here: over 19,060 recorded Bash calls, 690 route to `grep-rg` and **75.2% of
 * them print no `path:` prefix at all** — a grep of a single file, or of piped
 * stdin, has nothing to hoist — which leaves the arm at 0.14%. (This comment
 * used to claim 83%, from a count nothing reproduced; the replay says 75.2%.)
 * The traffic that does carry prefixes arrives as `cmd | grep foo` and
 * `cd x && rg …`, which the registry bypasses by construction. So the trigger
 * has to be the shape of the body. Sized that way, and counted MARGINALLY over
 * what the floor and the cap already take, it is worth 0.7% across 225 results.
 *
 * ## Why the accept test is this strict, and why it is only two checks
 *
 * A reshape that fires on output it misread is worse than one that never fires,
 * so this declines on the first line it cannot account for rather than grouping
 * what it recognised and passing the rest through. Past that it declines when
 * there is nothing to win: fewer than two files, or no file with more than one
 * match.
 *
 * A third check — "decline unless the result came out shorter" — was written and
 * then removed, because it can never fire. Grouping a file with `n` matches on a
 * path of length `p` removes `n × (p + 1)` characters and adds back `p + 1` for
 * the header, so it saves `(n − 1) × (p + 1)`: strictly positive whenever some
 * file repeats, and exactly zero when none does, which the repeat check already
 * refuses. A guard that cannot fire is a comment that can go stale without
 * anything failing; the arithmetic is pinned by a test instead.
 */

/**
 * `path:line:text` for a match, `path-line-text` for a context line — ripgrep
 * uses the dash on BOTH sides of the line number, so the leading separator has
 * to be part of the pattern rather than assumed to be a colon.
 *
 * One line can offer more than one reading of where the path ends, and taking
 * the shortest is wrong. `docs/rfc-7231-headers.md:42:Accept` splits at `-7231-`
 * as readily as at `:42:`, and the shortest reading hands the model the file
 * `docs/rfc` at line 7231 — a citation to somewhere that does not exist, which
 * is worse than declining. So every reading is enumerated and one is chosen.
 */
const SEPARATOR_RE = /[:-](\d+)[:-]/g;

type Reading = { path: string; colon: boolean; rest: string };

/** Every position where this line could split into `path`, line number, text. */
function readingsOf(line: string): Reading[] {
  const out: Reading[] = [];
  SEPARATOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEPARATOR_RE.exec(line)) !== null) {
    const path = line.slice(0, m.index);
    if (path !== "") {
      out.push({
        path,
        colon: line[m.index] === ":",
        rest: line.slice(m.index + 1),
      });
    }
    // Overlapping readings matter: `a-1-b-2-c` offers both.
    SEPARATOR_RE.lastIndex = m.index + 1;
  }
  return out;
}

/**
 * Which reading to believe, in order:
 *
 * 1. a path some earlier line already established — ripgrep prints every hit in
 *    a file under the same name, so agreement is strong evidence;
 * 2. the first reading whose separator is a COLON, because that is the form
 *    ripgrep uses for a match line and a dash inside a filename cannot produce
 *    one (`docs/rfc-7231-headers.md:42:` splits at the colon, not the dash);
 * 3. the first reading, for a context line that opens the body before any match
 *    line has named its file.
 */
function chooseReading(
  line: string,
  seen: ReadonlyMap<string, string[]>,
): Reading | null {
  const readings = readingsOf(line);
  if (readings.length === 0) return null;
  return (
    readings.find(r => seen.has(r.path)) ??
    readings.find(r => r.colon) ??
    readings[0] ??
    null
  );
}

export function groupMatchLines(body: string): string | null {
  const order: string[] = [];
  const byFile = new Map<string, string[]>();

  for (const line of body.split("\n")) {
    if (line === "") continue;
    const reading = chooseReading(line, byFile);
    if (!reading) return null;
    const path = reading.path;
    let matches = byFile.get(path);
    if (!matches) {
      matches = [];
      byFile.set(path, matches);
      order.push(path);
    }
    matches.push(reading.rest);
  }

  if (order.length < 2) return null;
  if (!order.some(path => (byFile.get(path)?.length ?? 0) > 1)) return null;

  return order
    .map(path => [path, ...(byFile.get(path) ?? [])].join("\n"))
    .join("\n");
}
