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
