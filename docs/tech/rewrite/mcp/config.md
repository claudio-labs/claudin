# Spec: `mcp/config`

The unit is two files: `src/mcp/config.ts` and `src/mcp/envExpansion.ts`.

## Purpose

This unit decides which MCP servers a session knows about. It reads server
configs from every scope:
- **user:** the `mcpServers` of the global config;
- **project:** `.mcp.json` files from the cwd upward;
- **local:** the `mcpServers` of this project's entry in the global config;
- **enterprise:** the admin's `managed-mcp.json`;
- **plugin:** the servers that enabled plugins declare;
- **claude.ai:** the connectors of a claude.ai login;
- **dynamic:** servers handed in by the caller, such as `--mcp-config`.

It validates each config, expands `${VAR}` placeholders, and merges the scopes
by precedence. It filters the result through the managed allow and deny policy,
and drops plugin and connector servers that duplicate one the user configured.
It also writes the user, project and local scopes (`claudin mcp add` and
`remove`, the desktop import, `/import`), and keeps the per-project lists of
enabled and disabled servers.

`envExpansion.ts` holds the placeholder syntax on its own, because the plugin
MCP and LSP loaders share it.

The approval dialog for project servers is `mcp/approvalDialogs`. The approval
*status* of a project server comes from `getProjectMcpServerStatus` in
`src/mcp/utils.ts` (`mcp/core`). This unit only applies it, and the suite pins
how it shows in the merge.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `expandEnvVarsInString` (`envExpansion.ts`) | `(value: string) => { expanded: string; missingVars: string[] }` | `src/plugins/mcpPluginIntegration.ts`, `src/plugins/lspPluginIntegration.ts` |
| `getEnterpriseMcpFilePath` | `() => string` | `src/mcp/utils.ts` |
| `unwrapCcrProxyUrl` | `(url: string) => string` | no importer outside the unit |
| `getMcpServerSignature` | `(config: McpServerConfig) => string \| null` | `src/platform/main/defaultAction/headless.ts` |
| `dedupPluginMcpServers` | `(pluginServers: Record<string, ScopedMcpServerConfig>, manualServers: Record<string, ScopedMcpServerConfig>) => { servers: Record<string, ScopedMcpServerConfig>; suppressed: Array<{ name: string; duplicateOf: string }> }` | no importer outside the unit |
| `dedupClaudeAiMcpServers` | same signature as `dedupPluginMcpServers`, with connectors as the first argument | `src/mcp/useManageMCPConnections.ts`, `src/platform/main/defaultAction/headless.ts` |
| `filterMcpServersByPolicy` | `<T>(configs: Record<string, T>) => { allowed: Record<string, T>; blocked: string[] }` | `src/mcp/useManageMCPConnections.ts`, `src/platform/headless/print/mcpReconcile.ts`, `src/platform/main/action/mcpAndPerms.ts` |
| `addMcpConfig` | `(name: string, config: unknown, scope: ConfigScope) => Promise<void>` | `src/commands/mcp/addCommand.ts`, `src/mcp/ui/MCPServerDesktopImportDialog.tsx`, `src/platform/headless/handlers/mcp.tsx`, `src/platform/import/apply.ts` |
| `removeMcpConfig` | `(name: string, scope: ConfigScope) => Promise<void>` | `src/platform/headless/handlers/mcp.tsx`, `src/platform/import/apply.ts` |
| `getProjectMcpConfigsFromCwd` | `() => { servers: Record<string, ScopedMcpServerConfig>; errors: ValidationError[] }` | no importer outside the unit |
| `getMcpConfigsByScope` | `(scope: 'project' \| 'user' \| 'local' \| 'enterprise') => { servers: Record<string, ScopedMcpServerConfig>; errors: ValidationError[] }` | `src/mcp/doctor.ts`, `src/mcp/mcpServerApproval.tsx`, `src/mcp/ui/McpParsingWarnings.tsx`, `src/permissions/ui/trust/TrustDialog.tsx`, `src/platform/headless/handlers/mcp.tsx`, `src/platform/settings/allErrors.ts` |
| `getMcpConfigByName` | `(name: string) => ScopedMcpServerConfig \| null` | `src/mcp/utils.ts`, `src/mcp/ui/MCPStdioServerMenu.tsx`, `src/platform/headless/handlers/mcp.tsx`, `src/platform/headless/print/mcpControlHandlers.ts`, `src/tools/AgentTool/runAgent.ts` |
| `getClaudeCodeMcpConfigs` | `(dynamicServers?: Record<string, ScopedMcpServerConfig>, extraDedupTargets?: Promise<Record<string, ScopedMcpServerConfig>>) => Promise<{ servers: Record<string, ScopedMcpServerConfig>; errors: PluginError[] }>`; the defaults are `{}` and a promise of `{}` | `src/mcp/useManageMCPConnections.ts`, `src/platform/main/action/mcpAndPerms.ts` |
| `getAllMcpConfigs` | `() => Promise<{ servers: Record<string, ScopedMcpServerConfig>; errors: PluginError[] }>` | `src/mcp/client/fetchCapabilities.ts`, `src/mcp/doctor.ts`, `src/mcp/ui/MCPServerDesktopImportDialog.tsx`, `src/platform/headless/handlers/mcp.tsx`, `src/platform/headless/print/mcpRuntime.ts` |
| `parseMcpConfig` | `(params: { configObject: unknown; expandVars: boolean; scope: ConfigScope; filePath?: string }) => { config: McpJsonConfig \| null; errors: ValidationError[] }` | `src/platform/main/action/mcpAndPerms.ts` |
| `parseMcpConfigFromFilePath` | `(params: { filePath: string; expandVars: boolean; scope: ConfigScope }) => { config: McpJsonConfig \| null; errors: ValidationError[] }` | `src/platform/main/action/mcpAndPerms.ts` |
| `doesEnterpriseMcpConfigExist` | `() => boolean`, carrying a `cache` with `clear()` | `src/mcp/useManageMCPConnections.ts`, `src/platform/main/action/mcpAndPerms.ts` |
| `shouldAllowManagedMcpServersOnly` | `() => boolean` | no importer outside the unit |
| `areMcpConfigsAllowedWithEnterpriseMcpConfig` | `(configs: Record<string, ScopedMcpServerConfig>) => boolean` | `src/platform/main/action/mcpAndPerms.ts` |
| `isMcpServerDisabled` | `(name: string) => boolean` | `src/mcp/client/fetchCapabilities.ts`, `src/mcp/doctor.ts`, `src/mcp/useManageMCPConnections.ts`, `src/platform/headless/print/mcpControlHandlers.ts` |
| `setMcpServerEnabled` | `(name: string, enabled: boolean) => void` | `src/mcp/useManageMCPConnections.ts`, `src/platform/headless/print/mcpControlHandlers.ts` |

The types (`ConfigScope`, `McpServerConfig`, `ScopedMcpServerConfig`,
`McpJsonConfig`, the schemas) belong to `src/mcp/types.ts` (`mcp/core`).
`ValidationError` belongs to `src/platform/settings/validation.ts`, and
`PluginError` to `src/shared/types/plugin.ts`.

**Contract constraints:**
- **The module path stays `src/mcp/config.ts`.** `src/platform/headless/print.test.ts` replaces it with `mock.module('src/mcp/config.js', …)`, giving `filterMcpServersByPolicy`, `getMcpConfigByName`, `isMcpServerDisabled` and `setMcpServerEnabled`. `src/platform/settings/allErrors.ts` exists to keep `settings.ts` from importing this module, because this module imports settings. The rewrite must not close that cycle again.
- **`doesEnterpriseMcpConfigExist.cache.clear()`.** The suite's harness calls it, so the export keeps a `cache` with a `clear`. A narrower `{ cache: { clear(): void } }` is enough.
- **Call-time reads.** Each call reads the managed directory through `getManagedFilePath()`, the cwd through `getCwd()`, the settings through the settings module, and the global config through `src/platform/config/config.ts`. The suite changes all of them between calls. The one exception is the enterprise check, which is decided once (Behaviour, 4).
- **Messages are contract.**
  - `src/mcp/doctor.ts` classifies errors by `message`. It matches the prefix `Missing environment variables:` and the whole text `Does not adhere to MCP server configuration schema`.
  - `getProjectMcpConfigsFromCwd` and the scope readers recognize a missing file by the prefix `MCP config file not found`.
  - The CLI prints the add and remove errors as they are.

## Observable behaviour

### 1. Placeholders: `expandEnvVarsInString(value)`

- **`${NAME}`** becomes the value of `NAME` in `process.env`, read at call time. An empty value counts as set.
- **`${NAME:-default}`** becomes the default when `NAME` is unset. Only the first `:-` separates, so `${A:-p:-q}` gives `p:-q`. An empty default gives an empty string, and a set variable wins over its default.
- **An unset variable with no default** stays verbatim, `${NAME}` included. Its name is added to `missingVars` once per occurrence, in order, repeats included.
- **What is not a placeholder:**
  - `$NAME` without braces, and `${}`, are left alone;
  - the name is everything up to `:-` or the closing brace: `${A-d}` looks up `A-d`, and `${ A }` looks up ` A ` with its spaces;
  - a placeholder ends at the first `}`, so `${A:-${B}}` gives `${B}` when `A` is unset.
- **One pass.** A substituted value is never expanded again.

### 2. Parsing: `parseMcpConfig` and `parseMcpConfigFromFilePath`

**The schema.** The object must be `{ mcpServers: Record<name, server> }`.
- **Server shapes.** A server matches one of the shapes in `src/mcp/types.ts`: stdio (type absent or `stdio`), `sse`, `http`, `ws`, `sse-ide`, `ws-ide`, `sdk` or `claudeai-proxy`.
- **Normalizing.** Unknown keys are dropped, on a server and beside `mcpServers`. A stdio server without `args` gets `args: []`.
- **On failure.** `config` is `null`, and there is one error per schema issue:
  - `path`: the issue path joined with `.` (`mcpServers.a`, `mcpServers.a.command`, `''` for a non-object). The exact path is whatever the schema library reports for the union;
  - `message`: `Does not adhere to MCP server configuration schema`;
  - `mcpErrorMetadata`: `{ scope, severity: 'fatal' }`;
  - `file`: present only when a file path is known. `--mcp-config` passes the literal `command line`.
- **All or nothing.** One invalid server rejects the whole config.

**Expansion** (when `expandVars` is true), per server:
- **stdio:** `command`, each of `args`, and each `env` value. Keys are never expanded.
- **`sse`, `http`, `ws`:** `url` and each `headers` value. `headersHelper` and `oauth` are left as written.
- **`sse-ide`, `ws-ide`, `sdk`, `claudeai-proxy`:** nothing is expanded.
- **Missing variables:** the server is kept, with the placeholders verbatim. One warning is added per server:
  - `path: 'mcpServers.<name>'`;
  - `message: 'Missing environment variables: A, B'`, each name once, in first-seen order, joined by `, `;
  - `suggestion: 'Set the following environment variables: A, B'`;
  - `mcpErrorMetadata: { scope, serverName, severity: 'warning' }`;
  - `file` when known.
- **With `expandVars` false,** nothing is substituted and nothing is reported.

**The Windows warning.** On Windows only, a stdio server whose command,
after expansion, is `npx` or ends in `\npx` or `/npx` gets a warning:
- the same `path`, `serverName` and `severity: 'warning'` as above;
- a message that names npx and says Windows needs a `'cmd /c'` wrapper;
- a suggestion to use `"cmd"` with args `["/c", "npx", ...]`.

`npx.cmd`, `cmd`, a command that merely contains `npx`, and every remote
server never warn.

**From a file** (`parseMcpConfigFromFilePath`). Each failure below gives `config: null`
and one fatal error with `path: ''` and `file` set to the path:

| Case | `message` | `suggestion` |
|---|---|---|
| missing | `MCP config file not found: <path>` | `Check that the file path is correct` |
| unreadable (a directory, no permission) | `Failed to read file: <the system error>` | `Check file permissions and ensure the file exists` |
| not JSON: empty, a comment, a trailing comma, the literals `null` or `false` | `MCP config is not a valid JSON` | `Fix the JSON syntax errors in the file` |

A UTF-8 byte-order mark is tolerated. Anything else goes through the schema
as above, with the path on every error.

### 3. Reading one scope: `getMcpConfigsByScope(scope)`

Every server returned carries `scope` set to the scope read. Values are expanded.

- **`enterprise`:** reads `managed-mcp.json` in the managed directory (`getEnterpriseMcpFilePath()`). It is never gated by setting sources.
  - A missing file gives nothing and no error.
  - A broken file gives no servers and its fatal errors.
  - Otherwise, the servers and any warnings.
- **`project`:** reads `.mcp.json` in the cwd and in every ancestor directory, but not the filesystem root itself. It does not stop at a repository root or at home.
  - **Nearer wins.** The files are applied farthest first, so for a name the nearer file wins the whole entry, with no merging of fields.
  - **Missing files** are silent.
  - **A broken file** adds its errors and contributes no servers. Nearer files still load.
  - **Warnings** from every level are collected, farthest first.
- **`user` and `local`:** the `mcpServers` of the global config and of this project's entry in it, parsed as an object with no file.
  - Nothing stored gives nothing.
  - A single invalid entry gives no servers at all and the fatal errors, without `file`.
- **Setting sources.** `user`, `project` and `local` return `{ servers: {}, errors: [] }` when `userSettings`, `projectSettings` or `localSettings` respectively is not an enabled setting source (`--setting-sources`).

`getProjectMcpConfigsFromCwd()` is the `project` read limited to the cwd. It
ignores ancestors, is gated by `projectSettings`, and is silent for a missing
file. For a broken file it gives no servers and the errors.

### 4. The managed file takes over

- **When it counts.** `doesEnterpriseMcpConfigExist()` is true when `managed-mcp.json` reads and validates. An empty `mcpServers` counts. So does a file whose placeholders are unset, which only warns. A missing file does not count, and neither does one that is not JSON or fails the schema (Findings, 6).
- **Decided once per process.** The answer is kept: a file installed after the first call is not noticed until the cache is cleared or the process restarts.
- **What changes while it is true:**
  - `getClaudeCodeMcpConfigs` and `getAllMcpConfigs` return only the managed servers that pass the policy. There are no user, project, local, plugin or claude.ai servers, and `errors` is `[]`.
  - `addMcpConfig` refuses every scope with `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers`. This check runs before validation, so it wins over every other error. `removeMcpConfig` is not blocked.
- **The `--mcp-config` exception.** `areMcpConfigsAllowedWithEnterpriseMcpConfig(configs)` is true only when every config is `{ type: 'sdk', name: 'claude-vscode' }`. An empty record is true. The CLI uses it to refuse `--mcp-config` while the managed file is in force.

### 5. The plugin-only lock

The managed setting `strictPluginOnlyCustomization` locks MCP when it is
`true`, or when it is a list that names `mcp`.
- **In the merge,** `getClaudeCodeMcpConfigs` drops the user, project and local scopes and keeps plugin servers.
- **By name,** `getMcpConfigByName` returns enterprise servers only.

A list without `mcp` locks nothing here.

### 6. Merging: `getClaudeCodeMcpConfigs(dynamicServers, extraDedupTargets)`

Unless the managed file takes over (4):
- **Project servers** take part only when their approval status is `approved` (`getProjectMcpServerStatus`). The suite pins how that status reaches the merge:
  - **pending:** nobody approved them, in an interactive session;
  - **approved:**
    - the server is listed in `enabledMcpjsonServers`, compared by the normalized name, so `b_x` approves `b.x`;
    - `enableAllProjectMcpServers` is set;
    - the session is non-interactive and `projectSettings` is enabled;
    - the user's settings set `skipDangerousModePermissionPrompt`;
  - **rejected:** the server is listed in `disabledMcpjsonServers`. Rejection beats every approval above;
  - **what the repository can do:** its own `.claudin/settings.json` cannot approve through `skipDangerousModePermissionPrompt`, but it can through `enabledMcpjsonServers` (Findings, 9).
- **Plugin servers** come from every enabled plugin:
  - keyed `plugin:<plugin>:<server>`;
  - `scope: 'dynamic'`;
  - `pluginSource` set to the plugin's source (`<name>@inline` for `--plugin-dir`).
- **De-duplication.** A plugin server is dropped when its signature (8) equals an enabled manual server's. Enabled manual servers are the user, approved project, local, `dynamicServers` and awaited `extraDedupTargets` entries that are not disabled (7) and that pass the policy.
  - **Between plugins,** the first loaded wins.
  - **Plugin servers that are disabled or policy-blocked** take no part in the race. They are kept in the result, and the final policy pass drops the blocked ones.
  - **Each drop** is reported in `errors` as `{ type: 'mcp-server-suppressed-duplicate', source: <plugin key>, plugin, serverName, duplicateOf }`, where `duplicateOf` names the first matching manual server, or the winning plugin key.
- **Precedence by name:** plugin < user < project < local. The later scope replaces the whole entry. The result lists plugin servers first, then user, project and local, each in its own order.
- **`dynamicServers`** are only dedup targets. They are not part of the result, so the caller merges them itself.
- **Policy.** The merged result goes through the policy (9). `sdk` entries in a config scope are filtered by name here, with no exemption.
- **`errors`** holds only plugin MCP errors and the suppressions:
  - **a plugin server with an unset variable** is kept, and gives `{ type: 'mcp-config-invalid', plugin, serverName, … }`;
  - **plugin loading failures,** such as a missing `--plugin-dir`, are logged but not returned;
  - **validation errors of the user, project and local scopes** are not returned. Callers get them from `getMcpConfigsByScope`.

### 7. Enabled and disabled servers

- **The rule.** A server is disabled when its name is in the project's `disabledMcpServers`. A claude.ai connector (a name starting `claude.ai `) is opt-in instead: it is disabled unless its name is in `enabledMcpServers`.
- **`setMcpServerEnabled(name, enabled)`** edits the one list that governs the name, adding or removing it once. It never touches the other list.
- **No change, no write.** A call that changes nothing writes nothing, and no config listener fires.

### 8. Signatures and de-duplication helpers

- **`getMcpServerSignature(config)`:**
  - **stdio** (type absent or `stdio`): `stdio:` followed by the JSON array `[command, ...args]`. `args` absent counts as `[]`, and `env` is ignored;
  - **any config with a `url`:** `url:` followed by the URL after `unwrapCcrProxyUrl`. Headers are ignored;
  - **`sdk`:** `null`.
- **`unwrapCcrProxyUrl(url)`.** When the string contains `/v2/session_ingress/shttp/mcp/` or `/v2/ccr-sessions/` anywhere, it returns the URL's `mcp_url` query parameter, decoded. It returns the input unchanged when:
  - neither marker occurs;
  - `mcp_url` is missing or empty;
  - the string is not a URL.
- **`dedupPluginMcpServers(plugins, manual)`:**
  - a plugin whose signature matches a manual one is suppressed, `duplicateOf` naming the first manual name with that signature;
  - a later plugin with the signature of an earlier kept plugin is suppressed, `duplicateOf` naming the earlier key;
  - `null` signatures always pass;
  - kept entries are the same objects, in input order.
- **`dedupClaudeAiMcpServers(connectors, manual)`:**
  - the same, except that a manual server that is disabled (7) is no target;
  - connectors never suppress each other.

### 9. The allow and deny policy

`filterMcpServersByPolicy(configs)` applies it to a record. It returns the
allowed entries as given (the same objects) and the blocked names in input
order. Entries with `type: 'sdk'` are always allowed here.

**Where the lists come from:**
- **`deniedMcpServers`:** the merged settings of every enabled source. A user, a project, or the policy can deny.
- **`allowedMcpServers`:** the merged settings too, with lists concatenated across sources. When the managed policy sets `allowManagedMcpServersOnly: true`, only the policy's own list counts. If the policy then sets no list, every server is allowed.
- **`shouldAllowManagedMcpServersOnly()`** reads the policy layer only. The flag in user or local settings does nothing.

**The verdict for a server.** A stdio server (type absent or `stdio`) is
matched by `[command, ...args]`. A remote server (any config with a `url`,
including `sse-ide`, `ws-ide` and `claudeai-proxy`) is matched by its URL.
1. **Denied, whatever the allowlist says,** when a deny entry matches:
   - a `serverName` equal to the name, case-sensitive, for any type;
   - a `serverCommand` equal to the command array, element by element: same length, same order;
   - a `serverUrl` pattern matching the URL.
2. **No allowlist:** allowed.
3. **An allowlist:**
   - an empty one blocks everything;
   - **a stdio server:** when the list has any `serverCommand` entry, it must match one of them, and name entries no longer help it. Otherwise it needs a name entry;
   - **a remote server:** when the list has any `serverUrl` entry, it must match one of them. Otherwise it needs a name entry;
   - **any other server** (an `sdk` entry outside the filter) needs a name entry.

**URL patterns:**
- `*` matches any run of characters, `/` and `:` included;
- every other character is literal, `.`, `?`, `+` and parentheses included;
- the pattern must match the whole URL;
- the comparison is case-sensitive today (Findings, 10).

**`addMcpConfig` applies the same verdict** to the validated config before it
writes:
- denied: `Cannot add MCP server "<name>": server is explicitly blocked by enterprise policy`;
- not allowed: `Cannot add MCP server "<name>": not allowed by enterprise policy`.

The `sdk` exemption does not apply there.

### 10. `getAllMcpConfigs()`

- **With the managed file:** exactly `getClaudeCodeMcpConfigs()`. No connector is merged.
- **Otherwise:**
  - **The fetch.** It starts the claude.ai connector fetch (`fetchClaudeAIMcpConfigsIfEligible`, `src/mcp/claudeai.ts`) and passes it as `extraDedupTargets`.
  - **The policy.** The connectors are filtered by the policy, with blocked connectors silently dropped.
  - **De-duplication.** Connectors are de-duplicated against the result with `dedupClaudeAiMcpServers`, also silently.
  - **The merge.** Connectors come first, at the lowest precedence, so a manual server with the same key replaces a connector.
- **A connector and a plugin server with the same URL.** If the connector is enabled, the plugin server is suppressed and reported. If it is not, the connector is dropped and the plugin server stays.
- **`errors`** is that of `getClaudeCodeMcpConfigs`.

### 11. By name: `getMcpConfigByName(name)`

- **Precedence:** enterprise, then local, then project, then user. Unknown names give `null`.
- **The plugin-only lock** limits it to enterprise servers (5).
- **What it ignores:** approval status, the policy and the disabled list. A rejected project server, a denied server and a disabled server are all returned (Findings, 5).

### 12. Writing: `addMcpConfig(name, config, scope)` and `removeMcpConfig(name, scope)`

**`addMcpConfig` checks, in this order. The first failure throws, and nothing is written:**
1. **The name.** Anything outside letters, digits, `-` and `_` throws `Invalid name <name>. Names can only contain letters, numbers, hyphens, and underscores.` An empty name passes today (Findings, 3).
2. **The managed file** (4).
3. **The schema.** It throws `Invalid configuration: <path>: <issue>`, with several issues joined by `, `. A config that matches no transport gives an empty path today (Findings, 4).
4. **The policy** (9).
5. **The name already exists in the target scope:**
   - `MCP server <name> already exists in .mcp.json`;
   - `MCP server <name> already exists in user config`;
   - `MCP server <name> already exists in local config`.
6. **The scope.** `dynamic`, `enterprise`, `claudeai` and `managed` throw `Cannot add MCP server to scope: <scope>`.

**What is stored.** The validated config: unknown keys dropped, `args: []` added
to stdio.
- **`user` and `local`:** the entry is added to the `mcpServers` of the global config or of this project's entry, keeping the others.
- **`project`:** `.mcp.json` in the cwd is rewritten. Ancestor files are never touched. Its format on disk is pinned by `src/mcp/__fixtures__/rewrite/written.mcp.json`:
  - `{ "mcpServers": { … } }`, the existing entries first;
  - indented by 2 spaces, with no trailing newline;
  - entries without `scope`.
- **The project write itself:**
  - **Atomic.** It goes through a temporary file beside the target, flushed to disk and then renamed over it, so no temporary file is left behind. A symlinked `.mcp.json` becomes a regular file, and its target is untouched.
  - **The mode.** A new file is created with mode `0644`, less the umask. An existing file keeps its exact mode, even bits the umask would strip.
  - **A failed write** throws `Failed to write to .mcp.json: <error>` (`Failed to remove from .mcp.json: <error>` for a removal).
  - **The existing entries** are re-read with expansion, which has consequences: Findings, 1 and 2.

**`removeMcpConfig`:**
- **Removes the one entry** and keeps the rest. Removing the last one leaves `{ "mcpServers": {} }`.
- **An unknown name throws:**
  - `No MCP server found with name: <name> in .mcp.json`;
  - `No user-scoped MCP server found with name: <name>`;
  - `No project-local MCP server found with name: <name>`.
- **Other scopes** throw `Cannot remove MCP server from scope: <scope>`.
- **A broken `.mcp.json`** reads as empty, so removal from it throws "not found" and leaves the file alone.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| No `.mcp.json` anywhere, no managed file, nothing stored | empty servers, no errors, from every reader |
| A broken `.mcp.json` in an ancestor | its errors in `getMcpConfigsByScope('project')`; nearer files still load; the merge returns no error for it |
| One invalid entry in user or local | that scope gives no servers at all, and fatal errors |
| An unset variable | the server is kept with the placeholder verbatim, and a warning |
| A `managed-mcp.json` that does not parse | the managed file does not take over; `getMcpConfigsByScope('enterprise')` reports it |
| A managed file installed mid-process | not noticed until restart (4) |
| A plugin directory that cannot be loaded | no MCP error; the other plugins load |
| Two plugins declaring the same command | the first loaded is kept and the second reported as a duplicate |
| `.mcp.json` is a symlink | a write replaces the link with a regular file |
| The cwd is not writable | the project write throws, wrapped, and nothing is left behind |
| A non-JSON literal (`null`, `false`) in a file | "not a valid JSON" |
| A JSON array in a file | a schema error at path `''` |
| A Windows `npx` command | a warning, and the server is kept |
| The filesystem root | never read by the walk. Not pinned: the root is not writable in a test |

## Security requirements

**Pinned by the tests:**
- **Deny always wins.** A deny entry blocks the server whatever the allowlist says, by name for any type, by exact command for stdio, and by URL pattern for remote servers, IDE and claude.ai transports included. Every deny path has a probe.
- **An allowlist with command or URL entries binds its type.** Then a stdio or remote server must match an entry of that kind, and a name entry no longer admits it.
- **An empty allowlist blocks everything** except `sdk` entries in `filterMcpServersByPolicy`.
- **`allowManagedMcpServersOnly` is read from the managed policy only,** and then only the policy's allowlist counts. User and project denies still apply.
- **The policy runs everywhere a server enters:**
  - on the merged result;
  - on managed servers;
  - on claude.ai connectors;
  - on `addMcpConfig`;
  - on the dedup targets, so a blocked manual server cannot hide a plugin twin.
- **The managed file locks every scope** for reading and for `addMcpConfig`, and the plugin-only lock drops the user, project and local scopes.
- **Project servers connect only when approved.** A repository cannot approve its own servers through `skipDangerousModePermissionPrompt`.
- **Writes are atomic and keep the file's mode.**

**Described, kept for parity:** Findings 5 to 11.

## Tests that pin it

- **The characterization suite, six files in `src/mcp/`, 253 tests.** It covers 100% of the functions of both files, 98.51% of the lines of `config.ts` and 100% of `envExpansion.ts`.
  - **`envExpansion.characterization.test.ts`:** the placeholder table.
  - **`config.parse.characterization.test.ts`:** the schema, expansion, the Windows warning, and file errors.
  - **`config.scopes.characterization.test.ts`:** each scope, the walk, setting sources, the managed file, and lookup by name.
  - **`config.policy.characterization.test.ts`:** a deny table and an allow table, whose lists count, and the `addMcpConfig` policy gate.
  - **`config.write.characterization.test.ts`:** add, remove, the `.mcp.json` bytes, the mode, symlinks, failures, and the enabled and disabled lists.
  - **`config.merge.characterization.test.ts`:** precedence, approval, the managed take-over, the plugin-only lock, plugin and connector de-duplication, signatures, and the CCR unwrap.
- **The harness, `src/mcp/__testutils__/mcpConfigWorld.ts`.** Each test gets a fresh temp tree:
  - `CLAUDIN_CONFIG_DIR` (the user `settings.json`);
  - the managed directory, through a seeded memo of `getManagedFilePath`, because `/etc/claude-code` is not writable in a test;
  - an outer and an inner project directory, set as cwd and original cwd;
  - plugin directories loaded through `setInlinePlugins`.

  The user and local scopes live in the in-memory global config of `NODE_ENV=test`, written through `saveGlobalConfig` and `saveCurrentProjectConfig`. The claude.ai connector listing is the one network boundary. Its memo is seeded per test, so no login or request happens. The Windows rows seed the memo of `getPlatform`.
- **Fixtures in `src/mcp/__fixtures__/rewrite/`:**
  - `config-scopes.mcp.json`, a hand-written `.mcp.json` with a stdio, an `http` and an `sse` server and two placeholders;
  - `written.mcp.json`, the exact bytes `addMcpConfig` writes when it adds an `http` server to a file holding one stdio server.
- **`scripts/migrations/probes/rewrite-mcp-config.json`:** 40 probes, 35 on `config.ts` and 5 on `envExpansion.ts`. Every one turns the suite red.
  - One probe was replaced, because it was an equivalent mutation. Turning off the explicit empty-allowlist check changes nothing a caller sees: an empty list already blocks every server through the per-type rules. The replacement probe makes every non-empty allowlist block everything.
- **Existing tests that reach the unit through callers,** and pass against the old module:
  - `src/mcp/doctor.test.ts`, on the error messages;
  - `src/platform/headless/print.test.ts`, which mocks the module;
  - `src/platform/settings/settings.characterization.test.ts`, on the policy layer the unit reads.
- **Inherited tests.** The unit's list in `phase-3.json` names none, so none were folded in or deleted.
- **Prompt text.** This unit sends no text to a model. Server names reach the model as tool names, but that text belongs to the connection units. No test, snapshot or generated file outside the unit pins text of this unit.
- **Not pinned, and why:**
  - **the filesystem root** in the walk, and a root `/.mcp.json`;
  - **a `stat` failure other than "missing"** before a project write, and a rename failure with its cleanup. Neither can be produced through the exports;
  - **logging** (`logForDebugging`, `logError`) of plugin loading errors and of parse failures;
  - **the real claude.ai fetch,** which needs a login and the network;
  - **the case of URL patterns** (Findings, 10: a fix);
  - **the fixes of Findings 1 to 4 and 13.**
- **Outside the unit, quoting or naming the old code:** `src/plugins/mcpPluginIntegration.ts` (line 539) cites `config.ts:911` by line number. The reference is already stale. Reword it when the implementation lands.

## Out of scope

- **Approval status** (`getProjectMcpServerStatus`) and name normalization belong to `mcp/core`. The approval dialogs belong to `mcp/approvalDialogs`.
- **The claude.ai fetch** (`mcp/capabilities`, `claudeai.ts`) and plugin MCP loading (`src/plugins/mcpPluginIntegration.ts`).
- **The policy setting schemas,** that is, which entries `allowedMcpServers` and `deniedMcpServers` accept. They belong to `src/platform/settings/types.ts`.
- **The built-in default-off server hook.** Today no built-in server is opt-in, so only claude.ai connectors are opt-in (7). The rewrite needs no placeholder for a future one.

## Findings

1. **A project write bakes expanded values into `.mcp.json`.**
   - Adding or removing a project server rewrites the other entries as they read after expansion. A `${API_TOKEN}` in an existing header or env becomes the token itself, in a file that is usually committed.
   - The rewrite also adds `args: []`, and drops unknown keys on entries and beside `mcpServers` (`$schema`, say).
   - **Decision: fix.** Entries the call does not touch are written back exactly as they were read, before expansion and before validation, and other top-level keys are kept. No caller, file or workflow can depend on a secret being written into the file. Not pinned.
2. **Adding to a `.mcp.json` that does not parse throws its content away.** The broken file reads as empty, so the write replaces it with only the new server.
   - **Decision: fix.** When the existing file has fatal errors, `addMcpConfig` throws and leaves it alone. Not pinned.
3. **An empty name is accepted** by `addMcpConfig`, and stored under the key `""`.
   - **Decision: fix.** The name must have at least one character. Nothing can depend on an unnamed server. Not pinned.
4. **A config that matches no transport gives `Invalid configuration: : Invalid input`**, with an empty path and a generic issue.
   - **Decision: fix.** Drop the empty path, so the message reads `Invalid configuration: Invalid input`, and name the transports accepted when no shape matches. The suite pins only the `Invalid configuration: ` prefix and the field-level messages.
5. **Security: lookup by name ignores approval, policy and the disabled list.**
   - An agent definition that names an MCP server (`src/tools/AgentTool/runAgent.ts`) connects to whatever `getMcpConfigByName` returns. That includes a project server the user rejected and a server the policy denies.
   - **Decision: keep for parity, and track.** `claudin mcp get`, the stdio server menu and the SDK reconnect and toggle handlers show and act on any configured server by name, so filtering here changes what they see. The fix belongs where an agent connects. That caller also accepts inline server definitions, which bypass every check already.
   - Pinned.
6. **Security: a managed file that does not parse does not take over.** A syntax error in `managed-mcp.json` silently gives users back every scope.
   - **Decision: keep for parity, and track.** Failing closed would lock users out of every server on an admin typo. That is noticeable, and so not pure hardening. The broken file is reported through `getMcpConfigsByScope('enterprise')`, which feeds `mcp doctor` and the settings error list.
   - Pinned.
7. **The take-over is decided once per process.**
   - **Decision: keep for parity.** The file is installed by an admin, and a restart picks it up. Callers ask often, on the startup path.
   - Pinned.
8. **Security: the upward walk reads `.mcp.json` above the project,** up to the directory below the filesystem root, past repository roots and home.
   - On a shared machine, a `/tmp/.mcp.json` planted by another user is a project server for a session in `/tmp/work`. A non-interactive session approves project servers automatically, so `claudin -p` there would start it.
   - **Decision: keep for parity, and track.** Monorepos rely on a `.mcp.json` above the package directory. The trust dialog lists project servers, and an interactive session asks before each one.
   - Pinned.
9. **Security: a repository can approve its own project servers.** Its `.claudin/settings.json` may set `enabledMcpjsonServers` or `enableAllProjectMcpServers`.
   - **Decision: keep for parity here.** The approval status is computed in `mcp/core`, and teams commit these settings on purpose. The trust dialog gates the repository first. Raise it with `mcp/core`.
   - Pinned through the merge.
10. **Security: URL patterns are loose and case-sensitive.**
    - **The wildcard crosses boundaries.** `*` matches across `/`, `.` and `:`, so the allow entry `https://*.example.com/*` also admits `https://evil.test/x.example.com/`.
    - **The case is significant.** A deny of `https://mcp.example.com/*` does not stop `https://MCP.example.com/x`, which reaches the same host.
    - **Decision, case: fix.** Compare the scheme and the host case-insensitively, and the rest of the URL as written. This is pure hardening: it only adds matches for the same host. Not pinned.
    - **Decision, wildcard: keep for parity, and track.** Admins' existing patterns may rely on `*` spanning path segments.
    - Pinned by "the host wildcard also accepts a look-alike path on another host".
11. **Security: command and name denies are easy to step around.**
    - A command deny is exact array equality, so `["npx", "-y", "pkg"]` or an absolute path to `npx` escapes a deny of `["npx", "pkg"]`.
    - A name deny is escaped by renaming the server.
    - **Decision: keep for parity.** This is the documented matching. Only an allowlist with command or URL entries is a boundary, and the spec states it as such.
    - Pinned.
12. **The `sdk` exemption is inconsistent.** `filterMcpServersByPolicy` lets `sdk` entries through, while the merge and `addMcpConfig` judge them by name.
    - **Decision: keep for parity.** The stricter path is the one config scopes go through, and SDK servers normally arrive through the filter.
    - Pinned both ways.
13. **The Windows npx suggestion links to another product's documentation** (`code.claude.com`).
    - **Decision: fix.** Link to this project's MCP documentation, or drop the link. The suite does not pin the URL.
14. **Outside this unit: a stale line reference.** `src/plugins/mcpPluginIntegration.ts` cites `config.ts:911`.

## Target design

- **The facade.** `src/mcp/config.ts` stays the module that callers import, with every export above, and `envExpansion.ts` stays a leaf with no imports. The work lives in small modules beside the facade:
  - **parsing and expansion:** pure functions over a parsed object, plus one file reader;
  - **the scope readers:** one per scope, each taking its source and returning servers and errors;
  - **the merge:** precedence, approval, the managed take-over and the plugin-only lock;
  - **the policy:** a pure verdict function, `(name, config, lists) => 'allowed' | 'denied' | 'not-allowed'`. The lists are resolved separately, from the settings and the managed-only flag;
  - **de-duplication and signatures:** pure functions;
  - **the `.mcp.json` writer:** atomic and mode-preserving, writing raw entries (Findings, 1 and 2).
- **Types.**
  - A discriminated union for the verdict, and a small `PolicyLists` type.
  - A named type for the dedup result, `{ servers; suppressed }`, which both helpers share.
  - URL patterns compiled once per call, with scheme and host case-folded (Findings, 10).
  - No `any`.
- **Call-time reads.** The settings, the global config, the managed path, the cwd and the environment are read on each call. Only the enterprise check is cached, and it exposes `cache.clear()`.
- **No new import of `settings.ts` into a module it imports.** Keep `allErrors.ts` as the place that joins the two.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.**
  - All 35 inherited bodies were written anew.
  - `config.ts` is now a facade that re-exports from `src/mcp/config/`. The
    modules there are `jsonFile`, `expand`, `parse`, `scopes`, `policy` (a
    pure verdict function), `policySettings`, `dedup`, `toggles`,
    `projectFile` (an atomic writer), `write` and `merge`.
  - The six characterization suites pass unchanged.
- **Fixes, each with a test.**
  - **Secrets stay placeholders.** Adding or removing a project server writes
    the other entries back raw, so `${TOKEN}` stays a placeholder. Keys beside
    `mcpServers` are kept.
  - **No wipe.** Adding to an unusable `.mcp.json` throws and leaves the file alone.
  - **Names.** An empty server name is refused.
  - **Errors.** A config that matches no transport gets a clear error.
  - **URL patterns.** Scheme and host compare case-insensitively.
  - **Windows npx hint.** It no longer links to `code.claude.com`.
- **Unchanged.** Every "keep" and "keep, track" behaviour is as before,
  security ones included (team memory `bugs/mcp-config-security-findings.md`).
- **Probes.** `rewrite-mcp-config.json` holds 130 probes, one on every deny path.
- **Residue, reviewed.** 24 lines of Claude Code remain, all signatures:
  - `dedup.ts`, 16: the two dedup exports and their record-shaped parameters,
    and the shared helper's signature;
  - `parse.ts`, 4;
  - `scopes.ts`, 2;
  - `envExpansion.ts`, 2.
