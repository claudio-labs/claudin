---
name: tmpdir-ownership-unchecked
description: getClaudeTempDir never checks who owns /tmp/claude-<uid>; another local user who pre-creates it (or bundled-skills/<version>) can swap files under reads the permission layer allowlists — not fixed, found 2026-09-27
type: project
---

**Symptom:** none visible. It is a latent local privilege issue on shared multi-user machines.

**Where:**
- `src/platform/tmpdir.ts`: `getClaudeTempDir()` returns `/tmp/claude-<uid>/` (or `$CLAUDIN_TMPDIR/claude-<uid>/`) and never checks its owner or mode.
- Everything under it inherits the gap. The sharpest case is the bundled-skill extraction root, `src/skills/bundledSkillsRoot.ts` → `<tmp>/bundled-skills/<version>/<128-bit nonce>`, because `src/permissions/filePermissions/internalPaths.ts` allowlists reads under it without a prompt.

**How it plays out:**
1. Another user creates `/tmp/claude-<victim-uid>/bundled-skills/<version>` first, as directories they own.
2. The victim's `mkdir -p` succeeds inside them.
3. The attacker lists their own `<version>` directory and learns the nonce.
4. After extraction they rename the victim's nonce directory away and plant their own in its place.
5. The model is told `Base directory for this skill: <path>` and reads the planted files.

The nonce and the 0700/0600 modes do not help once a parent is theirs.

**Status:**
- Inherited: the old module had the same design, and its SECURITY comment assumed the parent chain was safe.
- It surfaced during the clean-base pilot (`docs/tech/rewrite/skills/bundledSkills.md`, Outcome), and is not fixed.
- The fix belongs in `tmpdir.ts`: `lstat` the per-user dir and every directory below it that we create, require our uid and no group or world write access, and otherwise fall back to a fresh `mkdtemp`, or refuse to extract.
