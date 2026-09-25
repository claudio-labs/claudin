# `tengu_*` gate keys — removal ledger

Upstream reads ~100 remote feature flags from GrowthBook, all named
`tengu_*` (Claude Code's internal codename). This fork never had the remote:
a key resolved to `~/.claudin/feature-flags.json` (which nobody wrote), then
to a short list of values the fork flipped, then to the default written at
the call site. Every key was therefore a constant.

On 2026-09-25 all 94 surviving keys were removed. Each read was replaced by
the value it already resolved to, per call site, and the branch that could
then never run was deleted along with whatever lost its last importer. The
resolver (`src/platform/analytics/growthbook.ts`) went last, so
`~/.claudin/feature-flags.json` and `CLAUDE_FEATURE_FLAGS_FILE` are no longer
read. `src/` holds zero `tengu` tokens, pinned by
`scripts/verify/tengu-census.test.ts`.

The rule for what survived as a switch: a feature this fork **turned on**
against upstream became a `CLAUDIN_*` killswitch; everything else became a
constant. A switch that already existed as an env var (`CLAUDIN_JSON_TOOL_USE`,
`CLAUDIN_DISABLE_NONSTREAMING_FALLBACK`, `CLAUDIN_DISABLE_FAST_MODE`,
`CLAUDIN_PLAN_MODE_INTERVIEW_PHASE`, `CLAUDIN_ATTRIBUTION_HEADER`, …) kept
working. The FUNCIONA/QUEBRA audit the removal was planned from, and the
three census blind spots it found, are in this file's git history.

## The six that became `CLAUDIN_*` switches

On unless set to `0`/`false`/`no`/`off`. Each is documented where it is read,
pinned by `src/agent/forkDefaults.test.ts` or
`src/memory/memdir/extractionDefaults.test.ts`, and proved by
`scripts/migrations/probes/forkDefaults.json`.

| key | now | read in |
|---|---|---|
| `tengu_sedge_lantern` | `CLAUDIN_AWAY_SUMMARY` | `src/agent/awaySummary.ts` |
| `tengu_passport_quail` | `CLAUDIN_EXTRACT_MEMORIES` | `src/memory/memdir/paths.ts` |
| `tengu_bramble_lintel` (15) | `CLAUDIN_EXTRACT_MEMORIES_EVERY=<n>`, default 15 | `src/memory/memdir/paths.ts` |
| `tengu_coral_fern` | `CLAUDIN_MEMORY_PAST_CONTEXT` | `src/memory/memdir/memdir.ts` |
| `tengu_glacier_2xr` | `CLAUDIN_DEFERRED_TOOLS_DELTA` | `src/tools/ToolSearchTool/prompt.ts` |
| `tengu_scratch` | `CLAUDIN_SCRATCHPAD` | `src/agent/scratchpad.ts` |

`tengu_slate_thimble` (extraction in a non-interactive session, off) folded
into `isExtractModeActive()`.

## Became `true` — the feature stays, the rollback path went

`tengu_agent_list_attach` (agent list as an attachment) ·
`tengu_amber_flint` (swarm killswitch) · `tengu_amber_stoat` (Plan agent) ·
`tengu_attribution_header` · `tengu_basalt_3kr` (MCP instructions as delta
attachments) · `tengu_bridge_repl_v2_cse_shim_enabled` ·
`tengu_compact_cache_prefix` (forked-agent compaction) ·
`tengu_herring_clock` (team memory follows auto-memory) ·
`tengu_iron_gate_closed` (the auto-mode classifier fails closed) ·
`tengu_kairos_cron_durable` · `tengu_plan_mode_interview_phase` ·
`tengu_plugin_official_mkt_git_fallback` · `tengu_slate_prism` ·
`tengu_slim_subagent_claudemd` · `tengu_turtle_carbon` (ultrathink, still
behind `feature('ULTRATHINK')`).

## Became a constant value

- `tengu_bridge_initial_history_cap` → 200.
- `tengu_bridge_min_version` → `0.0.0`, so the version check went.
- `tengu_bridge_poll_interval_config`, `tengu_kairos_cron_config`,
  `tengu_sm_compact_config`, `tengu_slate_heron`, `tengu_grey_step2` → their
  default objects.
- `tengu_ccr_bundle_max_bytes` → `DEFAULT_BUNDLE_MAX_BYTES`.
- `tengu_cicada_nap_ms` → 0, so there is no startup throttle.
- `tengu_hawthorn_window`, `tengu_tool_search_unsupported_models` → the
  built-in defaults.
- `tengu_sandbox_disabled_commands` → only `settings.sandbox.excludedCommands`.
- `tengu_amber_wren`, `tengu_satin_quoll` → the hard-coded caps; their
  `CLAUDIN_FILE_READ_MAX_OUTPUT_TOKENS` / `MAX_MCP_OUTPUT_TOKENS` overrides stay.
- `tengu_onyx_plover` → auto-dream is the `autoDreamEnabled` setting over its
  `DEFAULTS`.
- `tengu_auto_mode_config` → auto mode is offered whenever settings allow it
  and the model supports it. The remote `'disabled'`/`'opt-in'` states, the
  `disableFastMode` breaker and the XML `fast`/`thinking` classifier modes
  went; the settings-driven circuit breaker stays.

## Off — the feature never ran, so it went

| key | what went |
|---|---|
| `tengu_amber_json_tools`, `tengu_fgts` | the flag half of a check; the `CLAUDIN_*` env half stays |
| `tengu_amber_prism` | the memory-correction hint on rejections |
| `tengu_anti_distill_fake_tool_injection` | the `fake_tools` opt-in, with `ANTI_DISTILLATION_CC` |
| `tengu_auto_background_agents` | the flag half; `CLAUDIN_AUTO_BACKGROUND_TASKS` stays |
| `tengu_bridge_repl_v2`, `tengu_bridge_repl_v2_config` | the env-less bridge (`remoteBridgeCore.ts` and friends) |
| `tengu_bridge_system_init` | the bridge init message |
| `tengu_ccr_bridge_multi_session` | multi-session spawning (its CLI flags still parse and refuse) |
| `tengu_ccr_bundle_seed_enabled` | the flag half; the `CCR_*_BUNDLE` env vars stay |
| `tengu_chair_sermon` | the system-reminder smoosh and merge in message normalization |
| `tengu_cobalt_raccoon` | the "% context used" label, with `REACTIVE_COMPACT` |
| `tengu_compact_line_prefix_killswitch` | the padded line-number format (padded input is still accepted) |
| `tengu_compact_streaming_retry` | compaction's streaming retry loop |
| `tengu_cork_m4q` | the cached-spec variant of the shell-prefix prompt |
| `tengu_destructive_command_warning` | the destructive-command notice in the Bash/PowerShell dialogs |
| `tengu_disable_bypass_permissions_mode` | the remote bypass killswitch; the settings one stays |
| `tengu_disable_keepalive_on_econnreset` | the keep-alive retry branch |
| `tengu_disable_streaming_to_non_streaming_fallback` | the flag half; `CLAUDIN_DISABLE_NONSTREAMING_FALLBACK` stays |
| `tengu_hawthorn_steeple` | the per-message tool-result budget and its transcript records (old records are skipped on load) |
| `tengu_immediate_model_command` | immediate `/model`, `/fast` and `/effort` |
| `tengu_keybinding_customization_release` | `~/.claudin/keybindings.json`, `/keybindings` and its skill — defaults only |
| `tengu_lapis_finch` | the plugin-hint recommendation pipeline |
| `tengu_marble_sandcastle`, `tengu_penguins_off` | fast mode's native-binary refusal and remote off-switch |
| `tengu_miraculo_the_bard` | the alternative to `prefetchFastModeStatus()` |
| `tengu_otk_slot_v1` | the capped output-token slot and its escalation |
| `tengu_paper_halyard` | skipping project-level instruction files |
| `tengu_pebble_leaf_prune` | the pruned resume leaf walk |
| `tengu_pewter_ledger` | the plan-mode Phase 4 experiment arms |
| `tengu_pid_based_version_locking` | the flag half; the env stays |
| `tengu_plum_vx3` | WebSearch on the small model |
| `tengu_quartz_lantern` | the git diff on Edit/Write results |
| `tengu_quiet_fern`, `tengu_vscode_cc_auth`, `tengu_vscode_onboarding`, `tengu_vscode_review_upsell` | the `experiment_gates` payload to the VS Code extension |
| `tengu_read_dedup_killswitch` | the read-dedup killswitch |
| `tengu_remote_backend` | the remote-session backend on resume, which now prints the URL and exits |
| `tengu_review_bughunter_config` | `/ultrareview` |
| `tengu_sage_compass` | `/advisor` and the advisor tool wiring |
| `tengu_session_memory`, `tengu_sm_config`, `tengu_sm_compact` | session-memory extraction; compaction stays behind `ENABLE_CLAUDE_CODE_SM_COMPACT` |
| `tengu_sessions_elevated_auth_enforcement` | the trusted-device token |
| `tengu_streaming_tool_execution2` | the streaming tool executor |
| `tengu_terminal_panel` | the meta+j terminal panel, with `TERMINAL_PANEL` |
| `tengu_terminal_sidebar` | the terminal-tab status |
| `tengu_thinkback` | `/thinkback` and `/thinkback-play` |
| `tengu_tide_elm`, `tengu_tern_alloy`, `tengu_timber_lark` | three tips |
| `tengu_tool_pear` | strict tool schemas (`Tool.strict`) |
| `tengu_toolref_defer_j8m` | the tool_reference sibling relocation |
| `tengu_willow_mode` | the idle-return dialog |
| `tengu-off-switch` | the remote Opus off-switch and its error message |

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
