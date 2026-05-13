// System-inspection filters: ps aux, top, journalctl, and a long tail of
// filesystem / network / process utilities (ping, rsync, tree, ssh, df, du,
// dmesg, stat, jq).
//
// ps/top are dominated by kernel threads (VIRT/RSS=0) that are rarely relevant
// to a coding agent. journalctl repeats the hostname on every line — strip it.
// Phase 9 (system utilities) adds 9 declarative specs that cover commands the
// RTK reference filter covered but Claudio did not — see
// docs/discovery/bash-output-filter/system-utils-deep-dive-2026-05.md.
//
// Regex are declared at module level — see .claudio/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- ps aux --------------------------------------------------------------

const PS_AUX_MATCH = /^ps\s+(?:aux|-ef|auxf|aufx)\b/
// Kernel thread rows in `ps aux` output:
//   USER  PID  %CPU  %MEM  VSZ=0  RSS=0  TTY=?  STAT  START  TIME  [cmd]
// The defining signals are VSZ=0 *and* RSS=0 *and* the command in brackets.
const PS_KTHREAD_LINE =
  /^\S+\s+\d+\s+\d+\.\d\s+\d+\.\d\s+0\s+0\s+\?\s+\S+\s+\S+\s+\S+\s+\[[^\]]+\]\s*$/

export const psAux: FilterSpec = {
  name: 'ps-aux',
  matchCommand: PS_AUX_MATCH,
  stripLinesMatching: [PS_KTHREAD_LINE],
  // The header + top user processes are the signal. 50 lines comfortably
  // covers a reasonable laptop/server even after stripping kthreads.
  maxLines: 50,
}

// --- top -bn1 ------------------------------------------------------------

const TOP_MATCH = /^top\s+(?:-b|-n\s*1|-bn1)\b/
// Kernel-thread rows in `top` use VIRT=RES=SHR=0. Be strict: match the
// exact triple-zero middle columns to avoid eating real processes that
// just happen to have zero CPU%.
//   PID USER PR NI VIRT=0 RES=0 SHR=0 S %CPU %MEM TIME+ COMMAND
const TOP_KTHREAD_LINE =
  /^\s*\d+\s+\S+\s+\S+\s+\S+\s+0\s+0\s+0\s+\S\s/

export const top: FilterSpec = {
  name: 'top',
  matchCommand: TOP_MATCH,
  stripLinesMatching: [TOP_KTHREAD_LINE],
  // top's header is 5-7 lines + column header; cap at 60 to cover header
  // and the ~50 busiest user processes.
  maxLines: 60,
}

// --- journalctl ------------------------------------------------------------
// Every line repeats the hostname — strip it. Empty-entries and boot markers
// add noise without actionable information, so replace them too.
// Passthrough when user requested structured output, is following live, or
// using --machine (hostname is informative in multi-host context).

const JOURNALCTL_MATCH = /^(?:sudo )?journalctl\b/
const JOURNALCTL_REJECT =
  /--output=json\b|--output=cat\b|-o\s+(json|cat|export)\b|-f\b|--follow\b|--machine\b/
// "May 05 12:18:04 viudes-arch ..." → "May 05 12:18:04 ..."
const JOURNALCTL_HOST_REPLACE =
  /^(\w{3} \d{1,2} \d{2}:\d{2}:\d{2}) \S+ /gm

export const journalctl: FilterSpec = {
  name: 'journalctl',
  matchCommand: JOURNALCTL_MATCH,
  matchCommandReject: JOURNALCTL_REJECT,
  replace: [{ pattern: JOURNALCTL_HOST_REPLACE, replacement: '$1 ' }],
  stripLinesMatching: [
    /^-- No entries --$/,
    /^-- Boot [0-9a-f]+ --$/,
  ],
}

// --- ping ----------------------------------------------------------------
// Phase 9 — `ping`/`ping6` repeats one round-trip line per packet. The signal
// the agent actually wants is the header (resolved IP + payload size), the
// `--- statistics ---` block, and `rtt min/avg/max`. Head 3 + tail 9 covers
// that without truncating either. Anchored verb so `ping-utility` (uncommon
// but real) and `ping6-something` cannot accidentally match.
//
// `truncateLineAt: 4096` defends against `ping -f` (flood) collapsing the
// per-packet `.` markers into a single mega-line via `\r`-style updates.

const PING_MATCH = /^ping6?(?=\s|$)/

export const ping: FilterSpec = {
  name: 'ping',
  matchCommand: PING_MATCH,
  truncateLineAt: 4096,
  maxLines: 12,
  headLines: 3,
  tailLines: 9,
}

// --- rsync ---------------------------------------------------------------
// Phase 9 — `rsync -av` lists every transferred filename, which is per-file
// noise the agent rarely needs. Strip the `sending|receiving incremental
// file list` banner and the filename-only lines, preserve the summary block
// (`sent`/`received`/`total size`/`speedup`) and any rsync error/IO line.
// Anchored verb prevents `rsyncd`/`rsync-something` from matching.
//
// `--info=progress2` is rsync's modern single-line progress meter that
// `\r`-overwrites itself (same trick curl uses). The CR-collapse pass below
// reduces it to the final summary line before strip/cap apply.

const RSYNC_MATCH = /^rsync(?=\s|$)/
const RSYNC_BANNER = /^(?:sending|receiving) incremental file list$/
// A bare filename line: no whitespace, starts with an alnum/_/./- and contains
// no shell-special chars. Critical: anchor to `^...$` so any line that also
// carries words like `error`, `failed`, `IO error`, `sent`, `received`, `total
// size`, `speedup` (all contain spaces) is preserved.
const RSYNC_FILE_LINE = /^[\w.][\w./-]*$/
// Carriage-return overwrites from `--info=progress2`. Linear, ReDoS-safe.
const RSYNC_CR_OVERWRITE = /[^\r\n]*\r/g

export const rsync: FilterSpec = {
  name: 'rsync',
  matchCommand: RSYNC_MATCH,
  replace: [{ pattern: RSYNC_CR_OVERWRITE, replacement: '' }],
  stripLinesMatching: [RSYNC_BANNER, RSYNC_FILE_LINE],
  maxLines: 30,
  headLines: 5,
  tailLines: 25,
}

// --- tree ----------------------------------------------------------------
// Phase 9 — `tree` listings explode on large repos. Cap at 75 lines (50 head
// + 25 tail). Reject `-J`/`-X` because we must not corrupt structured output
// downstream consumers might parse. Strip ANSI in case the user enabled
// colors. Verb anchored so `tree-sitter` (a real binary in dev toolchains)
// cannot be claimed by this filter.

const TREE_MATCH = /^tree(?=\s|$)/
const TREE_REJECT = /(?:^|\s)(?:-J|--json|-X|--xml)\b/

export const tree: FilterSpec = {
  name: 'tree',
  matchCommand: TREE_MATCH,
  matchCommandReject: TREE_REJECT,
  stripAnsi: true,
  // Defends against a flat directory with thousands of entries collapsed into
  // a single tree-drawing line (rare but observed with `tree -L 1 huge-dir/`).
  truncateLineAt: 4096,
  maxLines: 80,
  headLines: 50,
  tailLines: 25,
}

// --- ssh -----------------------------------------------------------------
// Phase 9 — `ssh -v`/`-vv`/`-vvv` emits hundreds of `debug<N>:` lines that
// are useful when actively debugging an SSH problem but pure noise when the
// agent only cares about the remote command's output. Strip those lines;
// leave everything else (banners, remote output, errors). Verb anchored so
// `ssh-add`/`ssh-keygen`/`ssh-copy-id` are not matched by accident.

const SSH_MATCH = /^ssh(?=\s|$)/
const SSH_DEBUG = /^debug\d+:\s/

export const ssh: FilterSpec = {
  name: 'ssh',
  matchCommand: SSH_MATCH,
  stripLinesMatching: [SSH_DEBUG],
  maxLines: 60,
}

// --- df ------------------------------------------------------------------
// Phase 9 — `df`/`df -h` is short but many rows are kernel-managed pseudo
// filesystems (`tmpfs`, `devtmpfs`, `squashfs`, FUSE, `none`) that the agent
// rarely cares about. Strip those. Respect explicit `-a`/`--all`: the user
// asked to see everything, so pass through. Header line starts with
// `Filesystem`, so it is preserved by the strip regex.
//
// Note: `overlay` is intentionally NOT in the strip list — docker disk-usage
// debugging needs that line (audit-2026-05 finding A3). `overlay` rows are
// real backing storage from the agent's perspective.

const DF_MATCH = /^df(?=\s|$)/
const DF_REJECT = /(?:^|\s)(?:-a|--all)\b/
const DF_NOISE = /^(?:tmpfs|devtmpfs|squashfs|fuse\.|none\s)/

export const df: FilterSpec = {
  name: 'df',
  matchCommand: DF_MATCH,
  matchCommandReject: DF_REJECT,
  stripLinesMatching: [DF_NOISE],
  maxLines: 40,
}

// --- du ------------------------------------------------------------------
// Phase 9 — `du -h` can dump thousands of subdir lines in a JS or git tree.
// Without an RFC-level `sortBy` we cannot deliver the "top-N largest"
// behaviour, so we do the minimum useful thing: strip the deepest known-noise
// patterns (nested `node_modules/.../node_modules/` and the `.git/refs|objects/`
// subtree) and cap with head/tail. Top-level totals and shallow subdirs (the
// signal an agent typically wants) survive both filters.

const DU_MATCH = /^du(?=\s|$)/
const DU_DEEP_NOISE =
  /(?:^|\/)\.git\/(?:refs|objects)\/|node_modules\/[^/]+\/node_modules\//

export const du: FilterSpec = {
  name: 'du',
  matchCommand: DU_MATCH,
  stripLinesMatching: [DU_DEEP_NOISE],
  maxLines: 60,
  headLines: 30,
  tailLines: 30,
}

// --- dmesg ---------------------------------------------------------------
// Phase 9 — `dmesg` typically dumps the entire kernel ring buffer (thousands
// of boot-time lines). The most recent events are usually what the agent
// cares about, but boot-time hardware enumeration (PCI/ACPI/USB/NVMe) is the
// #1 reason a human runs `dmesg` — losing it would defeat the purpose. So we
// keep the first 10 boot lines AND the last 50 recent lines. No strip
// patterns — output is hard to parse declaratively and most lines carry
// useful timing info. Audit-2026-05 finding A4.
//
// Corner-case audit P0:
//   - `stripAnsi: true` handles `dmesg --color=always`, which embeds CSI
//     codes even in non-TTY captures.
//   - `truncateLineAt: 4096` defends against pathological single-line entries
//     (e.g. a 16 KB userland-stack dump) blowing out the budget.
//   - A kernel oops/panic stack (~30 lines + 5-line code dump) lands at the
//     end of the ring buffer; `tailLines: 50` reliably captures it.

const DMESG_MATCH = /^dmesg(?=\s|$)/

export const dmesg: FilterSpec = {
  name: 'dmesg',
  matchCommand: DMESG_MATCH,
  stripAnsi: true,
  truncateLineAt: 4096,
  maxLines: 60,
  headLines: 10,
  tailLines: 50,
}

// --- stat ----------------------------------------------------------------
// Phase 9 — `stat <file>` is already short (~8 lines). The spec exists for
// defence-in-depth: a `stat -L` on a symlink chain can grow, and the cap
// keeps the harness honest. Verb anchored.

const STAT_MATCH = /^stat(?=\s|$)/

export const stat: FilterSpec = {
  name: 'stat',
  matchCommand: STAT_MATCH,
  maxLines: 40,
}

// --- jq ------------------------------------------------------------------
// Phase 9 — `jq '.'` on a large JSON file produces hundreds of lines. Critical
// safety: when the user invoked jq with a structured-output flag
// (`-r`/`--raw-output`/`-c`/`--compact-output`/`--tab`/`-j`/`--join-output`)
// they are piping the result to another command — pass it through untouched.
//
// Cap rationale (corner-case audit P0 C1): the prior fix dropped *all* caps
// to avoid mid-object truncation (A1), but that left jq unbounded — a 50k-
// line pretty-printed JSON would either OOM the LLM context or be raw-tail-
// truncated by the pipeline cap (which also produces invalid JSON, just
// less obviously). We compromise with a generous 500-line cap (≈30 KB of
// pretty JSON, well above 99% of real outputs) and an explicit head/tail
// split: if a user pipes us 600 lines of JSON, they see the first 200 and
// the last 300 with a clear marker — invalid JSON, but the marker makes it
// *obviously* invalid and the LLM can request a narrower jq filter.

const JQ_MATCH = /^jq(?=\s|$)/
const JQ_STRUCTURED =
  /(?:^|\s)(?:-r|--raw-output|-c|--compact-output|--tab|-j|--join-output)\b/

export const jq: FilterSpec = {
  name: 'jq',
  matchCommand: JQ_MATCH,
  matchCommandReject: JQ_STRUCTURED,
  maxLines: 500,
  headLines: 200,
  tailLines: 300,
}

// --- find ----------------------------------------------------------------
// `find` output is pure signal (one path per line), so there is nothing to
// strip without losing information. The risk is volume: `find / -type f`
// or a scan over a populated `node_modules/` can produce tens of thousands
// of lines, all of which would land in the LLM context if uncapped. We
// cap with a generous head/tail split so the agent still sees both the
// beginning and the end of the listing — enough to recognise truncation
// and re-run with a narrower predicate.
//
// Reject paths that change output format/structure, because our cap would
// either be redundant (already aggregating output) or actively wrong:
//   -printf / -fprintf / -fprint  → custom record format, may emit
//                                   newlines/binary inside a "record"
//   -print0 / -fprint0            → NUL-delimited stream; "lines" don't
//                                   exist, line-based cap corrupts it
//   -exec / -execdir / -ok / -okdir → arbitrary subprocess output mixed in
//   -ls                           → multi-column tabular output, different
//                                   shape than plain paths
// Verb anchored so `findutils` or `find-something` cannot be claimed.

const FIND_MATCH = /^find(?=\s|$)/
const FIND_REJECT =
  /(?:^|\s)(?:-printf|-fprintf|-fprint|-print0|-fprint0|-exec|-execdir|-ok|-okdir|-ls)\b/

export const find: FilterSpec = {
  name: 'find',
  matchCommand: FIND_MATCH,
  matchCommandReject: FIND_REJECT,
  // Defends against pathological filenames (no real filename should exceed
  // 4 KB; if it does, truncating is safer than blowing the budget).
  truncateLineAt: 4096,
  maxLines: 150,
  headLines: 50,
  tailLines: 100,
}
