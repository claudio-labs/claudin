# Spec: `permissions/shellRules`

Five files: `src/permissions/shellRuleMatching.ts`, `shadowedRuleDetection.ts`,
`dangerousPatterns.ts`, and `permissionSetup/dangerousRuleDetection.ts` and
`permissionSetup/dangerousRuleStash.ts`. The last two are reached through the
`src/permissions/permissionSetup.ts` barrel, which is this project's own and
keeps every name it exports.

## Purpose

This unit decides what a shell permission rule's body means, and protects auto
mode from allow rules that would get around the classifier.

- **The rule grammar.** The Bash and PowerShell permission checks and the file
  tools call it to classify a rule body: an exact command, a legacy `name:*`
  prefix, or a wildcard pattern. They also call it to match a wildcard body
  against a command string, and to build the "always allow" suggestion for a
  command.
- **Unreachable rules.** `/doctor` and the permission UI use it to find
  specific allow rules that can never take effect, because a tool-wide deny or
  ask rule for the same tool wins first.
- **Dangerous rules.** Startup, the mode transitions, plan mode and the REPL
  use it on the way into auto mode. It finds the allow rules that let the
  model run arbitrary code or spawn a sub-agent before the classifier sees the
  action, takes them out of the in-memory context, and keeps them on the
  context so they can be put back when auto mode ends.

## Public contract

Every export keeps its name and signature. Paths are under `src/`.

| Export | Signature | Used by |
|---|---|---|
| `ShellPermissionRule` (type, `shellRuleMatching.ts`) | `{ type: 'exact'; command: string } \| { type: 'prefix'; prefix: string } \| { type: 'wildcard'; pattern: string }` | `tools/PowerShellTool/powershellPermissions.ts`, `tools/BashTool/bashPermissions/suggestions.ts` |
| `permissionRuleExtractPrefix` | `(permissionRule: string) => string \| null` | `tools/BashTool/bashPermissions/suggestions.ts` (re-exported by `bashPermissions.ts`, used by `BashTool.tsx`), `permissions/ui/shellPermissionHelpers.tsx` |
| `hasWildcards` | `(pattern: string) => boolean` | `tools/BashTool/bashPermissions/suggestions.ts` |
| `matchWildcardPattern` | `(pattern: string, command: string, caseInsensitive?: boolean) => boolean` (default `false`) | `tools/BashTool/bashPermissions/*` (rule matching, sandbox exclusions, `BashTool.tsx`), `tools/PowerShellTool/powershellPermissions.ts` (always case-insensitive), `tools/{FileRead,FileEdit,FileWrite,Grep,Glob}Tool` |
| `parsePermissionRule` | `(permissionRule: string) => ShellPermissionRule` | `tools/PowerShellTool/powershellPermissions.ts`, `tools/BashTool/bashPermissions/suggestions.ts` |
| `suggestionForExactCommand` | `(toolName: string, command: string) => PermissionUpdate[]` | `tools/PowerShellTool/powershellPermissions.ts`, `tools/BashTool/bashPermissions/suggestions.ts` |
| `suggestionForPrefix` | `(toolName: string, prefix: string) => PermissionUpdate[]` | `tools/BashTool/bashPermissions/suggestions.ts` |
| `ShadowType` (type, `shadowedRuleDetection.ts`) | `'ask' \| 'deny'` | the UI below |
| `UnreachableRule` (type) | `{ rule: PermissionRule; reason: string; shadowedBy: PermissionRule; shadowType: ShadowType; fix: string }` | `permissions/ui/rules/PermissionRuleList.tsx`, `AddPermissionRules.tsx`, `permissions/ui/PermissionDecisionDebugInfo.tsx` |
| `DetectUnreachableRulesOptions` (type) | `{ sandboxAutoAllowEnabled: boolean }` | the same |
| `isSharedSettingSource` | `(source: PermissionRuleSource) => boolean` | the module itself; keep it exported |
| `detectUnreachableRules` | `(context: ToolPermissionContext, options: DetectUnreachableRulesOptions) => UnreachableRule[]` | `platform/doctor/doctorContextWarnings.ts`, `AddPermissionRules.tsx`, `PermissionDecisionDebugInfo.tsx` |
| `CROSS_PLATFORM_CODE_EXEC` (`dangerousPatterns.ts`) | `readonly` tuple of strings (`as const`) | the detection; `platform/shell/powershell/dangerousCmdlets.ts` |
| `DANGEROUS_BASH_PATTERNS` | `readonly string[]` | the detection |
| `isDangerousBashPermission` (barrel) | `(toolName: string, ruleContent: string \| undefined) => boolean` | tests |
| `isDangerousPowerShellPermission` (barrel) | same shape | tests |
| `isDangerousTaskPermission` (barrel) | same shape | tests |
| `DangerousPermissionInfo` (type, barrel) | `{ ruleValue: PermissionRuleValue; source: PermissionRuleSource; ruleDisplay: string; sourceDisplay: string }` | `permissions/permissionSetup/startupContext.ts` |
| `findDangerousClassifierPermissions` (barrel) | `(rules: PermissionRule[], cliAllowedTools: string[]) => DangerousPermissionInfo[]` | `startupContext.ts` (only when `TRANSCRIPT_CLASSIFIER` is on and the start mode is `auto`) |
| `removeDangerousPermissions` (barrel) | `(context: ToolPermissionContext, dangerousPermissions: DangerousPermissionInfo[]) => ToolPermissionContext` | `startupContext.ts` |
| `stripDangerousPermissionsForAutoMode` (barrel) | `(context: ToolPermissionContext) => ToolPermissionContext` | `permissionSetup/modeTransition.ts`, `planAutoMode.ts`, `platform/main/action/mcpAndPerms.ts`, `agent/repl/REPL.tsx`, `permissions/ui/ExitPlanModePermissionRequest/…`, `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| `restoreDangerousPermissions` (barrel) | `(context: ToolPermissionContext) => ToolPermissionContext` | `modeTransition.ts`, `planAutoMode.ts`, `autoModeGate.ts`, `ExitPlanModePermissionRequest`, `ExitPlanModeV2Tool.ts` |

`dangerousRuleStash.ts` imports the detection from
`permissionSetup/dangerousRuleDetection.ts` directly, and `startupContext.ts`
does too. Both paths must keep resolving.

## Observable behaviour

### Classifying a rule body

- `permissionRuleExtractPrefix(body)` returns everything before a final `:*`
  when there is at least one character before it, and `null` otherwise. Nothing
  is trimmed. `npm run:*` gives `npm run`, ` npm:*` gives ` npm`, `a:*:*` gives
  `a:*`, `*:*` gives `*`. `:*`, `npm`, `npm:` and `npm:*x` give `null`.
- `hasWildcards(body)` is `false` for any body ending in `:*`. Otherwise it is
  `true` when some `*` is preceded by an even number of backslashes (zero
  included): `a\*` has none, `a\\*` has one, `a\\\*` has none.
- `parsePermissionRule(body)` checks in this order: a legacy prefix (see the
  first item) gives `{ type: 'prefix', prefix }`; a wildcard gives
  `{ type: 'wildcard', pattern: body }`, with the body unchanged; anything else
  gives `{ type: 'exact', command: body }`. So `x*y:*` is a prefix `x*y`, `:*`
  is exact, and the empty body is exact `''`.

### Matching a wildcard body

`matchWildcardPattern(pattern, command, caseInsensitive = false)`:

- The pattern is trimmed at both ends. The command is not.
- `\*` stands for a literal star, and `\\` for a literal backslash. Any other
  backslash is literal, and so is a lone trailing one.
- Each unescaped `*` matches any run of characters, empty included, and that
  run may contain newlines.
- Every other character matches only itself, regex metacharacters included
  (`. + ? ^ $ { } ( ) | [ ] \`). Quotes are ordinary characters.
- The whole command must match, from its first character to its last.
- **The optional tail.** When the pattern ends in a space and a star, and that
  star is the only unescaped one, the space and what follows are optional. So
  `git *` matches `git` as well as `git add .`. Only a space starts that tail:
  `git *` does not match `git<TAB>status` or `gitx`. With two or more unescaped
  stars the tail is required, so `* run *` does not match `npm run`.
- With `caseInsensitive`, letters match in either case. The default is
  case-sensitive.

### Suggestions

- `suggestionForExactCommand(tool, command)` returns one update:
  `{ type: 'addRules', rules: [{ toolName: tool, ruleContent: command }], behavior: 'allow', destination: 'localSettings' }`.
  The command goes in unchanged. Parentheses are not escaped here.
- `suggestionForPrefix(tool, prefix)` returns the same shape with
  `ruleContent: '<prefix>:*'`. That body classifies back as the same prefix.
- Each call returns a new array.

### Unreachable rules

`detectUnreachableRules(context, { sandboxAutoAllowEnabled })` reads the three
rule lists of the context, parsed the way the permission check parses them:
legacy tool names are normalized (`Task` is `Agent`), and `Tool()` and
`Tool(*)` mean the whole tool.

- Only an allow rule **with a body** can be reported. It is reported when
  there is a tool-wide deny or ask rule for exactly the same tool name. The
  name comparison is case-sensitive.
- **Deny first.** If a tool-wide deny exists, the rule is reported once with
  `shadowType: 'deny'`, and ask is not considered. Otherwise a tool-wide ask
  gives `shadowType: 'ask'`. `shadowedBy` is the first tool-wide rule of that
  kind, in source order.
- **The sandbox exception.** With `sandboxAutoAllowEnabled`, a tool-wide
  **Bash** ask rule does not shadow when it comes from a personal source
  (`userSettings`, `localSettings`, `flagSettings`, `cliArg`, `session`). It
  still shadows from a shared source. The exception looks only at the first
  tool-wide ask rule found. It never applies to deny, or to any other tool.
- `isSharedSettingSource` is `true` for `projectSettings`, `policySettings` and
  `command`, and `false` for every other source.
- **Order.** The results follow the allow rules: by source in the order
  `userSettings`, `projectSettings`, `localSettings`, `flagSettings`,
  `policySettings`, `cliArg`, `command`, `session`, and within a source in list
  order.
- **Texts.** `<tool>` is the canonical name of the shadowing rule's tool. The
  sources use their lowercase display names: `user settings`,
  `shared project settings`, `project local settings`,
  `command line arguments` (flag settings), `enterprise managed settings`,
  `CLI argument`, `command configuration`, `current session`.
  - deny `reason`: `Blocked by "<tool>" deny rule (from <deny source>)`.
  - ask `reason`: `Shadowed by "<tool>" ask rule (from <ask source>)`.
  - `fix`: `Remove the "<tool>" <deny|ask> rule from <shadowing source>, or remove the specific allow rule from <allow source>`.

  `/doctor` prints these lines, and the rule list UI shows them.
- `rule` and `shadowedBy` are full rules:
  `{ source, ruleBehavior, ruleValue }`.

### The dangerous names

`CROSS_PLATFORM_CODE_EXEC` holds, in this order: `python`, `python3`,
`python2`, `node`, `deno`, `tsx`, `ruby`, `perl`, `php`, `lua`, `npx`, `bunx`,
`npm run`, `yarn run`, `pnpm run`, `bun run`, `bash`, `sh`, `ssh`.
`DANGEROUS_BASH_PATTERNS` is that list followed by `zsh`, `fish`, `eval`,
`exec`, `env`, `xargs`, `sudo`. Both are pinned exactly.

PowerShell checks the shared list plus these names: `pwsh`, `powershell`,
`cmd`, `wsl`, `iex`, `invoke-expression`, `icm`, `invoke-command`,
`start-process`, `saps`, `start`, `start-job`, `sajb`, `start-threadjob`,
`register-objectevent`, `register-engineevent`, `register-wmievent`,
`register-scheduledjob`, `new-pssession`, `nsn`, `enter-pssession`, `etsn`,
`add-type`, `new-object`.

### Is a rule dangerous

- `isDangerousBashPermission(tool, body)` is `false` unless `tool` is exactly
  `Bash`. It is `true` for no body, an empty body, or a body that is `*` once
  trimmed. Otherwise the body is trimmed and lowercased, and it is `true` when,
  for some name `N` on the Bash list, the body is one of these:
  - `N` itself;
  - `N:*`, `N*` or `N *`;
  - a body that starts with `N -` and ends with `*`.

  Anything else is `false`.
- `isDangerousPowerShellPermission(tool, body)` follows the same rules for
  `tool === 'PowerShell'`, with the PowerShell list. Each name also counts with
  `.exe` added to its **first** word: `python.exe`, and `npm.exe run` for
  `npm run`.
- `isDangerousTaskPermission(tool, body)` is `true` for `Agent` and its legacy
  name `Task`, whatever the body, and `false` for any other tool. Names are
  case-sensitive.

### Scanning for dangerous rules

`findDangerousClassifierPermissions(rules, cliAllowedTools)` returns the
findings from the loaded rules first, then those from `--allowed-tools`, each
in input order.

- **Loaded rules.** Only rules with `ruleBehavior: 'allow'` are judged. A rule
  is dangerous when any of the three predicates says so. Each finding keeps the
  rule's `ruleValue` and `source`.
  - `ruleDisplay` is `Tool(body)` with the body as stored, unescaped, or
    `Tool(*)` when there is no body.
  - `sourceDisplay` depends on the source:
    - a settings source shows its file path, relative to the current working
      directory when that form is shorter, and absolute otherwise. A project
      or local file shows as `.claudin/settings.json` or
      `.claudin/settings.local.json` from the project root, and the managed
      file shows absolute;
    - a flag source with no `--settings` file, and the `cliArg`, `command` and
      `session` sources, show the source name itself.
- **`--allowed-tools` entries.** An entry is read as `Name` or `Name(body)`,
  where the body holds no `)`. Name and body are trimmed. An entry that does not
  fit that shape is skipped.
  - Each finding has `source: 'cliArg'` and `sourceDisplay: '--allowed-tools'`,
    and its `ruleValue` is `{ toolName, ruleContent }` (`ruleContent` is
    `undefined` with no parentheses, `''` with empty ones).
  - `ruleDisplay` is the entry exactly as typed when the body is non-empty, and
    `Name(*)` otherwise.

### Entering auto mode: `stripDangerousPermissionsForAutoMode`

- It reads every allow list of the context, parses each string the way the
  permission check does, and judges the rules as the scan above does.
- **Nothing dangerous.** The result is a new context with the same rules. Its
  `strippedDangerousRules` is the context's existing stash when there is one,
  and `{}` otherwise.
- **Something dangerous.** Each dangerous rule from a writable source
  (`userSettings`, `projectSettings`, `localSettings`, `session`, `cliArg`)
  leaves that source's allow list. Every copy of its string goes, and the other
  rules keep their order. The stash becomes a record, by source, of the rule
  strings taken out, in their stored (escaped) form and in list order.
- **Unwritable sources.** Dangerous rules from `flagSettings`, `policySettings`
  and `command` stay in force and are not stashed.
- Deny and ask lists, `mode`, the working directories and every other field are
  left as they were. The input context is not mutated. Nothing is written to
  disk.
- Each dangerous rule found is logged to the debug log. That line is not
  pinned.

### Leaving auto mode: `restoreDangerousPermissions`

- **No stash** (`undefined`): the very same context object comes back. A
  second exit is therefore a no-op.
- **A stash.** Each non-empty source list is appended, in order, to that
  source's allow list, which is created if it is missing. Empty lists add
  nothing, not even an empty key. The result has the `strippedDangerousRules`
  key set to `undefined`. Deny, ask and mode are left as they were.
- A strip followed by a restore gives back every rule. The restored ones come
  after the rules that stayed.

### Removing a list of findings: `removeDangerousPermissions`

- Each finding from a writable source removes, from that source's allow list,
  every string equal to the finding's `ruleValue` written in rule form: a body
  with parentheses is written escaped, and no body means the bare tool name.
- Findings from unwritable sources are skipped. With no findings the very same
  context comes back. The stash is not touched.
- Startup uses this with the findings from `--allowed-tools`. Those entries are
  removed as typed, including `Bash(*)`.

## Edge cases and errors

- No function here throws on any string input, and none reads from or writes to
  disk. The scan reads only the settings paths and the working directory.
- Empty inputs. An empty body classifies as exact `''`. An empty rule list or
  `--allowed-tools` list gives no findings. An empty context gives no
  unreachable rules.
- A prefix body is not checked for word boundaries here. `git:*` is the prefix
  `git`, and deciding whether `gitx` starts with it is the caller's job.
- A version-suffixed or path-qualified interpreter (`python3.12:*`,
  `/usr/bin/python:*`) and wrappers (`timeout:*`, `nohup *`) are not dangerous.
  Neither are wildcards broader than a listed name (`p*`, `* *`, `**`). See
  findings 4 and 5.

## Security requirements

- **The matcher knows no shell syntax, and its callers must keep it that way
  safe.** A wildcard runs across `&&`, `;`, `|`, `$(…)`, backticks, redirects
  and newlines. So `git *` matches `git status && rm -rf /`, and `echo *`
  matches `echo a<LF>rm -rf /`. Quotes in a pattern are literal, so `echo "*"`
  matches `echo "a"; rm -rf / "`. It is safe only because the Bash permission
  check splits compound commands, strips redirects, wrappers and env prefixes,
  and refuses compound commands for allow rules **before** it calls the
  matcher. The rewrite must not add shell awareness here that the callers then
  rely on, and must not remove anything the suite pins.
- **Every "must not match" row stays false.** These are pinned:
  - look-alike words (`gitx`, `git-lfs`, `npm runx`);
  - a leading space or a tab in the command;
  - a case difference (by default), and an env prefix or `sudo` in front;
  - extra arguments after a pattern with no star, and a missing literal tail;
  - regex metacharacters, and an escaped star;
  - the required tail of a pattern with several stars.
- **Detection never shrinks.** Every listed name stays dangerous in every rule
  shape, for both shells, with and without `.exe` for PowerShell. Tool-wide
  rules and every `Agent`/`Task` rule stay dangerous. Widening the lists is
  welcome. Narrowing them is a regression.
- **The stash never loses a rule it took.** A strip followed by a restore gives
  back every stripped string. The stash is cleared on restore, so a rule is put
  back at most once per strip.
- **Deny and ask are never touched** by the strip, the restore or the removal.
- **Unreachable-rule reporting never claims a rule is reachable when a
  tool-wide deny applies.** The sandbox exception applies to ask rules only,
  and only for Bash from personal sources.

## Tests that pin it

- `src/permissions/shellRules.matching.characterization.test.ts` (106 tests):
  the prefix extraction, the wildcard detection, the classification, the
  matching rows in both directions (adversarial inputs included), the
  case-insensitive mode, and the suggestions.
- `src/permissions/shellRules.shadowed.characterization.test.ts` (44): shared
  sources, what is and is not reported, the sandbox exception, the order and
  the texts.
- `src/permissions/shellRules.dangerous.characterization.test.ts` (113): both
  name lists, the three predicates, and the scan with real settings paths under
  temp directories (`CLAUDIN_CONFIG_DIR`, the original and current working
  directory, and the `--settings` path, all redirected).
- `src/permissions/shellRules.stash.characterization.test.ts` (17): strip,
  restore, round trip and removal.
- `scripts/migrations/probes/rewrite-permissions-shellRules.json`: 40 probes
  over the five files. Each of them turns the suites red. Every "must not
  match" and "must not report" case has its own probe.
- Kept, this project's own (residue sweep in `phase-3.md`):
  `src/permissions/dangerousRuleDetection.test.ts` and
  `dangerousRuleStash.test.ts`.
- Callers' suites that load the unit: `tools/BashTool/bashPermissions.test.ts`,
  `permissions/modeTransition.test.ts` and `permissions/autoModeGate.test.ts`.

The unit names no inherited test (`phase-3.json` has no `tests` entry for it),
so nothing was folded in or deleted.

**Feature flags.** None of the five files reads `feature()`. `BASH_CLASSIFIER`
and `TRANSCRIPT_CLASSIFIER` only decide whether callers invoke the unit, so the
suite needs no `--feature` child run.

## Out of scope

- Splitting compound commands, stripping wrappers, env prefixes and redirects,
  and prefix matching with word boundaries. These belong to the Bash permission
  check (`tools/BashTool/bashPermissions/`), whose phase pins them.
- Detecting overlaps between specific rules, such as a specific deny that
  covers a specific allow. That was never in this unit.
- Writing the strip back to settings files. The strip has always been
  in-memory only.

## Findings

The characterization fixes none of these. The suites pass on the old code, and
a finding decided "fix" is left unpinned so that the rewrite can apply it.

1. **Security: a non-canonical spelling survives the strip.**
   - **What happens.** `--allowed-tools` entries go into the context as typed.
     Started in another mode and later switched into auto (Shift+Tab, plan
     exit), an entry such as `Bash(*)`, `Bash()`, `Task` or `Task(x)` is found
     dangerous but is **not removed**, because removal looks for the canonical
     string (`Bash`, `Agent`, `Agent(x)`).
   - **The effect.** The stash records the canonical form, so the tool-wide
     Bash allow stays in force through auto mode and gets around the
     classifier. On exit a second, canonical copy is added.
   - **Decision: fix.** Remove every allow string whose parsed value equals a
     dangerous one, and stash the strings actually removed. This is pure
     hardening: the canonical spelling of the same rule is already stripped,
     so no legitimate use depends on the other spelling surviving.
2. **A second strip overwrites the stash.**
   - **What happens.** When the context already holds a stash and new
     dangerous rules are found, the stash is replaced. The rules stripped
     earlier are already gone from the lists, so they are lost for the session
     (settings files are untouched).
   - **Decision: fix.** Merge the new strings into the existing stash. No
     caller or stored data depends on losing them.
3. **The restore does not deduplicate.** If the user re-added a stripped rule
   while in auto mode, leaving auto mode lists it twice. Decision: fix. Skip
   strings already present. Harmless today, but the duplicate shows in the
   rule list.
4. **Security: the name list misses broader and indirect forms.**
   - **What is missed.** Wildcards wider than a name (`Bash(p*)`, `Bash(* *)`,
     `Bash(**)`), versioned or absolute interpreters (`python3.12:*`,
     `/usr/bin/python:*`), and broader subcommand prefixes (`npm:*` covers
     `npm run` and `npm exec`). Wrappers that run their argument (`timeout`,
     `nohup`, `nice`, `command`, `find -exec`) are missed too.
   - **The effect.** All of these stay active in auto mode.
   - **Decision: keep for parity, and track.** Flagging more rules changes what
     users who rely on them see in auto mode, so it is not pure hardening. A
     candidate follow-up: treat a wildcard rule as dangerous when it matches a
     sample invocation of any listed name (`python -c x`).
   - Pinned by the "not dangerous" rows.
5. **Security: unwritable sources keep their dangerous rules in auto mode.**
   - **What happens.** Rules from `flagSettings` (a `--settings` file),
     `policySettings` and `command` are found but neither removed nor stashed.
     The strip is in-memory, so they could be removed.
   - **Decision: keep for parity, and track.** Policy is an administrator's
     choice, and the flag file is an explicit launch choice. Changing it changes
     visible behaviour. Pinned by "rules from sources that cannot be written
     stay in force".
6. **An `--allowed-tools` entry with `)` in its body is not scanned.**
   - **What happens.** `Agent(a(b))` is skipped at startup, although the
     permission check reads it as an Agent rule. The mid-session strip, which
     uses the real parser, does catch it.
   - **Decision: fix.** Parse entries with the same rule parser the permission
     check uses. Legitimate use never notices.
7. **Over-flagging by case.** Bash bodies are lowercased, so `Bash(PYTHON:*)`
   counts as dangerous although Bash is case-sensitive. Decision: keep for
   parity. It is harmless: it only strips a rule in auto mode.
8. **The legacy suffix wins over stars.** `x*y:*` is the prefix `x*y`, a
   literal star and not a wildcard. Decision: keep for parity. Stored rules may
   rely on it, and the prefix suggestion writes `:*` rules.

## Target design

- **`shellRuleMatching.ts`** stays a pure module with no imports beyond the
  `PermissionUpdate` type.
  - Classification, wildcard compilation and the suggestions are separate small
    functions.
  - The wildcard compiler turns a pattern into an anchored regular expression
    in one pass, with the escapes and the optional-tail rule stated as named
    steps. The compiled form may be cached by pattern and flag.
- **`shadowedRuleDetection.ts`** holds one pure function over the three parsed
  rule lists. The two text templates live in one table keyed by shadow type,
  and the shared-source set is a constant set.
- **`dangerousPatterns.ts`** is data only, and its two exports keep their
  order.
- **`dangerousRuleDetection.ts`**:
  - one table-driven predicate per shell, over the same rule shapes, with the
    PowerShell `.exe` variant derived from the name;
  - the scan as a pure function, with source display injected or derived
    through the settings-path module;
  - `--allowed-tools` entries parsed with the shared rule parser (finding 6).
- **`dangerousRuleStash.ts`**:
  - strip and restore are pure transforms over `ToolPermissionContext`;
  - removal matches on the parsed rule value, not the string (finding 1);
  - the stash merges (finding 2), and the restore skips duplicates (finding 3);
  - the writable-source set is a single constant shared by the removal and the
    stash, so the two can never disagree.
- **Types.** Explicit throughout, with no `any`. The stash keeps the
  `ToolPermissionRulesBySource` shape, because callers spread it.

## Outcome

Rewritten per method on 2026-10-03.
- **What was rewritten.** The 22 inherited bodies and the `dangerousPatterns.ts` tables. The four
  characterization suites pass unchanged, and 5,937 caller tests stay green.
- **Fixes, each with a test.**
  1. The auto-mode strip removes every allow string whose parsed value matches a dangerous rule, so
     `Bash(*)`, `Bash()`, `Task` and `Task(x)` go. The strings are stashed as typed.
  2. A second strip adds to the stash instead of replacing it.
  3. Leaving auto skips rules already present.
  4. An `--allowed-tools` entry that is not plain `Name(body)` is read with the permission-check
     parser.
- **Kept.** Findings 4, 5, 7 and 8. The matcher stays shell-unaware. Its callers split compound
  commands, and that requirement is recorded above. The narrow dangerous-rule check is tracked in
  `bugs/permission-core-security-findings.md`.
- **Probes.**
  - `rewrite-permissions-shellRules.json`: 98 probes, one on every must-not-match case.
  - The older `permissionSetup.json`: its probes on these files were re-pointed.
- **Residue, reviewed.** 40 lines of Claude Code remain. They are the signatures of the detection and
  stash functions, the dangerous-rule result fields, and one `ToolPermissionContext` literal in the
  fixes test, whose fields the contract names.
