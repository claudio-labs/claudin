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
  (`src/services/tools/toolInputPlaceholders.ts`) turns the resulting `""`/`null` back
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

**VERIFIED LIVE 2026-07-29** — gpt-5.5 over Codex OAuth, `claudindev -p` with
`--output-format stream-json`, reading a 40-line file, one variant per build:

| shipped? | schema sent | result |
|---|---|---|
| ✅ **current** | `strict:true` + forced `required` + widening | 200; model sends `pages/symbol/view/limit/offset: null`; strip removes them; answer **40** (correct) |
| ✗ | `strict:true` + truthful `required` | **400 `invalid_function_parameters`** — *"Invalid schema for function 'Agent': 'required' … must include every key in properties. Missing 'isolation'."* |
| ✗ | no `strict` + truthful `required` + widening | 200; model still sends nulls (harmless) |
| ✗ | no `strict` + truthful `required`, **no widening** | 200, but model invents `limit:1, offset:1, pages:"", symbol:"", view:"full"` → read returns ONE line → **answer wrong (1)** |

Three things this settles:
1. The "Codex requires strict schemas" claim, unsourced since the initial
   commit, is **true** — with `strict:true` the backend enforces
   all-keys-in-`required`.
2. The backend **accepts the widened enum** (`{type:['string','null'],
   enum:[…,null]}`). That was the standing risk; it is closed.
3. **Dropping `strict` would NOT have fixed the bug.** gpt-5.5 invents
   placeholders even when the schema honestly says the field is optional — and
   `limit: 1` is a *value*, not a placeholder, so no strip can rescue it. The
   widening (giving the model an explicit `null` to send) is the part that
   works. Do not "simplify" this by removing `strict` and the widening.

`scripts/profile/codex-strict-probe.ts` remains the reusable instrument for
re-checking after a model or backend change (its header carries these results).
It could not run here: on Linux the Codex OAuth blob lives in libsecret, not in
`.credentials.json`, so the live check was done through `claudindev` instead —
which is the better test anyway, since it exercises the real credential path,
the real tool schemas and the strip together.
