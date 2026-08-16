# Changelog

## v1.1.14 — 2026-08-16

### 🧪 Tests

- test(bash): put the Bash validators under test, verified by mutation (#101) (a13cf36b)

### 🔧 Miscellaneous

- Point a Sponsor button at the project's own tip jar. (#106) (e74cdead)
- Give the Explore report an output contract, and a reading order to match (#105) (b19be669)
- Teach Glob what find is reached for, and convert find with it (#104) (3d514739)
- Widen the Bash→tool redirect where the corpus says it pays (#103) (71f2e727)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.13 — 2026-08-16

### ✨ Features

- feat(bridge): turn Remote Control back on, credential-gated (cbfbed0a)
- feat(bash-redirect): translate BRE to ERE, add Glob -i, fold `cat F | grep` (#96) (bfb2e933)

### 🐛 Bug Fixes

- fix(bash-filter): a stripped `| tail -N` must keep the promise it makes (#98) (401db339)
- fix(build-redirect): stop refusing non-build targets like `make lint` (#97) (aa57c8a6)
- fix(read-gate): carry seen ranges across reads, re-read changed files in full (#95) (cc888d9b)
- fix(apply_patch): repair four unambiguous parse failures instead of rejecting the patch (#94) (4a0af3f9)
- fix(build): stop baselining test fixture strings as missing imports (#89) (7b620924)
- fix(typecheck): take tsc --noEmit to zero (#87) (7241b101)

### ♻️ Refactoring

- refactor(reorg): screaming architecture — retire the seven catch-all directories (#93) (cf0a5bbb)
- refactor(read): split FileReadTool.ts into sibling modules (#92) (7e2c7c76)
- refactor(outline): split scanSymbols.ts into a package (#91) (885a3d1e)
- refactor: move the subsystems out of src/utils into their own domains (#88) (d5220e1c)

### 📚 Documentation

- docs(memory): cite the /create skill by commit — its (#98) is the retired remote's numbering, not GitHub's (8a437b37)
- docs(rules): add code-design rule — read before you edit, SOLID/Clean Code as this tree spells them (34894400)

### 🔧 Miscellaneous

- chore(scripts): give scripts/ a shape, and fix the release lane it was hiding (#100) (6af3126f)
- Remove upstream identity from wire, bundle, help and env vars (#99) (b8631a81)
- chore(license): make LICENSE a plain MIT file (0c37342e)
- chore(ide): drop the bundled VS Code extension and its build wiring (#90) (fcbcbc11)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.12 — 2026-08-13

### ✨ Features

- feat(read-gate): a range read no longer authorizes a write outside it (#86) (853dcf9)
- feat(search+read): honest empty results, and one encoding label that reaches all three tools (#84) (736048a)
- feat(prompt): sub-agent authority/report guards + a prompt dump that matches the build (#81) (2bdc1c8)
- feat(tui): fold file writes into the collapsed read/search group (#79) (73b9d0e)
- feat(prompt): runtime killswitches for the work-contract and anti-narration steering, plus the A/B that measures them (#77) (3c1e05d)

### 🐛 Bug Fixes

- fix(outline): emit object-literal members, not just class methods (#85) (88369f5)
- fix(glob): rank matches newest-first and page past the 100-path cap (#82) (7396ff0)
- fix(apply-patch): treat @​@​ as a search cursor, and say where a hunk diverges (#80) (9fdfb66)
- fix(git-tool): redirect git reads whose operators live inside quotes (#78) (92d2437)

### 🧪 Tests

- test(profile): a graded claudin-vs-claude A/B on one search-edit-build task (#83) (a3acb20)
- test(profile): A/B the lean tool-prompt tier that #82 deferred (#76) (0724ed5)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.11 — 2026-08-11

### ✨ Features

- feat(git-tool): run gh watch commands with a live elapsed clock (#74) (b8b75c1)
- feat(prompt): show session and git diff totals on the input top rule (#71) (457b8c2)
- feat(bash): fold a trailing head/sed into the Grep the redirect suggests (#66) (d7308e6)

### 🐛 Bug Fixes

- fix(runtests): stop refusing the raw-output escalation after a RunTests run (#75) (c1b349c)
- fix(tui): make /diff and /explorer scrollable outside fullscreen (#72) (121c02e)
- fix(git-tool): stop refusing a commit message for the punctuation in its prose (#70) (aae42b2)
- fix(read): point the auto-outline pivot footer at view='full' instead of a no-op (#69) (9b2ee92)
- fix(read): stop the auto-outline pivot from claiming a read cap it never hit (#68) (71893cd)

### 📦 Dependencies

- chore(deps): bump the production-dependencies group with 3 updates (#73) (6e36a7c)

### 📚 Documentation

- docs(memory): record the 2026-08-10 dependabot audit (0d38198)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.10 — 2026-08-08

### ✨ Features

- feat(spinner): replace the orbit-then-brand-C cycle with a dense braille orb (#63) (fb38624)
- feat(prompt): let bash mode read from the prompt frame instead of a footer hint (#62) (fafc169)
- feat(git-tool): take a multi-line message, and make `full: true` mean whole (#60) (74a8cef)

### 🐛 Bug Fixes

- fix(build): report a verdict, and stop dropping the duration on the way to the TUI (#65) (fec479f)
- fix(theme): follow the terminal palette for Tokyo Night's stalled spinner (#64) (fadaa01)
- fix(theme): take Tokyo Night brand orange from the dark-ansi theme (f2fb7fb)
- fix(theme): align Tokyo Night brand orange and stalled spinner with the other themes (#61) (e692f16)

### 📚 Documentation

- docs(memory): date the typecheck snapshots and fix the stale claims (4abb1b7)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.9 — 2026-08-07

### ✨ Features

- feat(rules): catch the two ways a rule file fails silently (#58) (e62ab9f)

### 🐛 Bug Fixes

- fix(memdir): measure and cut MEMORY.md against real UTF-8 bytes (#56) (7060d1b)

### ⚡ Performance

- perf(attachments): stop sending every rule and CLAUDE.md twice per session (#59) (7ea132c)

### ♻️ Refactoring

- refactor: finish ROADMAP 11b/11e + fix the hang they surfaced (#57) (909bdf9)

### 🔧 Miscellaneous

- chore(repo): type backlog, three CI guards, and a dead-code sweep (#55) (38f6f26)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.8 — 2026-08-06

### ✨ Features

- feat(tui): a live progress line for SourceCheck and Test (#54) (b19e5e2)
- feat(build): a Build tool that reports diagnostics instead of the build log (#52) (115d35f)
- feat(git): a Git tool for batched git/gh commands with Bash-parity permissions (#51) (d477bf4)
- feat(release): group the release notes by commit type (18e7142)

### 🐛 Bug Fixes

- fix(git): route the gh reads the tool renders better, and stop mangling them (#53) (65729e7)

### ⚡ Performance

- perf(grep): pivot a broad content search to the symbol map (#50) (fc513f1)
- perf(summarizer): teach the Grep strategy about ripgrep context lines (#49) (5d50ab0)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.7 — 2026-08-04

- feat(typecheck): baseline-aware Typecheck tool (#48) (c3b86a3)
- chore(deps): dedupe google-auth-library via a $-ref override (241f6af)
- fix(vertex): hand the SKIP_VERTEX_AUTH stub a real Headers (ea0fefb)
- chore(deps): bump the dev-dependencies group with 2 updates (#45) (0894d88)
- chore(deps): bump the production-dependencies group with 4 updates (#46) (a1c9291)
- chore(deps): bump google-auth-library from 10.9.1 to 11.0.0 (#47) (709a5c3)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.6 — 2026-07-31

- fix(diff,explorer): size the stacked file list to the terminal and fix the Changed group (d8a2950)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.5 — 2026-07-31

_No user-facing commits since previous tag._


## v1.1.4 — 2026-07-30

- feat(shell): show the batch elapsed on the collapsed group header (88b4c60)
- feat(shell): keep the elapsed time moving while a command runs (2ea2b74)
- fix(memory): stop the stub prompt from teaching an unparseable frontmatter (aa211b9)
- feat(prompts): add the work-contract sections to the system prompt (34f9b28)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.3 — 2026-07-30

- docs(readme): center the title logo on the cap height (ea5b405)
- docs(readme): drop the Providers list in favor of the docs link (bf124b6)
- docs(readme): promote Screenshot to a top-level section (f9681db)
- docs(readme): give the screenshot its own heading and fix the logo alignment (b4f375e)
- docs(readme): center the badge row under the title (773f602)
- docs(readme): center the title and logo above the rule (f6dfb9f)
- docs(memory): record that the docs site lives outside this checkout (ab103f0)
- docs(readme): show the launch banner after the dev-binary setup (8773f47)
- docs(readme): point at the docs site instead of a local feature list (035a976)
- docs(readme): correct the Node floor and surface project health badges (87e41ae)
- fix(mcp): pick the OAuth callback port with a CSPRNG (1f7b5f9)
- fix(runtests): sum every summary line instead of trusting the first (a8e1d65)
- fix(runtests): let an output-trimming pipe through the Bash redirect (cb54b2a)
- fix(tui): restore the missing fork-boilerplate message component (469c3bf)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.2 — 2026-07-29

- docs(codex): record the live evidence for the strict-schema contract (#44) (57aebd6)
- fix(plan-mode): keep the plan file put when a Bash `cd` moves the cwd (7da75dd)
- fix(update): detect the package manager that actually owns the install (9d15216)
- fix(agents): indent nested sub-agents under their parent in the footer panel (8178001)
- fix(codex): let the model decline an optional tool argument (#43) (72cc23b)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.1 — 2026-07-28

- fix(runtests): detect the runner the project actually declares (d285e06)
- docs(rules): record chalk 6's exact-level FORCE_COLOR semantics (1ef3c76)
- chore(deps): bump chalk from 5.6.2 to 6.0.0 (#42) (be85070)
- chore(deps): bump the production-dependencies group with 6 updates (#41) (8dcb494)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.0 — 2026-07-26

- feat(tui): make the frame rate configurable and identical in both renderers (#40) (3810c5a)
- fix(spinner): make the thinking glow breathe instead of blink (6fe0839)
- test(provider): wait for the focused row instead of a fixed sleep before Enter (9b1ba8b)
- feat(config): group the /config settings into sections instead of one flat list (ee607ba)
- feat(config): let /config pick the terminal renderer instead of hiding it behind a flag (044fc23)
- fix(tasks): reconcile the task list at end of turn instead of leaving it stale (#39) (b28c709)
- fix(profile): make the agent token bench price the whole session, not just the parent (92219d5)
- fix(agents): make auto-background opt-in so inline spawns stay inline (#38) (e20ff18)
- feat(effort): scope /effort to the project, with global fallback (#37) (49dd307)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.17 — 2026-07-26

- feat(tools): steer file reads and searches to Read/Grep/Glob instead of Bash (#36) (ad71f67)
- feat(tools): steer test runs to RunTests instead of Bash (#35) (f74c518)
- fix(edit): stop refusing partially-read files with a message that hides the fix (#34) (178b426)
- feat(read): pin a re-sent Read body so context management stops clipping it (#33) (f2e4806)
- feat(tools): Rename tool for project-wide identifier renames (#32) (ecfd513)
- Register Claude Opus 5 as native-1M flagship model (#31) (6c30d1c)
- refactor(tools): rename ApplyPatch user-facing name to Patch (28d2929)
- feat(tools): add RunTests tool with framework detection and structured failures (#30) (a19a6ea)
- feat(edit): whitespace-tolerant fuzzy fallback for FileEditTool (#29) (a598f03)
- docs(memory): record Codex 403 HTML-block misclassified as login prompt (f40d3ce)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.16 — 2026-07-24

- feat(outline): expand symbol scanning to 19 more languages (#28) (4db75cf)
- feat(read): circuit-breaker for the clipped-Read re-read loop (217fba7)
- fix(git): suppress "Generated with Claude Code" footer in commits/PRs (883b24a)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.15 — 2026-07-21

- fix(apply_patch): report all batch failures at once, not one per resubmit (6fa96de)
- feat(apply_patch): instruct models to batch multi-file edits into one call (59eef00)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.14 — 2026-07-21

- fix(codex): stop sending prompt_cache_retention (backend 400s on it) (0d4b5b1)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.13 — 2026-07-20

- chore(deps): bump execa from 9.6.1 to 10.0.0 (#26) (fc7840f)
- chore(deps): bump the production-dependencies group with 4 updates (#25) (2c5470d)
- chore(ci): bump the github-actions group with 3 updates (#24) (6654355)
- fix(mcp): enrich tool-arg validation errors so models stop re-guessing (#27) (018f46e)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.12 — 2026-07-20

- feat(model): dynamic Codex model filter + gpt-5.6 sol/terra/luna (#23) (2bf563c)
- fix(security): broaden WebFetch script/style end-tag strip to attribute-bearing tags (a867073)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.11 — 2026-07-19

- docs(memory): team note on byte-length-sensitive bashfilter fixtures (7d43b4c)
- fix(security): resolve 8 high + 2 medium CodeQL code-scanning alerts (b5a5edc)
- chore(repo): scrub machine-specific paths/usernames from docs, fixtures, scripts (28b5382)
- chore(dev): bun run link:dev — reproducible claudindev symlink for contributors (8f81606)
- feat(memory): /memory tidy — conservative duplicate merge (#22) (ca5e4aa)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.10 — 2026-07-19

- feat(usage): active-only wall duration + 'what's driving your usage' scroll pane (e79aca7)
- feat(provider): send OpenAI prompt-cache params on Codex OAuth transport (#21) (773e5ef)
- feat(permissions): auto mode for non-Claude providers via classifier capability probe (#20) (564fef0)
- fix(provider): robust model + error handling across provider switches (c75f1c5)
- feat(provider): add Kimi Code OAuth (device-flow) provider (#19) (eaabb20)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.9 — 2026-07-18

- fix(bash-input): repair the user `!command` path end-to-end (#18) (0bcd73a)
- fix(context): make /context panel scrollable so the grid isn't clipped (46bb4fc)
- test(plan): update PLAN_PHASE4_CONTROL snapshot for Tasks-section format (84d6494)
- feat(workflow): self-hosted background agent (claudin workflow run|watch) (#17) (295ba2f)
- chore(claudin): reorganize agent memory into path-scoped rules + skills (#16) (e3243b9)
- feat(plan): seed the TodoV2 tasklist from the plan on ExitPlanMode (f0a459c)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.8 — 2026-07-16

- fix(ripgrep): restore exec bit on vendored rg in the compiled binary (f3b48f2)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.7 — 2026-07-16

- test: pin getAPIProvider at the real leak seam, not getActiveProviderProfile (378ac55)
- test: isolate provider state in prompt/effort tests to stop full-suite flakiness (17b3548)
- chore(release): add per-platform npm package bootstrap script (8ea87cb)
- feat(plan): reframe plan-mode as two-way co-design, not an interview (ee3c96e)
- fix(explorer): list files from the session cwd, not process.cwd() (2f43f66)
- fix(commands): register /commit so Skill(commit) resolves (38430ec)
- fix(ui): rebrand user-facing "Claude Code" tips and notices to Claudin (058493e)
- fix(model): show a single Opus 4.8 entry in the subscriber picker (70a8520)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.6 — 2026-07-15

- fix(update): publish the npm wrapper as CommonJS so the .exe stub can launch (#15) (2db43c1)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.5 — 2026-07-15

- fix(diff): embed highlight.js grammars in --compile binary via static requires (4f03d27)
- fix(update): self-heal Bun global installs whose postinstall was skipped (#14) (b27ff1a)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.4 — 2026-07-14

- feat(model): make /model selection project-scoped, decoupled from provider override (#13) (0666a7b)
- feat(models): drop standalone Opus 4.8 entry from first-party picker (a26e8a8)
- fix(context): restore two-tier context warning, truthful compact %, and discovery-first window sizing (#12) (e6c416c)
- fix(image): vendor sharp into the compiled binary + tolerant resize fallback (#11) (2a02ced)
- fix(plan-mode): recognize plan file by directory, not exact slug (#10) (ea84889)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.3 — 2026-07-14

- ci(release): cross-compile darwin-x64 on arm64, drop macos-13 Intel runner (1ffb786)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.2 — 2026-07-14

- ci(release): build linux-arm64-musl via docker, not an arm64 Alpine job container (2ee530f)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.1 — 2026-07-14

- ci(release): unify on the native-binary release, remove the Node-bundle flow (67b13b1)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.0.0 — 2026-07-14

- feat(dist): native binary distribution via npm (Bun --compile) (#9) (8c9c915)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v0.7.6 — 2026-07-13

- feat(agents): enable auto-background agents by default (5fe1570)
- fix: batch of correctness/security/data-loss fixes from code audit (#8) (949854f)
- feat(openai-shim): recover XML-embedded tool calls (GLM/Qwen/Hermes/HY3) (#7) (975e4dc)
- chore(deps): bump tsx in the dev-dependencies group (#5) (b2a9984)
- chore(deps): bump the production-dependencies group with 4 updates (#6) (b4c2f0e)
- feat(thinking): default to adaptive thinking for supported Claude models (911dd36)
- feat(attribution): drop baked-in default, opt-in only via settings (b583a1b)
- ci(release): stop commit-subject @​mentions duplicating the Contributors strip (e5cffb0)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v0.7.5 — 2026-07-09

- ci(release): push bump/changelog to main via GH_CHANGELOG_TOKEN (7af417d)
- ci(release): sync changelog to own CHANGELOG.md and claudio-labs/claudin-site (89d51db)
- docs(readme): fix logo and version (d3b47a7)
- chore(deps): drop 8 @opentelemetry devDependencies via local no-op shim (#4) (72ebd8e)
- chore(deps): bump the production-dependencies group with 4 updates (#3) (2a1c18f)
- chore(deps): bump the dev-dependencies group with 10 updates (#2) (75ec17c)
- chore(ci): bump the github-actions group with 2 updates (#1) (1eb2f07)
- ci(dependabot): enable weekly version updates for bun deps + GitHub Actions (1b9c63e)
- docs(security): fix stale 'Open Claude' name -> Claudin (b54cfac)
- docs: require Discussion + benchmarks for large/perf changes; welcome contributions (94af66d)
- test(cost-tracker): freeze the clock to de-flake projectTotals duration (c7025ba)
- ci(release): render Contributors with GitHub avatar + @handle (a40fe4e)

### Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## Unreleased

### BREAKING

- Rebrand Claudio → Claudin: npm package `@claudiolabs/claudio` → `@claudiolabs/claudin`; binary `claudio` → `claudin`; config dir `~/.claudio` → `~/.claudin`; env vars `CLAUDIO_*` → `CLAUDIN_*`; VSCode extension publisher and id changed. Reinstall and re-authenticate required.

## [unreleased]

### feat

- **`/autofix-pr` substitui `/pr-comments`:** Novo slash command que coleta comentários de review do PR atual, triage em 8 labels (`ok`, `change_request`, `nit`, `praise`, `incorrect`, `pr_questionable`, `unclear`, `out_of_scope`), aplica fixes, roda typecheck+test, commita, dá push e responde nas threads. Faz loop até 5 iterações com anti-stall em `(comment_id, updated_at)`. Suporta `--dry-run` para paridade 1:1 com o antigo `/pr-comments` (listagem read-only). Guarda contra rodar na default branch, HEAD detached, sem `gh auth` ou sem PR aberta.

- **Bash output filter — default-on (Phase 7):** O filtro de saída de comandos Bash agora está ativo por padrão em todas as instalações novas. Economiza ~50k tokens por sessão típica de 30min (~72% de redução de custo de input) filtrando noise de ~35 comandos (pytest, cargo, bundle install, git log, ls, ps aux, etc.). Toggle disponível em `/config` → "Bash output filter". Para desativar: `/config` → toggle off, ou `bashOutputFilterEnabled: false` em `~/.claudio/settings.json`. ([docs/tech/bash-output-filter/](docs/tech/bash-output-filter/))

- **Tip de performance:** Nova tip `bash-output-filter-token-saving` informando sobre o ganho de tokens do filtro. Aparece após 5 startups quando o filtro está ativo, cooldown de 20 sessões.

### chore

- `shouldFilterOutput`: gate alterado de `=== true` para `!== false` — `undefined` (config nova) agora ativa o filtro sem necessidade de valor explícito.
