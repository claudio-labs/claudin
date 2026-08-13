---
name: search-stack-measured
description: Measured 2026-08-12 — text/file search is best-in-class ripgrep, but symbol/method search is the weak axis (uncached regex scanner, no repo-wide "where is X defined", LSPTool unavailable by default)
type: project
---

Benchmarked on this repo (`src/`, 3,281 files, 26.9 MB, warm page cache, median of 5,
ripgrep 15.2.0). Three search axes, three different verdicts.

**Text/content — best in class, nothing to do.** Literal pattern: rg 8 ms, git grep
14 ms, grep -rn 28 ms. Regex `async function \w+\(`: rg 11 ms, grep -rnE 30 ms,
git grep -nE 48 ms. Nested quantifier `(\w+\s*)+=>`: **rg 14 ms vs grep -rnE 193 ms**
— that 14× is the finite-automata-vs-backtracking difference showing up on a real
corpus, and it is the reason not to reach for a JS regex fallback. Both Grep and Glob
spawn the real `rg` binary; there is no JS fallback and no glob library.

**File listing — fine.** `rg --files` 6 ms, `find -type f` 5 ms. `--sortr=modified`
(what GlobTool actually uses) costs 15 ms because it stats everything; that 2.5× is
worth it since it is what makes a truncated 100-path list useful.

**Symbol/method — the weak axis.** `scanSymbols` throughput is ~22 KB/ms and it has
**no cache of any kind** (pure function, re-reads and re-scans on every Grep
symbols call, every Read outline, every Rename). GrepTool symbols mode caps at 50
files and reads each whole: measured 17.8 ms on 50 random files, **188 ms on the 50
largest** — repeated identically on the next call. RenameTool's `discoveryMemo`
(60 s TTL, mtime+size stamps) is the only memo and is Rename-only.

**Why:** the real gap is not speed, it is that no tool answers "where is symbol X
defined" repo-wide. Read's `symbol=` is file-scoped (`file_path` required).
Grep `output_mode:"symbols"` takes a *text pattern* and returns each match's
enclosing symbol — it answers "what contains this text", not "where is X". LSPTool
has `goToDefinition`/`findReferences`/`workspaceSymbol`, but servers come
**exclusively from enabled plugins** with no built-in registry
(`src/services/lsp/config.ts:48-51`), so for a default user the tool is permanently
present and permanently returns `LSP_UNAVAILABLE_MESSAGE`. `workspaceSymbol` also
requires a `filePath` anyway. The accidental best repo-wide identifier lookup is
`Rename mode:"preview"` — a rename tool used as a query.

**How to apply:** don't optimize the ripgrep layer, it is already optimal. Before
proposing a symbol *index*, re-read [[repo-map-rejected-orientation-measured]] and
[[code-review-graph-evaluated-rejected]] — both index-shaped ideas were rejected on
measured data, so the bar is a measurement, not an argument.

**CORRECTION 2026-08-12, same day.** This memory originally named two candidates —
an mtime-keyed scanSymbols cache, and a first-class definition lookup. A census of
528 transcripts / 280 sessions killed both, and found the real defect. See
[[outline-blind-to-nested-members]]: the cache has no work to do (the 60 s
tool-result cache already absorbs all but 5.5% of repeat scans), LSPTool is the
wrong surface (0 calls ever, and it is
a *deferred* tool), and a definition lookup built on today's scanner returns "no
definition" for 35 of the 60 most-grepped identifiers because the scanner cannot see
object-literal members or anything nested.

Known scanner limits (from code + tests, all fail-open so a failure is
indistinguishable from "no symbols"): nested declarations dropped **by design**
(emit only at `depth === 0`), methods only at `depth >= 1`, generics cut by
`/<.*$/`, TS overload signatures survive as duplicates, Elixir and PowerShell return
`[]`. The `export const fn = () =>` blind spot that
[[code-review-graph-evaluated-rejected]] found in *their* parser is **not** present
here — `RE_CONST` handles it and `scanSymbols.test.ts:157-172` pins it.
