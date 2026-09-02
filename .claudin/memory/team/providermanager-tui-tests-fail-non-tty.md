---
name: ProviderManager.test.tsx PRESET_ORDER must mirror the .tsx preset list exactly
description: The 2 long-"known non-TTY" ProviderManager failures (Ollama/Vertex) were actually stale PRESET_ORDER navigation drift; FIXED 2026-07-08
type: feedback
---

The two `src/components/ProviderManager.test.tsx` failures long dismissed as
"non-TTY / raw-mode" ("first-run Ollama preset auto-detects installed models"
and "Vertex preset collects gcpProject and gcpRegion", each ~3s "Timed out
waiting for ProviderManager test condition") were **misdiagnosed**. Real cause:
the test's `PRESET_ORDER` array drifted from the preset list in
`ProviderManager.tsx` `renderPresetSelection()`.

**Why:** `navigateToPreset()` presses `j` exactly `PRESET_ORDER.indexOf(label)`
times to reach a preset. When presets are added to the .tsx list but not to
`PRESET_ORDER`, every target after the insertion point overshoots and the
awaited frame never renders → timeout. On 2026-07-08 the .tsx had gained
`Cloudflare Workers AI` + `Cloudflare AI Gateway` (between Bankr and Codex OAuth)
and `Z.AI (GLM Coding Plan)` (between Together AI and Custom); the two Cloudflare
inserts shifted Vertex/Ollama by 2. Bedrock/Foundry/Anthropic tests kept passing
because they sit *before* the insertion point. The `Raw mode is not supported`
flood in the output is unrelated Ink-teardown noise, not the failure — these
tests fake a TTY via `createTestStreams()` (`isTTY=true`, `setRawMode` no-op).

**How to apply:** if a ProviderManager navigation test times out, first diff
`PRESET_ORDER` (test) against the `options` array order in
`ProviderManager.tsx::renderPresetSelection()` (note `canUseCodexOAuth` adds
Codex/xAI, `mode==='first-run'` adds Skip, legacy-import may prepend one). Don't
attribute it to the sandbox. Any PR that adds/reorders a preset must update
`PRESET_ORDER` in lockstep. Fixed in commit on main 2026-07-08; full file now
20 pass / 0 fail.
