---
name: census
description: Run the committed session censuses over a date window (requests, re-reads, Bash cuts, spend) and report what is new against the last census in team memory.
allowed-tools: Bash, Read, Grep
argument-hint: "<since YYYY-MM-DD> [--exclude=<session-prefix>]"
arguments: since
---

# /census — session census over a window

Measure how recorded sessions used tools since `$since`. The scripts are
committed; do not rebuild them in the scratchpad. Each one's header documents
its labels.

## Steps

1. **Exclude this session.** Its transcript grows while the census runs. Pass
   it to the three scripts that take it: `--exclude-session=<session id>` to the
   request census, `--exclude=<first 8 chars of the id>` to the re-read census,
   and `--exclude=<session id>` to the feature-usage census. Benches under
   `/tmp` are already left out.
2. **Run the five in one response**, each into the scratchpad. None of them
   writes to the tree.
   - `NODE_ENV=test bun --preload ./src/stubs/test-preload.ts scripts/bench/tokens/request-census.ts --since=$since --exclude-session=…`
     answers which requests could have shared an earlier response, by lever.
   - `bun scripts/bench/tokens/reread-census.ts --since=$since --exclude=…`
     answers which files were read again and why: auto or asked outline, Bash
     cut, duplicate, paging.
   - `NODE_ENV=test bun --preload ./src/stubs/test-preload.ts scripts/bench/tokens/cut-refetch-census.ts --since=$since --lane`
     answers whether the Bash filter's cuts cost re-runs, and which cut shapes
     the read lane would now pass.
   - `bun scripts/bench/tokens/session-census.ts --since=$since` answers the
     spend, the cache drops and the tool errors.
   - `bun scripts/bench/tokens/feature-usage-census.ts --since=$since --exclude=… --project=<slug>`,
     once per directory under `~/.claudin/projects/`, answers how Grep and Read were shaped, the
     Grep globs with a `/` that came back empty, and the WaitFor re-polls.
3. **Compare with the last census.** Find it with
   `Grep(pattern: "census-", path: ".claudin/memory/team/")` and read it before
   calling anything new. A number with no baseline is a measurement, not a
   change.
4. **Report** in this order, one line each with its denominator:
   - re-reads by cause;
   - mergeable requests;
   - Bash cuts and what followed them;
   - WaitFor re-polls and empty slash-glob Greps;
   - tool errors;
   - cache.

   Then name candidate fixes with file:line. Leave undecided candidates out of
   team memory; they belong in the answer.

## Traps

- `request-census.ts` bounds sessions by file mtime, so a session active in the
  window counts whole. `reread-census.ts` bounds records by timestamp, so the
  two totals differ.
- `feature-usage-census.ts` walks only the project of the cwd unless
  `--project` names another, and `--until` defaults to today.
- Sub-agent transcripts carry no `toolUseResult`. The re-read census reads
  ranges off the `N→` line numbers. Any new counter must do the same, or it
  will count every follow-up Read as a duplicate.
- Pair `tool_use` with `tool_result` by id. A grep over the corpus overcounts
  about 3x (team memory `session-corpus-census-inflation`).
