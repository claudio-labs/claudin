---
name: frontmatter-hash-truncates-values
description: FIXED 2026-10-23 — a frontmatter value with a space before a hash sign was cut there (YAML comment), and a mid-line triple dash split it (Bun reads a new document); both are now quoted before the first parse
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

**Status:** FIXED 2026-10-23 on `fix/openclaude-inherited-bugs`. `parseFrontmatter` now
quotes a plain `key: value` line before the first parse when its value holds what the parser
would cut without an error: a `#` after whitespace, or `---`/`...` followed by whitespace,
which Bun's YAML reads as a document marker even mid-line (`d: a --- b` parsed to
`[{d:'a'},'b']`). The same round made the closing `---` a line of its own
(`FRONTMATTER_REGEX`). Only top-level plain values are touched: a `#` inside an indented or
list line is still a YAML comment. `/skill-doctor`'s `truncated_value` check stays as a
guard for those.
