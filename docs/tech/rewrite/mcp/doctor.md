# Spec: `mcp/doctor`

## Purpose

The health check behind `claudin mcp doctor [name]`. For every MCP server name
the configuration knows (or for one name), it reports where the server is
declared, which declaration the runtime would actually load, whether it is
pending approval or disabled, which config errors concern it, and, unless asked
not to, whether the server answers a live MCP connection. It returns a report
object. The command's handler turns that report into text or JSON and an exit
code.

## Public contract

`src/mcp/doctor.ts` keeps these exports.

| Export | Signature | Used by |
|---|---|---|
| `doctorAllServers` | `(options?: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter }, deps?: McpDoctorDependencies) => Promise<McpDoctorReport>`. `options` defaults to `{ configOnly: false }` | `src/platform/headless/handlers/mcp.tsx` (`mcpDoctorHandler`) |
| `doctorServer` | `(name: string, options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter }, deps?: McpDoctorDependencies) => Promise<McpDoctorReport>` | `src/platform/headless/handlers/mcp.tsx` |
| `buildEmptyDoctorReport` | `(options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter; targetName?: string }) => McpDoctorReport` | tests only |
| `findingsFromValidationErrors` | `(validationErrors: ValidationError[]) => McpDoctorFinding[]` | tests only |
| `McpDoctorReport` | `{ generatedAt: string; targetName?: string; scopeFilter?: McpDoctorScopeFilter; configOnly: boolean; summary: { totalReports; healthy; warnings; blocking: number }; findings: McpDoctorFinding[]; servers: McpDoctorServerReport[] }` | `handlers/mcp.tsx` |
| `McpDoctorScopeFilter` | `'local' \| 'project' \| 'user' \| 'enterprise'` | `handlers/mcp.tsx` |
| `McpDoctorServerReport` | `{ serverName: string; requestedByUser: boolean; definitions: McpDoctorDefinition[]; liveCheck: McpDoctorLiveCheck; findings: McpDoctorFinding[] }` | the `--json` output |
| `McpDoctorDefinition` | `{ name; sourceType: 'local' \| 'project' \| 'user' \| 'enterprise' \| 'managed' \| 'plugin' \| 'claudeai' \| 'dynamic' \| 'internal'; sourcePath?; transport?; runtimeVisible: boolean; runtimeActive: boolean; pendingApproval?: boolean; disabled?: boolean }` | the `--json` output |
| `McpDoctorLiveCheck` | `{ attempted: boolean; durationMs?: number; error?: string; result?: 'connected' \| 'needs-auth' \| 'failed' \| 'pending' \| 'disabled' \| 'skipped' }` | the `--json` output |
| `McpDoctorFinding` | `{ blocking: boolean; code: string; message: string; remediation?: string; scope?: string; serverName?: string; severity: McpDoctorSeverity; sourcePath?: string }` | the `--json` output |
| `McpDoctorSeverity` | `'info' \| 'warn' \| 'error'`. `info` is never produced | the `--json` output |
| `McpDoctorDependencies` | `{ getAllMcpConfigs; getMcpConfigsByScope; getProjectMcpServerStatus; isMcpServerDisabled; describeMcpConfigFilePath; connectToServer; clearServerCache }`, each typed as the function of that name in `src/mcp/config.ts`, `src/mcp/utils.ts` and `src/mcp/client.ts` | tests; the default is the real functions |

`knip-baseline.json` lists four of the types as unused exports. They stay,
because they type the `--json` output.

The report is the `--json` format, printed as is. Its exact bytes, with the
run-specific values and the wording masked, are pinned by
`src/mcp/__fixtures__/rewrite/doctor-report.json`. Key order is part of it:
- **report:** `generatedAt`, `targetName`, `scopeFilter`, `configOnly`, `summary`, `findings`, `servers`;
- **summary:** `totalReports`, `healthy`, `warnings`, `blocking`;
- **server:** `serverName`, `requestedByUser`, `definitions`, `liveCheck`, `findings`;
- **definition:** `name`, `sourceType`, `sourcePath`, `transport`, `runtimeVisible`, `runtimeActive`, `pendingApproval`, `disabled`;
- **live check:** `attempted`, `result`, `durationMs`, `error`;
- **finding:** `blocking`, `code`, `message`, `remediation`, `scope`, `serverName`, `severity`, `sourcePath`.

An absent value is left out of the JSON.

## Observable behaviour

### 1. The report envelope

- **`generatedAt`** is the ISO timestamp of the call.
- **`configOnly` and `scopeFilter`** echo the options.
- **`targetName`** is the name for `doctorServer`, and absent for `doctorAllServers`.
- **`findings`** holds the global findings (5).
- **`servers`** holds one report per name.
- **`buildEmptyDoctorReport`** returns that envelope with zero counts and empty lists, as a fresh object on every call.

### 2. Which names get a report

- **`doctorAllServers`:**
  - **The names.** Every name declared in a selected scope. With no filter, also every name the runtime would load (`getAllMcpConfigs`): plugin servers and claude.ai connectors.
  - **The order.** Sorted by UTF-16 code unit, so `Zed` comes before `alpha`. Each name appears once.
  - **The flag.** `requestedByUser` is `false`.
- **`doctorServer`** gives exactly one report, for the name given, with `requestedByUser: true`. That holds even when the name is configured nowhere.
- **The selected scopes.** With no filter: enterprise (`managed-mcp.json`), local, project (`.mcp.json`) and user. With a filter: that scope only.

### 3. Definitions

**One definition per selected scope that declares the name,** in the order
enterprise, local, project, user. The scope readers ignore approval, the policy
and the disabled list, so a denied, rejected or disabled server is still
listed.

| Field | Value |
|---|---|
| `name` | the server name |
| `sourceType` | the scope |
| `sourcePath` | enterprise: the `managed-mcp.json` path. Project: `<cwd>/.mcp.json`, even when the entry comes from a parent directory (Findings, 5). User: the global config file. Local: `<global config file> [project: <cwd>]` |
| `transport` | the entry's `type`, or `stdio` when it has none |
| `pendingApproval` | `true` only for a project definition whose approval status is `pending`; `false` otherwise |
| `disabled` | whether the name is disabled. That means the project's disabled list or, for claude.ai connectors, not being in its enabled list. The same value goes on every definition of the name |
| `runtimeActive` | `true` for at most one definition: the one the runtime would load. It is not disabled, and it has the same source type and identity as the runtime's config. The identity is the scope and transport, plus the URL for remote transports and the command and arguments for stdio |
| `runtimeVisible` | equal to `runtimeActive` |

**An observed definition** is appended when the runtime would load a config for
the name, no listed definition has the same source type, `sourcePath` and
transport, and one of these holds:
- no definition was listed and there is no scope filter;
- definitions were listed but none of them runs. With `--scope user` on a name that local shadows, for example, the local one is appended.

Its fields:
- **`sourceType`:**
  - `plugin` for a dynamic config with a non-empty plugin source. A dynamic config with an empty or absent source is plain `dynamic`;
  - `claudeai`, `managed`, `dynamic` as the runtime scope says;
  - otherwise the scope itself.
- **`sourcePath`:** `plugin:<pluginSource>` for plugins, `claude.ai` for connectors, and otherwise the scope word, for example `local` (Findings, 4).
- **`transport`:** as above.
- **`runtimeActive` and `runtimeVisible`:** `true` unless the name is disabled.
- **`disabled`:** as above.
- **`pendingApproval`:** absent.

### 4. Findings on a server, in this order

1. **Validation findings** whose `serverName` is this server (5).
2. **Shadowing.** When more than one definition comes from local, project, user or enterprise, two warnings. A plugin or claude.ai definition never counts here.
3. **State.** One per definition that is pending approval, and one per definition that is disabled.
4. **`state.not_found`,** when there is no definition at all.
5. **The live finding** (6).

| Code | Severity | Blocking | Extra fields | The message states |
|---|---|---|---|---|
| `duplicate.same_name_multiple_scopes` | warn | no | `serverName` | the active source type (the running definition's, or else the first listed) |
| `scope.shadowed` | warn | no | `serverName` | the server name |
| `state.pending_project_approval` | warn | no | `scope: 'project'`, `serverName`, `sourcePath` | the server name, and that it awaits project approval |
| `state.disabled` | warn | no | `serverName`, `sourcePath` of that definition | the server name, and that it is disabled |
| `state.not_found` | error | yes | `serverName` | the server name, and that no selected source declares it |
| `auth.needs_auth` | warn | no | `serverName`, `sourcePath` of the running definition | the server name, and that it needs authentication |
| `health.failed` | error | yes | `serverName`, `sourcePath` of the running definition | the server name, and the connection error when there is one |
| `stdio.command_not_found` | error | yes | as `health.failed` | as `health.failed`. The remediation mentions `PATH` |

- **Remediation.** Every finding above carries one.
- **Wording.** The codes, severities and fields are the contract. The wording is free, apart from the facts listed.

### 5. Validation findings

**The source.** The `errors` of `getMcpConfigsByScope` for each selected scope,
in the order enterprise, local, project, user. With a filter, the other scopes'
errors are left out.

**`findingsFromValidationErrors`** maps each error, in order:

| Error message | Code |
|---|---|
| exactly `MCP config is not a valid JSON` | `config.invalid_json` |
| starting with `Missing environment variables:` (case-sensitive) | `config.missing_env_vars` |
| containing `Windows cannot launch npx directly` (the wording `mcp/config` has emitted since its rewrite on 2026-10-03) anywhere | `config.windows_npx_wrapper_required` |
| exactly `Does not adhere to MCP server configuration schema` | `config.invalid_schema` |
| anything else | `config.validation_error` |

**The fields.**
- **Severity:** metadata severity `fatal` gives `error` and blocking. `warning`, absent or anything else gives `warn`, not blocking.
- **The rest:** `message` is the error's message, `remediation` its suggestion, `sourcePath` its file, and `scope` and `serverName` come from its metadata.

**Where a finding goes.** A finding with a `serverName` goes on that server's
report. A finding without one is global, in `report.findings`, and is never
copied onto servers. Both entry points carry the global findings. Real cases:
- **A `.mcp.json` that is not JSON:** global, blocking, `scope: 'project'`.
- **A `.mcp.json` off the schema:** global, blocking, and none of that file's servers appear at all.
- **An invalid user entry:** global, `scope: 'user'`, no `sourcePath`.
- **A broken `managed-mcp.json`:** global, blocking, `scope: 'enterprise'`. The file does not take over.
- **An unset `${VAR}`:** a warning on its server.
- **A Windows `npx` command:** a warning on its server.

### 6. The live check

**With `configOnly`:** `{ attempted: false, result: 'skipped' }` for every
server, whatever its state. Nothing is started or contacted.

**Without it,** the doctor checks the config the runtime would load for the
name. It does so only when a definition runs, or when an observed definition
was added. The results:

| Case | `liveCheck` |
|---|---|
| nothing to check, a definition pending approval | `{ attempted: false, result: 'pending' }` |
| nothing to check, a definition disabled | `{ attempted: false, result: 'disabled' }` |
| nothing to check otherwise (not found, denied, rejected, outside a filter, managed take-over) | `{ attempted: false, result: 'skipped' }` |
| connected | `{ attempted: true, result: 'connected', durationMs }` |
| needs authentication | `{ attempted: true, result: 'needs-auth', durationMs }` |
| connection says pending or disabled | `{ attempted: true, result: <that>, durationMs }`, no finding |
| failed | `{ attempted: true, result: 'failed', durationMs, error }` |

- **`durationMs`** is the wall time of the connection attempt.
- **`stdio.command_not_found`** replaces `health.failed` when the running definition is stdio and the error contains `not found`, in any case. A remote error saying "not found" stays `health.failed`.
- **The connection lifecycle.** Each checked server is connected once per call, with the runtime config. Afterwards its connection is always cleared, and a failure while clearing is ignored. When a call returns, no process it started is still running, whatever the outcome. Servers are checked concurrently, and reported in name order.

### 7. The summary

- **`totalReports`:** the number of server reports.
- **`blocking`:** the number of blocking findings, global and per server.
- **`warnings`:** the number of `warn` findings, global and per server.
- **`healthy`:** the number of servers whose live check is `connected` and that carry no `warn` or `error` finding. A config-only run therefore has no healthy server.

### 8. The command (caller-side, pinned here)

`claudin mcp doctor [name] [--scope <s>] [--config-only] [--json]`, through
`mcpDoctorHandler`:

**The help text** says that stdio servers may be spawned and remote servers
contacted unless `--config-only` is given, and to use the command only in
trusted directories.

**`--scope`** must be a config scope. An unknown one prints
`Invalid scope: <s>. Must be one of: …` on stderr, prints nothing on stdout and
exits 1. A known scope is passed through as the filter.

**`--json`** prints `JSON.stringify(report, null, 2)` and a newline, in one
write, and nothing else.

**The text form** is facts by line:
- **The header.** It opens with `MCP Doctor`, then a `Summary` heading. Then come four count lines, in the order total, healthy, warnings, blocking: `- <n> server reports generated`, `- <n> healthy`, `- <n> warnings`, `- <n> blocking issues` (Findings, 9). The single-server form adds `- target: <name>`.
- **One block per server:**
  - a blank line, then the server name on its own line;
  - when a definition runs, `- Active source: <sourceType>` and `- Transport: <transport>`;
  - when there are several definitions, `- Additional definitions: <sourceType>, …` for the ones that do not run;
  - `- State: <result>` for `skipped`, `pending` and `disabled`, or `- Live check: <result>` for the rest;
  - `- Error: <error>` when there is one;
  - each finding as `- <message>`, followed by `- Fix: <remediation>`.
- **Global findings,** when there are any, come last under a `Global findings` heading, in the same message and fix form.

**The exit code** is 1 when the summary counts any blocking finding, and 0
otherwise. Warnings alone exit 0. A thrown error exits 1, with its message on
stderr.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| Nothing configured | no servers, zero counts, exit 0 |
| `doctorServer` on an unknown name | one report: no definitions, `state.not_found`, check `skipped`, exit 1 |
| A name only in another scope than the filter | as unknown. Nothing is started, even if the runtime would run it |
| A runtime-only server (plugin, connector) under any filter | as unknown |
| `--scope dynamic`, `claudeai` or `managed` | accepted by the command, matches no scope: an empty report, exit 0 (Findings, 8) |
| A server that dies before the handshake | `health.failed` with the connection error, exit 1, process gone |
| A stdio command missing from `PATH` | `stdio.command_not_found`, exit 1 |
| A remote URL nobody listens on | `health.failed` |
| A disabled name declared in two scopes | two `state.disabled` warnings, one per definition with its file (Findings, 7) |
| A claude.ai connector not enabled | listed as disabled, with a `state.disabled` warning |
| A connection function that throws instead of resolving | the whole call rejects. The real one never throws (Findings, 10) |

## Security requirements

**What the doctor never starts or contacts, pinned by the tests with real stdio
servers:**
- **Policy:**
  - a server the allow and deny policy blocks: a deny by name or by command, in managed or user settings, an allowlist that leaves it out, or an empty allowlist;
  - with a `managed-mcp.json` in force, every server outside it.
- **Approval and disabled state:**
  - a disabled server, plugin servers included;
  - a project server the user rejected (`disabledMcpjsonServers`);
  - in an interactive session, a project server nobody approved.
- **Options:**
  - anything, under `configOnly`;
  - a target absent from the filtered scope.

**What it does start:** only the config the runtime would load, never a
shadowed declaration. Each server is started at most once per call, and no
process outlives the call.

**The doctor asks nothing itself.** Whether a project server starts depends on
its approval status alone. In a non-interactive session (stdout is not a TTY,
as with `--json | jq` or CI), every unrejected `.mcp.json` server is started,
including one in a parent directory (Findings, 1). The help text's trust
warning is the only guard.

**Described, kept for parity:** Findings 1 and 2.

## Tests that pin it

- **The characterization suite, four files in `src/mcp/`, 127 tests,** 3 green runs in a row. Coverage of `doctor.ts`: 100% of functions and 99.6% of lines. The one line left is the identity of an `sdk` config, which never reaches the doctor.
  - **`doctor.config.characterization.test.ts`** (37), config only, real files: the envelope, names and order, definitions and their paths, precedence, shadowing, approval and disabled state, runtime-only servers, not found, validation findings, and the scope filter.
  - **`doctor.live.characterization.test.ts`** (26), real stdio servers and local HTTP ports:
    - each outcome;
    - no process left behind;
    - config-only starts nothing;
    - the approval, policy, managed take-over, disabled and filter cases above, each checked by whether a process started.
  - **`doctor.contract.characterization.test.ts`** (40):
    - `buildEmptyDoctorReport`;
    - the `findingsFromValidationErrors` tables;
    - through `deps`, with the real config readers and a scripted connection: `needs-auth`, `pending` and `disabled` outcomes, cleanup failures, the connection ledger, and the `dynamic`, `managed`, plugin and claude.ai observed definitions.
  - **`doctor.cli.characterization.test.ts`** (24), `mcpDoctorHandler` with `process.exit` recorded: the help text facts, exit codes, the text lines, `--json`, and the fixture.
- **Harnesses:**
  - `src/mcp/__testutils__/mcpConfigWorld.ts`, shared with `mcp/config`: the temp world, `CLAUDIN_CONFIG_DIR` and the managed directory;
  - `src/mcp/__testutils__/stdioProbeServers.ts`, new: an answering server, a server that dies at once and a missing command, with a pid ledger. The live suites also point `HOME` at the temp world.
- **The fixture:** `src/mcp/__fixtures__/rewrite/doctor-report.json`, the `--json` bytes of a config-only run. It has a global error, a pending project server and a shadowed server. The timestamp, temp paths, global config path and all `message`/`remediation` values are masked.
- **`scripts/migrations/probes/rewrite-mcp-doctor.json`:** 40 probes, 37 on `doctor.ts` and 3 on the handler's exit code and text. Every one turns the suite red.
- **The inherited test** `src/mcp/doctor.test.ts` (443 of 589 lines openclaude) is deleted. Each of its 18 cases is carried into the suite: the empty report, the three validation mappings, global findings not duplicated, shadowing, pending, disabled not checked, config-only, both filter cases, plugin-only servers in both forms, a disabled plugin, failed, needs-auth, the filter not leaking, and not found.
- **Elsewhere:** `src/commands/mcp/doctorCommand.test.ts` pins the options of the command (8 inherited lines; not this unit's). `docs/tech/rewrite/mcp/config.md` names the deleted `doctor.test.ts` among its callers' tests.
- **Prompt text.** None: the unit sends nothing to a model. No snapshot or generated file outside the unit pins its text.
- **Not pinned:**
  - the fixes in Findings 4, 6, 8, 9 and 10;
  - a real `needs-auth` from a server. Reaching it needs an OAuth discovery and a token store, which belong to `mcp/auth`.

## Out of scope

- **Reading config, approval status, the policy and the disabled list:** `mcp/config` and `mcp/core`. The doctor reports what they say.
- **Connecting and cleaning up:** `mcp/connection`. The error texts in live checks are theirs.
- **The text rendering and the exit code** live in `src/platform/headless/handlers/mcp.tsx`, rewritten with the headless handlers. They are pinned here because they are what the user sees.
- **The `internal` source type and `info` severity** are in the types but never produced. Keep them in the types for `--json` readers, with no behaviour.

## Findings

1. **Security: a non-interactive run starts every unrejected project server.**
   - Piped or in CI, the approval status of an unlisted `.mcp.json` server is "approved", so the doctor starts it. That includes a server from a parent directory, such as a `/tmp/.mcp.json` planted by another user.
   - In a TTY the same server is reported pending and left alone.
   - **Decision: keep for parity, and track.** A fix would turn such a server's failure into "pending", and CI exit codes would change from 1 to 0. That is noticeable, so not pure hardening. The help text warns to trust the directory. The approval rule belongs to `mcp/core`.
   - Pinned.
2. **Security, and silent: blocked servers get no explanation.**
   - The policy is honoured. A denied or non-allowlisted server, one outside a managed take-over, and a rejected project server are never started.
   - But the report says nothing about why: no finding, check `skipped`, exit 0.
   - **Decision: keep for parity, and track.** New findings would change the warning counts that `--json` readers see, and they need a policy verdict per server that the doctor does not receive today.
   - Pinned.
3. **A scope filter on a shadowed name checks a definition from another scope.**
   - **Decision: keep for parity.** It is the configuration that actually runs, and the report shows it as an extra definition.
   - Pinned.
4. **Observed definitions from a file-backed scope give the scope word as `sourcePath`** (`local`), where declared ones give the file.
   - **Decision: fix.** For local, project, user and enterprise, use the same file description as declared definitions. Keep `plugin:…`, `claude.ai`, `dynamic` and `managed` as they are. Nothing reads the field but `--json` readers, and the text output never prints it.
   - Not pinned.
5. **Every project definition is attributed to `<cwd>/.mcp.json`,** even when it comes from a parent directory's file.
   - **Decision: keep for parity, and track.** The scope reader returns no file per server. The fix belongs to `mcp/config` and `mcp/core`.
   - Pinned.
6. **When no definition runs, the duplicate warning still names an "active source"** (the first listed).
   - **Decision: fix.** Say that no definition is active. Only the message changes, and no caller reads it.
   - Not pinned.
7. **A disabled name declared in two scopes gives one `state.disabled` per definition,** and so two warnings.
   - **Decision: keep for parity.** Each names a different file, and the counts are part of `--json`.
   - Pinned.
8. **The command accepts `--scope dynamic`, `claudeai` and `managed`,** which match no scope the doctor reads. The result is an empty report, or "not found", with no error.
   - **Decision: fix, in the handler.** Reject them with the same `Invalid scope` error, listing the four. Nothing can depend on an always-empty answer.
   - Not pinned.
9. **The count lines do not agree in number:** `1 server reports generated`, `1 blocking issues`.
   - **Decision: fix.** Use the singular for 1. The suite reads the counts by label, singular or plural.
   - Not pinned.
10. **A connection function that throws takes the whole report down.**
    - **Decision: fix.** Report a thrown error as a `failed` check for that server only. Pure robustness, and the real connection function never throws.
    - Not pinned.
11. **There is no limit on concurrent checks:** every server is started at once. `claudin mcp list` batches its checks.
    - **Decision: keep for parity, and track.** Results are reported in name order either way.

## Target design

- **The facade.** `src/mcp/doctor.ts` stays the module the handler imports, with every export above and the optional `deps` parameter as the one seam for tests.
- **The work, in small modules beside it:**
  - **readings:** each selected scope and the runtime config, read once per call and passed down as data;
  - **definitions:** a pure function from those readings, the approval and disabled lookups and the file descriptions to the definition list, the running one and the observed one;
  - **findings:** pure builders, one per code. A `McpDoctorFindingCode` string-literal union lists every code above, and `findingsFromValidationErrors` is a table from message rule to code;
  - **the live check:** connect, map the outcome, always clear, never throw (Findings, 10);
  - **the summary:** a pure fold over the findings and live checks.
- **Types.** Keep the exported shapes, and their key order, for `--json`. Internally, model "what to check" as a discriminated union: nothing (pending, disabled or skipped) or a config to connect.
- **No `any`,** and no casts on the connection outcome.
- **The text rendering** stays in the handler. When it is rewritten, it applies Findings 8 and 9.

## Outcome

Rewritten per method on 2026-10-04.

**Code.** `doctor.ts` is now a facade over `doctor/`:
- `readings`: one read of each scope per call;
- `definitions`: pure, it builds the definitions and the check plan;
- `findings`: one builder per finding code;
- `liveCheck`: never throws, and always clears the connection;
- `summary` and `scopes`.

The four characterization suites pass unchanged. The handler in `platform/headless/handlers/mcp.tsx`
gained the scope validation and the singular counts that fixes 8 and 9 need.

**Fixes, each with a test:**
- **4.** An observed definition shows its file path.
- **6.** "None of its definitions is active" when nothing runs.
- **8.** `--scope dynamic|claudeai|managed` errors and exits 1.
- **9.** Singular counts.
- **10.** A connection that throws fails only its own server.

Findings 1, 2, 3, 5, 7 and 11 are kept as pinned. The project-scope trust items are tracked in team
memory.

**Probes.** 87 in `rewrite-mcp-doctor.json`.

**Residue.** 102 lines of Claude Code remain: the nine exported report types, which are the
`--json` output contract, and the four function signatures.
