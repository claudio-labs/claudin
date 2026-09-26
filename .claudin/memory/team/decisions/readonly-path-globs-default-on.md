---
name: readonly-path-globs-default-on
description: Since 2026-09-25 a path glob in cat/head/tail/wc/ls/grep keeps Bash's read-only verdict (`cat src/*.ts` needs no prompt in default mode and no classifier request in auto) — why only those six commands with a `/` before the glob, and the CLAUDIN_READONLY_GLOBS=0 killswitch
type: project
scope: src/tools/BashTool/readOnlyValidation.ts (readsPathGlobs, PATH_GLOB_READERS)
impact: functional
paths:
  - "src/tools/BashTool/readOnlyValidation.ts"
  - "src/tools/BashTool/readOnlyGlobs.test.ts"
---

**Decision:** a path glob no longer costs Bash's read-only verdict when the
command is `cat`, `head`, `tail`, `wc`, `ls` or `grep` and the glob's word
starts with a literal that is not `-` or `{`, with a `/` before the glob
(`src/*.ts`, `./*.ts`, `/repo/src/*.ts`). On by default since 2026-09-25
(branch perf/request-count-levers, commit 6b9b18ab). `CLAUDIN_READONLY_GLOBS=0`
restores the old verdict, where any unquoted glob costs it.

**Why:** in auto mode, every session's first call (`git ls-files && … && cat
src/*.ts`) went to the classifier because of the glob, at ~$0.035 a request
with an uncached transcript. In the session A/B `20260925-061930` the combined
auto arm sent 11 classifier requests over 5 sessions against 20, none of them
judging a glob read; in default mode the same command stopped asking. The
effect is small and shares its arm with two parked flags, but it costs the
session nothing, and the user promoted it on that
([[request-count-levers-2026-09-24]]).

**What changes for a teammate:**
- The path check (`checkPathConstraints`) runs before the verdict and still
  asks for a glob outside the working directories (`cat /etc/*.conf`,
  `cat ../*.md`). Only in-project globs are spared.
- A command joins `PATH_GLOB_READERS` only if it reads whatever its arguments
  are. A glob can expand to several words, and where it stands as a flag's
  value the rest shift into later positions (`nice -n src/* cat x` runs
  `src/b`; `xargs -I src/* echo`), so a command that executes one of its
  arguments must never join.
- A bench base arm now has it on; pass `=0` to measure the old verdict.

**Rejected:**
- Sparing a glob with no `/` before it (`cat README*`, `ls [a-z]*`). A
  bare-name expansion can be a subcommand or a command name, which is only
  harmless command by command; the `/` keeps the rule independent of the
  command.
- Sparing it in every allowlisted command, because of the flag-value shift
  above.

**Evidence:**
- `src/tools/BashTool/readOnlyGlobs.test.ts`: SPARED and REFUSED lists, plus
  the whole permission decision;
- `scripts/bench/ab/response-chain-e2e.ts` scenario 13: the built bundle, by
  default and with `=0`;
- 32 break-probes in `scripts/migrations/probes/requestLevers2.json`, all red.
