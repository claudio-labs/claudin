# Team Memory

> Coding gotchas live in `.claudin/rules/`, loaded by path (ink-tui, cache, testing, build-system,
> typescript-patterns, code-design); git-conventions.md is always-on. This index holds state, decisions, refs.

## Decisions
- [Bash cap keeps reads the command bounded (#252)](decisions/cap-keeps-model-bounded-reads.md) — sed -n / head -N / grep|head ≤150 lines whole; `CLAUDIN_CAP_KEEP_BOUNDED=0`
- [All 94 upstream flag gates removed (09-25)](decisions/upstream-flag-gates-removed-claudin-killswitches.md) — inlined to stock values; feature-flags.json gone; 6 `CLAUDIN_*` killswitches
- [Patch/Edit `then` + path-keeping Bash cap ON (09-25)](decisions/edit-then-and-cap-keep-paths-default-on.md) — calls −14%; `then` arms the response guard by default; `=0` killswitches
- [Path globs in read commands count as read-only (09-25)](decisions/readonly-path-globs-default-on.md) — cat/head/tail/wc/ls/grep with a `/`; classifier 20→11; `CLAUDIN_READONLY_GLOBS=0`
- [Bash advises, 4 dev tools deferred (#244)](decisions/bash-redirects-advisory-dev-tools-deferred.md) — `CLAUDIN_BASH_REDIRECT=refuse|off`, `CLAUDIN_EAGER_DEV_TOOLS=1`
- [SendMessage reaches other local sessions (#243)](decisions/cross-session-messaging.md) — owner-only sockets + token; Claudin↔Claudin, REPL inbox only
- [apply_patch is `Patch` on the wire (#244)](decisions/patch-tool-rename.md) — alias + legacy-name map; a census must count both names
- [Patch takes any earlier read (#242)](decisions/apply-patch-any-read.md) — only never-read is refused, the hunk match is the check; Edit keeps the gate
- [Batch Read on by default, hooks per file (#246)](decisions/batch-read-default-on.md) — file_paths + symbol lists; `CLAUDIN_READ_MULTI=0` kills it
- [Opus 5.5 defaults to medium effort, like Claude Code (#242)](decisions/opus-5-5-default-effort-medium.md) — the only lever that closed the cost gap; pins win
- [Team memory: git IS the sync (2026-09-21)](decisions/team-memory-git-is-the-sync.md) — HTTP sync + LLM recall deleted; `paths:` loads on demand
- [`safeguards` classifier — REJECTED 2026-09-22](decisions/safeguards-classifier-rejected.md) — CC doesn't send it on the real endpoint; it would ship rules and identity
- [Tool-prompt tone rewrite — DROPPED 2026-09-13](decisions/prompt-tone-rewrite-unmeasurable.md) — no over-compliance in 3,391 Bash calls
- [Seven catch-all dirs retired — 15 slices + 3 non-slices](decisions/reorg-catch-all-dirs-retired.md) — moduleBoundaries.test.ts; `src/shared/` upward imports ≤131
- [memory_delta deleted 2026-08-07](decisions/memory-delta-removed-double-send.md) — a second full copy, not a delta (~57 KB/session)
- Repo map / code index — REJECTED twice: [flat 08-07](decisions/repo-map-rejected-orientation-measured.md) · [graph 08-17](decisions/repo-map-graph-topology-degenerate.md) — loses to one `ls`
- [LSPTool back since 2026-06-17, plugin-only](decisions/lsp-tool-reintroduced-plugin-only.md) — read-only 9 ops, cache-safe; built-in servers removed
- [Explore agent: removed 08-18, back ON by default 09-25](decisions/explore-agent-removed.md) — `CLAUDIN_EXPLORE_AGENT=0` turns it off; sonnet; A/B: tool calls −29%, cost −9% (overlap), wall +30%
- [Fork-subagent by default](decisions/fork-subagent-by-default.md) — no subagent_type forks, a named agent stays fresh; auto-background opt-in
- [Git tool (D2), shipped 2026-08-04](decisions/git-tool-design.md) — cost −11.5%; the batching claim did NOT survive the A/B
- [Effort is project-scoped like provider and model](decisions/effort-is-project-scoped.md) — projects[].activeEffortForProject; `/effort inherit` clears
- [Adaptive thinking on by default (2026-07-13)](decisions/adaptive-thinking-default-on.md) — `CLAUDIN_ENABLE_ADAPTIVE_THINKING=0` opts out
- [Essential-traffic privacy level by default](decisions/anthropic-startup-traffic-disabled-default.md) — 7→0 startup requests; `ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0` opts in
- [Footer PR pill supports GitLab + Gitea](decisions/pr-status-gitlab-gitea.md) — prStatusHosts lives in config.json, not settings.json
- [Bash filter shape blindness — CLOSED 2026-08-29](decisions/bash-filter-shape-wontfix.md) — specs cap at 6.8% of chars over 18.3k calls
- [code-review-graph — REJECTED 2026-08-08](decisions/code-review-graph-evaluated-rejected.md) — 284 MB db, loses to reading the diff; 4 ideas kept
- [Cache TTL: agent:* 5m, fork keeps 1h](decisions/cache-ttl-tiering-subagents.md) — new one-shot querySources go in SHORT_LIVED_QUERY_SOURCES
- [Defer-cache-marker default REVERSED to 0 (2026-09-23)](decisions/defer-cache-marker-shipped.md) — 2048 cost 4–17% more; opt-in only
- [Bash cat-as-read credit — PARKED off (09-23/24)](decisions/bash-read-passthrough-not-promoted.md) — engages since round 2, +6% on top of the batch Read
- [Devin provider port halted 2026-06-06](decisions/devin-provider-port-halted.md) — f31 attestation is a hard blocker; needs a Ghidra/IDA budget
- [OpenTelemetry stays devDep-only + stubbed](decisions/opentelemetry-devdep-stubbed.md) — removal REJECTED 07-08: the deps only satisfy tsc type refs

## Bugs
- [Resume restores a REFUSED Write as read](bugs/resume-restores-refused-write.md) — the Write branch of extractReadFilesFromMessages skips is_error
- [Sub-agents ran on the PARENT's model — FIXED 2026-09-25](bugs/subagents-ran-on-parent-model.md) — query loop read the parent's app state; definitions, /agents, per-call `model` were inert
- [Built-in sub-agents never retry a 529](bugs/builtin-subagents-skip-529-retry.md) — the set lists `'agent:builtin'` exactly, built-ins run as `agent:builtin:<Type>`; not fixed
- [Interactive Agent schema drops run_in_background and name](bugs/agent-schema-drops-run-in-background.md) — still on v1.1.35; "background" agents run inline
- [The missing-module stub's default is TRUTHY](bugs/missing-module-stub-makes-dead-things-look-alive.md) — phantom `noop`; `claudin install`, `mcp serve` broken
- [systemPrompt.main.txt regen captures harness text](bugs/systemprompt-snapshot-harness-drift.md) — diff the regen against source before committing
- [Two latent bugs pinned, not fixed (2026-09-20)](bugs/latent-bugs-pinned-not-fixed.md) — autobackground misses `sleep N`; deleted rules resurrect
- [RunTests shell/env bugs — FIXED in #244](bugs/runtests-tool-shell-env-bugs.md) — cwd ignored, FORCE_COLOR=0, env-prefix; two fixture traps
- [Provider pointer heal — open follow-ups](bugs/provider-pointer-heal-followups.md) — mid-session reconcile, cache GC, migrate rerun pending
- [Codex 403 HTML block misread as "run /login"](bugs/codex-403-html-block-misclassified-as-login.md) — a Cloudflare edge block, not a revoked token
- [/diff canonicalizes worktrees to the main repo](bugs/diff-reviewer-worktree-canonicalization.md) — fix deferred on purpose
- [checkBatchWritePermission's updatedInput:{} clobbers the input](bugs/checkbatchwrite-updatedinput-clobbers-input.md) — echo the real input on allow
- [memory-turn-by-turn RSS bench flakes under full bun test](bugs/memory-turn-by-turn-bench-flaky-full-suite.md) — re-run in isolation first
- [WaitFor dropped its optional params — FIXED in #244](bugs/waitfor-drops-optional-params.md) — Bash's updatedInput clobbered them; Monitor too
- [stream-json prints each assistant event twice](bugs/stream-json-duplicate-assistant-events.md) — benches counting blocks dedupe by uuid
- [Resume re-wrote the whole prompt cache — FIXED 2026-09-23](bugs/resume-rewrites-cache-prefix.md) — 40%→100% read-back (#239); cache.md §7

## Docs
- [The memory subsystem has a design doc](docs/memory-subsystem-design-doc.md) — docs/tech/memory/project-local-team-memory.md
- [/diff reviewer living spec (feature 8.1)](docs/diff-reviewer-living-spec.md) — docs/features/8.1-diff-reviewer.md, synced as features land
- [Public docs site claudiolabs.ai is outside this repo](docs/claudiolabs-docs-site.md) — extensionless URLs; README links pages

## Conventions
- [Coding gotchas go in .claudin/rules/, not team memory](coding-gotchas-go-in-rules-not-memory.md) — memory holds state/decisions/refs; procedures → skills
- [Appended <system-reminder> nudges benched at zero adoption](tool-result-nudges-benched-zero-adoption.md) — fix the refusal message instead
- [Steering Read shape from the prompt is cost-neutral](read-shape-steering-is-cost-neutral.md) — shape moves, cache_read differs 0.15%
- [Claude Code 2.1.270's prompt, extracted 2026-09-14](claude-code-2.1.270-prompt-diff.md) — upstream MANDATES narration now
- [ANTI_NARRATION removed from every prompt (#242)](anti-narration-never-benched-on-claude-5.md) — the narr arm moved neither thinking nor cost
- [AGENTS.md documents the repo, never Claudin-only behavior](agents-md-excludes-claudin-only-behavior.md) — killswitches go in module headers
- [Keep repo steering out of always-on context](dogfood-without-repo-steering.md) — it hides bugs users hit elsewhere; verify from a throwaway cwd
- ["Don't tell the user" reminders get flagged as injection](model-flags-hidden-reminders-as-injection.md) — gate on input !== null, except sub-agents
- [break-probe is the committed break-and-restore harness](break-probe-harness.md) — 43 specs; a probe that turns nothing red is the finding
- [claudin -c hijacks the session you are working in](headless-c-resumes-current-session.md) — verify multi-turn from a throwaway cwd
- [A tree-wide rewrite updates artifacts, not their producers](mechanical-rewrites-skip-producers.md) — grep generators after a move
- [Stale paths in team memory — resolution table](memory-cites-pre-reorg-paths.md) — reorg dirs + the deleted agent-safety.md; read the sentence first
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
- [Betas Claude Code sends and Claudin doesn't (2026-09-22)](claude-code-beta-gap-2026-09-22.md) — a mock base URL fakes safeguards
- [De-fingerprinting round (2026-08-15)](defingerprinting-branch-2026-08.md) — the one lane keeping upstream headers; env clusters move as units
- [tsc --noEmit reached ZERO (2026-08-13)](typecheck-backlog-shape.md) — the ratchet and its absolute-path fingerprint trap
- [/upgrade, /extra-usage, /rate-limit-options REMOVED 09-15](upsell-commands-missing-login.md) — all hung on the absent Login stub
- [growthbook.ts — stub made real, then deleted 09-25](growthbook-source-dead-stub-is-real.md) — a module-wide build stub leaves source dead but tested
- [CLAUDIN_SYNC_PLUGIN_INSTALL hung headless -p — FIXED #57](headless-sync-plugin-install-broken-import.md) — real TS2307 vs the ~107 expected
- [knip's "unused export" is not "unused"](knip-unused-export-is-not-unused.md) — nothing imports it; `bun run build` is the gate
- [Token census 09-09..10 — transcripts miss rule/CLAUDE.md injections](token-census-2026-09-10-hidden-injections.md) — ~19% of context
- Weekly token censuses: [09-04..08](weekly-token-census-2026-09-08.md) · [09-14..20](weekly-token-census-2026-09-20.md) — reads 45%→68%; no compaction on 1M = $355-580/wk
- [Feature-usage validation 09-14..16](feature-usage-census-2026-09-16.md) — outline 100% success; its "79 symbol= calls" is WRONG (25) · [09-14..15](feature-usage-census-2026-09-15.md)
- [Per-turn filesystem scans audited 2026-08-07](per-turn-fs-scan-audit.md) — scanMemoryFiles off per turn; worktree exit leaks rule caches
- [Mask desyncs blanked files from the symbol table — FIXED 08-25](outline-mask-desync-zero-symbols.md) — broke Read(symbol=), Grep symbols, Rename
- ["Read it first" gate census 2026-09-04 — FIXED in #157](read-gate-false-refusals-census-2026-09.md) — Edit mid-line, injected MEMORY.md, /resume
- [Tool error census 09-14..20 + fixes](tool-error-census-2026-09-20.md) — read-gate 219 refusals/$70; 3 harness bugs fixed

## Roadmap & major features
- [Dead-code + codename cleanup — #204 (2026-09-16)](dead-code-cleanup-2026-09-15.md) — −25k lines, analytics gone; the gates followed 09-25
- Dead-code rounds (09-18/19): [r2](dead-code-round-2-2026-09-18.md) · [r3](dead-code-round-3-2026-09-18.md) knip in CI · [r4](dead-code-round-4-2026-09-18.md) throw-probe · [r5 #214](dead-code-round-5-2026-09-19.md) JSX-as-regex trap
- Dead-code seeds (SPENT): [inventory](unreachable-clusters-inventory-2026-09-18.md) · [r3](dead-code-round-3-plan-seed.md) · [r4](dead-code-round-4-seed.md) · [bash parser](bash-parser-unreachable-behind-tree-sitter-flag.md)
- [The three dead-code gates and what none sees](deadcode-gate-include-allowlist-hole.md) — knip answers "imported?", never "reachable?"
- [Tier-3 giant-file split roadmap](tier3-file-split-roadmap.md) — round 2 done 09-20; md5 split gate, back-edge trap
- [PR #129's code vanished from main](pr-129-lost-to-force-push.md) — recover via refs/pull/N/head, never `gh pr diff`
- [Unified context-relief policy (#156)](context-relief-unified-policy-ab.md) — cost −25%; on 1M the retain floor sits ABOVE its band
- [Clip-pin A/B 2026-07-25](clip-pin-cache-ab-2026-07-25.md) — STALE number, don't cite; kept for its three bench traps
- [Product roadmap 2026-07](roadmap-2026-07.md) — R1 cost routing → R2 sandbox → R3 bg agent ✅ → R4 replay eval → R5 MCP Apps · [token-efficiency](token-efficiency-roadmap.md)
- [Rule files have FOUR silent failure modes](rule-files-four-silent-failure-modes.md) — inert `paths:`, unconditional `globs:`, wrong facts, map drift
- [Dev-tooling token roadmap 2026-08](dev-tooling-token-roadmap.md) — D1 D2 D5 done; D3 Read re-read dedup (~9.5%) and D4 open
- [A session-corpus grep census overcounts ~3x](session-corpus-census-inflation.md) — pair tool_use↔tool_result
- [Bash-as-file-reader census + redirect reach (08-09/16)](bash-file-read-census-and-redirect-reach.md) — refusal converted 84.7%
- [Auto-outline pivot's false cap claim (08-09)](auto-outline-pivot-false-cap-claim.md) — 1,809 is an upper bound; PR #67 closed on it
- [Token-bench measurement traps](token-bench-measurement-traps.md) — `--allowedTools` doesn't remove tools; check range overlap
- Bench traps: [cache-ab-bench bugs](cache-ab-bench-unreliable.md) · [head-anchor, unmerged](cache-head-anchor-branch-state.md) · [-p orphans bg agents](headless-bg-agents-not-drained.md)
- [R3 background agent — IMPLEMENTED 2026-07-17](r3-background-agent-implemented.md) — workflow run|watch, triggers, worktree+PR
- [/create bundled skill](create-skill-bundled-pr.md) — loader gotchas incl. agent frontmatter `model`
- [Fork vs fresh A/B 2026-09-09](fork-vs-fresh-ab-2026-09-09.md) — fresh Code agent −44% at equal answers; 3 parallel forks pass
- [Delegation A/B 09-23](delegation-steer-ab-2026-09-23.md) — lean Agent text held every gate (N=5)
- Typecheck tool: [baseline design](typecheck-tool-baseline-design.md) · [phantom "new" errors, fixed 08-07](typecheck-baseline-message-fingerprint-fragile.md) · [A/B: what to cite](typecheck-ab-bench-fixture-flaw.md)
- [React Compiler's t0 param → ~1400 TS7006](react-compiler-props-param-typing.md) — count sites (403), not errors
- [The 107 TS2307 are the fork's shape](missing-subsystems-retired-by-all-any-declarations.md) — all-`any` .d.ts on purpose
- [RunTests language coverage](runtests-tool-language-coverage.md) — 23 runners; JUnit/JSON vs heuristic tier
- Search: [stack measured 08-12](search-stack-measured.md) (corrected same day) · [symbol-parser options](symbol-parser-options-researched.md) — tree-sitter shippable, sync scanSymbols blocks
- [Outline-scanner phantoms that DELETE declarations (#141)](outline-blind-to-nested-members.md) — 6 traps; witness-based gate
- Cross-CLI A/B: [2-arm 08-12](cli-search-edit-ab-bench.md) · [3-arm 09-22](three-cli-ab-bench-2026-09-22.md) — 09-22 supersedes the cost gap
- [Session cache A/B vs Claude Code (09-23/24)](session-cache-ab-bench-2026-09-23.md) — +53% → +7% after #239; @medium +14%; run arms simultaneously
- [Session cost round 3 (09-23)](session-cost-round-3-2026-09-23.md) — effort medium closes it; display/narration/tools don't
- [Prompts v2 — default since #242, cleanup pending](prompts-v2-2026-09.md) — 1st request 27.2k→19.9k (CC 20.2k); 4 `=0` killswitches to delete
- [Request prefix, broken down](request-prefix-size-2026-09-23.md) — eager tools were ≈20k; deferred schemas unbilled; 17.3k vs CC 21.0k since 09-24
- [Build tool A/B — the `directory` gap](build-tool-ab-directory-gap.md) — with `directory`: −7.7% cost, −25% output
- [Dev tools deferred + Bash advice A/B (09-24)](dev-tools-deferred-advice-ab-2026-09-24.md) — no regression, prefix −3.3k; deferred RunTests unused
- [cat-read + batch-Read A/Bs (09-24)](cat-read-and-batch-read-ab-2026-09-24.md) — batch Read ties Claude Code ($1.04, one run); catread +6%
- [Fewer requests per session — 4 rounds (09-25)](request-count-levers-2026-09-24.md) — round 4: `then` and path-keeping cap PROMOTED; Grep bodies never engaged, parked
- [Cut results cost ~0.3% of requests (09-25)](cut-results-request-cost-2026-09-25.md) — summarizer none; cap on `sed -n`/`head -N` reads in sub-agents is the leak
- [Single deferred cache marker → full-history rewrites — FIXED 09-13](single-marker-lookback-full-rewrites.md) — lost 38.6% of cache writes

## Providers & models
- [/models discovery only parses `context_length`](context-window-discovery-field-names.md) — strict OpenAI/Azure return nothing
- [OpenAI-compat reasoning effort was inert — FIXED](opencode-gateway-effort-dead-on-arrival.md) — levels come from models.dev reasoning_options
- [provider !== 'anthropic' includes bedrock/vertex/foundry](provider-tag-not-anthropic-includes-cloud.md) — gate with an explicit set
- [Native-1M models need a getContextWindowForModel branch](native-1m-context-window.md) — modelSupports1M alone doesn't set the window
- [SDK error checks: isSdk* guards, never instanceof](externalized-sdk-copies-instanceof-apierror.md) — externalized SDKs load their own copy
- [CLAUDIN_SKIP_VERTEX_AUTH stub must return a real Headers](vertex-skip-auth-stub-needs-headers.md) — vertex-sdk calls .get() on it
- [Adding a /provider preset](../../skills/add-provider-preset/SKILL.md) — the `/add-provider-preset` skill, not a memory · [old recipe](openai-compat-preset-recipe.md)
- [Kimi Code OAuth provider (device flow)](kimi-code-oauth-provider.md) — mirrors xAI; impersonates the official CLI (gray area)
- [Shim-only body fields need a model-aware gate](shim-only-body-fields-model-aware-gate.md) — gate on activeTransportUsesOpenAiShim
- [Codex strict schemas → placeholder args](codex-strict-schema-placeholder-args.md) — `pages:""` looped Read 135×; strip ""/null
- [Codex OAuth prompt cache — key only](codex-oauth-prompt-cache-params.md) — Codex 400s on prompt_cache_retention
- [Grok cache hint x-grok-conv-id — UNMEASURED](grok-cache-hint-missing.md) — no xAI account to measure with
- [xAI / Grok OAuth provider — on main since 2026-09-10](xai-oauth-provider-shipped.md) — loopback PKCE, pinned port 56121

## Build, release & distribution
- [Native-binary distribution (bun --compile)](compile-binary-distribution.md) — ~409 vs 727ms; rg+sharp vendored; strip breaks binaries
- [Binary release process](binary-release-rollout-state.md) — release-binaries.yml via OIDC; verify with `npm access list`
- [claudin-bin on the AUR + Omarchy](aur-omarchy-packaging.md) — PR #134, NOT live; the /usr/lib layout keeps rg+sharp resolving
- [Node engine floor 22.12.0](node-engine-floor-22.md) — commander 15 is ESM-only; breaks Node 20
- [Incremental bun install misses nested deps](incremental-bun-install-misses-nested-deps.md) — "No matching export": `bun install --force`
- Dependabot audits, no code changes: [08-03](dependabot-bumps-2026-08-03-no-code-changes.md) · [08-10](dependabot-bumps-2026-08-10-no-code-changes.md) · [08-17](dependabot-bumps-2026-08-17-no-code-changes.md) · [08-31](dependabot-bumps-2026-08-31-audited.md) · [09-07](dependabot-bumps-2026-09-07-audited.md)
- [v8cache GC blocked process exit — fixed](startup-v8cache-gc-blocked-exit.md) — detached child + daily stamp; checkpoint deltas mislead
- [Launcher jemalloc LD_PRELOAD leak — fixed 06-11](launcher-jemalloc-ld-preload-leak.md) — it reached children and broke the OAuth browser
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
- [Live-verifying TUI mouse under tmux](tmux-mouse-click-verification.md) — fullscreen only (CLAUDIN_NO_FLICKER=1); SGR via send-keys
- [apply_patch failure taxonomy](apply-patch-failure-taxonomy.md) — 11.9% vs Edit 4.6%, mostly read gates (lifted in #242); parser repairs
- ["∴ <sentence>" lines are progress updates, not leaked thinking](progress-update-lines-read-as-leaked-thinking.md) — ● like CC since 09-25; display (summarized too) cache-neutral; sub-agents inherit thinking

## References (sibling repos, wire formats, archives)
- [openclaude: claudin's PARENT fork, mine it for BUGS](openclaude-sibling-fork-reference.md) — forked from 9e23c2be (04-25); ~5.5% of lines theirs; LICENSE attribution deferred; 17/28 bug claims real
- [Three code-graph siblings audited 08-17](code-graph-siblings-audited.md) — no measured win; 4 ideas kept
- [opencode (SST) feature gaps](opencode-sst-feature-gap-reference.md) — auto-format, LSP-diagnostics-on-edit, ACP/Zed, part-revert · [OAuth port queue](web-login-provider-port-queue.md)
- [Windsurf upstream reference](windsurf-upstream-reference.md) — opencode-windsurf-auth has the wire format + OAuth flow
- [mitmproxy recipe for Rust agent CLIs](mitmproxy-rust-binary-recipe.md) — SSL_CERT_FILE + NODE_EXTRA_CA_CERTS + REQUESTS_CA_BUNDLE
- Devin RE: [backend](devin-shares-codeium-backend.md) · [wire quirks](devin-oauth-quirks.md) · [f31 vs quota](devin-port-works-quota-blocker.md) · [f31 RE](devin-f31-characterization.md) · [A/B method](devin-wire-ab-procedure.md)
- [Devin provider port — ARCHIVED to docs](../../../docs/tech/devin-provider/README.md) — abandoned 06-12 on f31 attestation
