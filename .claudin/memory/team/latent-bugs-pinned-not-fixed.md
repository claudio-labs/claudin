---
name: latent-bugs-pinned-not-fixed
description: Two defects surfaced while writing coverage for the 2026-09-20 giant-file split; both are pinned as current behaviour and deliberately NOT fixed
type: project
---

Writing tests for code that had none — the standing bar on
`refactor/split-remaining-giants` — surfaced two real defects. Both were left
alone because that branch was a relocation and changing behaviour inside one
hides the thing the diff is supposed to prove. Both are pinned by a test that
asserts the CURRENT answer, so whoever fixes them gets a red test naming the
decision rather than a silent change.

**1. `isAutobackgroundingAllowed` misses the case its own doc comment names.**
`src/tools/BashTool/bashCommandClassification.ts`. It calls
`splitCommand_DEPRECATED`, which returns whole segments, then tests
`DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand)` — a list of command
NAMES. So `baseCommand` is the string `"sleep 5"`, which is not in the list, and
only a bare `sleep` with no argument is refused. The comment says "returns false
for commands that should not be auto-backgrounded (like sleep)".

Not user-visible today: `detectBlockedSleepPattern` refuses `sleep 5` earlier in
`validateInput`, so the lenient answer is never reached for the shape that
matters. Pinned in `bashCommandClassification.test.ts` under a test literally
named `KNOWN GAP`. Fix by splitting the segment before the lookup — and expect
that test to go red, which is the point of it.

**2. `restoreDangerousPermissions` resurrects rules the user deleted.**
`src/permissions/permissionSetup/dangerousRuleStash.ts`. Auto mode strips
dangerous permission rules on entry and stashes them; on exit, restore re-adds
every stashed rule unconditionally, with no check against the current rule set.
A rule the user deleted from settings while auto mode was active comes back when
auto mode ends.

What IS pinned is the narrower invariant that does hold: restore writes back
only to the rule's own source, never to `session`, and clears the stash so a
second exit is a no-op. The unwritable-source case is closed upstream — strip
never stashes `policySettings`/`flagSettings`/`command`.

**Why:** both are the kind of defect that only a first test finds, because the
code reads correctly and the wrong answer is reachable only through an input
nobody wrote down. Recording them beats rediscovering them, and recording that
they were seen and left beats a future reader assuming nobody looked.

**How to apply:** when either is fixed, the pinning test is the one to update,
in the same commit. Do not "fix" them inside another relocation branch. See
[[tier3-file-split-roadmap]] for the coverage-before-split ordering that
surfaced them.
