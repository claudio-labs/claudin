---
name: claude-code-2.1.270-prompt-diff
description: What Claude Code 2.1.270's system prompt actually contains vs claudin's — narration policy is INVERTED upstream, and 3 blocks we thought were claudin-only are upstream verbatim
type: project
---

Extracted 2026-09-14 from the locally installed Claude Code **2.1.270** at
`~/.local/share/mise/installs/node/25.9.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
— a 214 MB Bun-compiled ELF, unstripped, no `cli.js` any more. Method: `strings -n 12`
(→ 44.6 MB of literals) then grep for prose. Minification mangles identifiers but not
string literals, so prompt prose survives verbatim. Prompt builders visible as
`MRo` (Tone and style), `RRo` (Using your tools), `lRo` (Communicating with the user),
`ORo` (lean intro), `TRo` (autonomy append), `LRo`/`FRo` (Delivering work / Corrections).

**The headline: upstream now steers the OPPOSITE way on narration.** Claude Code has no
anti-narration bullets and no "4 checkpoints" rule. It mandates narration:
*"Before your first tool call, say in a sentence what you're about to do; while working,
give brief updates when you find something load-bearing or change direction."* The lean
variant adds *"Brief is good — silent is not."* There is a separate `CLAUDE_CODE_TURN_UPDATES`
steering block saying the same. So claudin's `ANTI_NARRATION` is a divergence from upstream,
not a leftover of it.

**Present upstream verbatim (do NOT treat as claudin-only):**
- `# Delivering work` and `# Corrections` — gated `delivering_work_max` / `overcorrection`.
- `ACT_ON_WHAT_YOU_KNOW`.
- "Before ending your turn, check your last paragraph…" — gated to autonomous sessions
  (`autonomy_append`, flag `tengu_amber_sextant`), carries the "changes system state" para too.
- Tool batching — TWO shapes: the lean path has the one-sentence form
  ("Independent tool calls can run in parallel in one response"), the standard path has a
  ~560-char paragraph comparable to claudin's. "Upstream is one sentence" is true of the lean path only.
- Memory — upstream's is *larger*, not half: the compact single-dir branch matches what claudin
  ported (~2.3 K chars), but the private+team branch adds `## Memory scope`,
  `## How to save memories`, `## Memory and other forms of persistence`,
  `## Sharing skills in memories` → roughly 2×. No "Searching past context" subsection and no
  grep/jsonl recipes upstream (that half IS claudin-only).
- Idle notice — **turn**-gated, not time-gated: `"The user hasn't heard from you in a while.
  As you continue, keep them updated when there's something to tell — a finding, a change of plan."`
  Threshold from `I("tengu_hushed_lark", 5)`, override `CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS` / `_TEXT`.
- Knowledge cutoff — model-keyed from the model catalog (`knowledge_cutoff` per entry), not an
  if-chain. `claude-opus-5` → **"May 2026"**; claudin's `getKnowledgeCutoff` says January 2026.

**Genuinely claudin-only:** verbosity steering ("shortest response that fully answers"),
two of the three code-style sentences ("beyond what was asked", "verify it actually works" —
only "match its comment density, naming, and idiom" is upstream), the full
`# Scratchpad Directory` section (upstream is one env-info line), and the
"Searching past context" memory sub-block.

**Upstream blocks claudin LACKS**, worth considering as additions rather than cuts:
- `# Writing for the user` (`bRo`, flag `willow_tern`) — 12 bullets: "One idea per sentence,
  about 20 words, with a verb"; "No em-dashes, no parentheticals, no arrows"; "Keep numbers out
  of prose… goes in a short table"; "No headers in a message under about 500 words. Above that,
  at most three."; "Stop when the content stops."
- Comment policy: "Only write a code comment to state a constraint the code itself can't show,
  never to say where it came from, what the next line does, or why your change is correct."
- An explicit risky-action taxonomy (destructive / hard-to-reverse / shared-state / third-party
  upload) plus "In a git repository, run `git status` before any command that could discard
  uncommitted work". Claudin compresses this into one `getActionsSection` paragraph.

Consequence for any "trim the prompt for Claude 5" proposal: the token-saving motive is
much smaller than a naive diff suggests, because a large share of what looks claudin-only
is upstream. The real question is behavioral and narrower — whether `ANTI_NARRATION`
should fire on Claude 5 at all. See [[anti-narration-never-benched-on-claude-5]].
