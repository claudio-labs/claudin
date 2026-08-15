# Team Memory

> Durable coding gotchas now live in `.claudin/rules/` (auto-loaded by path):
> **ink-tui.md** (renderer), **cache.md** (prompt/tool-result cache), **testing.md**
> (mocking leaks + known flakes), **agent-safety.md** (sub-agent/worktree hazards,
> always-on), **build-system.md** + **typescript-patterns.md** (feature()/compile).
> This index holds project state, decisions, and references that aren't coding rules.

## Conventions
- [Durable coding gotchas go in .claudin/rules/, not team memory](coding-gotchas-go-in-rules-not-memory.md) — path-scoped rules own renderer/cache/testing/agent-safety/build gotchas; memory is for state/decisions/refs; procedures → skills
- [Appended <system-reminder> nudges benched at zero adoption](tool-result-nudges-benched-zero-adoption.md) — SERIAL_READ_NUDGE killed on merit (adoption 0); fix the friction/refusal message instead, and land new nudges flag-OFF as bench instrumentation
- [AGENTS.md documents the repo, never Claudin-only runtime behavior](agents-md-excludes-claudin-only-behavior.md) — other harnesses read that file too; redirects/killswitches go in the source module header + .claudin/rules/, not the toggle table
- [Reminders that say "don't tell the user" get flagged as injection](model-flags-hidden-reminders-as-injection.md) — same for attachments stapled mid-turn; gate new producers on input !== null, never add a gag order
- [claudin -c hijacks the session you are working in](headless-c-resumes-current-session.md) — headless resume is keyed by project dir; verify multi-turn behavior from a throwaway cwd, never `-c` in the repo
- [A tree-wide rewrite updates artifacts, not their producers](mechanical-rewrites-skip-producers.md) — the 2026-08 reorg silently disarmed a telemetry stub, broke verify:sdk-types and "freshened" a fictional path; grep generators/plugins/script globs after any move

## Repo health
- [The seven catch-all dirs are retired — 18 feature slices](reorg-catch-all-dirs-retired.md) — moduleBoundaries.test.ts is the only thing keeping them gone; `src/shared/` is explicitly NOT a clean leaf layer (~169 upward imports, unpinned on purpose)
- [tsc --noEmit reached ZERO on 2026-08-13](typecheck-backlog-shape.md) — the ratchet, the absolute-path fingerprint trap, and TWO corrections: "cannot be hand-fixed" and "never reaches zero" were both disproven
- [/upgrade and /extra-usage hang on a Login component that does not exist](upsell-commands-missing-login.md) — stubbed to `() => null`, onDone never fires; product call, not fixed
- [CLAUDE_CODE_SYNC_PLUGIN_INSTALL hung headless -p](headless-sync-plugin-install-broken-import.md) — FIXED in PR #57; kept for the 2-question test that tells a real TS2307 from the fork's ~107 expected ones
- [knip's "unused export" is not "unused"](knip-unused-export-is-not-unused.md) — it means nothing IMPORTS it; needs a local-reference guard AND a grep guard, with `bun run build` as the gate — re-parsing is too weak
- [Per-turn filesystem scans audited 2026-08-07](per-turn-fs-scan-audit.md) — CORRECTED: scanMemoryFiles is uncached but gated OFF per-turn (tengu_moth_copse) and benched at 0.014 ms/file; getMemoryFiles memo omits cwd; worktree-exit *dialog* leaks stale rule caches
- [memory_delta deleted 2026-08-07 — it was a second full copy, not a delta](memory-delta-removed-double-send.md) — re-sent every rule/CLAUDE.md body one turn after nested_memory (~57 KB/session); check the raw lane announces a hash before pairing a delta with it

## Roadmap & major features
- [Tier-3 giant-file split roadmap (item 11)](tier3-file-split-roadmap.md) — the ROADMAP-11 list is EXHAUSTED (11i/11j/11k done too); new top offenders measured by size×churn, led by scanSymbols.ts; two split-only traps
- [Clip-pin A/B 2026-07-25 (dev vs stable, 30 turns)](clip-pin-cache-ab-2026-07-25.md) — STALE number, do NOT cite; kept for the three bench traps (auto-outline eats files ≥250 lines, --revisits does one pass, the 60s Read cache)
- [Product roadmap 2026-07 (market-gap × codebase audit)](roadmap-2026-07.md) — R1 cost routing → R2 real sandbox backend → R3 self-hosted background agent ✅ IMPLEMENTED → R4 record&replay eval → R5 MCP Apps; replaces token-efficiency roadmap (all shipped)
- [Repo map / generated project index — REJECTED on data 2026-08-07](repo-map-rejected-orientation-measured.md) — orientation is 32% of tool-result chars but Glob is 0.3% of it; 59.5% of read paths are one-offs; no task→location signal. Read (D3) is the real target
- [Rule files have two silent failure modes](rule-files-two-silent-failure-modes.md) — inert `paths:` vs `globs:` silently making a rule unconditional; verify:rules + /doctor + /refresh-rules; prose-path checks need a project anchor
- [Dev-tooling token roadmap 2026-08 (measured)](dev-tooling-token-roadmap.md) — Read is 59.7% of tool-result chars but D3's honest ceiling is 9.5% of ALL (re-sized 2026-08-07); D1 ✅ D2 ✅ → **D3** → D4 widen redirects → D5 build wrapper
- [Bash-as-file-reader census + redirect reach (2026-08-09)](bash-file-read-census-and-redirect-reach.md) — 38% of Bash calls read files (rising); a refusal naming the alternative converts 84.7%, re-send 0%; Read-friction ruled out (92.6% cold); reach 26→141 on the gap corpus
- [Auto-outline pivot claimed a cap it never hit (2026-08-09)](auto-outline-pivot-false-cap-claim.md) — 1,809 is an UPPER bound; success is the RANGE 40.8-68.3%; N=6 A/B: −24.5% context for 2× latency, cost ~1.3× marginal; PR #67 closed on this data
- [Token-bench measurement traps (2026-08-09)](token-bench-measurement-traps.md) — `--allowedTools` does NOT remove tools (use `--tools` + `--strict-mcp-config`); max output per message.id; alternate arm order; price cache-read; check range OVERLAP, not just the median
- [R3 self-hosted background agent — IMPLEMENTED 2026-07-17](r3-background-agent-implemented.md) — workflow run|watch on branch feat/self-hosted-background-agent; TriggerSource abstraction (github/url/command + --match), headless runWorkflow, worktree+PR, atomic dedup; docs/tech/background-agent/
- [/create bundled skill (PR #98)](create-skill-bundled-pr.md) — bundled skill teaching skills/rules/agents authoring; loader gotchas (agent model, arguments format, .claudin write gate)
- [LSPTool reintroduced 2026-06-17 (cache-safe, plugin-only)](lsp-tool-reintroduced-plugin-only.md) — was dropped (0 usage) then re-added: read-only 9 ops, always-present+fixed msg (not isLsp), built-in servers + install UI removed
- [Fork-subagent-by-default initiative](fork-subagent-by-default.md) — FORK_SUBAGENT shipped 2026-06-04: default spawn forks (inherits context+cache), named agent stays fresh; 2026-07-26 ungated fork + flipped auto-background to opt-in
- [Typecheck tool — baseline design + the traps it hides](typecheck-tool-baseline-design.md) — clean-tree baseline keyed by HEAD, line-independent fingerprints; worktree reconstruction for the first dirty check; exec() caps stdout at 30k
- [typecheck ratchet phantom "new" errors — fixed 2026-08-07](typecheck-baseline-message-fingerprint-fragile.md) — tsc's union elaboration used to shift the hash on any added file; elideTruncatedUnion fixes it, triage step kept
- [React Compiler's t0 param is the root of ~1400 TS7006](react-compiler-props-param-typing.md) — count sites (403) not errors (1710); the props type is already in the file; grade every guess with the compiler
- [The 107 TS2307 are the fork's shape, not a backlog](missing-subsystems-are-not-fixable-by-declaration.md) — CORRECTED: all-`any` .d.ts retire them (concrete shapes cannot — TS2339); buys zero type safety; 19 call sites DO hit the stub eagerly
- [Typecheck A/B bench — what to cite and what is noise](typecheck-ab-bench-fixture-flaw.md) — cost −16/−18% and payload −80% hold across 5 runs; context swings −13%→−1%; fixture backlog must overlap the edited files
- [RunTestsTool still has the 3 shell/env bugs Typecheck fixed](runtests-tool-shell-env-bugs.md) — ignores its cwd (worktree sub-agent tests main), FORCE_COLOR=0 enables colour, env-prefix breaks compound commands
- [RunTestsTool language coverage + reporter constraints](runtests-tool-language-coverage.md) — 23 runners IMPLEMENTED (feat/run-tests-tool); JUnit/JSON-via-flag vs heuristic-only tier; catch2/doctest override-only triad (enum+case+DESCRIPTION); fake-runner-on-PATH validation
- [Search stack measured 2026-08-12](search-stack-measured.md) — text/file search is optimal ripgrep (14× over grep on nested quantifiers); symbol search is the weak axis. CORRECTED same day, read the next line first
- [Symbol-parser options researched 2026-08-12](symbol-parser-options-researched.md) — tree-sitter IS shippable under bun --compile and its tags.scm already solves our blind spot; the blocker is the SYNC scanSymbols call in toolResultSummarizer, not size (binary is already 224 MB, no size gate)
- [Outline is blind to nested/object-literal members](outline-blind-to-nested-members.md) — 26,336 hidden vs 23,452 emitted (72.6% of files); auto-outline serves PromptInput.tsx's 2,566 lines as 5 symbols; kills the scanSymbols-cache and LSPTool-surface ideas on census data
- [Graded cross-CLI A/B: search→edit→build (2026-08-12)](cli-search-edit-ab-bench.md) — claudin vs claude, 6/6 PASS, cost ranges separated ($0.247 vs $0.459); the gap is cache_read driven by turn count, not output
- [Build tool A/B — the `directory` gap](build-tool-ab-directory-gap.md) — first run was +27% cost because the tool only built getCwd(); with `directory` it is −7.7% cost / −25% output (median of 3)
- [Git tool — D2, shipped 2026-08-04](git-tool-design.md) — Git({commands:[…]}) over all git+gh; permissions delegate to bashToolHasPermission; cost −11.5%, replay take 30.6%; the batching claim did NOT survive the A/B

## Providers & models
- [Effort is project-scoped like provider and model](effort-is-project-scoped.md) — pin lives in projects[].activeEffortForProject; no REPL surface writes settings.effortLevel; 'auto' sentinel shadows the global, /effort inherit clears it
- [Runtime /models discovery only parses `context_length`](context-window-discovery-field-names.md) — in-memory per-session; Groq/vLLM/Mistral field names mapped but unshipped; strict OpenAI/DeepSeek/Azure return nothing
- [provider !== 'anthropic' wrongly includes bedrock/vertex/foundry](provider-tag-not-anthropic-includes-cloud.md) — gate OpenAI-only form behavior (/models discovery) with an exclusion set, not != 'anthropic'
- [Native-1M models need an explicit getContextWindowForModel branch](native-1m-context-window.md) — modelSupports1M=true does NOT set the runtime window for a no-[1m]-suffix model; add it beside the `fable-5` check or it compacts at 200k (bit Sonnet 5)
- [Adaptive thinking is now the default (was opt-in)](adaptive-thinking-default-on.md) — 2026-07-13 flip: Claude models send {type:'adaptive'} by default; CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING=0 opts back to budget mode
- [Provider pointer heal — open follow-ups](provider-pointer-heal-followups.md) — febf362a fixed projects clobber + startup heal; mid-session reconcile, cache GC, /provider migrate rerun still pending
- [SDK error checks: use isSdk* guards from src/shared/errors.ts, never instanceof](externalized-sdk-copies-instanceof-apierror.md) — externalized bedrock/vertex/foundry load their own sdk copy; FIXED 2026-07-03
- [CLAUDE_CODE_SKIP_VERTEX_AUTH stub must return a real Headers](vertex-skip-auth-stub-needs-headers.md) — vertex-sdk calls .get() on getRequestHeaders(); the old `{}` killed every request under the flag; fixed + guarded 2026-08-03
- [Adding a /provider preset](../../skills/add-provider-preset/SKILL.md) — the recipe (API-key OpenAI-compat + OAuth variant) is now the `/add-provider-preset` skill, not a memory
- [Kimi Code OAuth provider (device-flow)](kimi-code-oauth-provider.md) — mirrors xAI; RE wire-format at docs/tech/kimi-code/; impersonates official CLI (UA+X-Msh-*, gray area); OAuth-web registry; review follow-ups resolved (preset removed, /coding path pinned, test gaps closed)
- [Shim-only body fields need a model-aware gate](shim-only-body-fields-model-aware-gate.md) — provider-quirk fields added to the openaiShim wire body 400 native Anthropic + Copilot-on-Claude unless gated on activeTransportUsesOpenAiShim(model)
- [Codex strict schemas make the model send placeholder args](codex-strict-schema-placeholder-args.md) — every prop forced into `required` → `pages:""` looped Read 135×; widen optionals (enums too) + strip ""/null ONLY under the codex transport; widening unverified live
- [Codex OAuth prompt-cache — retention REJECTED, key only](codex-oauth-prompt-cache-params.md) — Codex backend 400s on prompt_cache_retention (2026-07-21 fix: removed from codexShim+cache-probe); sends prompt_cache_key only; official-OpenAI still sends both
- [Codex 403 HTML-block misread as "Please run /login"](codex-403-html-block-misclassified-as-login.md) — HTML-body 403 = OpenAI/Cloudflare edge block (IP/region/fingerprint), NOT a revoked token; generic errors.ts 401/403 branch wrongly suggests /login; improvement pending
- [Claudin defaults to essential-traffic privacy level](anthropic-startup-traffic-disabled-default.md) — b2be87b5 (2026-06-06) flips default; 7→0 Anthropic startup requests; ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0 opts back in

## Build, release & distribution
- [Native-binary distribution (Bun --compile)](compile-binary-distribution.md) — 2026-07-14: per-platform binaries via npm (wrapper+optionalDependencies+install.cjs hardlink); ~409ms vs 727ms; ripgrep + sharp vendored beside execPath; strip breaks Bun binaries
- [Binary release process — release-binaries.yml + npm OIDC gotchas](binary-release-rollout-state.md) — sole release path (OIDC, not NPM_TOKEN); rollout DONE (v1.0.1→v1.0.8+ live); durable gotchas: OIDC can't first-publish, confirm via `npm access list` not `npm view`, assemble hard-fails if any platform binary missing
- [Node engine floor raised to 22.12.0](node-engine-floor-22.md) — engines.node is >=22.12.0 (was >=20) since commander 15 is ESM-only; breaking for Node 20 consumers
- [Incremental `bun install --frozen-lockfile` misses nested deps](incremental-bun-install-misses-nested-deps.md) — axios 1.19 nested https-proxy-agent@5 not materialized → build dies on "No matching export for default"; plain `bun install` fixes; CI unaffected
- [Dependabot batch 2026-08-03 audited — no code changes](dependabot-bumps-2026-08-03-no-code-changes.md) — google-auth-library 11 = Node>=22 only; axios/MCP/firecrawl inert; firecrawl typecheck error is pre-existing; vertex-sdk gal v10 nesting now deduped via overrides
- [Dependabot batch 2026-08-10 audited — no code changes](dependabot-bumps-2026-08-10-no-code-changes.md) — marked/undici/ws all inert; undici's top-level h2 knobs now deprecated for h2Options.*; the nested-manifest gap closed when vscode-extension/ was deleted
- [v8cache GC blocked process exit — fixed; startup deltas mislead](startup-v8cache-gc-blocked-exit.md) — 2026-07-13: in-process sweep added ~334ms/launch → detached child + daily stamp; also: profile checkpoint deltas over-attribute across awaits
- [Launcher jemalloc LD_PRELOAD leak](launcher-jemalloc-ld-preload-leak.md) — heap-bump re-exec leaked jemalloc to all children; Chromium segfaults → OAuth browser never opened; fixed in bin/claudin 2026-06-11
- [Plans dir moved project-local + hardened](plans-dir-project-local-hardening.md) — 2026-07-05: cwd-keyed memoize, symlink-escape realpath check, 0700 perms, global-gitignore, cleanup sweep; round-3 added plans.test.ts + cleanup.test.ts
- [PRs for this repo go to GitHub via gh](repo-prs-github-via-gh.md) — origin is github.com/claudio-labs/claudin; `gh` (andersonviudes) authed; push then `gh pr create --base main`; old git.viudescloud.uk+tea flow superseded (verify with `git remote -v`)

## TUI / diff / tooling
- [/diff reviewer has a living design doc (feature 8.1)](diff-reviewer-living-spec.md) — canonical spec at docs/features/8.1-diff-reviewer.md, kept in sync as features land (multi-repo discovery, etc.)
- [Diff reviewer canonicalizes git worktrees to the main repo](diff-reviewer-worktree-canonicalization.md) — /diff groups collapse worktrees into their main checkout; visual features are group-agnostic; fix deferred 2026-06-18 on purpose
- [parseGitDiff must not assume a/ b/ prefixes](gitdiff-mnemonic-prefix-parse.md) — diff.mnemonicPrefix emits c/ w/ → broke /diff hunk parse (all files "Large file"); forced prefixes + loose regex
- [Footer PR pill supports GitLab + Gitea](pr-status-gitlab-gitea.md) — fetchPrStatus dispatches host→gh/glab/tea; auto-detects self-hosted; prStatusHosts lives in config.json NOT settings.json; Bitbucket deferred
- [collapseRuns + blank-strip is SAFE since the 2026-06-27 root fix](bashfilter-collapseruns-blankstrip-footgun.md) — collapseIdenticalRuns no longer marks blank runs; the combo is now allowed; don't reintroduce the marker-on-blank behavior
- [bashfilter fixture edits must preserve byte length](bashfilter-fixtures-byte-length-sensitive.md) — ROI tests assert reduction % per sample; scrub fixtures with equal-length placeholders (viudes→devusr)
- [Bash filter samples live in ONE dir since 2026-08-06](bash-filter-sample-corpus-unified.md) — docs/discovery copy merged into __fixtures__/samples/; don't recreate the mirror; 87 of 142 unmapped in FIXTURE_MAP
- [Live-verifying TUI mouse click/hover under tmux](tmux-mouse-click-verification.md) — mouse only works in fullscreen (CLAUDE_CODE_NO_FLICKER=1); inject SGR clicks via `send-keys`; ctrl+o verifies the render, SGR verifies the click
- [checkBatchWritePermission's updatedInput:{} clobbers the tool's real input](checkbatchwrite-updatedinput-clobbers-input.md) — apply_patch was DOA in auto/bypass mode; harness applies updatedInput verbatim; echo real input on allow; green unit tests missed it

## References (sibling repos, wire formats, archives)
- [Public docs site claudiolabs.ai lives outside this repo](claudiolabs-docs-site.md) — no site/ dir tracked (README icon 404'd); URLs are extensionless; README links pages instead of duplicating features
- [openclaude is a sibling fork to mine for features](openclaude-sibling-fork-reference.md) — Tier-1 gaps (integrations/ registry, compressToolHistory, doomLoop) + 2026-08-14 hash-diff: only 209/3366 files byte-identical, so cherry-picks never apply
- [code-review-graph audited 2026-08-08 — graph REJECTED, 4 ideas kept](code-review-graph-evaluated-rejected.md) — 284 MB db on claudin, TS parser blind to `export const` (445/495), impact answer = 203k tokens; their own bench shows the graph losing to reading the diff
- [opencode (SST) feature-gap reference](opencode-sst-feature-gap-reference.md) — ../opencode SST monorepo scout 2026-06-24; apply_patch since shipped; open gaps: auto-format, LSP-diagnostics-on-edit, ACP/Zed adapter, part-level revert; Share=skip (privacy)
- [Windsurf upstream reference repo](windsurf-upstream-reference.md) — sibling repo opencode-windsurf-auth holds the wire-format docs, proto tags, OAuth flow; Claudin has NO windsurf provider, pure external reference
- [mitmproxy recipe for Rust agent CLIs](mitmproxy-rust-binary-recipe.md) — SSL_CERT_FILE+NODE_EXTRA_CA_CERTS+REQUESTS_CA_BUNDLE bundle trick verified against Devin Rust binary
- [Devin provider port — ARCHIVED to docs](../../../docs/tech/devin-provider/README.md) — port abandoned 2026-06-12 (f31 = per-request sealed attestation is the hard gate); full RE archive moved OUT of memory to docs/tech/devin-provider/; branch feat/devin-provider went to the retired remote, NOT reachable from origin
