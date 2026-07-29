---
name: Codex strict schemas make the model send placeholder args
description: Codex/OpenAI strict mode forces every tool property into `required`, so optional args arrive as "" or null — widen the schema, and strip placeholders only under that transport
type: project
---

Codex Responses tools are sent with `strict: true` and `enforceStrictSchema`
puts EVERY property in `required` (codexShim.ts). A model that means "I am not
passing this optional argument" therefore cannot omit it — it invents a
placeholder: `pages: ""`, `symbol: ""`, `limit: 2000`, `view: "full"`.

**Why:** on 2026-07-28 a user session (`conversa_json.txt`, 1090 events) had
Read called 135 times with the identical input `{file_path: …glossario.md,
limit: 2000, offset: 1, pages: "", symbol: "", view: "full"}`, each answered
`Invalid pages parameter: ""` by FileReadTool.validateInput. The
repeated-failure hint fired from the 3rd failure to the 135th and changed
nothing: the model could not drop `pages`, because the schema said it was
required. Four other files looped the same way in that one session.

**How to apply:**
- Two halves, and both are needed: `enforceStrictSchema` widens every
  originally-optional property so the model has a legal way to decline it
  (`type: [t,'null']`; for an enum, `null` joins BOTH the type union and the
  value list), and `stripPlaceholderOptionalFields`
  (`src/utils/toolInputPlaceholders.ts`) turns the resulting `""`/`null` back
  into an absent key.
- **The two halves must walk the same depth.** `enforceStrictSchema` recurses
  into nested objects, array `items` and combinators, so it widens optionals at
  every level; the strip therefore walks value and schema together, all the way
  down. A top-level-only strip (the first revision) left
  `ReportFindings.findings[].line: null` for zod to reject — a REGRESSION,
  since the pre-fix `""` parsed fine there. Both sides now read optionality
  from the SAME JSON Schema (`inputJSONSchema`, else
  `zodToJsonSchema(inputSchema)`), so they cannot drift.
- **The strip is gated on the transport of the request being made**, via
  `transportSendsStrictToolSchemas(model)` (`src/services/api/providerConfig.ts`).
  Three traps that gate has to survive, all found in review: (1) reading the
  ACTIVE PROFILE's model is wrong — `/model`, a sub-agent `model:` override and
  `--fallback-model` all change the request model without touching the profile,
  so the model is passed in from `toolUseContext.options.mainLoopModel`;
  (2) re-deriving the transport instead of asking `resolveProviderRequest`
  drifts — a Copilot profile reports `github_copilot` yet resolves to
  `codex_responses` for GPT-5+/codex, and a `github:gpt-5` id only matches after
  normalization; (3) **`convertToolsToResponsesTools` has a SECOND call site** —
  openaiShim's `messagesClient` 400-fallback re-sends the same tools through
  /responses when Copilot answers "/chat/completions not accessible". That retry
  is invisible to the resolver (the request resolved to `chat_completions`), so
  the gate also returns true for ANY `github_copilot` profile. Grep both call
  sites before touching the gate. Do not make the strip global either: `""` is a
  real argument on every other transport.
- **Pass the whole tool, never `tool.inputSchema`.** MCP tools keep a
  passthrough `z.object({}).passthrough()` as their zod schema
  (`src/tools/MCPTool/MCPTool.ts:17`) and the server's real schema in
  `inputJSONSchema`, which is what their Ajv gate validates against
  (`MCPTool.ts:82-116`). Reading only the zod side makes the strip a silent
  no-op for every MCP tool — and combined with the widening that is a
  REGRESSION, because Ajv rejects `null` against `{"type":"string"}` outright
  where the old `""` usually passed. Caught by a review agent, not by tests.
- **An absent `required` means "nothing is required"** — JSON Schema semantics,
  applied identically in `enforceStrictSchema` and in the strip. The earlier
  "treat it as all-required" reading left tools whose every field is optional
  (`ListMcpResourcesTool`) uncallable without an invented argument.
- `const` and combinators (`anyOf`/`oneOf`/`allOf`) are still not widened: a
  const has one legal value, and a combinator already has branch structure.

**Unverified against the live backend (2026-07-28):** there is no Codex profile
on this machine, so the widening — especially the enum form
`{type:['string','null'], enum:[…,null]}` — was never sent to chatgpt.com. If
Codex 400s on it, that hunk in `allowNull` is the first suspect.
`scripts/profile/codex-strict-probe.ts` settles it: five variants (`v0` is the
pre-fix positive control, `v3` is exactly what production ships, `v4` the
`anyOf` alternative), N reps each, request body mirroring
`performCodexRequest`. Read `v0` first — if the control does not come back
PLACEHOLDER, the run detected nothing and the other verdicts are void.

**The fix that would delete all of it:** `strict: true` in
`convertToolsToResponsesTools` is inherited from the initial commit with NO
recorded evidence that the Codex backend requires it. If the probe shows a
truthful `required` list is accepted (variant v1 or v2), then `allowNull`, the
forced-required list and the whole strip layer in `toolExecution.ts` all go
away — only the `src/entrypoints/mcp.ts` strip stays, because there the liar is
the *other* harness driving us as an MCP server.
