---
name: providermanager-tui-tests-fail-non-tty
description: ProviderManager.test.tsx timeouts are never non-TTY — four causes so far (PRESET_ORDER drift 07-08, leaked CLAUDIN_SIMPLE 09-02, an Enter sent before a just-mounted Select listens 10-22, then env); the triage order is at the end
type: feedback
---

The two `src/providers/ui/ProviderManager.test.tsx` failures long dismissed as
"non-TTY / raw-mode" ("first-run Ollama preset auto-detects installed models"
and "Vertex preset collects gcpProject and gcpRegion", each ~3s "Timed out
waiting for ProviderManager test condition") were **misdiagnosed**. Real cause:
the test's `PRESET_ORDER` array drifted from the preset list in the preset
selection screen.

**Why:** `navigateToPreset()` presses `j` exactly `PRESET_ORDER.indexOf(label)`
times to reach a preset. When presets are added to the screen's list but not to
`PRESET_ORDER`, every target after the insertion point overshoots and the
awaited frame never renders → timeout. On 2026-07-08 the .tsx had gained
`Cloudflare Workers AI` + `Cloudflare AI Gateway` (between Bankr and Codex OAuth)
and `Z.AI (GLM Coding Plan)` (between Together AI and Custom); the two Cloudflare
inserts shifted Vertex/Ollama by 2. Bedrock/Foundry/Anthropic tests kept passing
because they sit *before* the insertion point. The `Raw mode is not supported`
flood in the output is unrelated Ink-teardown noise, not the failure — these
tests fake a TTY via `createTestStreams()` (`isTTY=true`, `setRawMode` no-op).

**How to apply:** if a ProviderManager navigation test times out, first diff
`PRESET_ORDER` (still in `ProviderManager.test.tsx`) against the `options` array
order in `PresetSelectionScreen` — since the 2026-09-19 split that screen is
`src/providers/ui/screens/PresetSelection.tsx`, not `ProviderManager.tsx` (note
`canUseCodexOAuth` adds Codex/xAI, `mode==='first-run'` adds Skip, and a
legacy-import may prepend one). Don't
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

**2026-10-22, a FOURTH cause: an Enter dropped on a Select that just mounted.**
"manual model step starts empty from a preset, keeps the value when editing" timed
out every time with output piped (`| grep`, `bun run test:provider`) and passed with
output sent to a file, which is how the full `bun test` passed it. Instrumenting
the wait showed the last frame still on "Choose a model" with "Enter manually"
focused. That row is first, so `pressUntilFocused` pressed nothing, and the
test's `write('\r')` landed before the Select's passive-effect key listener
existed. Whether the output is a pipe or a file changes the timing enough to
flip it. Fixed with `confirmFocusedRow`, which re-presses Enter only while the row
is still the focused one on screen, at the three confirms in that test. Other
`pressUntilFocused` + `write('\r')` pairs whose target can already be focused
(the Codex login choices) carry the same latent race.

**So the triage order for a ProviderManager timeout is now:** (1) is bare mode
leaked in — run the one-liner above; (2) has `PRESET_ORDER` drifted from the
screen's list; (3) does a confirm follow a `pressUntilFocused` that pressed
nothing — log the last frame on timeout; (4) only then look at the environment.
