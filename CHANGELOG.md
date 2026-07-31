# Changelog

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
