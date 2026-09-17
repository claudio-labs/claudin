# `tengu_*` gate keys — audit

104 distinct keys across the tree. This is the Fase 4a deliverable: which of
them still mean anything in this fork, and which are candidates for removal.

Resolution order, from the stub in `scripts/build/no-telemetry-plugin.ts`:
`~/.claudin/feature-flags.json` > `_openBuildDefaults` > the `defaultValue` the
call site passes. **No key reaches a network.** Every one resolves locally, and
a user can override any of them by writing that file.

The per-key stock values live in
`scripts/build/__tests__/__snapshots__/flagResolution.characterization.test.ts.snap`,
and the call sites come from `bun run scripts/verify/tengu-census.ts --gates`.

## The census was under-reporting, and this is how it was found

The first audit pass ran against 83 keys. It came back with the finding that
about two dozen live keys were missing from the list, and it was right: the gate
regex required the function's paren to follow its name immediately, so a call
written with a generic type argument —

```ts
getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
  'tengu_amber_wren',
  {},
)
```

— never matched. Those keys were not lost from the census total; they landed in
the `indirect` bucket as bare string literals, which is worse than being lost,
because `--gates` is the work list and they were silently absent from it.

Fixed in both the census and the resolution table: **83 → 103 keys**, 29
occurrences moved from `indirect` to `gate`. Both carry a test that fails
without the fix.

It happened a second time, from the other side. A key held in a `const` and
handed to the accessor by NAME —

```ts
const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'
getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
```

— has no literal between the parens either, so `tengu_sessions_elevated_auth_enforcement`
(`platform/bridge/trustedDevice.ts:33`) sat in `indirect` and was absent from all
103. The census now resolves a **file-local** binding passed to a gate accessor,
and `tengu_satin_quoll`'s const site joins the two literal ones it already had.
Two tests pin it — one for the promotion, one control arm asserting a bare
`const` (or one consumed by `logEvent`) stays `indirect`, which is what stops the
pass from filing every event constant as a gate key.

Then a third, from the token regex rather than the call shape. `tengu[A-Za-z0-9_]*`
has no hyphen, and two keys are not snake_case: `tengu-off-switch`
(`providers/shims/claude/streaming.ts:315`) and `tengu-top-of-feed-tip`
(`terminal/logo/EmergencyTip.tsx:6`). The token stopped at a bare `tengu`, which
no call-shape range could then cover, so both classified `indirect` — and the
first is read on **every** non-subscriber Opus request. Widening the class moves
no totals: a hyphenated mention in prose already counted once as `tengu`.

**103 → 106 keys** across the three fixes. Still deliberately unresolved: a key
imported from another module, or built by concatenation. Those stay in
`indirect` for human eyes rather than being chased by a pass that would only
work most of the time.

This is now the third time the instrument under-reported and the second time it
did so while its own "unclassified stays at zero" invariant was green. A count
that adds up is not a bucket that is right.

The lesson generalizes past this repo: an instrument that buckets things needs a
test per bucket boundary, not just a total that adds up. The census's
"unclassified must stay at zero" invariant could not catch this, because a
mis-bucketed key still classified.

## Buckets

**FUNCIONA** — flipping the key in `feature-flags.json` changes behaviour that
works here. **QUEBRA** — the branch is dead on arrival: it sits under a
`feature()` the build folds to `false`, or reaches a module this fork never
received. **INERTE** — read, but both outcomes are equivalent or the value is
never used.

### QUEBRA (13) — removal candidates

Nine are gated by a build flag that folds to `false`, so the read never runs and
flipping the key does nothing. The branch goes with the flag, not with the key:

| key | blocked by | site |
|---|---|---|
| `tengu_anti_distill_fake_tool_injection` | `ANTI_DISTILLATION_CC` (absent) | `providers/shims/claude/paramBuilders.ts:100` |
| `tengu_birch_trellis` | `TREE_SITTER_BASH_SHADOW` (absent) | `tools/BashTool/bashPermissions/decide.ts:142` |
| `tengu_ccr_mirror` | `CCR_MIRROR` (absent) | `platform/bridge/bridgeEnabled.ts:163` |
| `tengu_cobalt_harbor` | `CCR_AUTO_CONNECT` (absent) | `bridgeEnabled.ts:151` |
| `tengu_cobalt_raccoon` | `REACTIVE_COMPACT` (absent) | `autoCompact.ts:270` and two more |
| `tengu_collage_kaleidoscope` | `NATIVE_CLIPBOARD_IMAGE` (absent) | `terminal/image/imagePaste.ts:125` |
| `tengu_terminal_panel` | `TERMINAL_PANEL` (absent) | `useGlobalKeybindings.tsx:134` |
| `tengu_lodestone_enabled` | folded flag | — |

Note what "absent" means: `build.ts` folds `featureFlags[name] ?? false`, so a
flag missing from the map is false **by omission, not by decision**. That is how
`src/commands/ultraplan.tsx` — ~300 lines plus its prompt — became unreachable
without anyone choosing it; the whole ULTRAPLAN cluster (launch path, session
display and the SDK wire field) has since been deleted 2026-09-17.

`tengu_copper_panda` was the tenth, gating the skill-improvement post-sampling
hook behind `SKILL_IMPROVEMENT`. Both are gone: the hook wrote its suggestion to
an `AppState` field no UI ever read, so the whole chain — 171 lines, the field
and its two initializers — went with the key.

Four more only compose the `experiment_gates` payload handed to Anthropic's
closed VS Code extension (`vscodeSdkMcp.ts:79-106`): `tengu_vscode_review_upsell`,
`tengu_vscode_onboarding`, `tengu_vscode_cc_auth`, `tengu_quiet_fern`. Nothing in
`src/` reads their values.

### INERTE (0) — was 1, and it is gone

`tengu_harbor_permissions` gated `isChannelPermissionRelayEnabled()` in
`mcp/channelPermissions.ts`, the permission-prompts-over-Telegram relay. Every
export in that file was reachable only from inside it; the single external
reference was the `ChannelPermissionCallbacks` **type**, on an optional
`AppState` field that nothing wrote and nothing read — its own comment claimed
it was "constructed once in useManageMCPConnections", which had stopped being
true. File and field deleted, which is why the count above is 105 and not 106.

### FUNCIONA (91)

Everything else, with three subgroups that carry a condition:

- **Flipped by this fork on purpose (5):** `tengu_sedge_lantern`,
  `tengu_passport_quail`, `tengu_coral_fern`, `tengu_bramble_lintel`,
  `tengu_glacier_2xr`. These are `_openBuildDefaults`, and the characterization
  table proves the override path runs.
- **Only with a claude.ai credential (9):** the `tengu_bridge_*`, `tengu_ccr_*`
  and `tengu_cobalt_lantern` keys, plus
  `tengu_sessions_elevated_auth_enforcement` — the CLI-side half of the
  trusted-device rollout, which decides whether `X-Trusted-Device-Token` is sent
  at all (`trustedDevice.ts`, read at three sites). Live, but only for a user
  signed in.
- **Only on the first-party provider (9):** `tengu_attribution_header`,
  `tengu_amber_json_tools`, `tengu_tool_pear`, `tengu_fgts`,
  `tengu_cicada_nap_ms`, `tengu_miraculo_the_bard`, `tengu_penguins_off`,
  `tengu_marble_sandcastle`, `tengu-off-switch`.

## Findings worth acting on

1. **The bypass-permissions killswitch was half-disarmed — FIXED.** The stub
   neutralized `checkSecurityRestrictionGate` to `return false` precisely so a
   user cannot lock themselves out of `--dangerously-skip-permissions`. But three
   other sites read the *same* key through
   `checkStatsigFeatureGate_CACHED_MAY_BE_STALE`, which *does* honour
   `feature-flags.json` (`permissionSetup.ts:663`, `:893`, `:1375`), so writing
   `{"tengu_disable_bypass_permissions_mode": true}` still disabled the mode.

   Confirmed empirically, not by reading: with the guard removed from a COPY of
   the stub and that key set in a flags file, `checkStatsigFeatureGate` returns
   `true`; with it, `false`. The refusal now lives in `_getFlagValue`, which every
   accessor passes through, and is pinned by two tests — one asserting all four
   accessors, one asserting the refusal is scoped to that key rather than
   ignoring the whole file.
2. **`tengu_marble_sandcastle` inverted meaning in this fork.** Its comment treats
   it as legacy ("fast mode no longer needs the native binary"), but the default
   artifact is a Node bundle (`build.ts` targets `node`), so `isInBundledMode()`
   — which checks `Bun.embeddedFiles` — is false and the branch is live. Turning
   the key on makes first-party fast mode report "requires the native binary" in
   the build users actually run. Only `build:compile` closes that branch.
3. **Two commands were orphaned by an absent flag, not by design — one is now
   resolved.** `/web-setup` (the remote-setup site of `tengu_cobalt_lantern`)
   hung on `CCR_REMOTE_SETUP`, absent from the `featureFlags` map, and has been
   removed: 399 lines across three files plus `platform/github/ghAuthStatus.ts`,
   whose only importer it was. That key now has one site instead of two.
   `tengu_ultraplan_model` still hangs on `ULTRAPLAN`, which is absent for the
   same reason, and that one is NOT a clean cut — `RemoteAgentTask.tsx` imports
   `UltraplanPhase` from `agent/ultraplan/ccrSession.ts` and `pillLabel.ts`
   renders its phase off the live remote-agent task state.

   The general form is now pinned by
   `scripts/build/feature-flags-source-guard.test.ts`, which enumerates every
   `feature()` name off the map and fails on a new one.
4. **`tengu_slate_thimble` is unobservable in the REPL.** `paths.ts:74-80`
   short-circuits on an interactive session, so the key only has an effect
   non-interactively — and there it depends on `tengu_passport_quail`, which this
   fork already turns on.
5. **`tengu-off-switch` is the bypass killswitch's twin, and is still settable.**
   `streaming.ts:310-321` refuses the request outright when
   `{"tengu-off-switch": {"activated": true}}` is set, for any non-subscriber on
   a non-custom Opus model. Upstream that is an emergency capacity lever pulled
   remotely; here the only thing that can pull it is the user's own flag file,
   and what they get is `CUSTOM_OFF_SWITCH_MESSAGE` with nothing naming the
   cause. That is the exact argument that put
   `tengu_disable_bypass_permissions_mode` in `SECURITY_RESTRICTIONS`
   (finding 1), so it is a candidate for the same treatment — left as a finding
   rather than done here, because unlike the bypass mode this one is not a
   feature the user explicitly asked for and the call is theirs.

## Unsettled

These were classified from reading only; nothing was driven at runtime.

- The four VS Code keys are QUEBRA *within this tree*. Whether anyone points the
  Anthropic VS Code extension at a `claudin` binary is not decidable from here;
  if they do, flipping them changes that extension's behaviour.
- `tengu_plugin_official_mkt_git_fallback` selects between a GCS bucket and a git
  fallback for the official plugin marketplace. Whether the GCS bucket answers
  non-Anthropic clients cannot be read off the source; if it never does, turning
  the key off breaks `/plugin` rather than reordering its sources.
- `tengu_thinkback` is registered and does enable the command, but the command
  installs a `thinkback@` plugin from the official marketplace — publication
  status unverified.
