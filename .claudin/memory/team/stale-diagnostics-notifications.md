---
name: new-diagnostics notifications can be stale mid-edit snapshots
description: <new-diagnostics> reminders reported errors an edit had already fixed — FIXED 2026-09-24 (registry merged every publish, dropped the "clean" one, and missed file:// lookups); the separate mid-build "file modified" case is this repo's in-place preprocess, not a diagnostics bug
type: project
---

**Symptom (2026-06, the xAI audit pass, commit `4a339d4c`).** `<new-diagnostics>`
reminders flagged "Cannot find name", undefined constants and unreachable code
that were already fixed in the file on disk.

**Root cause, found 2026-09-24 (branch `fix/unmasked-cli-bugs`).** Three defects
in the LSP diagnostic path, together:
- `LSPDiagnosticRegistry` stored every publishDiagnostics under a random UUID
  and the turn-level pull delivered their union, so an error the next edit fixed
  was still delivered beside the fix's own diagnostics.
- `passiveFeedback` dropped an EMPTY publish before it reached the registry, so
  the server's "this file is clean now" never displaced anything.
- The edit tools looked diagnostics up by `file://` + path while the registry
  stored plain paths: the per-edit wait always timed out (1.5 s per edit), the
  end-of-turn tail-wait never found its file, and an edit never reset its file.

**Fix.** One pending entry per (server, file) holding that server's latest
publish; an empty publish deletes it and answers a per-edit wait at once; every
lookup normalizes to a path; `forgetDiagnosticsForEditedFile` drops a file's
pre-edit diagnostics before the server is notified. Pinned by
`src/platform/lsp/passiveFeedback.test.ts`, which drives the real notification
handler with fake servers; the probe spec `lspDiagnosticsLatest.json` proves each
line. Not verified against a live language server (no LSP plugin on the machine
it was fixed on). Still open: the client sends `version: 1` on every change, so a
publish computed from an older version cannot be told apart.

**A separate mechanism, not a diagnostics bug.** On 2026-09-15 a batch of
"`<file>` was modified" reminders quoted the build's folded `feature()` tree
(`const bridge = true`, `if (false)`). That reminder re-reads a file when its
mtime moves, and `bun run build` rewrites ~478 sources in place and restores
them in a `finally` — so it showed the file accurately, mid-build. It is
specific to this repo's build; a project whose build does not rewrite its
sources never sees it.
