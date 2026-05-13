// Network command filters: curl, dig.
//
// curl -v drowns the useful HTTP request/response in TLS handshake noise —
// ~30 lines of TLS frames + byte-count markers before the first `>` line.
// dig includes semicolon-prefixed comment lines that roughly double the output
// without adding information a coding agent needs.
//
// Regex are declared at module level — see .claudio/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- curl ------------------------------------------------------------------
// Only applies when -v / --verbose is active. Passthrough for -s (silent) and
// -I (headers only) since those are already compact.

const CURL_MATCH = /^curl\b.*(?:-v\b|--verbose\b)/
const CURL_REJECT = /-s\b|--silent\b|-I\b|--head\b/
// TLS handshake frame lines: "* TLSv1.3 (OUT), ..." / "* SSL ..."
const CURL_TLS = /^\*\s+TLS/
const CURL_SSL = /^\*\s+SSL/
// Frame byte-count markers: "} [1566 bytes data]" / "{ [5 bytes data]"
const CURL_BYTES = /^[}{]\s+\[\d+\s+bytes\s+data\]\s*$/
// DNS resolution and connection noise
const CURL_IPV = /^\*\s+IPv[46]:/
const CURL_TRYING = /^\*\s+Trying\s/
const CURL_ALPN = /^\*\s+ALPN:/
const CURL_CONN = /^\*\s+Connection #/
const CURL_CAFILE = /^\*\s+CAfile:/
const CURL_CAPATH = /^\*\s+CApath:/
const CURL_RESOLVED = /^\*\s+Host\s.*was\s+resolved\./

export const curlV: FilterSpec = {
  name: 'curl',
  matchCommand: CURL_MATCH,
  matchCommandReject: CURL_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    CURL_TLS,
    CURL_SSL,
    CURL_BYTES,
    CURL_IPV,
    CURL_TRYING,
    CURL_ALPN,
    CURL_CONN,
    CURL_CAFILE,
    CURL_CAPATH,
    CURL_RESOLVED,
  ],
  maxLines: 100,
}

// --- dig -------------------------------------------------------------------
// dig output is ~50% comment lines (semicolons). Strip the boilerplate header
// and stats footer; preserve answer records and the QUESTION SECTION query
// line (;example.com. IN A) so the agent knows what was resolved.
//
// Two patterns:
//   ^;; — section separators and stats (";; Got answer:", ";; Query time:", etc.)
//   ^; \s — version / option headers ("; <<>> DiG…", "; EDNS: …")
// Actual query entries start with ";hostname" (no space), so they are kept.
// Passthrough when user already requested short/no-comments format.

const DIG_MATCH = /^dig\b/
const DIG_REJECT = /\+nocomments\b|\+short\b/
// ";; …" — section headers and stats footer
const DIG_COMMENT_FULL = /^;;/
// "; …" (semicolon + space) — version banner and EDNS pseudo-section
const DIG_COMMENT_SPACE = /^; /

export const dig: FilterSpec = {
  name: 'dig',
  matchCommand: DIG_MATCH,
  matchCommandReject: DIG_REJECT,
  stripAnsi: true,
  stripLinesMatching: [DIG_COMMENT_FULL, DIG_COMMENT_SPACE],
  maxLines: 50,
}

// --- curl (plain — no -v) -------------------------------------------------
// Phase 9 — `curl URL` without `-v`/`-s`/`-I`/`-o` prints a progress meter to
// stderr that the agent does not need. The meter is two header lines
// (`% Total ... Current` and `Dload Upload ...`) followed by data rows that
// `\r`-overwrite themselves into a single physical line on a real terminal
// but become multiple lines in a captured buffer.
//
// Strategy:
//   1) Collapse `\r`-overwrites by replacing `...content...\r` with empty —
//      this is what the terminal would have shown. `[^\r\n]*\r` is linear and
//      ReDoS-safe (single quantifier, anchored class).
//   2) Strip the two textual header lines on whatever remains.
//   3) Strip a final residual progress data row if any survived the CR pass.
//
// `curlV` (Phase 6.1.5) already handles `curl -v` with the TLS-frame stripper,
// so we reject `-v`/`--verbose` to avoid double-claiming the command. `-s`
// (silent), `-I` (head only), `-o` (write to file) all skip — those modes do
// not emit the progress meter to begin with.

const CURL_PLAIN_MATCH = /^curl(?=\s|$)/
const CURL_PLAIN_REJECT =
  /(?:^|\s)(?:-v|--verbose|-s|--silent|-I|--head|-o|--output)\b/
// Carriage-return overwrites: everything up to (and including) each `\r` on a
// line. Char class is non-greedy by virtue of excluding `\r`, so no backtrack.
const CURL_CR_OVERWRITE = /[^\r\n]*\r/g
const CURL_PROGRESS_HEADER = /^\s*%\s+Total\s+%\s+Received/
const CURL_PROGRESS_RULE = /^\s*Dload\s+Upload\b/
const CURL_PROGRESS_DATA = /^\s*\d+\s+\d+[kKMG]?\s+\d+\s+\d+[kKMG]?/

export const curlPlain: FilterSpec = {
  name: 'curl-plain',
  matchCommand: CURL_PLAIN_MATCH,
  matchCommandReject: CURL_PLAIN_REJECT,
  stripAnsi: true,
  replace: [{ pattern: CURL_CR_OVERWRITE, replacement: '' }],
  stripLinesMatching: [
    CURL_PROGRESS_HEADER,
    CURL_PROGRESS_RULE,
    CURL_PROGRESS_DATA,
  ],
  maxLines: 100,
}

// --- wget -----------------------------------------------------------------
// `wget` (without `-q`) prints a verbose download log: timestamped request
// banner, CA-cert load, DNS resolution, TCP connect, HTTP request/response,
// content length, target path, and then a progress meter consisting of
// dot-blocks ("     0K .......... .......... ... 100% 22.3M=0s") — one line
// per ~50 KB on a large file. A 50 MB download produces ~1000 progress
// lines that carry no information beyond the final "saved" summary.
//
// Strategy: strip the chatter (Loaded CA, Resolving, Connecting, Length:,
// Saving to:) and every progress-dot/bar line. The `HTTP request sent,
// awaiting response...` line is only stripped when the response was a
// success (200/206) — non-2xx codes (3xx redirects, 4xx/5xx errors) are
// signal the LLM needs. The "saved [n/total]" final summary survives
// because it doesn't start with any of the stripped tokens. Errors
// (`failed:`, `unable to resolve`, `ERROR`, retry banners) survive too.
//
// Passthrough when `-q`/`--quiet` is in effect (no output) or when the
// user pipes the body to stdout via `-O -` / `-O-` / `-qO-` (very common
// `wget -qO- URL | sh` installer pattern) — filtering those would corrupt
// the payload downstream.
//
// `--progress=bar` emits a single-line bar that `\r`-overwrites itself
// (same trick curl/rsync use). The CR-collapse pass below reduces it to
// the final frame before the bar-strip pattern fires.

const WGET_MATCH = /^wget(?=\s|$)/
// Stdout-writing forms must be rejected. We match three shapes:
//   `-O -` / `-O-` (space optional)
//   `-qO-` / `-qO -` (glued short form, common in installer one-liners)
//   `--output-document=-`
// Plain `-q`/`--quiet` is also rejected (no output to filter).
const WGET_REJECT =
  /(?:^|\s)(?:-q|--quiet)\b|(?:^|\s)-q?O\s*-(?:\s|$)|--output-document=-(?:\s|$)/
// Boilerplate header lines emitted before the transfer starts.
const WGET_RESOLVING = /^Resolving\s/
const WGET_CONNECTING = /^Connecting to\s/
// Only strip the HTTP-status line for *successful* responses. Non-2xx
// (3xx redirect, 4xx/5xx error) is the only place the status code shows
// up in non-fatal cases — must survive.
const WGET_HTTP_OK = /^HTTP request sent, awaiting response\.\.\. 20[06]\b/
const WGET_LENGTH = /^Length:\s/
const WGET_SAVING = /^Saving to:\s/
const WGET_CA = /^Loaded CA certificate\s/
// Carriage-return overwrites from `--progress=bar`/`--progress=bar:force`.
// Linear, ReDoS-safe (single quantifier, anchored class).
const WGET_CR_OVERWRITE = /[^\r\n]*\r/g
// Progress dot rows: leading whitespace, optional offset (e.g. "   500K"),
// at least one run of dots, optional percentage, optional rate, optional ETA.
// Anchored at start of line so a real filename line containing dots cannot
// match by accident.
const WGET_PROGRESS_DOTS = /^\s*\d+[KMG]?\s+\.{2,}(?:\s|$)/
// Progress bar rows: `[===>     ] 12,345,678  12.3M/s`. Anchored.
const WGET_PROGRESS_BAR = /^\s*\d+[KMG]?\s*\[=*>?\s*\]\s/

export const wget: FilterSpec = {
  name: 'wget',
  matchCommand: WGET_MATCH,
  matchCommandReject: WGET_REJECT,
  stripAnsi: true,
  replace: [{ pattern: WGET_CR_OVERWRITE, replacement: '' }],
  stripLinesMatching: [
    WGET_CA,
    WGET_RESOLVING,
    WGET_CONNECTING,
    WGET_HTTP_OK,
    WGET_LENGTH,
    WGET_SAVING,
    WGET_PROGRESS_DOTS,
    WGET_PROGRESS_BAR,
  ],
  maxLines: 60,
}
