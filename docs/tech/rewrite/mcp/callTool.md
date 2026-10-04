# Spec: `mcp/callTool`

The unit is five files: `src/mcp/client/callTool.ts`,
`src/mcp/client/toolResult.ts`, `src/mcp/client/errors.ts`,
`src/mcp/mcpValidation.ts` and `src/mcp/mcpOutputStorage.ts`.

It is characterized together with `mcp/connection` and `mcp/capabilities`
through the barrel `src/mcp/client.ts`, which keeps every name it exports.

## Purpose

This unit carries one MCP tool call and decides how its result reaches the
model:
- **the call:** its timeout, progress, and how each failure surfaces (tool error, 401, expired session, abort);
- **the URL-elicitation loop:** a server answering `-32042` gets its URLs shown to the user, or settled by a hook or the SDK host, and the call is retried;
- **the result:** which shape wins, how each content type becomes message blocks, and where binary content is saved;
- **the size gate:** output that is too large is either saved to a file the model is told to read, or cut, with a notice.

Its callers are the MCP tools built by `mcp/capabilities`, the IDE RPC, the
resource tools and WebFetch (binary saving), the MCP tool UI (size estimate),
and the tool executor (the error classes).

## Public contract

Through the barrel `src/mcp/client.js` unless noted.

| Export | Signature | Used by |
|---|---|---|
| `callMCPToolWithUrlElicitationRetry` | `(opts: { client: ConnectedMCPServer; clientConnection: MCPServerConnection; tool: string; args: Record<string, unknown>; meta?: Record<string, unknown>; signal: AbortSignal; setAppState: (f: (prev: AppState) => AppState) => void; onProgress?: (data: MCPProgress) => void; callToolFn?: (…) => Promise<…>; handleElicitation?: (serverName: string, params: ElicitRequestURLParams, signal: AbortSignal) => Promise<ElicitResult> }) => Promise<{ content: MCPToolResult; _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }>` | `mcp/capabilities` |
| `callMCPTool` (`client/callTool.js`) | `(opts: { client: ConnectedMCPServer; tool; args; meta?; signal; onProgress? }) => Promise<same result>` | `mcp/capabilities` (`callIdeRpc`) |
| `extractToolUseId` (`client/callTool.js`) | `(message: AssistantMessage) => string \| undefined` | `mcp/capabilities` |
| `DEFAULT_MCP_TOOL_TIMEOUT_MS` (`client/callTool.js`) | `300000` | this unit |
| `McpAuthError` | `class extends Error { serverName: string }`; `(serverName: string, message: string)` | `agent/tools/toolExecution.ts` |
| `McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` | `class extends TelemetrySafeError…`; `(message: string, telemetryMessage: string, mcpMeta?: { _meta?: Record<string, unknown> })` | `agent/tools/toolExecution.ts` |
| `McpSessionExpiredError` (`client/errors.js`) | `class extends Error`; `(serverName: string)` | `mcp/capabilities` |
| `isMcpSessionExpiredError` | `(error: Error) => boolean` | `mcp/connection` |
| `transformResultContent` | `(resultContent: PromptMessage['content'], serverName: string) => Promise<ContentBlockParam[]>` | `mcp/capabilities` (prompt commands) |
| `transformMCPResult` | `(result: unknown, tool: string, name: string) => Promise<TransformedMCPResult>` | this unit |
| `processMCPResult` | `(result: unknown, tool: string, name: string) => Promise<MCPToolResult>` | this unit |
| `inferCompactSchema` | `(value: unknown, depth?: number) => string` (depth defaults to 2) | this unit |
| `MCPResultType`, `TransformedMCPResult` (types) | `'toolResult' \| 'structuredContent' \| 'contentArray'`; `{ content: MCPToolResult; type: MCPResultType; schema?: string }` | `mcpOutputStorage.ts` |
| `MCPToolResult` (`mcpValidation.js`, type) | `string \| ContentBlockParam[] \| undefined` | `tools/MCPTool/UI.tsx` |
| `getContentSizeEstimate` (`mcpValidation.js`) | `(content: MCPToolResult) => number` | `tools/MCPTool/UI.tsx` |
| `getMaxMcpOutputTokens`, `mcpContentNeedsTruncation`, `truncateMcpContent`, `truncateMcpContentIfNeeded`, `MCP_TOKEN_COUNT_THRESHOLD_FACTOR` (0.5), `IMAGE_TOKEN_ESTIMATE` (1600) (`mcpValidation.js`) | `() => number`; `(content) => Promise<boolean>`; `(content) => Promise<MCPToolResult>` ×2 | this unit |
| `persistBinaryContent` (`mcpOutputStorage.js`) | `(bytes: Buffer, mimeType: string \| undefined, persistId: string) => Promise<{ filepath: string; size: number; ext: string } \| { error: string }>` | `WebFetchTool/utils.ts`, `ReadMcpResourceTool` |
| `getBinaryBlobSavedMessage` (`mcpOutputStorage.js`) | `(filepath: string, mimeType: string \| undefined, size: number, sourceDescription: string) => string` | `ReadMcpResourceTool` |
| `isBinaryContentType` (`mcpOutputStorage.js`) | `(contentType: string) => boolean` | `WebFetchTool/utils.ts` |
| `extensionForMimeType`, `getFormatDescription`, `getLargeOutputInstructions` (`mcpOutputStorage.js`) | `(mimeType?: string) => string`; `(type: MCPResultType, schema?: unknown) => string`; `(path: string, contentLength: number, formatDescription: string, maxReadLength?: number) => string` | this unit |

## Observable behaviour

### 1. The call

- **What is sent.** `tools/call` with the tool's name, the arguments, and `meta` as `_meta`.
- **What comes back.** `{ content, _meta, structuredContent }`, where `content` is the result after the size gate (4), and the other two are the server's own, or `undefined`.
- **Progress.** Server progress notifications reach `onProgress` as `{ type: 'mcp_progress', status: 'progress', serverName, toolName, progress, total, progressMessage }`.
- **The timeout.** A call that outlives `MCP_TOOL_TIMEOUT` milliseconds (default 300000) fails with `MCP server "<server>" tool "<tool>" timed out after <whole seconds>s`.

Failures:
- **`isError: true`** throws `McpToolCallError` (name `McpToolCallError`). Its message is the text of the first content block, or a legacy `error` field when there is no content, or else `Unknown error`. Its telemetry message is `MCP tool [<server>] <tool>: <message>`. It carries `mcpMeta: { _meta }` when the result had `_meta`.
- **A 401** throws `McpAuthError(server, 'MCP server "<server>" requires re-authorization (token expired)')`. A 401 here is an error whose `code` is 401, from the HTTP layer or as a JSON-RPC code, or the SDK's unauthorized error.
- **An expired session** throws `McpSessionExpiredError` (`MCP server "<server>" session expired`), after clearing the server's cached connection. An expired session is HTTP 404 with JSON-RPC `-32001` in the body, either spelling. On `http` and `claudeai-proxy` servers, the SDK's `-32000` "Connection closed" counts too. On other types that error passes through.
- **Aborting the signal** rejects with the SDK's error, code `-32001`, whose message names the AbortError (Findings, 5).
- **Anything else** passes through unchanged.

`extractToolUseId(message)` gives the id of the message's first content block
when that block is a `tool_use`, and `undefined` otherwise.

### 2. URL elicitation (`-32042`)

`callMCPToolWithUrlElicitationRetry` makes the call. On an SDK error with code
`-32042` it reads `error.data.elicitations`, keeping only those with
`mode: 'url'` and string `url`, `elicitationId` and `message`. If none
remain, it rethrows the error. For each kept elicitation, in order:
1. **Elicitation hooks** for the server name run first.
   - A hook that answers decline or cancel ends the call with content `URL elicitation was <declined|canceled> by a hook. The tool "<tool>" could not complete because it requires the user to open a URL.`
   - A hook that accepts goes on to the next elicitation, with no prompt to anyone.
2. **Otherwise, with `handleElicitation`** (SDK and print mode), it is asked `(serverName, params, signal)`.
3. **Otherwise (the REPL)**, an entry is appended to `appState.elicitation.queue`:
   - `serverName`, `requestId: error-elicit-<elicitationId>`, `params`, `signal`;
   - `waitingState: { actionLabel: 'Retry now', showCancel: true }`;
   - `respond(result)`: an accept there is only consent and resolves nothing. Decline and cancel resolve;
   - `onWaitingDismiss(action)`: `'retry'` resolves accept, anything else cancel. Aborting the signal resolves cancel.
4. **ElicitationResult hooks** then may replace the answer. Anything but accept ends the call with content `URL elicitation was <declined|canceled> by the user. The tool "<tool>" could not complete because it requires the user to open a URL.`

When every elicitation is accepted, the call is made again. After three
accepted rounds, a fourth `-32042` is thrown. The server name passed around is
the record's name, or `unknown` when the record handed over is not connected.
Before each attempt, an aborted signal throws
`Tool call aborted during URL elicitation`.

### 3. The result: `transformMCPResult(result, tool, server)`

The first matching shape wins:
1. **`toolResult`:** `{ content: String(toolResult), type: 'toolResult' }`.
2. **`structuredContent`** (not undefined): `{ content: <JSON text>, type: 'structuredContent', schema }`.
3. **a `content` array:** each item through `transformResultContent`, flattened, as `{ content: blocks, type: 'contentArray', schema }`.

Anything else throws `MCP server "<server>" tool "<tool>": unexpected response format`.

The schema hint (`inferCompactSchema`) is jq-like:
- `null`, the `typeof` of a primitive, and `[]`;
- an array is `[<hint of its first element>]`, one level deeper;
- an object is `{k: <hint>, …}` with at most 10 keys, then `, ...`;
- past the depth (2 by default) an object is `{...}`. So `{items: [{id: 1}]}` reads `{items: [{...}]}`.

`transformResultContent(item, server)`:

| Item | Blocks |
|---|---|
| `text` | one text block, sanitized of invisible and private-use characters |
| `image` | one image block, re-encoded within the API's size limits; media type from the image |
| `audio` | the bytes saved to disk (5); one text block naming the path, prefixed `[Audio from <server>] ` |
| `resource` with `text` | one text block, `[Resource from <server> at <uri>] <text>`, sanitized |
| `resource` with a `blob` of type png, jpeg, gif or webp | a text block holding the prefix alone, then the image block |
| `resource` with any other `blob` | saved to disk like audio, with the resource prefix |
| `resource` with neither | nothing |
| `resource_link` | `[Resource link: <name>] <uri>`, plus ` (<description>)` when there is one |
| any other type | nothing |

### 4. The size gate: `processMCPResult(result, tool, server)`

1. **The transform** (3).
2. **The `ide` server's content is returned as is.**
3. **Content under half the cap** (the cap is `MAX_MCP_OUTPUT_TOKENS` if a positive number, else 25000) is returned without counting. The estimate is:
   - text at the active model's characters per token;
   - 1600 per image;
   - nothing for other blocks.
4. **Otherwise the model's token-counting endpoint is asked.** Content passes as is when the count is at most the cap, when there is no count, or when counting fails (Findings, 1).
5. **Too large, with `ENABLE_MCP_LARGE_OUTPUT_FILES` set to a false value, or with any image in the content:** the output is cut (6).
6. **Too large otherwise:** it is saved as text under the session's tool-results directory, as `mcp-<server>-<tool>-<time…>.txt`, names normalized to `[a-zA-Z0-9_-]`. String content is saved as is, block content as indented JSON. The model gets instead the read-the-file instructions (7), with the path, the saved length and the format: `Plain text`, `JSON with schema: <hint>`, or `JSON array with schema: <hint>`, or without the schema when there is none.
7. **If saving fails,** the model gets `Error: result (<n> characters) exceeds maximum allowed tokens. Failed to save output to file: <reason>.` and a pointer to the server's pagination or filtering tools.

### 5. Saving binary content

- **`persistBinaryContent(bytes, mime, id)`** writes the bytes as given to `<tool-results>/<id>.<ext>`, overwriting, and returns `{ filepath, size, ext }`. A failed write returns `{ error }` and is never thrown.
- **The extension** comes from a fixed list: pdf, json, csv, txt, html, md, zip, docx, xlsx, pptx, doc, xls, mp3, wav, ogg, mp4, webm, png, jpg, gif, webp, svg. The mime type's parameters, case and spaces do not matter. Anything else is `bin`.
- **The blob ids this unit uses** are `mcp-<normalized server>-blob-<time>-<random>`.
- **The model is told** `<prefix>Binary content (<mime or "unknown type">, <size as 12 bytes / 2KB / 3MB>) saved to <path>`. When the write fails: `<prefix>Binary content (<mime>, <n> bytes) could not be saved to disk: <reason>`.
- **`isBinaryContentType(type)`** is false for the empty string, `text/*`, JSON (`application/json`, `+json`), XML (`application/xml`, `+xml`), `application/javascript…` and form data. It is true for everything else.

### 6. Cutting

- **The budget** is four characters per token of the cap.
- **Strings** keep their first budget characters, then the notice.
- **Blocks** share the budget:
  - text blocks are kept until the budget runs out, and the one that crosses it is cut;
  - an image counts 1600 tokens' worth. If it does not fit, it is compressed into what is left, or dropped when nothing is left or compression fails;
  - other blocks are kept;
  - the notice is appended as a last text block.
- **The notice must:**
  - say that the output was truncated at the cap, giving the cap in tokens (`[OUTPUT TRUNCATED - exceeded <cap> token limit]`);
  - point the model to the server's pagination or filtering tools;
  - otherwise have it tell the user that it is working with truncated output.
- **`truncateMcpContentIfNeeded`** returns the same content object when no cut is needed.

### 7. The read-the-file instructions

`getLargeOutputInstructions(path, length, format, maxReadLength?)` is text to
the model. It must state:
- that the result (`<length with thousands separators> characters`) exceeds the maximum allowed tokens, and that the output was saved to `<path>`;
- the format, on its own `Format: …` line;
- to read it in portions with offset and limit, search it, and use jq for structured queries;
- that for a summary, analysis or review it must read the file at `<path>` in sequential chunks until 100% of it has been read;
- to shrink the chunk size on truncation warnings. With `maxReadLength`, it names the `[N lines truncated]` warning, insists it not proceed until done, and states the Bash output limit with separators;
- that before any summary it must say how much it read, and say so explicitly if not everything.

## Edge cases and errors

- **A `-32042` with no usable URL elicitation** is rethrown at once, without asking anyone.
- **A tool error whose first block is not text** reads `Unknown error`, even when later blocks hold text.
- **A blob resource with no mime type** is saved as `.bin`, and the message says `unknown type`.
- **The counting endpoint is a model call.** Every provider without it lets large output through (Findings, 1).

## Security requirements

**Pinned by the tests:**
- **Files stay in the tool-results directory.** Server and tool names are normalized before they become file names, so `../` in a name cannot leave it. Extensions come from a fixed list, so a mime type cannot name a path.
- **Oversized output never reaches the model whole when it is counted over the cap:** it is either saved and replaced by instructions, or cut with the notice.
- **When saving fails, the model gets the reason and not the output.**
- **Server text is sanitized** before it reaches the model.
- **A 401 surfaces as `McpAuthError`,** so the tool layer marks the server needs-auth instead of retrying.
- **The elicitation loop is bounded** (three rounds), stops on abort, and ignores malformed and form-mode entries.

**Described:** Findings 1 and 2 (keep for parity, tracked), and Finding 4 (fix).

## Tests that pin it

- **`src/mcp/client.callTool.characterization.test.ts` (new, 24 tests):** calls against real SDK servers, over the in-memory transport and a loopback Streamable HTTP port (`mcpServerBed`). It covers results, progress, each failure, the URL-elicitation loop through the host handler, through the REPL queue held in a real app state, and through real command hooks from `settings.json` in a temp `CLAUDIN_CONFIG_DIR`, plus the error classes.
- **`src/mcp/client.toolResult.characterization.test.ts` (new, 28 tests):** the transforms, the size gate, cutting and storage. Files land under a temp `CLAUDIN_CONFIG_DIR`. The token-counting endpoint, a model call, is the one boundary replaced: it is spied per test with the count the case needs.
- **Coverage, from a run of the two suites:** `callTool.ts` 97%, `toolResult.ts` 99.6%, `errors.ts` 100%, `mcpValidation.ts` 98%, `mcpOutputStorage.ts` 100%.
- **`scripts/migrations/probes/rewrite-mcp-callTool.json`:** 40 probes over the five files. Every one turns the suites red. They include the refusal paths: the name normalization of saved files and blobs, the tool-results directory, the save-failure text, and the truncation notice.
- **Prompt text.** This unit sends text to the model: the read-the-file instructions, the truncation notice, the saved-blob message, the save-failure message, the elicitation endings, and the content prefixes. Their facts are pinned by targeted matches, on both forms of the instructions. No file outside the unit pins any of them byte for byte. The FileRead tests that match "exceeds maximum allowed tokens" pin FileRead's own message.
- **The existing `src/mcp/client.regression.test.ts`** (residue sweep) also pins `isMcpSessionExpiredError`, `inferCompactSchema`, `transformMCPResult` and `processMCPResult` cases.
- **Not pinned, and why:**
  - **An HTTP-layer 401 during a call.** The OAuth client intercepts it first, and a loopback server cannot play a server that is both an MCP endpoint and an OAuth-protected resource. The JSON-RPC 401 path pins the mapping.
  - **The 30-second "still running" log line,** which would take 30 seconds.
  - **The fixes of Findings 3 and 4.**

## Out of scope

- **Writing tool results** (`persistToolResult` in `agent/tools/toolResultStorage.ts`) and its directory layout. Image resizing (`terminal/image`). Token counting (`shared/tokenEstimation.ts`). The elicitation hooks and the dialog (`mcp/elicitation`, `mcp/elicitationDialog`).
- **Building tools from a server, and retrying an expired session** (`mcp/capabilities`).

## Findings

1. **Security: oversized output reaches the model whole when it cannot be counted.**
   - Counting is a call to the model provider. Every provider without a counting endpoint (all OpenAI-compatible ones, Gemini and others) answers nothing, so the output is neither cut nor saved. The same happens when the call fails.
   - **Decision: track** (kept for parity until decided). Falling back to the local estimate changes what users of those providers get.
   - Pinned.
2. **Security: output from a server named `ide` is never size-checked,** and any configured server may take that name. Only `executeCode` and `getDiagnostics` survive the tool filter (`mcp/capabilities`).
   - **Decision: keep for parity, and track** reserving the name for the IDE integration.
   - Pinned.
3. **Saved output is named by server, tool and millisecond only.** Two calls of the same tool in the same millisecond share a file. Since the write never overwrites, the second result points the model at the first one's content.
   - **Decision: fix.** Add a random part, as the blob names have. No caller reads the name. Not pinned: the suite pins the prefix and the extension only.
4. **Security: `persistBinaryContent` takes the file name from its caller unchecked.** An id holding `/` or `..` writes outside the tool-results directory. Every current caller passes a safe id.
   - **Decision: fix.** Refuse such an id. This is pure hardening. Not pinned.
5. **An abort never yields "no content".** The SDK in use turns it into its own `-32001` error, so the empty-result path written for an abort is never reached.
   - **Decision: keep for parity.** The tool layer already treats it as an error of an aborted turn.
   - Pinned.
6. **A JSON-RPC error with code 401 from any server type,** stdio included, becomes `McpAuthError`.
   - **Decision: keep for parity.**
   - Pinned.
7. **A tool error keeps only the first content block,** and a non-text first block reads `Unknown error`.
   - **Decision: keep for parity.** Error consumers parse the message.
   - Pinned.
8. **Content with any image is cut, never saved,** and images over budget are compressed or dropped without a word to the model.
   - **Decision: keep for parity.**
   - Pinned.
9. **The schema hint's own documentation claims two levels through arrays.** Arrays use a level, so an array of objects reads `[{...}]` at the second level.
   - **Decision: keep for parity.** The model sees this text.
   - Pinned.

## Target design

- **Three modules:**
  - `call`: the request, the timeout and the error mapping, as a pure `classifyCallError(error, configType) => 'auth' | 'expired' | 'passthrough'`;
  - `elicitationLoop`: the bounded retry, with the three resolution paths (hook, host, queue) behind one `resolveUrlElicitation` interface;
  - `resultGate`: transform, then decide, as a pure `decide(sizeEstimate, counted, flags) => 'pass' | 'save' | 'cut'`, then act.
- **Storage:**
  - one `toolResultFile(kind, parts)` that builds every name from normalized parts plus a random suffix (Findings, 3);
  - refuses ids with separators (Findings, 4);
  - always joins under the tool-results directory.
- **Model-facing texts** live in one module of templates, each a function of the facts listed in 4, 5, 6 and 7, so the tests can pin facts per template.
- **Types:** `MCPToolResult` and `TransformedMCPResult` stay. Add `CallOutcome` for the elicitation endings, and drop the casts on the SDK result.

## Outcome

Rewritten per method on 2026-10-04.

**What was rewritten.** All bodies and private declarations of the five files. New modules:
- `callErrors` (error classification);
- `urlElicitation` (the bounded retry loop);
- `modelTexts` (every text the model sees);
- `resultFiles`, `resultContent` and `resultGate`.

The two characterization suites pass unchanged.

**Fixes, each with a test.**
- **Finding 3.** Saved-output names carry six random characters, so two calls in the same
  millisecond get two files.
- **Finding 4.** `persistBinaryContent` refuses an id containing `/`, `\` or `..` (or an empty id)
  and writes nothing.

**Tracked, unchanged, each with a comment and a probe.** Findings 1 and 2: oversized output can
reach the model when tokens cannot be counted, and a server named `ide` skips the size limit. Both
are listed in `bugs/mcp-config-security-findings.md`.

**Kept.** Findings 5–9.

**Dead code, gone with it.** The old call path computed a code-indexing tool name for a telemetry
event that no longer exists, and never used it. `detectCodeIndexingFromMcpServerName` and its
pattern table in `shared/fs/codeIndexing.ts` lost their only caller, so they were removed. The Bash
side does the same unused computation; that is BashTool's, in phase 6.

**Probes.** 159, in `rewrite-mcp-callTool.json`.

**Residue, reviewed.** 141 lines of Claude Code remain:
- the `callMCPTool` signature and its options record;
- the transport-session error class;
- the `toolResult` content types;
- the `mcpOutputStorage` result types;
- the validation helpers' signatures.

Callers import all of them.
