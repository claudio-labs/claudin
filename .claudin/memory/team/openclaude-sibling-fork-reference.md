---
name: openclaude-sibling-fork-reference
description: openclaude (@gitlawb) at ../openclaude is the fork claudin was cut from (9e23c2be, 2026-04-25; ~5.5% of lines still theirs; LICENSE attribution deferred by the user 2026-09-25); mine their fix( stream over inherited code, not their feature list — next audit starts at a838b670
type: reference
---

`@gitlawb/openclaude` is NOT just a sibling — **claudin was forked FROM it** (measured 2026-09-25): root `27454381` ("Claudio v0.1.0", 2026-04-29, `@gitlawb/claudio`) is openclaude `9e23c2be` (04-25, #813) + cherry-picks #882/#908, squashed (83% blob-identical), synced from Gitlawb/openclaude via a Gitea workflow deleted 04-30. At HEAD 71f12a8a: ~45% of distinctive lines are upstream Claude Code, ~5.5% openclaude-authored (openaiShim, codexShim, providerProfiles/ProviderManager, cacheMetrics, WebSearch providers, mcp/doctor, autoFix, wiki), 145 files ≥80% openclaude. LICENSE went from their NOTICE (with "OpenClaude contributors" renamed to "Claudio contributors") to plain MIT "Claudio Labs" on 08-14 (0c37342e). The repo is checked out at `../openclaude`. Same architecture (openaiShim, providerConfig, withRetry, Ink TUI, slash commands, MCP).

**Open, deferred by the user on 2026-09-25:** the LICENSE carries neither
openclaude's copyright notice nor its NOTE on the Anthropic code, while ~21k of
their lines remain; the session's reading (not legal advice) was that their
license asks for the notice to be kept. The user pulled it out of that round —
"a licença vamos ajustar em uma próxima rodada" — so don't change it unasked.
The same round (#251) rewrote the `src/` comments that cited openclaude to
describe only the code; the `/import` adapter for openclaude users
(`src/platform/import/`), comparison docs and benches keep the name on purpose.

**Why:** both forks evolve the same upstream independently. What pays is their `fix(` stream
over **inherited upstream code**, not their feature list — the 2026-09-10 audit found 17 real
bugs that way, and falsified 11 more that only matched by line number.

**How to apply:** cross-check any candidate against claudin's tree first — several things converged independently (claudin already HAS: `/goal`, reasoned-denial permission prompts, per-agent model routing in `/agents`, bypassPermissions mode, 5xx/HTML-overload retry). Verify a claim by running the real regex or function and tracing its consumers, not by matching a line. The earlier audits, with the FALSIFIED list to read before reopening any old entry, are in [[openclaude-audit-history]].

## 2026-10-23 round (their v0.30.0..a838b670, 105 commits; #319, v1.1.49)

Next audit starts at openclaude `a838b670`. Of the 17 confirmed in the 09-10 audit, five
were already fixed: #1 heredoc, `__proto__`, attribution block,
`argumentSubstitution` (`e58d3ead`, 09-10) and persist-before-throw
(`cf78225f`, 10-10). #319 fixed 11 of the other 12 plus 11 new
ports from their v0.31–0.33 fix stream, each with a red test first and a probe
in `scripts/migrations/probes/inheritedBugs20261023.json`. Still open on purpose:
**#17 GLM pricing** (a price-data refresh, not a bug). Ported only in part:
`d834904e` — the guard against an empty remote answer, not its atomic-replace
and transcript-lock machinery. Not ported: `87d4e3a6` (color-only banner),
because claudin already draws a plain colored rule when the banner text is empty.

Traps that round hit, worth knowing before the next one:
- **Bun's YAML splits a value at a mid-line `--- ` or `... `**, treating it as
  a document marker (`d: a --- b` → `[{d:'a'},'b']`). So anchoring the
  frontmatter regex alone made `description: a --- b` parse to `{}`.
- **`sleep N` is auto-backgrounded on timeout** (the pinned latent bug), so a
  timeout test built on `sleep` sees a background task, not a kill.
- **`fastMode.test.ts` leaked a partial `src/shared/constants/oauth.js` mock**
  until c011d5a7. A suite reading a success URL got `undefined` and answered 500.
- Their fixes are often far bigger than the bug: #2235 (permission forwarding)
  touched 31 files with 12 follow-up race fixes, and `d834904e` 1.6k lines.
  Port the guard, not the framework.
