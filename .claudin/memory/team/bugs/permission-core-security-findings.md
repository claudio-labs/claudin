---
name: permission-core-security-findings
description: Phase-3 pins — repo settings start -p in bypass and can ship the bypass-warning skip; shift+tab approves into bypass silently; Monitor's always-allow saves a Bash prefix rule; .mcp.json approval defaults to "all future"; plus the rewrite-fixed deny holes
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
- **One bypass acceptance covers every checkout** (`modeDialogs` 1). Startup also
  takes the skip from a checkout's own `.claudin/settings.local.json`, so with the
  repo-bypass item above a checkout can open an interactive session in bypass
  with no warning at all.
- **Shift+Tab on "Ready to code?" approves straight into bypass** (`modeDialogs` 4)
  whenever bypass is offered; nothing on screen says so.
- **A read's "Yes, during this session" inside the project turns on accept-edits
  for the whole session** (`fileDialogs` 1); the file dialogs ignore the result's
  suggestions and compute their own grant, so ask rules and protected paths
  still offer accept-edits (`fileDialogs` 2). The config-home grant always names
  `~/.claudin/**` even when `CLAUDIN_CONFIG_DIR` points elsewhere (`fileDialogs` 3),
  and the project `.claudin` match ignores case, so `.CLAUDIN/x` grants
  `Edit(/.claudin/**)` (`fileDialogs` 4).
- **Monitor/Wait "don't ask again" saves a Bash prefix rule** (`toolDialogs` 2):
  `make` → `Bash(make:*)`, `rm -rf x` → `Bash(rm -rf:*)`, words taken across
  `&&` or a newline; plain Bash then stops asking too. The label says "Wait commands".
- **The `.mcp.json` approval dialog** (`mcp/approvalDialogs`): Enter means "this
  and all future servers" and every checklist row starts ticked; servers the
  policy denies are still asked about. Queued fix: an answer copies the MERGED
  approval lists into `.claudin/settings.local.json`, so a repo's self-approval
  outlives the repo.
- **Auto mode's dangerous-rule check is narrow.** It misses broader rules
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
