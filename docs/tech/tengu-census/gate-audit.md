# `tengu_*` gate keys — audit

103 distinct keys across the tree. This is the Fase 4a deliverable: which of
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

### QUEBRA (14) — removal candidates

Ten are gated by a build flag that folds to `false`, so the read never runs and
flipping the key does nothing. The branch goes with the flag, not with the key:

| key | blocked by | site |
|---|---|---|
| `tengu_anti_distill_fake_tool_injection` | `ANTI_DISTILLATION_CC` (absent) | `providers/shims/claude/paramBuilders.ts:100` |
| `tengu_birch_trellis` | `TREE_SITTER_BASH_SHADOW` (absent) | `tools/BashTool/bashPermissions/decide.ts:142` |
| `tengu_ccr_mirror` | `CCR_MIRROR` (absent) | `platform/bridge/bridgeEnabled.ts:163` |
| `tengu_cobalt_harbor` | `CCR_AUTO_CONNECT` (absent) | `bridgeEnabled.ts:151` |
| `tengu_cobalt_raccoon` | `REACTIVE_COMPACT` (absent) | `autoCompact.ts:270` and two more |
| `tengu_collage_kaleidoscope` | `NATIVE_CLIPBOARD_IMAGE` (absent) | `terminal/image/imagePaste.ts:125` |
| `tengu_copper_panda` | `SKILL_IMPROVEMENT` (absent) | `lifecycleHooks/skillImprovement.ts:164` |
| `tengu_terminal_panel` | `TERMINAL_PANEL` (absent) | `useGlobalKeybindings.tsx:134` |
| `tengu_lodestone_enabled` | folded flag | — |
| `tengu_ultraplan_model` | `ULTRAPLAN` (absent) | `commands/ultraplan.tsx:31` |

Note what "absent" means: `build.ts` folds `featureFlags[name] ?? false`, so a
flag missing from the map is false **by omission, not by decision**. That is how
`src/commands/ultraplan.tsx` — ~300 lines plus its prompt — became unreachable
without anyone choosing it.

Four more only compose the `experiment_gates` payload handed to Anthropic's
closed VS Code extension (`vscodeSdkMcp.ts:79-106`): `tengu_vscode_review_upsell`,
`tengu_vscode_onboarding`, `tengu_vscode_cc_auth`, `tengu_quiet_fern`. Nothing in
`src/` reads their values.

### INERTE (1)

`tengu_harbor_permissions` — `isChannelPermissionRelayEnabled()`
(`mcp/channelPermissions.ts:36`) has no importer; only the
`ChannelPermissionCallbacks` type is used.

### FUNCIONA (88)

Everything else, with three subgroups that carry a condition:

- **Flipped by this fork on purpose (5):** `tengu_sedge_lantern`,
  `tengu_passport_quail`, `tengu_coral_fern`, `tengu_bramble_lintel`,
  `tengu_glacier_2xr`. These are `_openBuildDefaults`, and the characterization
  table proves the override path runs.
- **Only with a claude.ai credential (8):** the `tengu_bridge_*`, `tengu_ccr_*`
  and `tengu_cobalt_lantern` keys. Live, but only for a user signed in.
- **Only on the first-party provider (8):** `tengu_attribution_header`,
  `tengu_amber_json_tools`, `tengu_tool_pear`, `tengu_fgts`,
  `tengu_cicada_nap_ms`, `tengu_miraculo_the_bard`, `tengu_penguins_off`,
  `tengu_marble_sandcastle`.

## Findings worth acting on

1. **The bypass-permissions killswitch is half-disarmed.** The stub neutralizes
   `checkSecurityRestrictionGate` to `return false`
   (`no-telemetry-plugin.ts:219-222`) precisely so a user cannot lock themselves
   out of `--dangerously-skip-permissions`. But three other sites read the *same*
   key through `checkStatsigFeatureGate_CACHED_MAY_BE_STALE`, which *does* honour
   `feature-flags.json` (`permissionSetup.ts:663`, `:893`, `:1375`). Writing
   `{"tengu_disable_bypass_permissions_mode": true}` still disables the mode. The
   neutralization is incomplete.
2. **`tengu_marble_sandcastle` inverted meaning in this fork.** Its comment treats
   it as legacy ("fast mode no longer needs the native binary"), but the default
   artifact is a Node bundle (`build.ts` targets `node`), so `isInBundledMode()`
   — which checks `Bun.embeddedFiles` — is false and the branch is live. Turning
   the key on makes first-party fast mode report "requires the native binary" in
   the build users actually run. Only `build:compile` closes that branch.
3. **Two commands are orphaned by an absent flag, not by design.**
   `tengu_ultraplan_model` and the remote-setup site of `tengu_cobalt_lantern`
   depend on `ULTRAPLAN` and `CCR_REMOTE_SETUP`, neither of which exists in the
   `featureFlags` map.
4. **`tengu_slate_thimble` is unobservable in the REPL.** `paths.ts:74-80`
   short-circuits on an interactive session, so the key only has an effect
   non-interactively — and there it depends on `tengu_passport_quail`, which this
   fork already turns on.

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
