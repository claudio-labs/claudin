---
name: permission-carveouts-compare-paths-as-text
description: The file-permission carve-outs (memory, agent memory, .claudin/plans, launch.json) compare paths as text, so a symlink a cloned repo ships there opens its target with no prompt; the shell route can create a dangling link's target outside the project
type: project
---

Found by the `permissions/filePaths` characterization on 2026-10-03 (branch
`rewrite`). Pinned as current behaviour in
`src/permissions/filePaths.*.characterization.test.ts`, decision "keep for
parity". Not fixed. This is the cause behind
[[memory-carveout-follows-symlinks]].

- The write and read carve-outs that skip the permission prompt check whether
  a path is *textually* under the memory dir, agent memory, `.claudin/plans`
  or `.claudin/launch.json`. They never resolve links.
- A link at one of those paths therefore opens its target with no prompt, and
  a cloned repository can ship all four.
- Through the shell route, a write to a *dangling* link is allowed and creates
  the target outside the project.
- Related findings, all pinned:
  - containment ignores case on Linux, so a sibling that differs only in case
    counts as inside;
  - the protected-file list misses `.zshenv`, `.envrc` and `.npmrc`.

**Why:** these carve-outs decide what an agent writes without asking, inside a
checkout the user did not author.

**How to apply:**
- This is the first behaviour change to make after `permissions/filePaths` is
  rewritten.
- The fix compares real paths on both sides, `realpath` of the target and of
  the carve-out root, and refuses a dangling link.
- Changing it flips pins in the characterization suites in the same commit.
