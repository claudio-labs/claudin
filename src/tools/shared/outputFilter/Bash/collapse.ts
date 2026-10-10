/**
 * The two line collapses the floor runs (`pipeline.ts`, `collapseRuns` and
 * `collapseDigitTemplates`). They lived with the tool-result summarizer's Bash
 * arm, which no longer exists; the filter is their only user.
 */

export function collapseIdenticalRuns(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const out: string[] = [];
  let runLine = lines[0] ?? "";
  let runCount = 1;
  // Annotate a collapsed run with ` (×N)` — EXCEPT a run of blank/whitespace-only
  // lines, which collapses to a single blank line with no marker. A ` (×N)` count
  // on a blank run is never useful and is actively harmful to downstream
  // line-oriented filters: the resulting ` (×N)` line is non-blank, so it both
  // survives a `/^\s*$/` strip rule and prevents `onEmpty` from firing (the Bash
  // output-filter pipeline runs collapseRuns before stripLinesMatching/onEmpty).
  const emit = (line: string, count: number) =>
    out.push(count > 1 && line.trim() !== "" ? `${line} (×${count})` : line);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === runLine) {
      runCount++;
      continue;
    }
    emit(runLine, runCount);
    runLine = line;
    runCount = 1;
  }
  emit(runLine, runCount);
  return out;
}

// Collapse runs of lines that only differ by digits. Only collapses runs of
// DIGIT_TEMPLATE_MIN_RUN or more so legitimate line-numbered logs survive
// (e.g. consecutive `line 1`/`line 2` debug output); aggressive enough to
// catch progress bars / percentage dumps / tick counters.
const DIGIT_TEMPLATE_MIN_RUN = 5;

export function collapseDigitTemplates(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const out: string[] = [];
  let template: string | null = null;
  let runStart = 0;
  let runCount = 0;

  const emitRun = (endExclusive: number) => {
    if (runCount >= DIGIT_TEMPLATE_MIN_RUN) {
      // One sample line + count marker.
      out.push(`${lines[runStart] ?? ""} (${runCount} updates)`);
    } else {
      // Preserve each line as-is.
      for (let i = runStart; i < endExclusive; i++) {
        out.push(lines[i] ?? "");
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.replace(/\d+/g, "#");
    if (template !== null && t === template) {
      runCount++;
      continue;
    }
    if (template !== null) emitRun(i);
    template = t;
    runStart = i;
    runCount = 1;
  }
  if (template !== null) emitRun(lines.length);
  return out;
}
