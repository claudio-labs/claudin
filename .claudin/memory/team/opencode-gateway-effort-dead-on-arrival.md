---
name: opencode-gateway-effort-dead-on-arrival
description: Reasoning effort on OpenAI-compatible providers was inert (picker refused every id, and the body never carried the field) — FIXED by the models.dev reasoning_options catalog on feat/reasoning-effort-catalog
type: project
---

Measured 2026-09-20 against `https://opencode.ai/zen/go/v1`. **Two** independent
breaks, both fixed on `feat/reasoning-effort-catalog`:

1. **The picker gate.** `modelSupportsEffort` was an allowlist of model-name
   fragments, so every gateway id except `gpt-5.6-luna` returned false.
2. **The wire.** `reasoning_effort` was written in exactly ONE place in the
   whole OpenAI shim — inside the `isDeepSeekBaseUrl` branch. Probed with the
   shim harness: `gpt-5.6-luna` with `effortValue:'xhigh'` produced body keys
   `["max_tokens","messages","model","stream"]`. The picker was cosmetic there,
   and on official `api.openai.com` too.
3. **A third surface, found only by driving the real app**: `ModelPicker.tsx`
   had its OWN `cycleEffortLevel` ladder (low/medium/high/max from
   `modelSupportsMaxEffort`), so ←/→ offered `medium` on a glm-5.3-flash. No
   unit test saw it. Deleted in favour of the shared `cycleEffortForModel`.

**The fix is data, not a bigger table.** models.dev publishes
`reasoning_options` per (provider, model) — a union of `{type:'toggle'}`,
`{type:'effort',values:[…]}` and `{type:'budget_tokens'}`. Vendored as
`src/providers/model/reasoningCatalogData.ts` (21 providers, 423 models, 26 KB)
by `bun run codegen:reasoning-catalog`; `CLAUDIN_MODELS_CATALOG_REFRESH=1` adds
an opt-in on-disk refresh, off means zero network. `reasoningCatalog.ts` is the
single resolver the picker AND `messagesClient` call, which is what
`reasoningEffortInvariant.test.ts` pins.

Four independent corroborations that the catalog is accurate, each matching
vendor docs: glm-5.3 has no `medium`, glm-5/5.1 declare nothing (docs say
"GLM-5.2 and above"), minimax declares only a toggle (no `reasoning_effort` in
its docs), Groq lists `none|default|low|medium|high` (its prose page, not the
API reference that contradicts it).

**Verified live** (tmux, real requests, 2026-09-20): OpenCode GO glm-5.3-flash
at `max` → 200; OpenRouter openai/gpt-5-mini at `high` via `reasoning:{effort}`
→ 200. `/model` shows levels `low/high/max` for glm-5.3-flash and still says
"Effort not supported for glm-5.1" one row above.

Facts worth keeping:
- The gateway `/models` returns only `id/object/created/owned_by` — no
  capability metadata, not even `context_length`. Nothing to discover there.
- opencode itself is only *half* dynamic: `reasoningVariants()` reads
  `reasoning_options`, but the wire ENCODING is a 430-line hardcoded
  `variants()` with a denylist (`glm|kimi|qwen|minimax|deepseek-*`). No probing,
  no 400 retry.
- Do NOT broaden `isKimiEffortModel` to match `kimi-k3`: that lane's write is
  gated on a Moonshot host, so a gateway `kimi-k3` would light up the picker and
  send nothing — the exact defect. The catalog handles it.
- DeepSeek and Moonshot stay excluded from the generic lane (their own dialects).
  DeepSeek's picker is still *narrower* than its wire — a known, pinned asymmetry.
- **CI's CodeQL check gates on new alerts and it caught a real one here.** A host
  test written as `h.endsWith('aiplatform.googleapis.com')` trips
  `js/incomplete-url-substring-sanitization` (high). **Adding the separator is
  NOT enough** — `endsWith('-aiplatform.googleapis.com')` was rejected the same
  way, because any suffix test still accepts an arbitrary host in front of it.
  What passes is an **anchored module-level regex**,
  `/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/`, which is the repo's regex
  convention anyway. A leading dot (`.openai.azure.com`) satisfies the rule;
  anything else needs the anchors. Two round trips of CI to learn that — write
  the regex first.
  The check reports as `CodeQL … fail` in 2-3s while the two `Analyze` jobs
  pass, which reads like a flake and is not one: the alert is in
  `output.summary` of `gh api repos/<o>/<r>/commits/<sha>/check-runs`, and
  `gh api repos/<o>/<r>/code-scanning/alerts -f pr=<n> -f state=open` gives the
  file, line and message.

See [[context-window-discovery-field-names]] and
[[shim-only-body-fields-model-aware-gate]].
