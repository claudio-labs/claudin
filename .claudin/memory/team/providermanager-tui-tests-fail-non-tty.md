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

**2026-09-02 — the same names came back, with a THIRD cause.** "first-run Ollama
preset", "Vertex preset collects gcpProject and gcpRegion" and now "Moonshot AI
preset shows OAuth vs API-key choice" failed on main with the same ~3s "Timed
out waiting for ProviderManager test condition". Not non-TTY, not PRESET_ORDER
drift: a sibling suite leaked `CLAUDIN_SIMPLE=1`, and under bare mode the OAuth
and preset flows these tests drive never render, so the awaited frame never
arrives. `ORIGINAL_ENV` snapshotted the leaked value at module load and the
`afterEach` then re-installed it after every test, so the file could not recover
on its own. Confirm this cause in seconds with
`CLAUDIN_SIMPLE=1 bun test src/providers/ui/ProviderManager.test.tsx` — it
reproduces exactly those three. See [[full-suite-in-ci-portability]].

**So the triage order for a ProviderManager timeout is now:** (1) is bare mode
leaked in — run the one-liner above; (2) has `PRESET_ORDER` drifted from the
.tsx list; (3) only then look at the environment.
