---
name: frontmatter-hash-truncates-values
description: A frontmatter value with a space before a hash sign is cut there — YAML reads it as a comment and the quoting fallback runs only when parsing fails; 18 team memory descriptions citing PR numbers are truncated
type: project
paths:
  - src/shared/frontmatterParser.ts
---

**Symptom:** `description: … 17.3k vs 21.0k after #242/#244) — eager tools are the bulk …`
comes back as `… 17.3k vs 21.0k after` — everything from the ` #` on is dropped, with no error.

**Where:** `parseFrontmatter` in `src/shared/frontmatterParser.ts`. It parses with `Bun.YAML`
first; in YAML a `#` after whitespace starts a comment, so that parse SUCCEEDS with the value
cut. `quoteProblematicValues` — whose own comment lists `#` as a special character — is only the
fallback after a parse error, so it never runs for these lines.

**Reach:** every frontmatter the parser reads: memories (the extraction fork's manifest and the
`/memory` browser show the cut description), skills, agents, rules. On 2026-09-29, 18 team
memories had a ` #` in their description, all PR numbers.

**Repro:** a memory whose description is `x after #1 y` parses to `description: 'x after'`.
Found by reading the parser against YAML's comment rule; not executed.

**Status:** open, 2026-09-29. Workaround for writers: "PR 242", or quote the whole value.
Likely fix: run the quoting pre-pass when a value contains ` #` (or always), not only after a
failed parse.

**Why not fixed:** found by a memory-maintenance pass, which cannot edit `src/`.
