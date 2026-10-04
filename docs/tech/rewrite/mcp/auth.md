# Spec: `mcp/auth`

The unit is seven files: `src/mcp/auth/authFetch.ts`,
`src/mcp/auth/callbackParams.ts`, `src/mcp/auth/clientSecretStore.ts`,
`src/mcp/auth/oauthErrors.ts`, `src/mcp/auth/serverKey.ts`,
`src/mcp/auth/tokenRevocation.ts` and `src/mcp/headersHelper.ts`.

## Purpose

This unit holds the parts of MCP server authentication that are not the OAuth
provider itself:
- **the credential key** under which every token, client and secret of a server is stored;
- **the OAuth fetch** (a timeout per request, and error bodies rewritten so the SDK can classify them) and authorization-server metadata discovery;
- **the browser redirect:** which value of a repeated parameter counts, the order in which state, error and code are judged, and URL redaction for logs;
- **client secrets:** read from the environment or a hidden TTY prompt, stored and cleared per server;
- **sign-out:** RFC 7009 revocation, then local clearing whatever the server said;
- **`headersHelper`:** a command named in a remote server's config that prints the request headers as JSON, merged over the static `headers` each time a transport is built.

`claudeAuthProvider.ts` (the SDK's `OAuthClientProvider`) and `oauthFlow.ts`
(the interactive sign-in) were ported from opencode and are out of this unit.
They are this unit's main callers. The barrel `src/mcp/auth.ts` is this
project's own and keeps every name it exports.

## Public contract

Through the barrel `src/mcp/auth.js` unless noted.

| Export | Signature | Used by |
|---|---|---|
| `getServerKey` | `(serverName: string, serverConfig: McpSSEServerConfig \| McpHTTPServerConfig) => string` | `claudeAuthProvider.ts`, `oauthFlow.ts` (from the file); every store function of this unit |
| `hasMcpDiscoveryButNoToken` | same arguments, `=> boolean` | `src/mcp/client/fetchCapabilities.ts` |
| `createAuthFetch` (`auth/authFetch.js`, not on the barrel) | `() => FetchLike` | `src/mcp/client/fetch.ts`, `claudeAuthProvider.ts`, `oauthFlow.ts` |
| `fetchAuthServerMetadata` (`auth/authFetch.js`, not on the barrel) | `(serverName: string, serverUrl: string, configuredMetadataUrl: string \| undefined, fetchFn?: FetchLike, resourceMetadataUrl?: URL) => Promise<AuthorizationServerMetadata \| undefined>` (the SDK's metadata type) | `claudeAuthProvider.ts`, `oauthFlow.ts`, revocation |
| `normalizeOAuthErrorBody` | `(response: Response) => Promise<Response>` | the barrel; `createAuthFetch` |
| `getFirstOAuthCallbackParam` | `(value: string \| string[] \| null \| undefined) => string \| undefined` | the barrel only |
| `validateOAuthCallbackParams` | `(params: { code?, state?, error?, error_description?, error_uri? }, oauthState: string) => { type: 'code'; code: string } \| { type: 'error'; error: string; errorDescription: string; errorUri: string; message: string } \| { type: 'missing_result' } \| { type: 'state_mismatch' }`; each param takes the type `getFirstOAuthCallbackParam` takes | `oauthFlow.ts` |
| `redactSensitiveUrlParams` | `(url: string) => string` | `claudeAuthProvider.ts` |
| `readClientSecret` | `() => Promise<string>` | `src/commands/mcp/addCommand.ts`, `src/platform/headless/handlers/mcp.tsx` |
| `saveMcpClientSecret` | `(serverName: string, serverConfig: McpSSEServerConfig \| McpHTTPServerConfig, clientSecret: string) => void` | the same two |
| `clearMcpClientConfig` | `(serverName: string, serverConfig: McpSSEServerConfig \| McpHTTPServerConfig) => void` | `src/platform/headless/handlers/mcp.tsx` |
| `revokeServerTokens` | `(serverName: string, serverConfig: McpSSEServerConfig \| McpHTTPServerConfig, options?: { preserveStepUpState?: boolean }) => Promise<void>` | `src/mcp/ui/MCPRemoteServerMenu.tsx`, `src/platform/headless/print/mcpControlHandlers.ts` |
| `clearServerTokensFromSecureStorage` | `(serverName: string, serverConfig: McpSSEServerConfig \| McpHTTPServerConfig) => void` | `src/platform/headless/handlers/mcp.tsx`, `claudeAuthProvider.ts`, `oauthFlow.ts` |
| `getMcpServerHeaders` (`src/mcp/headersHelper.js`) | `(serverName: string, config: McpSSEServerConfig \| McpHTTPServerConfig \| McpWebSocketServerConfig) => Promise<Record<string, string>>` | `src/mcp/client/transport.ts`, for `sse`, `http` and `ws` |
| `getMcpHeadersFromHelper` (`src/mcp/headersHelper.js`) | same arguments, `=> Promise<Record<string, string> \| null>` | no importer outside the file |

The barrel also carries `ClaudeAuthProvider`, `getScopeFromMetadata`,
`performMCPOAuthFlow`, `wrapFetchWithStepUpDetection` and
`AuthenticationCancelledError`, which belong to the two ported files. The
barrel's name list and each export's arity (`Function.length`) are part of the
contract, because a lost re-export passes the build and the typecheck.

The `config` that callers pass to the headers functions is in practice a
`ScopedMcpServerConfig`: it also carries `scope`.

## Observable behaviour

### 1. The credential store

All state lives in the secure storage of `src/platform/secureStorage`. On
Linux it asks `secret-tool` first, and when that refuses, it writes
`.credentials.json` with mode 0600 under `CLAUDIN_CONFIG_DIR`. This unit uses
two maps of that store, both keyed by the server key (2):
- `mcpOAuth[key]`: `serverName`, `serverUrl`, `accessToken`, `expiresAt`, and optionally `refreshToken`, `scope`, `clientId`, `clientSecret`, `stepUpScope` and `discoveryState` (`authorizationServerUrl`, optional `resourceMetadataUrl`);
- `mcpOAuthClientConfig[key]`: `{ clientSecret }`.

Every write is read, modify, write of the whole store, and keeps every other
key and every other server's entry as it was. A clear for a server with no
entry writes nothing at all.

### 2. The server key: `getServerKey(name, config)`

- The key is `<name>|<16 lowercase hex>`. The hex is the first 16 characters of the SHA-256 of the compact JSON text of `{"type":…,"url":…,"headers":{…}}`, in that member order, with `headers` taken as the config has them (`{}` when absent).
- So the name, the transport, the URL, each header name and value, and the order of the headers all change the key. `oauth`, `headersHelper`, `scope` and other fields do not.
- The name goes in verbatim: spaces, slashes and non-ASCII characters included.
- This is a storage format. `src/mcp/auth/__fixtures__/rewrite/server-keys.json` holds keys produced from real configs, and the rewrite must reproduce every one.

`hasMcpDiscoveryButNoToken(name, config)` is true only when the store holds an
`mcpOAuth` entry for the key, and that entry has neither a non-empty
`accessToken` nor a `refreshToken`. A missing store, a missing map or a missing
entry gives false.

### 3. The OAuth fetch: `createAuthFetch()`

- It returns a fetch with a fresh 30-second timeout for each request.
- A caller's `signal` is honoured alongside the timeout: already aborted, the request fails at once; aborted later, the request fails at that moment.
- For a POST (any case of the method name), the response goes through `normalizeOAuthErrorBody` (4). Other methods get the response untouched.

### 4. Error bodies: `normalizeOAuthErrorBody(response)`

- A non-2xx response is returned as the same object, with its body unread.
- A 2xx whose body is JSON matching the RFC 6749 error shape (`error` a string), and that is not a valid token response, becomes a new response: status 400, status text `Bad Request`, the original headers, and a JSON body of the error fields the SDK knows (`error`, `error_description`, `error_uri`). Other fields are dropped.
- The vendor codes `invalid_refresh_token`, `expired_refresh_token` and `token_expired` become `invalid_grant`. The server's `error_description` is kept, or else it reads `Server returned non-standard error code: <code>`. The `error_uri` of an aliased code is dropped.
- A token response is recognised first: a body with `access_token` and `token_type` passes even if it also has an `error` key.
- Anything else (not JSON, empty, some other shape, `error` not a string, a registration response) passes with its status, status text, headers and exact body.

### 5. Metadata discovery: `fetchAuthServerMetadata(...)`

- **With a configured metadata URL.**
  - It must start with `https://`, or the call throws `authServerMetadataUrl must use https:// (got: <url>)`.
  - It is fetched directly, with `Accept: application/json`, through `fetchFn` or else `createAuthFetch()`, and parsed against the SDK's metadata schema.
  - A non-OK status throws `HTTP <status> fetching configured auth server metadata from <url>`.
  - No discovery request is made.
- **Without one.**
  - It runs RFC 9728 discovery against `serverUrl` (the protected-resource document, then RFC 8414 against the first authorization server it names), through `fetchFn` when given, starting from `resourceMetadataUrl` when given.
  - When that finds nothing or fails, and `serverUrl` has a path, it asks for RFC 8414 metadata at the path-aware location of `serverUrl` itself (`/.well-known/oauth-authorization-server/<path>`).
  - For a root URL there is no second attempt, and the answer is `undefined`.

### 6. The browser redirect

- **`getFirstOAuthCallbackParam`.** Of an array, the first non-empty item. Of a string, itself unless empty. Otherwise `undefined`.
- **`validateOAuthCallbackParams`.** Each parameter is first reduced as above. Then:
  1. a state that is not exactly `oauthState` gives `state_mismatch`, whatever else came. An absent or empty state never matches, not even an empty `oauthState`;
  2. a non-empty `error` gives `error`, with `errorDescription` and `errorUri` (`''` when absent), and `message`: `OAuth error: <error>`, then ` - <description>` when there is one, then ` (See: <uri>)` when there is one. An error wins over a code;
  3. a non-empty `code` gives `code`;
  4. otherwise `missing_result`.
- **`redactSensitiveUrlParams`.** In a parseable URL, each of the query parameters `state`, `nonce`, `code_challenge`, `code_verifier` and `code` that is present is replaced by one `[REDACTED]` (repeats collapse to one). The URL is then reserialised (`[REDACTED]` reads `%5BREDACTED%5D`, and a bare origin gains its `/`). Other parameters and the fragment are kept. A string that is not a URL is returned unchanged.

### 7. Client secrets

- **`readClientSecret()`.**
  - `MCP_CLIENT_SECRET`, when set and non-empty, is the answer, with no prompt.
  - Without a TTY on stdin it rejects with `No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.`
  - At a TTY it writes `Enter OAuth client secret: ` to stderr, puts stdin in raw mode (nothing echoed), and collects input until Enter (`\r` or `\n`), then writes a newline and resolves. Backspace (`DEL` or `\b`) removes the last character. Ctrl+C rejects with `Cancelled`. In both endings raw mode is turned off and its stdin listener removed.
  - The keys are recognised only when they arrive one per chunk. A pasted chunk is taken whole, Enter included (Findings, 12).
- **`saveMcpClientSecret(name, config, secret)`** sets `mcpOAuthClientConfig[key] = { clientSecret }`, replacing that server's earlier secret.
- **`clearMcpClientConfig(name, config)`** removes that one entry.

### 8. Sign-out: `revokeServerTokens(name, config, { preserveStepUpState })`

- With no `mcpOAuth` map in the store, nothing is contacted or written.
- With an entry holding an access or a refresh token, it revokes on the server, best-effort:
  - **Where.** The authorization server is the `discoveryState.authorizationServerUrl` recorded at sign-in, or else the server URL. Its metadata comes from (5), honouring `config.oauth.authServerMetadataUrl`. With no metadata, or no `revocation_endpoint`, nothing is sent.
  - **Order.** The refresh token first, then the access token. Each is a form POST of `token` and `token_type_hint` (`refresh_token` or `access_token`).
  - **Client authentication.** With a client id and a secret, it uses HTTP Basic over the URL-encoded id and secret, unless the server's method list rules Basic out and allows `client_secret_post`. Then the id and secret go in the body. The list is `revocation_endpoint_auth_methods_supported`, or else `token_endpoint_auth_methods_supported`. With an id only, `client_id` goes in the body. With neither, no client authentication is sent.
  - **The Bearer retry.** A 401 is retried once, with `Authorization: Bearer <access token>` and no client credentials in the body. With no access token there is no retry.
  - **Failures.** Any other failure, of either request or of discovery, is swallowed.
- **Local clearing.** Then, always, the server's `mcpOAuth` entry is removed. The client secret map is untouched.
- **Step-up state.** With `preserveStepUpState: true`, and when the old entry had a `stepUpScope` or a `discoveryState`, a new entry is written. It holds `serverName`, `serverUrl`, `accessToken: ''` and `expiresAt: 0`, plus whichever of those two the old entry had. The `discoveryState` is cut down to its two URLs. Without the option, nothing of the entry survives.

`clearServerTokensFromSecureStorage(name, config)` removes that server's
`mcpOAuth` entry, and writes nothing when there is none.

### 9. `headersHelper`: `getMcpHeadersFromHelper(name, config)`

- **When it runs.**
  - With no `headersHelper` (absent or empty), the answer is `null` and nothing runs.
  - In an interactive session, a config whose `scope` is `project` or `local` runs only once workspace trust is accepted for the current project (the global config's project entry, or any ancestor of the cwd). Before that, the answer is `null` and nothing runs. Trust accepted mid-session counts from the next call.
  - Every other scope, and a config with no `scope`, runs without a trust check. So does every scope in a non-interactive session.
  - It runs on every call. Nothing is cached, so a helper can rotate its token.
- **What runs.**
  - The value is one executable path or bare name, run directly, with no shell and no arguments.
  - A value with spaces, quotes or shell syntax names a program that does not exist, so nothing runs.
  - A bare name must consist of letters, digits, `.`, `_` and `-`, and is looked up on `PATH`.
  - A relative path resolves against the process working directory, which is also the helper's working directory.
- **Its environment.** The full environment of the process, plus `CLAUDIN_MCP_SERVER_NAME` (the server name) and `CLAUDIN_MCP_SERVER_URL` (the config's `url`), for every transport. Its stdin is an empty pipe.
- **The deadline.** After 10 seconds the helper is sent SIGTERM. When that ends it, the answer is `null`. The call then waits for the process to close and its output to end (Findings, 3).
- **The answer.**
  - The whole stdout, trimmed, must parse as a JSON object whose values are all strings. Then that object is the answer. `{}` counts, and so does an empty string value.
  - Stderr is ignored, within the output limit.
- **Failures give `null`, never an exception.**
  - **The cases:** a non-zero exit, or one ended by a signal; empty stdout; stdout that is not JSON; JSON that is not an object (an array, `null`, a string, a number); a value that is not a string; more than about 1 MB of output; a missing or non-executable file.
  - **The report.** Each failure is logged to the server's MCP log, and through `logError`, as `Error getting MCP headers from headersHelper for server '<name>': <reason>`.
  - **The reasons:** `headersHelper for MCP server '<name>' did not return a valid value` for a failed run or empty output; `… must return a JSON object with string key-value pairs` for a non-object; `… returned non-string value for key "<key>": <typeof>` for a bad value (`null` reads `object`); the JSON parser's own message for text that is not JSON (Findings, 13).

### 10. `getMcpServerHeaders(name, config)`

The answer is the config's static `headers` (or none), with the helper's
answer laid over them key by key. When the helper gives `null` the static
headers go alone. Names are compared exactly, so `authorization` and
`Authorization` are two entries (Findings, 6). The config's own `headers`
object is not modified.

## Edge cases and errors

- **Store.** An empty or absent store: lookups give false or nothing, and clears write nothing. Other servers' entries and other top-level keys always survive a write.
- **Revocation** never throws for a server-side problem. A metadata URL that is not https, a dead host, a 500 or a 401 without an access token all end in the local clearing.
- **The redirect.** A forged state placed before the real one in a repeated parameter is a mismatch, and only the first non-empty value counts. A state differing only in case is a mismatch.
- **`readClientSecret`** at a TTY with an immediate Enter resolves `''`.
- **`headersHelper`.**
  - Output padded with blank lines or spaces is accepted.
  - A helper that reads stdin gets EOF at once.
  - A value like `/path/helper.sh --flag` fails without running anything.
  - An inherited environment value that holds a newline stops the helper from running at all (Findings, 4).
- **`fetchAuthServerMetadata`** with a configured URL never falls back to discovery. A non-OK status is an exception, not `undefined`.

## Security requirements

**Pinned by the tests:**
- **The trust gate.** In an interactive session, a project or local `headersHelper` runs only after workspace trust, and never before it, whether called directly or through `getMcpServerHeaders`.
- **No shell.** A `headersHelper` value is never interpreted by a shell. Arguments, `;`, `$(…)` and `sh -c` all mean nothing runs.
- **The deadline.** A `headersHelper` that dies on SIGTERM cannot hold a connection longer than about 10 seconds (Findings, 3).
- **Failures are contained.** A misbehaving helper yields `null`, and the static headers still apply.
- **The failure report** names the key and the type of a bad value, and never the value itself. Output that is not JSON is the exception (Findings, 13).
- **State first.** The redirect's state is judged before its error and its code, and an empty state never matches.
- **Redaction.** The five sensitive parameters never reach a log in clear.
- **Credentials do not cross servers.** The key separates servers by name, transport, URL and headers, and every clear touches one server only.
- **Revocation sends one client authentication at a time.** The Bearer retry strips the body credentials, and Basic credentials are URL-encoded.
- **Local tokens are cleared** whatever the server answers.
- **A configured metadata URL must be https.**

**Described, kept for parity:** Findings 1, 2 and 7.

## Tests that pin it

- **The characterization suite, 8 files, 60 tests.** It covers 100% of the lines and functions of all seven files.
  - **`src/mcp/headersHelper.characterization.test.ts` (new, 16 tests).** It runs real `sh` scripts from a fresh temp dir. The scripts record their runs, environment and working directory in files there. It covers success and failure tables, the environment for `sse`, `http` and `ws`, the working directory, PATH lookup, no shell, the 10-second kill (one test takes about 10 s), trust by scope in interactive and non-interactive sessions, trust given mid-session, and the merge.
    - Trust is driven through the real global config (`saveGlobalConfig` with a trusted project entry, and `resetTrustDialogAcceptedCacheForTesting`). Interactivity is driven through `setIsInteractive`.
    - The failure reasons are read from `getInMemoryErrors()`, after opting into error recording with `CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC=0`.
    - The suite defines `MACRO.FEEDBACK_CHANNEL`, which the build inlines and the refusal path reads.
  - **`src/mcp/auth/serverKey.characterization.test.ts` (new):** the fixture, the key derivation, what changes the key and what does not, and `hasMcpDiscoveryButNoToken` over a real store.
  - **`src/mcp/auth/callbackParams.characterization.test.ts` (new):** parameter reduction, the judging order, and the exact redacted text.
  - **`src/mcp/auth/oauthErrors.characterization.test.ts` (new):** the rewrite table, the pass-through table, and the identity of a failed response.
  - **`src/mcp/auth/barrel.characterization.test.ts` (new):** the barrel's names and arities, the provider's public methods, `getScopeFromMetadata`'s order, and `AuthenticationCancelledError`.
  - **`authFetch`, `clientSecretStore` and `tokenRevocation.characterization.test.ts`:** written with the opencode port. They already covered their files fully against a real authorization server on loopback, and are kept as they are.
- **The harness** is `src/mcp/auth/__testutils__/oauthTestBed.ts`. It provides the loopback authorization server, and a per-test store under a temp `CLAUDIN_CONFIG_DIR` with a refusing `secret-tool` stand-in first on `PATH`, so the OS keychain is never touched.
- **The fixture** is `src/mcp/auth/__fixtures__/rewrite/server-keys.json`.
- **`scripts/migrations/probes/rewrite-mcp-auth.json`:** 39 probes, 14 on `headersHelper.ts` and 3 to 6 on each other file. Every one turns the suite red.
- **The inherited test `src/mcp/auth.test.ts`** is deleted. It was 90% this project's own, with 50 matching lines. Every case it held is now in the suites above:
  - the callback-parameter cases are in `callbackParams`;
  - the error-body cases are in `oauthErrors`;
  - the server-key cases are in `serverKey`;
  - scope, the cancel error, the barrel names and the arity are in `barrel`.

  Its pin of the provider's prototype listed one private method. The new pin checks only the public `OAuthClientProvider` methods.
- **Prompt text.** This unit sends no text to a model, and no file outside the unit pins text of it.
- **Not pinned, and why:**
  - the fixes of Findings 3 to 6, 8, 12 and 13. The suite has no row for the old behaviour of 4 and 6, and pins only the server name for output that is not JSON;
  - a helper that ignores SIGTERM or leaves a child holding its output (Findings, 3), which takes longer than the deadline to show;
  - the refusal before trust, which is reported nowhere today (Findings, 5);
  - the debug-log lines (`logMCPDebug`) of revocation and of the helper;
  - the 30-second request timeout of `createAuthFetch`, which would take 30 seconds. The suite pins that a caller's abort cuts a request short.

## Out of scope

- **The OAuth provider and the interactive sign-in** (`claudeAuthProvider.ts`, `oauthFlow.ts`): ported from opencode, with their own suites.
- **Project server approval** (`getProjectMcpServerStatus`, in `mcp/core`) and the config merge (`mcp/config`). They decide whether a project server with a `headersHelper` is connected at all.
- **The workspace trust state** (`src/platform/config`), and the secure storage backends (`src/platform/secureStorage`).
- **The process runner** `src/shared/proc/execFileNoThrow.ts`, whose rules decide what a `headersHelper` value may be (Findings, 4).

## Findings

1. **Security: a non-interactive session runs a project `headersHelper` without trust.**
   - `claudin -p` in a freshly cloned repository approves its `.mcp.json` servers (`mcp/core`) and then runs their helpers, which are commands from the repository.
   - **Decision: keep for parity, and track.** Scripted and CI use relies on `-p` skipping the trust dialog, the same way it skips it for hooks. The gate belongs with project server approval.
   - Pinned.
2. **Security: trust is per workspace, not per helper.**
   - Once a project is trusted, any `headersHelper` its `.mcp.json` later names runs, including one added by a pull.
   - **Decision: keep for parity.** Approval of a project server is decided in `mcp/core` and `mcp/config`, and a new server needs approval there.
   - Pinned through the scope table.
3. **The 10-second deadline is not a hard limit.**
   - The helper gets SIGTERM, and the call waits for the process to close. A helper that ignores SIGTERM, or leaves a background child holding stdout open, keeps the connection waiting past 10 seconds. Checked: such a helper finishing at 14 s held the call for 14 s.
   - If it then exits 0 with valid JSON, that late answer is accepted.
   - **Decision: fix.** At 10 seconds the call answers `null` whatever the process does, and the helper's process group is killed. This is pure hardening. Not pinned.
4. **An inherited environment value that holds a newline stops every helper from running.**
   - The process runner refuses such an environment. Exported shell functions (`BASH_FUNC_*%%`) and multi-line variables are common, and the user only sees `did not return a valid value`.
   - **Decision: fix.** The helper runs with the environment as it is. Nothing can depend on the helper silently not running, and with no shell a newline in a value is inert. Not pinned: the suite has no row for it.
5. **The refusal before trust is silent.** The helper is skipped, and the reason goes to a logger that does nothing in this build. A user sees a server connect without its headers and gets no explanation.
   - **Decision: fix.** Log the refusal to the server's MCP log, naming the server and saying that workspace trust is pending. The message must not point at another product's feedback channel. Not pinned.
6. **Header names merge case-sensitively.**
   - A static `authorization` plus a helper `Authorization` sends both, which `fetch` joins into one comma-separated value.
   - **Decision: fix.** Compare names case-insensitively. The helper's entry wins, with its spelling. Nothing can depend on a joined `Authorization`. Not pinned: the suite has no row for it.
7. **A relative `headersHelper` resolves against the process working directory,** not the directory of the `.mcp.json` that names it. Started from a subdirectory, a project's helper is not found.
   - **Decision: keep for parity, and track.** The config carries no file path to resolve against, and existing setups rely on the cwd.
   - Pinned.
8. **Revocation requests have no timeout.**
   - Metadata discovery is bounded at 30 seconds, but the revocation POST and its retry are not. A server that never answers keeps "Clear authentication" waiting, and the local tokens are not cleared until it does.
   - **Decision: fix.** Bound each revocation request like every other OAuth request, at 30 seconds. This is pure hardening. Not pinned.
9. **The server key moves with header order and header values.**
   - Reordering or rotating a static header strands the stored tokens. Changing `oauth.clientId` does not change the key.
   - **Decision: keep for parity.** Users' stored credentials depend on the exact key.
   - Pinned by the fixture.
10. **An aliased error loses its `error_uri`, and every rewritten error body loses unknown fields.**
    - **Decision: keep for parity.** The SDK reads only the standard fields.
    - Pinned.
11. **Redaction covers five query parameters only.** It does not touch the fragment, or names like `access_token`.
    - **Decision: keep for parity.** The only caller logs authorization URLs, which carry none of those.
    - Pinned.
12. **A pasted client secret is not read as typed.**
    - A terminal delivers a paste as one chunk. A chunk is appended whole, so a paste ending in Enter keeps the prompt waiting. The next Enter then stores the secret with a trailing `\r`. Backspace and Ctrl+C inside a chunk are not recognised either.
    - **Decision: fix.** Handle a chunk character by character. Nothing can depend on a control character inside a stored secret. Not pinned.
13. **Output that is not JSON can reach the error log in part.**
    - The reason given is the JSON parser's message, which quotes the first token it rejects. For `Authorization: Bearer …` that is `Authorization`, and for other output it can be the start of a credential.
    - **Decision: fix.** Report that the output is not JSON, without the parser's text. This is pure hardening. Not pinned: the suite checks only the server name for this case.

## Target design

- **One slice, four small modules behind the barrel.**
  - `serverKey`: the key, plus one typed accessor per store map, so no module reads or writes the store's shape by hand.
  - `oauthHttp`: the fetch, error normalization and discovery.
  - `redirect`: pure functions over parameters and URLs.
  - `credentials`: client secrets and sign-out.
- **The `headersHelper` module stays where `transport.ts` imports it.** Its parts:
  - a pure trust decision, `(scope, interactive, trusted) => 'run' | 'refuse'`;
  - a runner with a hard deadline (Findings, 3) and the environment passed through (Findings, 4);
  - a pure parser, `(stdout) => { headers } | { reason }`;
  - a case-insensitive merge (Findings, 6).
- **Types.**
  - A named `StoredMcpOAuthEntry` type.
  - The callback result as an exported discriminated union.
  - A `RevocationClientAuth` union (`basic`, `post`, `public`, `none`).
  - No `any`, and no casts on `scope`: take a `ScopedMcpServerConfig` or an explicit `scope?`.
- **Timeouts as named constants:** the 30-second OAuth request (revocation included) and the 10-second helper.
- **Build-time constants.** `MACRO` stays out of the module, so its tests need no globals.

## Outcome

Rewritten per method on 2026-10-04.

**Code.** The seven files were rewritten. New modules sit beside them:
- `auth/credentialMaps` (typed store access);
- `auth/hiddenPrompt`;
- `auth/revocation/clientAuth` and `auth/revocation/signOut`;
- `headersHelper/` (`trust`, `runHelper`, `parseOutput`, `mergeHeaders`, `readHelperHeaders`).

The eight characterization suites and `src/mcp/auth.test.ts` pass unchanged.

**Fixes, each with a test.**
- **3.** The helper has a hard 10 s deadline: its own process group, SIGTERM, then SIGKILL.
- **4.** The environment passes through with newlines.
- **5.** A refusal made before trust is logged to the server's MCP log.
- **6.** Header names merge case-insensitively.
- **8.** Revocation is bounded at 30 s.
- **12.** No trailing `\r` on a pasted secret.
- **13.** Output that is not JSON is reported without quoting it.

**Kept, tracked.** Findings 1 and 2: `-p` runs a project's helper without trust, and trust is per-workspace. Both are tracked in `bugs/mcp-config-security-findings.md`. Findings 7, 9, 10 and 11 are also kept.

**Probes.** `rewrite-mcp-auth.json` holds 155 probes. The older `mcpAuth.json` (19 probes) and `rewrite-levers-mcp-auth.json` (18) were re-pointed with the same mutations, and all three specs were proved in the checkout.

**Residue, reviewed.** What remains is contract:
- 17 lines of Claude Code: signatures, and the helper's `exec` options.
- 22 lines of openclaude: the `OAuthCallbackValidationResult` union and the OAuth callback parameter names (`code`, `state`, `error`, `error_description`, `error_uri`), which the protocol fixes.
