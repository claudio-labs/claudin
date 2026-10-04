---
name: permission-core-security-findings
description: Phase-3 pins — a repo's settings start headless -p in bypassPermissions; batch writes under bypass skip Edit denies; read check asks on UNC paths before denies; whole-anchor deny patterns match nothing
type: project
---

The 2026-10-03 characterizations of `permissions/setup`, `fileRules` and
`decision` (branch `rewrite`) pinned these. The suites hold the current
behaviour.

**Being fixed in the rewrites**, each with a test:
- `shellRules` 1: after a switch into auto mid-session, `--allowed-tools`
  entries spelled `Bash(*)`, `Bash()`, `Task` or `Task(x)` are flagged but never
  stripped (removal looks for the canonical spelling), so `Bash(*)` keeps
  allowing every command in auto mode.
- `autoModeClassifier` 3: a tool missing from the tool list is allowed without
  asking the model.
- `fileRules` F1: whole-anchor deny and ask patterns (`Read(~/**)`,
  `Edit(/**)`, `Read(//**)`) match nothing. A user who denies their whole home
  gets no protection.
- `fileRules` F4: the read check asks about UNC and Windows-style paths
  *before* applying deny rules, so a denied file can be approved.
- `fileRules` F5: `checkBatchWritePermission` under `bypassPermissions` skips
  Edit deny rules, so ApplyPatch and Rename write denied files.
- `fileRules` F2: the same rule text in two sources keeps only the later one's
  anchor.
- `decision` 2: in auto mode, an MCP tool in no-prefix mode named like a
  built-in (`Read`) skips the classifier.
- `decision` 4: under the managed-only policy, a re-sync leaves `--settings`
  rules in force.
- `setup` 3: a CLI rule with nested parentheses splits into two broken rules,
  which can silently weaken a deny.
- `decision` 1: an import cycle (classify → messages → planMode → … →
  permissions) is a TDZ under `bun test`. The bundle is not affected.

**Kept for parity, decide with the trust and approval units:**
- **Bypass from a repo.** A checkout's `.claudin/settings.json` with
  `defaultMode: bypassPermissions` starts a headless `-p` session in bypass
  with no confirmation. Interactive mode shows one.
- **Extra working directories.** A repo's `additionalDirectories` adds working
  directories, labelled `cliArg`.
- **Plan mode.** A tool's own allow rule (`Edit(src/**)`) gets past plan mode.
- **First write check.** It creates `<start dir>/.claudin/plans`, as a side effect.
[clipped: ~424 tokens of new_string from Edit] It misses broader rules
  (`p*`, `* *`, `npm:*`, `python3.12:*`, `timeout:*`), and leaves dangerous
  rules from `flagSettings`, `policySettings` and `command` active (`shellRules` 4, 5).

**Why:** these decide what runs or gets written without asking.

**How to apply:**
- Decide the four "keep" items together with
  [[mcp-server-name-folding-reaches-other-servers-rules]] and
  [[permission-carveouts-compare-paths-as-text]] when
  `permissions/sessionDialogs` lands.
- The repo-bypass case is the most serious. Project scope should not be able
  to set `defaultMode` to bypass.
