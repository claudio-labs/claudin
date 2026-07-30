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

## Roadmap & major features
- [Clip-pin A/B 2026-07-25 (dev vs stable, 30 turns)](clip-pin-cache-ab-2026-07-25.md) — STALE number, do NOT cite; kept for the three bench traps (auto-outline eats files ≥250 lines, --revisits does one pass, the 60s Read cache)
- [Product roadmap 2026-07 (market-gap × codebase audit)](roadmap-2026-07.md) — R1 cost routing → R2 real sandbox backend → R3 self-hosted background agent ✅ IMPLEMENTED → R4 record&replay eval → R5 MCP Apps; replaces token-efficiency roadmap (all shipped)
- [R3 self-hosted background agent — IMPLEMENTED 2026-07-17](r3-background-agent-implemented.md) — workflow run|watch on branch feat/self-hosted-background-agent; TriggerSource abstraction (github/url/command + --match), headless runWorkflow, worktree+PR, atomic dedup; docs/tech/background-agent/
- [/create bundled skill (PR #98)](create-skill-bundled-pr.md) — bundled skill teaching skills/rules/agents authoring; loader gotchas (agent model, arguments format, .claudin write gate)
- [LSPTool reintroduced 2026-06-17 (cache-safe, plugin-only)](lsp-tool-rejected-empirically.md) — was dropped (0 usage) then re-added: read-only 9 ops, always-present+fixed msg (not isLsp), built-in servers + install UI removed
- [Fork-subagent-by-default initiative](fork-subagent-by-default.md) — FORK_SUBAGENT shipped 2026-06-04: default spawn forks (inherits context+cache), named agent stays fresh; 2026-07-26 ungated fork + flipped auto-background to opt-in
- [RunTestsTool language coverage + reporter constraints](runtests-tool-language-coverage.md) — 23 runners IMPLEMENTED (feat/run-tests-tool); JUnit/JSON-via-flag vs heuristic-only tier; catch2/doctest override-only triad (enum+case+DESCRIPTION); fake-runner-on-PATH validation

## Providers & models
- [Effort is project-scoped like provider and model](effort-is-project-scoped.md) — pin lives in projects[].activeEffortForProject; no REPL surface writes settings.effortLevel; 'auto' sentinel shadows the global, /effort inherit clears it
- [Runtime /models discovery only parses `context_length`](context-window-discovery-field-names.md) — in-memory per-session; Groq/vLLM/Mistral field names mapped but unshipped; strict OpenAI/DeepSeek/Azure return nothing
- [provider !== 'anthropic' wrongly includes bedrock/vertex/foundry](provider-tag-not-anthropic-includes-cloud.md) — gate OpenAI-only form behavior (/models discovery) with an exclusion set, not != 'anthropic'
- [Native-1M models need an explicit getContextWindowForModel branch](native-1m-context-window.md) — modelSupports1M=true does NOT set the runtime window for a no-[1m]-suffix model; add it beside the `fable-5` check or it compacts at 200k (bit Sonnet 5)
- [Adaptive thinking is now the default (was opt-in)](adaptive-thinking-default-on.md) — 2026-07-13 flip: Claude models send {type:'adaptive'} by default; CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING=0 opts back to budget mode
- [Provider pointer heal — open follow-ups](provider-pointer-heal-followups.md) — febf362a fixed projects clobber + startup heal; mid-session reconcile, cache GC, /provider migrate rerun still pending
- [SDK error checks: use isSdk* guards from utils/errors.ts, never instanceof](externalized-sdk-copies-instanceof-apierror.md) — externalized bedrock/vertex/foundry load their own sdk copy; FIXED 2026-07-03
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
- [Live-verifying TUI mouse click/hover under tmux](tmux-mouse-click-verification.md) — mouse only works in fullscreen (CLAUDE_CODE_NO_FLICKER=1); inject SGR clicks via `send-keys`; ctrl+o verifies the render, SGR verifies the click
- [checkBatchWritePermission's updatedInput:{} clobbers the tool's real input](checkbatchwrite-updatedinput-clobbers-input.md) — apply_patch was DOA in auto/bypass mode; harness applies updatedInput verbatim; echo real input on allow; green unit tests missed it

## References (sibling repos, wire formats, archives)
- [Public docs site claudiolabs.ai lives outside this repo](claudiolabs-docs-site.md) — no site/ dir tracked (README icon 404'd); URLs are extensionless; README links pages instead of duplicating features
- [openclaude is a sibling fork to mine for features](openclaude-sibling-fork-reference.md) — ../openclaude (gitlawb fork) feature-gap backlog 2026-06-23; Tier-1 ports: providerFallbackChain, credential pool, compactModel, fuzzy edit, MD/JSON export
- [opencode (SST) feature-gap reference](opencode-sst-feature-gap-reference.md) — ../opencode SST monorepo scout 2026-06-24; real gaps: apply_patch, auto-format, LSP-diagnostics-on-edit, ACP/Zed adapter, part-level revert; Share=skip (privacy)
- [Windsurf upstream reference repo](windsurf-upstream-reference.md) — sibling repo opencode-windsurf-auth holds the wire-format docs, proto field tags, OAuth flow Claudin's windsurf/ was ported from
- [mitmproxy recipe for Rust agent CLIs](mitmproxy-rust-binary-recipe.md) — SSL_CERT_FILE+NODE_EXTRA_CA_CERTS+REQUESTS_CA_BUNDLE bundle trick verified against Devin Rust binary
- [Devin provider port — ARCHIVED to docs](../../../docs/tech/devin-provider/README.md) — port abandoned 2026-06-12 (f31 = per-request sealed attestation is the hard gate); full RE archive moved OUT of memory to docs/tech/devin-provider/; branch feat/devin-provider (ec607be) pushed, not merged
