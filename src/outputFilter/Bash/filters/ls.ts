// ls -la filter: collapse long entries to "[d] name" / "[f] name" / "[l] name".
//
// A coding agent almost never needs the uid/gid/size/mtime columns — the
// filename + type is the signal. We also keep the `total N` header intact
// because it's one line and occasionally useful.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// Matches `ls -l` / `ls -la` / `ls -al` / `ls -lah` etc. We don't want to
// touch plain `ls` (no long-format output) or `ls -1` (already compact).
const LS_LA_MATCH = /^ls\s+-[A-Za-z]*l[A-Za-z]*a[A-Za-z]*\b|^ls\s+-[A-Za-z]*a[A-Za-z]*l[A-Za-z]*\b/
// Passthrough when the user asked for machine-readable output.
const LS_LA_PASSTHROUGH = /--(?:color=always|classify|indicator-style)\b/

// Long-format row. Group 1 captures the entry type letter (d, -, l, b, c, p, s);
// group 2 captures the filename, possibly with " -> target" for symlinks.
//   drwxr-xr-x 1 dev dev    680 May  5 14:20 name
//   ^type      ^nlink  ^user    ^grp  ^size ^month ^day ^time ^name
// `gm` flags required: `g` so every line is replaced (not just the first),
// and `m` so `^`/`$` anchor per line inside a multi-line input.
const LS_LA_LINE =
  /^([-dlbcps])[rwxSstTuagLM+-]{9,11}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/gm

export const lsLa: FilterSpec = {
  name: 'ls-la',
  matchCommand: LS_LA_MATCH,
  matchCommandReject: LS_LA_PASSTHROUGH,
  replace: [
    {
      pattern: LS_LA_LINE,
      // $1 = type glyph, $2 = filename (possibly with " -> link target")
      replacement: '[$1] $2',
    },
  ],
}
