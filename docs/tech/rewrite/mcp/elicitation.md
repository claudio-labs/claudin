# Spec: `mcp/elicitation`

Files: `src/mcp/elicitationHandler.ts`, `src/mcp/elicitationValidation.ts`,
`src/mcp/dateTimeParser.ts`.

## Purpose

MCP elicitation lets a connected server ask the user for structured input while
it works. The server either sends a small form (a flat object of typed fields)
or a link to open in a browser. This unit is the client side of that exchange,
minus the dialog:

- **The request handler.** It receives a server's `elicitation/create`, gives the Elicitation hooks the first chance to answer, and otherwise puts the request on the app state's elicitation queue. When the user answers, it gives the ElicitationResult hooks a chance to change the answer, and returns the result to the server. It also handles the server's "URL elicitation complete" notice.
- **The hook runners.** The tool-call retry flow (`mcp/client/callTool.ts`) and the headless host (`headless/print/mcpRuntime.ts`) use them on their own paths.
- **The field checks.** What the dialog (`mcp/ui/ElicitationDialog.tsx`, a separate unit) uses to classify each field and to check what the user typed.
- **Natural-language dates.** For `date` and `date-time` fields, text such as "tomorrow at 3pm" is turned into ISO 8601 by a small model call, and the result is checked like typed input.

## Public contract

These keep their names and types while their callers are not rewritten.

### `elicitationHandler.ts`

| Export | Signature | Used by |
|---|---|---|
| `ElicitationWaitingState` | type: `{ actionLabel: string; showCancel?: boolean }` | `mcp/client/callTool.ts` (builds one), `mcp/ui/ElicitationDialog.tsx` |
| `ElicitationRequestEvent` | type: `{ serverName: string; requestId: string \| number; params: ElicitRequestParams; signal: AbortSignal; respond: (response: ElicitResult) => void; waitingState?: ElicitationWaitingState; onWaitingDismiss?: (action: 'dismiss' \| 'retry' \| 'cancel') => void; completed?: boolean }` | `terminal/state/AppStateStore.ts` (the queue's element type), `mcp/ui/ElicitationDialog.tsx`, `mcp/client/callTool.ts` (queues its own), `agent/repl/ui/REPLDialogs.tsx` (reads and pops the queue) |
| `registerElicitationHandler` | `(client: Client, serverName: string, setAppState: (f: (prevState: AppState) => AppState) => void) => void` | `mcp/useManageMCPConnections.ts` |
| `runElicitationHooks` | `(serverName: string, params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult \| undefined>` | `mcp/client/callTool.ts`, `headless/print/mcpRuntime.ts` |
| `runElicitationResultHooks` | `(serverName: string, result: ElicitResult, signal: AbortSignal, mode?: 'form' \| 'url', elicitationId?: string) => Promise<ElicitResult>` | `mcp/client/callTool.ts`, `headless/print/mcpRuntime.ts` |

`Client`, `ElicitRequestParams` and `ElicitResult` are the MCP SDK's. `AppState` is `terminal/state/AppStateStore.ts`'s, whose `elicitation` field is `{ queue: ElicitationRequestEvent[] }`.

### `elicitationValidation.ts`

All are used by `mcp/ui/ElicitationDialog.tsx`, except `getEnumLabels` and `getMultiSelectLabels`, which have no caller outside the unit.

| Export | Signature |
|---|---|
| `ValidationResult` | type: `{ value?: string \| number \| boolean; isValid: boolean; error?: string }` |
| `isEnumSchema` | `(schema: PrimitiveSchemaDefinition) => schema is EnumSchema` |
| `isMultiSelectEnumSchema` | `(schema: PrimitiveSchemaDefinition) => schema is MultiSelectEnumSchema` |
| `isDateTimeSchema` | `(schema: PrimitiveSchemaDefinition) => schema is StringSchema & { format: 'date' \| 'date-time' }` |
| `getEnumValues` / `getEnumLabels` | `(schema: EnumSchema) => string[]` |
| `getEnumLabel` | `(schema: EnumSchema, value: string) => string` |
| `getMultiSelectValues` / `getMultiSelectLabels` | `(schema: MultiSelectEnumSchema) => string[]` |
| `getMultiSelectLabel` | `(schema: MultiSelectEnumSchema, value: string) => string` |
| `validateElicitationInput` | `(stringValue: string, schema: PrimitiveSchemaDefinition) => ValidationResult` |
| `validateElicitationInputAsync` | `(stringValue: string, schema: PrimitiveSchemaDefinition, signal: AbortSignal) => Promise<ValidationResult>` |

The schema types are the MCP SDK's.

### `dateTimeParser.ts`

Used only by `elicitationValidation.ts`.

| Export | Signature |
|---|---|
| `DateTimeParseResult` | type: `{ success: true; value: string } \| { success: false; error: string }` |
| `parseNaturalLanguageDateTime` | `(input: string, format: 'date' \| 'date-time', signal: AbortSignal) => Promise<DateTimeParseResult>` |
| `looksLikeISO8601` | `(input: string) => boolean` |

## Observable behaviour

### What a server's request may contain

The MCP SDK checks the request before this unit sees it. These limits are the protocol's, and the suite pins them as "never reaches the queue":

1. **A form request** has a `message` and a `requestedSchema`: `{ type: 'object', properties: { <name>: <field> }, required?: string[] }`. Each field is one of:
   - a string, optionally with `minLength`, `maxLength` and a `format` among `email`, `uri`, `date` and `date-time`;
   - a `number` or an `integer`, optionally with `minimum` and `maximum`;
   - a `boolean`;
   - a single choice: a string with `enum` (and the legacy `enumNames` labels), or with `oneOf: [{ const, title }]`;
   - a multi choice: `type: 'array'` with `items.enum`, or with `items.anyOf: [{ const, title }]`.
2. **A URL request** has `mode: 'url'`, a `message`, a `url` and an `elicitationId`.
3. **Refused before the queue:** a nested object field, a top-level schema that is not an object, an unknown string format, an array without choices, a missing message or schema, and a URL request without its id. The server gets an error response and the app state is never touched.
4. **Which modes a client accepts** depends on the capability the client declares. A client declaring `elicitation: {}`, as Claudin's does (`mcp/client/connection.ts`), accepts forms only, and a URL request is refused with `-32602`. A client declaring `{ form: {}, url: {} }` accepts both.

### Registering (`registerElicitationHandler`)

5. On a client created with the elicitation capability, it installs the request handler and the completion-notice handler for that server.
6. On a client created without it, it does nothing and does not throw. A server's request then gets `-32601` (method not found), and completion notices are ignored without touching the app state.

### A request, from arrival to answer

7. **Elicitation hooks first.** The hooks matching the server name run before anything is queued. If they produce an answer (see the hook runners below), that answer goes to the server and nothing is queued.
8. **Queueing.** Otherwise one event is appended at the end of `elicitation.queue`. Earlier events and every other field of the app state are kept as they were. The event carries:
   - `serverName`: the name given at registration;
   - `requestId`: the JSON-RPC id of the request, unchanged (a number from SDK servers);
   - `params`: the request's params exactly as received (no `mode` is added when the server omitted it);
   - `signal`: aborts when the server cancels the request;
   - `waitingState`: `{ actionLabel: 'Skip confirmation' }` for a URL request (no `showCancel`), absent for a form;
   - `respond`;
   - no `onWaitingDismiss` and no `completed`.
9. **Answering.** The first call to `respond` decides. Later calls are ignored and do not throw. The answer then passes through the ElicitationResult hooks (below), and what comes out is what the server receives: `accept` with its `content`, `decline`, or `cancel`.
10. **The queue is the caller's.** The handler never removes an event, whether it was answered or cancelled. The REPL pops the head once the dialog answers.
11. **The server cancels.** The event's `signal` aborts and the request resolves as `cancel`. The ElicitationResult hooks are skipped, because they run under the aborted signal, but the response notification (below) still announces `cancel`. The event stays queued, and a late `respond` is harmless.
12. **Any failure** inside the handler, such as the app-state setter throwing, answers the server with `cancel`.

### The completion notice (`notifications/elicitation/complete`)

13. It marks `completed: true` on the **first** queued event that belongs to the same server, is in URL mode, and has the same `elicitationId`. That includes events this handler did not create, such as a tool call's retry event. Every other event is left as is.
14. A notice that matches nothing leaves the app state object identical (the same reference).
15. Every notice, matched or not, is announced to the Notification hooks: notification type `elicitation_complete`, message `MCP server "<server>" confirmed elicitation <id> complete`.

### The hook runners

The hooks are the user's configured hooks, run by the hook engine (`platform/lifecycleHooks`), matched on the server name. What each hook receives is pinned as observed. Beside the fields every hook gets (session, transcript path, cwd), it receives:

16. **`runElicitationHooks`.** The hook input is:
    - `hook_event_name: 'Elicitation'`, `mcp_server_name` and `message`;
    - `mode`: `url` when the params say so, otherwise `form`, including when the params have no mode;
    - `url` and `elicitation_id`, when the params have them;
    - `requested_schema`, when the params have one.
17. **What `runElicitationHooks` returns.**
    - `undefined` when no hook is configured, a hook prints nothing, prints text that is not JSON, or prints JSON without an answer for the `Elicitation` event.
    - `{ action, content }` when a hook answers `accept` or `cancel` (`hookSpecificOutput: { hookEventName: 'Elicitation', action, content? }`).
    - `{ action: 'decline' }`, with no content, when a hook blocks (exit code 2, or `decision: 'block'`) or answers `decline`.
18. **`runElicitationResultHooks`.** The hook input is:
    - `hook_event_name: 'ElicitationResult'`, `mcp_server_name`, `action`, and `content` when the answer has any;
    - `mode` and `elicitation_id`, only when the caller passes them.
19. **What `runElicitationResultHooks` returns.**
    - The answer unchanged when no hook answers.
    - A hook's `accept` or `cancel` replaces the action. Its content replaces the user's, and when the hook gives none, the user's content is kept.
    - A block, or a `decline` answer, gives `{ action: 'decline' }` with no content.
20. **The announcement.** After the result hooks, the final action is announced to the Notification hooks: notification type `elicitation_response`, message `Elicitation response for server "<server>": <action>`. It does not wait for those hooks.

### Field kinds

21. `isEnumSchema` is true for a `string` with `enum` or `oneOf`, even an empty one, and false for any other type, even with an `enum`.
22. `isMultiSelectEnumSchema` is true for an `array` whose `items` is an object with `enum` or `anyOf`. It is false for an array without `items`, with `items: null`, or with plain string items.
23. `isDateTimeSchema` is true for a `string` with format `date` or `date-time`, and false otherwise.

### Choices and labels

24. **Values.**
    - `getEnumValues` returns `enum`, or the `const` of each `oneOf` entry, in order.
    - `getMultiSelectValues` returns `items.enum`, or the `const` of each `items.anyOf` entry.
    - Either returns `[]` for a schema with neither.
25. **Labels.**
    - `getEnumLabels` returns the `oneOf` titles, else the legacy `enumNames`, else the values.
    - `getMultiSelectLabels` returns the `anyOf` titles, else the values.
26. **One label.** `getEnumLabel` and `getMultiSelectLabel` return the label at the value's position. A value that is not listed comes back as itself, and so does a listed value without a label at its position (an `enumNames` shorter than `enum`).

### Checking typed input (`validateElicitationInput`)

27. **The result.** An accepted input gives `{ isValid: true, value }`, where `value` is what the form keeps. A refused one gives `{ isValid: false, error }`. When several rules fail, their messages are joined with `"; "`, the length rule first.
28. **Plain strings.**
    - Kept exactly as typed, spaces included. The empty string passes when there is no `minLength`.
    - `minLength` fails with `Must be at least <n> character(s)`, and `maxLength` with `Must be at most <n> character(s)`. The word is singular for 1.
    - An unknown `format` adds no check.
29. **`email`.** A full address, with no surrounding spaces and with a dot in the domain. It fails with `Must be a valid email address, e.g. user@example.com`.
30. **`uri`.** Any absolute URI with a scheme (`https:`, `mailto:` and others). A bare host fails with `Must be a valid URI, e.g. https://example.com`.
31. **`date`.** Exactly `YYYY-MM-DD`, and a real calendar date: `2024-02-29` passes, `2023-02-29` fails. It fails with `Must be a valid date, e.g. 2024-03-15, today, next Monday`.
32. **`date-time`.** `YYYY-MM-DDTHH:MM:SS`, with optional fractional seconds, followed by `Z` or a `±HH:MM` offset. Seconds and the zone are required. It fails with `Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm`.
33. **`number` and `integer`.**
    - The text is read as a JavaScript number: surrounding spaces, exponents (`1e3`) and hex (`0x1f`) are accepted. `Infinity` and words are not.
    - The value kept is the number. `integer` accepts `12.0` as 12, and refuses `12.5`.
    - Every failure, whether of type, integer or range, gives the same message for the schema:
      - with both bounds, `Must be <a number|an integer> between <min> and <max>`;
      - with one bound, `… >= <min>` or `… <= <max>`;
      - with none, `Must be a number` or `Must be an integer`.
    - Bounds are inclusive. For `number`, a whole bound is written with `.0` (`1.0`, `5.0`, `0.5`). For `integer` it is written as is.
34. **`boolean`.** `"true"` gives `true`. Other text is not pinned (see the findings).
35. **Choices.**
    - A listed value is kept as is.
    - Anything else is refused, including a label or a value in a different case. The error names each allowed value in double quotes.
    - Length limits do not apply to a choice.
    - An empty list refuses every input, with a non-empty error.
36. **A schema it cannot check** throws an `Error` with the message `Unsupported schema: <the schema as JSON>`. That covers multi-choice arrays, objects, unknown types and `{}`. The dialog never passes those to it.

### Natural-language dates

37. **`looksLikeISO8601`** is true when the text, trimmed, starts with `YYYY-MM-DD`, followed either by nothing or by `T`. Month and day ranges are not checked. Anything else is false: a space instead of `T`, a trailing letter, one-digit parts, no dashes, or the empty string.
38. **`validateElicitationInputAsync`.**
    - An input that passes the check above is returned as is, and the model is not called.
    - The model is called only when the field is `date` or `date-time` and the input does not look like ISO 8601. It is called once, with the field's format and the caller's signal.
    - The model's value is then checked against the whole field schema, length limits included. If it passes, that result is returned.
    - In every other case, the result is the check of the text the user typed, with its error.
39. **`parseNaturalLanguageDateTime`.**
    - It asks the model once. The reply is trimmed.
    - The reply is a success when it is non-empty, is not `INVALID`, and starts with four digits.
    - Otherwise the result is `{ success: false, error: 'Unable to parse date/time from input' }`.
    - If the model call fails, the result is `{ success: false, error: 'Unable to parse date/time. Please enter in ISO 8601 format manually.' }`, whatever the cause. The cause is never shown.

### Model-facing text: the date request

The request uses the small model, with query source `mcp_datetime_parse`, no tools and no agents, and passes the caller's signal through. The suite pins these facts with targeted matches:

- **The instructions** must get the model to reply with nothing but an ISO 8601 string, to prefer the future when the input is ambiguous, to use today's date for a time without a date, to leave the time out for a date without one, and to reply exactly `INVALID` (stated in double quotes) when it cannot parse the input confidently. They must mention `ISO 8601`, `ONLY`, `future` and `"INVALID"`.
- **The request** must state:
  - the user's text, verbatim inside double quotes, after `User input: `;
  - the current instant as a UTC ISO string followed by ` (UTC)`, for example `2026-03-04T05:06:07.890Z (UTC)`;
  - `Local timezone: ±HH:MM`, the local offset, zero-padded and signed (`+00:00` in UTC, `-03:00`, `+05:30`, `-09:30`);
  - `Day of week: <English weekday>`, taken in the **local** zone. At 01:00 UTC on a Wednesday, São Paulo reads `Tuesday`;
  - the output format: for `date`, `Output format: YYYY-MM-DD (date only, no time)`; for `date-time`, `Output format: YYYY-MM-DDTHH:MM:SS<offset> (full date-time with timezone)`, with the same offset;
  - the `"INVALID"` sentinel once more.

No test, snapshot or generated file outside the unit pins this text. `agent/prompts/querySource.ts` lists `mcp_datetime_parse` in a type union only.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| a client without the elicitation capability | registration is a silent no-op; the server gets `-32601` |
| a URL request to a client that declares forms only | `-32602` from the SDK; nothing queued |
| a malformed request | an error response from the SDK; nothing queued |
| `respond` called twice | the first answer is sent; the second is ignored |
| the server cancels | the event's signal aborts; `cancel` is announced; the event stays queued |
| the app-state setter throws | the server receives `cancel` |
| a completion notice for an unknown id | the app state is returned unchanged (same object) |
| two queued events share a URL id | only the first is ever marked completed |
| a hook prints non-JSON, or JSON for the other event | treated as no answer |
| an unsupported schema given to the check | it throws `Unsupported schema: <json>` |
| the model replies with prose, `INVALID`, or a two-digit year | the field keeps its own error |
| the model call fails | the field keeps its own error; the parser reports the ISO hint |

## Security requirements

- **The model's reply is never trusted.** A natural-language date is accepted only after its value passes the same field check as typed input, length limits included.
- **Nothing about a failed model call reaches the user** beyond the fixed hint.
- **A blocking hook always means `decline`.** It can never be turned into an answer, and its content is dropped.
- **Answers stay with their request.** An event is tied to the connection and the JSON-RPC id it came from. A completion notice affects only the notifying server's URL events.
- **Hooks keep their trust gate.** Every hook runs through the hook engine, which applies the workspace-trust and `disableAllHooks` rules. This unit must not run hook commands any other way.

## Tests that pin it

- Three suites, 166 tests, passing on three runs in a row:
  - `src/mcp/elicitation.validation.characterization.test.ts` (87): field kinds, choices and labels, every typed-input rule and message, and the unsupported-schema error.
  - `src/mcp/elicitation.dateTime.characterization.test.ts` (36): `looksLikeISO8601`, the model request under fixed clocks and five time zones, reply handling, and the async check. The model is the only stand-in.
  - `src/mcp/elicitation.handler.characterization.test.ts` (43): registration, queueing, answers, cancellation, completion notices, and both hook runners. Each test uses a real SDK `Server` and `Client` over the in-memory transport, with real command hooks from a temp `CLAUDIN_CONFIG_DIR`.
- **Line coverage:** `dateTimeParser.ts` 100%, `elicitationValidation.ts` 100%, `elicitationHandler.ts` 94.7%.
- **Not reached:** the request whose signal is already aborted when it would be queued, and the two hook-runner fallbacks for a hook engine that throws. If the engine throws, the request runner gives no answer, and the result runner returns the answer unchanged and still announces it. The contract offers no way to cause either.
- **A note on the SDK:** it ignores a cancel for JSON-RPC id `0`, so the cancellation test sends a ping first.
- `scripts/migrations/probes/rewrite-mcp-elicitation.json`: 40 probes over the three files, and every one turns the suites red.
- No `feature()` flag is read in this unit.
- Indirect coverage: `headless/print/mcpRuntime.characterization.test.ts` drives the hook runners on the headless path.

## Out of scope

- **Nothing is dropped.**
- **Elsewhere:**
  - the dialog, in `mcp/elicitationDialog`;
  - the tool-call retry flow for error `-32042`, in `mcp/callTool`;
  - the headless host's own handler, in `headless/print/mcpRuntime.ts`;
  - the capability Claudin declares, in `mcp/connection`.

## Findings

1. **A boolean check accepts any text.**
   - Any non-empty text, `"false"` included, gives `true`, and the empty string gives `false`.
   - The dialog toggles booleans itself and never sends them here.
   - **Decision: fix.** Accept `true` and `false` only, and refuse anything else with a message. No caller depends on the old behaviour. Not pinned.
2. **A blank number is accepted as 0.**
   - `""` and `"   "` pass a `number` or `integer` field as `0`.
   - The dialog handles blank input before it calls the check.
   - **Decision: fix.** Refuse blank input with the field's number message. Not pinned.
3. **The parser's success test is loose.**
   - Any reply that starts with four digits counts as a success, `2026garbage` included.
   - The async check re-checks the value, so nothing reaches a form.
   - **Decision: fix.** Count only an ISO date or date-time as a success. Not pinned.
4. **`uri` accepts any scheme**, `javascript:` and `file:` included.
   - The value only goes back to the server that asked. Claudin does not open it.
   - **Decision: keep for parity**, because a stricter rule would refuse legitimate URIs that servers ask for. Pinned with `mailto:`.
5. **Server-initiated URL elicitations never reach the handler in the shipped client.**
   - Claudin declares `elicitation: {}`, which this SDK reads as forms only. So the `Skip confirmation` waiting state is reachable only by a client that declares URL support.
   - The capability's comment cites compatibility with Java servers.
   - **Decision: keep for parity.** It belongs to `mcp/connection`. Pinned on both capability shapes.
6. **Only the first matching event is ever marked completed.**
   - When the handler's URL event and a tool call's retry event share an id, a second notice marks the first again.
   - **Decision: keep for parity.** The REPL shows the head of the queue, which is the first match. Pinned.
7. **ElicitationResult hooks do not see a cancellation by the server.**
   - They are skipped under the aborted signal, while the Notification hooks are told `cancel`.
   - **Decision: keep for parity.** Running a hook after the request is gone has no effect on the server, and the notification already reports it. Pinned.
8. **The user's date text goes into the model request unescaped**, inside double quotes, so the user can steer the model.
   - The reply is re-checked against the field, so the worst outcome is a well-formed value the user asked for.
   - **Decision: keep for parity.** Pinned (the quotes).
9. **The error for a choice outside the list is worded by the validation library.** An empty list's message is library jargon.
   - **Decision: keep for parity.** The suite pins only that the allowed values are named.

## Target design

- **Same three files, same exports.** The callers import them by path.
- **The handler is an adapter only.** It connects the SDK client to two pure pieces, both of which take a queue and return a queue (or the same one):
  - **queue operations**: append an event, and mark the matching URL event as completed;
  - **an answer pipeline**: request hooks, then the user, then result hooks, then the announcement.
- **Make the event's fields explicit.** One constructor builds an `ElicitationRequestEvent` from (server, request id, params, signal). The waiting state is decided by the mode there, and nowhere else.
- **Validation is a pure mapping** from a field schema to a checker that returns `ValidationResult`. Field kinds form a discriminated union (text, number, boolean, single choice, multi choice), classified once. The messages listed above live as named constants.
- **Date parsing** splits into a pure prompt builder, which takes the instant, the offset and the weekday as inputs (so no clock or `TZ` is needed in tests), and a thin model call. The success test is the ISO shape from finding 3.
- **Types.** Explicit throughout, with no `any`, and the SDK's schema types at the boundary.
