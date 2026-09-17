# Team Memory

> Durable coding gotchas now live in `.claudin/rules/` (auto-loaded by path):
> **ink-tui.md** (renderer), **cache.md** (prompt/tool-result cache), **testing.md**
> (mocking leaks + known flakes), **agent-safety.md** (sub-agent/worktree hazards,
> always-on), **build-system.md** + **typescript-patterns.md** (feature()/compile),
> **git-conventions.md** (commit/PR title format, always-on).
> This index holds project state, decisions, and references that aren't coding rules.

## Conventions
- [Durable coding gotchas go in .claudin/rules/, not team memory](coding-gotchas-go-in-rules-not-memory.md) — path-scoped rules own renderer/cache/testing/agent-safety/build gotchas; memory is for state/decisions/refs; procedures → skills
- [Appended <system-reminder> nudges benched at zero adoption](tool-result-nudges-benched-zero-adoption.md) — fix the friction/refusal message instead; land new nudges flag-OFF as bench instrumentation
- [Rewriting the shouted emphasis out of tool prompts — DROPPED on data 2026-09-13](prompt-tone-rewrite-unmeasurable.md) — no over-compliance in 3,391 Bash calls; empty thinking blocks make it unmeasurable from logs
- [Steering Read shape from the prompt is cost-neutral (2026-09-14)](read-shape-steering-is-cost-neutral.md) — shape moves, cache_read differs 0.15%; the Grep symbols nudge is inert in two wordings
- [Claude Code 2.1.270's prompt, extracted 2026-09-14](claude-code-2.1.270-prompt-diff.md) — upstream MANDATES narration now; Delivering work/Corrections/turn-discipline are upstream verbatim
- [ANTI_NARRATION was written for Opus 4.7/4.8, never benched on Claude 5](anti-narration-never-benched-on-claude-5.md) — ModelFamily can't express "Claude 5"; reuse work-contract-ab.ts (one build + env killswitch), not cache-ab-bench
- [AGENTS.md documents the repo, never Claudin-only runtime behavior](agents-md-excludes-claudin-only-behavior.md) — other harnesses read it too; redirects/killswitches go in the source module header + .claudin/rules/
- [Reminders that say "don't tell the user" get flagged as injection](model-flags-hidden-reminders-as-injection.md) — same for mid-turn attachments; gate new producers on input !== null, never add a gag order
- [claudin -c hijacks the session you are working in](headless-c-resumes-current-session.md) — headless resume is keyed by project dir; verify multi-turn from a throwaway cwd, never `-c` in the repo
- [A tree-wide rewrite updates artifacts, not their producers](mechanical-rewrites-skip-producers.md) — the 2026-08 reorg disarmed a telemetry stub and broke verify:sdk-types; grep generators after a move
- [Team memories still cite pre-reorg paths](memory-cites-pre-reorg-paths.md) — 23 files, 55 dead src/utils|services|components refs; Glob the basename, fix in place, don't clone
- [Harness "file modified" reminders can be stale mid-BUILD snapshots](stale-diagnostics-notifications.md) — they can quote the folded `feature()` tree and look like a killed build; grep one line first
- [Pin a feature from the BUNDLE before deleting it](characterization-net-before-deletion.md) — feature() is false outside the build; 2 of 4 new scanner tests were tautological
- [Removal passes take only what the build proves unreachable](removal-pass-only-provably-dead.md) — a reachable surface needs its own approval; one commit per phase
- [Deleting telemetry hollows the tests that observed through it](tests-observing-through-telemetry.md) — sort into decision-record / redundant / telemetry-only; never leave an assertion proving nothing
- [TypeScript 7 here has no classic compiler API](typescript-7-no-classic-compiler-api.md) — `ts.createSourceFile` fails at RUNTIME; go lexical with refusals, or pay for typescript/unstable/sync

## Repo health
- [De-fingerprinting round (feat/claudin-identity, 2026-08-15)](defingerprinting-branch-2026-08.md) — what shipped, the ONE lane that keeps upstream headers, and the two env clusters that move as units
- [The seven catch-all dirs are retired — 18 feature slices](reorg-catch-all-dirs-retired.md) — moduleBoundaries.test.ts keeps them gone; `src/shared/` is NOT a clean leaf layer (~169 upward imports, unpinned)
- [tsc --noEmit reached ZERO on 2026-08-13](typecheck-backlog-shape.md) — the ratchet, the absolute-path fingerprint trap; "cannot be hand-fixed" and "never reaches zero" both disproven
- [/upgrade, /extra-usage, /rate-limit-options — REMOVED 2026-09-15](upsell-commands-missing-login.md) — all three hung on the absent Login stub; the third auto-opened itself on a rate limit
- [The missing-module stub's default is TRUTHY](missing-module-stub-makes-dead-things-look-alive.md) — `feature(TRUE) ? require(absent)` registered a phantom `noop`; `claudin install` + `mcp serve tools/list` broken
- [growthbook.ts never runs — the build stub is the real one](growthbook-source-dead-stub-is-real.md) — 986 dead lines vs a ~200-line stub with different resolution order; `bun test` exercises the dead one
- [CLAUDIN_SYNC_PLUGIN_INSTALL hung headless -p](headless-sync-plugin-install-broken-import.md) — FIXED in PR #57; kept for the 2-question test telling a real TS2307 from the fork's ~107 expected
- [systemPrompt.main.txt regen captured harness-injected text](systemprompt-snapshot-harness-drift.md) — snapshot covers "Notes for this model" etc., injected by the harness; diff regen vs source before committing
- [knip's "unused export" is not "unused"](knip-unused-export-is-not-unused.md) — means nothing IMPORTS it; needs local-reference + grep guards, `bun run build` as the gate
- [Token census 2026-09-09..10 — the transcript is blind to rule/CLAUDE.md injections](token-census-2026-09-10-hidden-injections.md) — ~19% of context is non-persisted attachments; keep-alive $3 vs $15
- [Weekly token census 2026-09-04..08 + what it fixed](weekly-token-census-2026-09-08.md) — $170/1,044 calls, reads 45%; fork-clip LOST the A/B (+11%); sleep redirect stays opt-in
- [Feature-usage validation 2026-09-14..16](feature-usage-census-2026-09-16.md) — outline+symbol 100% success (161 calls, 13.1% of Reads, symbol= up 10x); bash filter 62% line savings
- [Per-turn filesystem scans audited 2026-08-07](per-turn-fs-scan-audit.md) — CORRECTED: scanMemoryFiles is gated OFF per-turn at 0.014 ms/file; worktree-exit dialog leaks rule caches
- [memory_delta deleted 2026-08-07 — a second full copy, not a delta](memory-delta-removed-double-send.md) — ~57 KB/session; check the raw lane announces a hash before pairing a delta
- [Three mask desyncs blanked whole files from the symbol table — FIXED 2026-08-25](outline-mask-desync-zero-symbols.md) — 220→198 zero-symbol files; also broke Read(symbol=), Grep symbols, Rename
- ["Read it first" gate census 2026-09-04 — 3 false causes FIXED in PR #157](read-gate-false-refusals-census-2026-09.md) — 65 refusals/23 sessions; Edit mid-line, injected MEMORY.md, /resume ranges

## Roadmap & major features
- [Dead-code + tengu cleanup — MERGED as PR #204 (2026-09-16)](dead-code-cleanup-2026-09-15.md) — −25k lines on main; analytics/telemetry GONE; tengu 1654→326; left: gate-key audit, growthbook collapse, rules sweep
- [Tier-3 giant-file split roadmap (item 11)](tier3-file-split-roadmap.md) — ROADMAP-11 exhausted; six barrels live; the fold gate, the re-measured offender list, the 4 split traps
- [PR #129's code vanished from main after merging](pr-129-lost-to-force-push.md) — a non-fast-forward push dropped it from GitHub too; recover via refs/pull/N/head, never `gh pr diff`
- [Unified context-relief policy A/B (PR #156, 2026-09-03)](context-relief-unified-policy-ab.md) — cost −25%, uncached input −56%; a Read-only "re-reads" column lied — count every lookup tool
- [Clip-pin A/B 2026-07-25 (dev vs stable, 30 turns)](clip-pin-cache-ab-2026-07-25.md) — STALE number, do NOT cite; kept only for its three bench traps
- [Product roadmap 2026-07 (market-gap × codebase audit)](roadmap-2026-07.md) — R1 cost routing → R2 sandbox → R3 background agent ✅ → R4 record&replay eval → R5 MCP Apps
- [Repo map / generated project index — REJECTED on data 2026-08-07](repo-map-rejected-orientation-measured.md) — 59.5% of read paths are one-offs, no task→location signal; Read (D3) is the real target
- [No repo index of ANY shape works here — CLOSED 2026-08-17](repo-map-graph-topology-degenerate.md) — fwd d2 recalls 0% median over 96 sessions, loses to one `ls`; what works is Glob + Grep
- [Rule files have FOUR silent failure modes](rule-files-four-silent-failure-modes.md) — inert `paths:`, unconditional `globs:`, wrong facts in a fence, a map drifting under green verify:rules
- [Dev-tooling token roadmap 2026-08 (measured)](dev-tooling-token-roadmap.md) — Read is 59.7% of tool-result chars but D3's ceiling is 9.5% of ALL; D1 ✅ D2 ✅ → **D3** → D4 redirects → D5 build wrapper
- [A grep census over the session corpus overcounts ~3x](session-corpus-census-inflation.md) — subagent mirroring inflates hits; pair tool_use↔tool_result, report calls/blocked/ran
- [Bash-as-file-reader census + redirect reach (2026-08-09, re-measured 08-16)](bash-file-read-census-and-redirect-reach.md) — refusal converts 84.7%; SIZE an arm before building it; `cd &&` at ZERO
- [Auto-outline pivot claimed a cap it never hit (2026-08-09)](auto-outline-pivot-false-cap-claim.md) — 1,809 is an UPPER bound, success is the RANGE 40.8-68.3%; PR #67 closed on this data
- [Token-bench measurement traps (2026-08-09)](token-bench-measurement-traps.md) — `--allowedTools` does NOT remove tools; alternate arm order; check range OVERLAP, not just the median
- [R3 self-hosted background agent — IMPLEMENTED 2026-07-17](r3-background-agent-implemented.md) — workflow run|watch; TriggerSource (github/url/command + --match), headless runWorkflow, worktree+PR
- [/create bundled skill (commit 28eacc0c)](create-skill-bundled-pr.md) — loader gotchas incl. agent frontmatter `model` (since 2026-09); `(#98)` is the OLD remote's numbering
- [LSPTool reintroduced 2026-06-17 (cache-safe, plugin-only)](lsp-tool-reintroduced-plugin-only.md) — dropped (0 usage) then re-added: read-only 9 ops, always-present+fixed msg; built-in servers removed
- [The built-in Explore agent was REMOVED 2026-08-18](explore-agent-removed.md) — a fresh Code agent replaces it since #170; measured worth (93.5% multi-hop, 13.2x) + the summarizer misfire
- [Fork vs fresh A/B 2026-09-09 + parallel-forks probe](fork-vs-fresh-ab-2026-09-09.md) — fresh Code agent −44% at equal answers; 3 parallel forks PASS 9/9; count_tokens stalls big Reads
- [Fork-subagent-by-default initiative](fork-subagent-by-default.md) — default spawn forks, named agent stays fresh; 2026-07-26 ungated it, flipped auto-background to opt-in
- [Typecheck tool — baseline design + the traps it hides](typecheck-tool-baseline-design.md) — clean-tree baseline keyed by HEAD, line-independent fingerprints; exec() caps stdout at 30k
- [typecheck ratchet phantom "new" errors — fixed 2026-08-07](typecheck-baseline-message-fingerprint-fragile.md) — tsc's union elaboration shifted the hash on any added file; elideTruncatedUnion fixes it
- [React Compiler's t0 param is the root of ~1400 TS7006](react-compiler-props-param-typing.md) — count sites (403) not errors (1710); the props type is already in the file
- [The 107 TS2307 are the fork's shape, not a backlog](missing-subsystems-retired-by-all-any-declarations.md) — all-`any` .d.ts retire them (concrete shapes cannot — TS2339); zero type safety
- [Typecheck A/B bench — what to cite and what is noise](typecheck-ab-bench-fixture-flaw.md) — cost −16/−18% and payload −80% hold across 5 runs; fixture backlog must overlap edited files
- [RunTestsTool still has the 3 shell/env bugs Typecheck fixed](runtests-tool-shell-env-bugs.md) — ignores its cwd, FORCE_COLOR=0 enables colour, env-prefix breaks compound commands
- [RunTestsTool language coverage + reporter constraints](runtests-tool-language-coverage.md) — 23 runners; JUnit/JSON vs heuristic-only tier; catch2/doctest override-only
- [Search stack measured 2026-08-12](search-stack-measured.md) — text/file search is optimal ripgrep; symbol search is the weak axis. CORRECTED same day, read the next line first
- [Symbol-parser options researched 2026-08-12](symbol-parser-options-researched.md) — tree-sitter IS shippable under bun --compile; the blocker is the SYNC scanSymbols call, not size
- [Outline scanner: phantoms that DELETE real declarations](outline-blind-to-nested-members.md) — PR #141; 6 scanner traps, and why the A/B gate is witness-based not rule-based
- [Graded cross-CLI A/B: search→edit→build (2026-08-12)](cli-search-edit-ab-bench.md) — claudin vs claude 6/6 PASS, cost ranges separated; the gap is cache_read driven by turn count
- [Build tool A/B — the `directory` gap](build-tool-ab-directory-gap.md) — first run +27% cost (only built getCwd()); with `directory`: −7.7% cost / −25% output (median of 3)
- [Single deferred cache marker → full-history rewrites — FIXED 2026-09-13](single-marker-lookback-full-rewrites.md) — lost 38.6% of 30 days of cache writes; lagging marker on fix/cache-lag-marker
- [Git tool — D2, shipped 2026-08-04](git-tool-design.md) — Git({commands:[…]}) over all git+gh; cost −11.5%, replay take 30.6%; the batching claim did NOT survive the A/B

## Providers & models
- [Effort is project-scoped like provider and model](effort-is-project-scoped.md) — pin lives in projects[].activeEffortForProject; 'auto' sentinel shadows the global, /effort inherit clears it
- [Runtime /models discovery only parses `context_length`](context-window-discovery-field-names.md) — in-memory per-session; Groq/vLLM/Mistral names mapped but unshipped; strict OpenAI/Azure return nothing
- [provider !== 'anthropic' wrongly includes bedrock/vertex/foundry](provider-tag-not-anthropic-includes-cloud.md) — gate OpenAI-only form behavior with an exclusion set, not != 'anthropic'
- [Native-1M models need an explicit getContextWindowForModel branch](native-1m-context-window.md) — modelSupports1M=true does NOT set the runtime window; add beside the `fable-5` check
- [Adaptive thinking is now the default (was opt-in)](adaptive-thinking-default-on.md) — 2026-07-13 flip: Claude sends {type:'adaptive'} by default; CLAUDIN_ENABLE_ADAPTIVE_THINKING=0 opts out
- [Provider pointer heal — open follow-ups](provider-pointer-heal-followups.md) — febf362a fixed projects clobber + startup heal; mid-session reconcile, cache GC, migrate rerun pending
- [SDK error checks: use isSdk* guards from src/shared/errors.ts, never instanceof](externalized-sdk-copies-instanceof-apierror.md) — externalized bedrock/vertex/foundry load their own sdk copy; FIXED
- [CLAUDIN_SKIP_VERTEX_AUTH stub must return a real Headers](vertex-skip-auth-stub-needs-headers.md) — vertex-sdk calls .get() on getRequestHeaders(); the old `{}` killed every request
- [Adding a /provider preset](../../skills/add-provider-preset/SKILL.md) — the recipe (API-key OpenAI-compat + OAuth variant) is the `/add-provider-preset` skill, not a memory
- [Kimi Code OAuth provider (device-flow)](kimi-code-oauth-provider.md) — mirrors xAI; RE wire-format at docs/tech/kimi-code/; impersonates official CLI (UA+X-Msh-*, gray area)
- [Shim-only body fields need a model-aware gate](shim-only-body-fields-model-aware-gate.md) — quirk fields in the openaiShim wire body 400 native Anthropic unless gated on activeTransportUsesOpenAiShim
- [Codex strict schemas make the model send placeholder args](codex-strict-schema-placeholder-args.md) — every prop forced into `required` → `pages:""` looped Read 135×; strip ""/null under codex
- [Codex OAuth prompt-cache — retention REJECTED, key only](codex-oauth-prompt-cache-params.md) — Codex 400s on prompt_cache_retention; sends prompt_cache_key only; official-OpenAI sends both
- [Grok's cache hint — x-grok-conv-id HEADER, shipped but UNMEASURED](grok-cache-hint-missing.md) — no xAI account to measure with; AGGRESSIVE clipping may eat it anyway
- [Codex 403 HTML-block misread as "Please run /login"](codex-403-html-block-misclassified-as-login.md) — HTML-body 403 = Cloudflare edge block, NOT a revoked token; errors.ts still suggests /login
- [Claudin defaults to essential-traffic privacy level](anthropic-startup-traffic-disabled-default.md) — b2be87b5 flips default; 7→0 Anthropic startup requests; ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0 opts back in
- [xAI / Grok OAuth provider — shipped and merged](xai-oauth-provider-shipped.md) — on main since 2026-09-10; loopback PKCE + pinned port 56121; device-code flow not ported

## Build, release & distribution
- [Native-binary distribution (Bun --compile)](compile-binary-distribution.md) — per-platform binaries via npm, ~409ms vs 727ms; rg+sharp vendored beside execPath; strip breaks Bun binaries
- [Binary release process — release-binaries.yml + npm OIDC gotchas](binary-release-rollout-state.md) — sole release path (OIDC); OIDC can't first-publish, verify with `npm access list` not `npm view`
- [claudin-bin on the AUR + the Omarchy mirror](aur-omarchy-packaging.md) — PR #134, NOT live yet; the /usr/lib layout keeps vendored rg+sharp resolving, both fail silently
- [Node engine floor raised to 22.12.0](node-engine-floor-22.md) — engines.node >=22.12.0 (was >=20) since commander 15 is ESM-only; breaking for Node 20 consumers
- [Incremental bun install misses nested deps](incremental-bun-install-misses-nested-deps.md) — build dies on "No matching export for default"; use `bun install --force`; CI unaffected
- [Dependabot batch 2026-09-07 audited — no code changes](dependabot-bumps-2026-09-07-audited.md) — zod 4.5 validators/record-keys miss us; undici 8.10.2 is an 11-GHSA release (keep it)
- [Dependabot batch 2026-08-31 audited — no code changes](dependabot-bumps-2026-08-31-audited.md) — SDK 0.122 breakage misses us; live change: bedrock env-creds beat AWS_PROFILE
- Older dependabot audits, all "no code changes": [08-03](dependabot-bumps-2026-08-03-no-code-changes.md) · [08-10](dependabot-bumps-2026-08-10-no-code-changes.md) · [08-17](dependabot-bumps-2026-08-17-no-code-changes.md)
- [v8cache GC blocked process exit — fixed; startup deltas mislead](startup-v8cache-gc-blocked-exit.md) — in-process sweep added ~334ms/launch → detached child + daily stamp; checkpoint deltas over-attribute
- [Launcher jemalloc LD_PRELOAD leak](launcher-jemalloc-ld-preload-leak.md) — heap-bump re-exec leaked jemalloc to children; Chromium segfaults → OAuth browser never opened; fixed 2026-06-11
- [Plans dir moved project-local + hardened](plans-dir-project-local-hardening.md) — cwd-keyed memoize, symlink-escape realpath check, 0700 perms, global-gitignore, cleanup sweep
- [PRs for this repo go to GitHub via gh](repo-prs-github-via-gh.md) — origin is claudio-labs/claudin, `gh` authed; the old git.viudescloud.uk+tea flow is superseded

## TUI / diff / tooling
- [Inline TUI stranded the frame at the top — FIXED 2026-09-11](inline-fullreset-per-message.md) — #172 anchored only the overflowing-prev branch; probe table, live A/B, why a closed issue lied
- [Auto-wrap eats a row — the side-panel divider checkerboard](ink-autowrap-eats-a-row.md) — a row painted to the LAST column + 1 cell of drift wraps later rows; DECAWM off per paint
- [/diff reviewer has a living design doc (feature 8.1)](diff-reviewer-living-spec.md) — canonical spec at docs/features/8.1-diff-reviewer.md, kept in sync as features land
- [Diff reviewer canonicalizes git worktrees to the main repo](diff-reviewer-worktree-canonicalization.md) — /diff groups collapse worktrees into their main checkout; fix deferred on purpose
- [parseGitDiff must not assume a/ b/ prefixes](gitdiff-mnemonic-prefix-parse.md) — diff.mnemonicPrefix emits c/ w/ → broke /diff hunk parse; forced prefixes + loose regex
- [Footer PR pill supports GitLab + Gitea](pr-status-gitlab-gitea.md) — fetchPrStatus dispatches host→gh/glab/tea; prStatusHosts lives in config.json NOT settings.json
- [collapseRuns + blank-strip is SAFE since the 2026-06-27 root fix](bashfilter-collapseruns-blankstrip-footgun.md) — collapseIdenticalRuns no longer marks blank runs; don't reintroduce marker-on-blank
- [bashfilter fixture edits must preserve byte length](bashfilter-fixtures-byte-length-sensitive.md) — ROI tests assert reduction % per sample; scrub with equal-length placeholders
- [Bash filter: shape blindness CLOSED, specs cap at 6.8% of chars](bash-filter-shape-wontfix.md) — 2026-08-29 census over 18.3k calls; the prefix round moved this corpus by +4 calls
- [Bash filter samples live in ONE dir since 2026-08-06](bash-filter-sample-corpus-unified.md) — docs/discovery copy merged into __fixtures__/samples/; 87 of 142 unmapped in FIXTURE_MAP
- [Live-verifying TUI mouse click/hover under tmux](tmux-mouse-click-verification.md) — mouse only in fullscreen (CLAUDIN_NO_FLICKER=1); SGR clicks via `send-keys`; ctrl+o render, SGR click
- [apply_patch fails 11.9% vs Edit 4.6% — measured taxonomy](apply-patch-failure-taxonomy.md) — 53% read gates, 31% context mismatch, 11% parser; replay the 1,870-payload corpus first
- [checkBatchWritePermission's updatedInput:{} clobbers the tool's real input](checkbatchwrite-updatedinput-clobbers-input.md) — apply_patch was DOA in auto/bypass mode; echo the real input on allow

## References (sibling repos, wire formats, archives)
- [Public docs site claudiolabs.ai lives outside this repo](claudiolabs-docs-site.md) — no site/ dir tracked; URLs are extensionless; README links pages instead of duplicating features
- [openclaude is a sibling fork to mine for BUGS, not features](openclaude-sibling-fork-reference.md) — 28 claims re-verified 2026-09-10: 17 real, 11 falsified incl. 3 of the old top 8
- [code-review-graph audited 2026-08-08 — graph REJECTED, 4 ideas kept](code-review-graph-evaluated-rejected.md) — 284 MB db, impact answer = 203k tokens; their bench loses to reading the diff
- [Three code-graph siblings audited 2026-08-17](code-graph-siblings-audited.md) — no honest measured win in any; 4 ideas kept (edge-confidence tiers, churn×complexity, …)
- [opencode (SST) feature-gap reference](opencode-sst-feature-gap-reference.md) — scout 2026-06-24; apply_patch since shipped; open gaps: auto-format, LSP-diagnostics-on-edit, ACP/Zed, part-revert
- [Windsurf upstream reference repo](windsurf-upstream-reference.md) — opencode-windsurf-auth has the wire format + OAuth flow; a port branch died on the old Gitea remote
- [mitmproxy recipe for Rust agent CLIs](mitmproxy-rust-binary-recipe.md) — SSL_CERT_FILE+NODE_EXTRA_CA_CERTS+REQUESTS_CA_BUNDLE bundle trick verified against Devin Rust binary
- [Devin provider port — ARCHIVED to docs](../../../docs/tech/devin-provider/README.md) — abandoned 2026-06-12 on f31 sealed attestation; branch lived on the retired remote
