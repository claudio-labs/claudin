# Upstream feature-flag keys — removal ledger

Upstream reads ~100 remote feature flags from GrowthBook, every key prefixed
with Claude Code's internal codename. This ledger lists them without the
prefix. This fork never had the remote: a key resolved to
`~/.claudin/feature-flags.json` (which nobody wrote), then to a short list of
values the fork flipped, then to the default written at the call site. Every
key was therefore a constant.

On 2026-09-25 all 94 surviving keys were removed. Each read was replaced by
the value it already resolved to, per call site, and the branch that could
then never run was deleted along with whatever lost its last importer. The
resolver (`src/platform/analytics/growthbook.ts`) went last, so
`~/.claudin/feature-flags.json` and `CLAUDE_FEATURE_FLAGS_FILE` are no longer
read. The codename itself is gone from every tracked file outside the agent's
memory notes, pinned by `src/__tests__/upstreamCodename.test.ts`.

The rule for what survived as a switch: a feature this fork **turned on**
against upstream became a `CLAUDIN_*` killswitch; everything else became a
constant. A switch that already existed as an env var (`CLAUDIN_JSON_TOOL_USE`,
`CLAUDIN_DISABLE_NONSTREAMING_FALLBACK`, `CLAUDIN_DISABLE_FAST_MODE`,
`CLAUDIN_PLAN_MODE_INTERVIEW_PHASE`, `CLAUDIN_ATTRIBUTION_HEADER`, …) kept
working. The FUNCIONA/QUEBRA audit the removal was planned from, and the
census script that classified every occurrence, are in git history.

## The six that became `CLAUDIN_*` switches

On unless set to `0`/`false`/`no`/`off`. Each is documented where it is read,
pinned by `src/agent/forkDefaults.test.ts` or
`src/memory/memdir/extractionDefaults.test.ts`, and proved by
`scripts/migrations/probes/forkDefaults.json`.

| key | now | read in |
|---|---|---|
| `sedge_lantern` | `CLAUDIN_AWAY_SUMMARY` | `src/agent/awaySummary.ts` |
| `passport_quail` | `CLAUDIN_EXTRACT_MEMORIES` | `src/memory/memdir/paths.ts` |
| `bramble_lintel` (15) | `CLAUDIN_EXTRACT_MEMORIES_EVERY=<n>`, default 15 | `src/memory/memdir/paths.ts` |
| `coral_fern` | `CLAUDIN_MEMORY_PAST_CONTEXT` | `src/memory/memdir/memdir.ts` |
| `glacier_2xr` | `CLAUDIN_DEFERRED_TOOLS_DELTA` | `src/tools/ToolSearchTool/prompt.ts` |
| `scratch` | `CLAUDIN_SCRATCHPAD` | `src/agent/scratchpad.ts` |

`slate_thimble` (extraction in a non-interactive session, off) folded
into `isExtractModeActive()`.

## Became `true` — the feature stays, the rollback path went

`agent_list_attach` (agent list as an attachment) ·
`amber_flint` (swarm killswitch) · `amber_stoat` (Plan agent) ·
`attribution_header` · `basalt_3kr` (MCP instructions as delta
attachments) · `bridge_repl_v2_cse_shim_enabled` ·
`compact_cache_prefix` (forked-agent compaction) ·
`herring_clock` (team memory follows auto-memory) ·
`iron_gate_closed` (the auto-mode classifier fails closed) ·
`kairos_cron_durable` · `plan_mode_interview_phase` ·
`plugin_official_mkt_git_fallback` · `slate_prism` ·
`slim_subagent_claudemd` · `turtle_carbon` (ultrathink, still
behind `feature('ULTRATHINK')`).

## Became a constant value

- `bridge_initial_history_cap` → 200.
- `bridge_min_version` → `0.0.0`, so the version check went.
- `bridge_poll_interval_config`, `kairos_cron_config`,
  `sm_compact_config`, `slate_heron`, `grey_step2` → their
  default objects.
- `ccr_bundle_max_bytes` → `DEFAULT_BUNDLE_MAX_BYTES`.
- `cicada_nap_ms` → 0, so there is no startup throttle.
- `hawthorn_window`, `tool_search_unsupported_models` → the
  built-in defaults.
- `sandbox_disabled_commands` → only `settings.sandbox.excludedCommands`.
- `amber_wren`, `satin_quoll` → the hard-coded caps; their
  `CLAUDIN_FILE_READ_MAX_OUTPUT_TOKENS` / `MAX_MCP_OUTPUT_TOKENS` overrides stay.
- `onyx_plover` → auto-dream is the `autoDreamEnabled` setting over its
  `DEFAULTS`.
- `auto_mode_config` → auto mode is offered whenever settings allow it
  and the model supports it. The remote `'disabled'`/`'opt-in'` states, the
  `disableFastMode` breaker and the XML `fast`/`thinking` classifier modes
  went; the settings-driven circuit breaker stays.

## Off — the feature never ran, so it went

| key | what went |
|---|---|
| `amber_json_tools`, `fgts` | the flag half of a check; the `CLAUDIN_*` env half stays |
| `amber_prism` | the memory-correction hint on rejections |
| `anti_distill_fake_tool_injection` | the `fake_tools` opt-in, with `ANTI_DISTILLATION_CC` |
| `auto_background_agents` | the flag half; `CLAUDIN_AUTO_BACKGROUND_TASKS` stays |
| `bridge_repl_v2`, `bridge_repl_v2_config` | the env-less bridge (`remoteBridgeCore.ts` and friends) |
| `bridge_system_init` | the bridge init message |
| `ccr_bridge_multi_session` | multi-session spawning (its CLI flags still parse and refuse) |
| `ccr_bundle_seed_enabled` | the flag half; the `CCR_*_BUNDLE` env vars stay |
| `chair_sermon` | the system-reminder smoosh and merge in message normalization |
| `cobalt_raccoon` | the "% context used" label, with `REACTIVE_COMPACT` |
| `compact_line_prefix_killswitch` | the padded line-number format (padded input is still accepted) |
| `compact_streaming_retry` | compaction's streaming retry loop |
| `cork_m4q` | the cached-spec variant of the shell-prefix prompt |
| `destructive_command_warning` | the destructive-command notice in the Bash/PowerShell dialogs |
| `disable_bypass_permissions_mode` | the remote bypass killswitch; the settings one stays |
| `disable_keepalive_on_econnreset` | the keep-alive retry branch |
| `disable_streaming_to_non_streaming_fallback` | the flag half; `CLAUDIN_DISABLE_NONSTREAMING_FALLBACK` stays |
| `hawthorn_steeple` | the per-message tool-result budget and its transcript records (old records are skipped on load) |
| `immediate_model_command` | immediate `/model`, `/fast` and `/effort` |
| `keybinding_customization_release` | `~/.claudin/keybindings.json`, `/keybindings` and its skill — defaults only |
| `lapis_finch` | the plugin-hint recommendation pipeline |
| `marble_sandcastle`, `penguins_off` | fast mode's native-binary refusal and remote off-switch |
| `miraculo_the_bard` | the alternative to `prefetchFastModeStatus()` |
| `otk_slot_v1` | the capped output-token slot and its escalation |
| `paper_halyard` | skipping project-level instruction files |
| `pebble_leaf_prune` | the pruned resume leaf walk |
| `pewter_ledger` | the plan-mode Phase 4 experiment arms |
| `pid_based_version_locking` | the flag half; the env stays |
| `plum_vx3` | WebSearch on the small model |
| `quartz_lantern` | the git diff on Edit/Write results |
| `quiet_fern`, `vscode_cc_auth`, `vscode_onboarding`, `vscode_review_upsell` | the `experiment_gates` payload to the VS Code extension |
| `read_dedup_killswitch` | the read-dedup killswitch |
| `remote_backend` | the remote-session backend on resume, which now prints the URL and exits |
| `review_bughunter_config` | `/ultrareview` |
| `sage_compass` | `/advisor` and the advisor tool wiring |
| `session_memory`, `sm_config`, `sm_compact` | session-memory extraction; compaction stays behind `ENABLE_CLAUDE_CODE_SM_COMPACT` |
| `sessions_elevated_auth_enforcement` | the trusted-device token |
| `streaming_tool_execution2` | the streaming tool executor |
| `terminal_panel` | the meta+j terminal panel, with `TERMINAL_PANEL` |
| `terminal_sidebar` | the terminal-tab status |
| `thinkback` | `/thinkback` and `/thinkback-play` |
| `tide_elm`, `tern_alloy`, `timber_lark` | three tips |
| `tool_pear` | strict tool schemas (`Tool.strict`) |
| `toolref_defer_j8m` | the tool_reference sibling relocation |
| `willow_mode` | the idle-return dialog |
| `off-switch` | the remote Opus off-switch and its error message |

## Left for a later round

These became dead only at a distance, outside the gates' own reach:

- the `getIsRemoteMode()` readers, because the remote-session backend lost its
  only setter;
- the bridge's `--spawn/--capacity/--create-session-in-dir` flags and the
  multi-session poll-loop code;
- the `ultrareview` remote-task type;
- persisted config fields that nothing writes any more: `trustedDeviceToken`,
  `remoteControlSpawnMode`, `advisorModel`, `showStatusInTerminalTab`,
  `cachedGrowthBookFeatures` and `growthBookOverrides`.
