# Changelog

## v1.1.17 — 2026-08-18

### ✨ Features

- feat(tui): fold the footer task panel into a one-line icon summary (#116) (b581ac5d)
- feat(permissions): add /auto-mode-setup to generate auto mode rules (#115) (aac61054)

### 🐛 Bug Fixes

- fix(bridge): retry remote control session creation before failing (#120) (81cc5487)

### ♻️ Refactoring

- refactor(agents): remove the built-in Explore subagent (#119) (10dc4d18)
- refactor(tui): drop the main row from the footer agent panel (#118) (d98c534d)

### 🧪 Tests

- test(providers): confirm the model-select is listening before Enter (#117) (4fcdd032)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.16 — 2026-08-18

### ✨ Features

- feat(tui): repaint the startup banner blue and unify its model name (#114) (86c8250a)
- feat(tui): wrap slash-command descriptions over two rows (#112) (86ba19b4)
- feat(rules): keep a navigation map claims true, and create one in every project (#111) (fbe934c1)

### 🐛 Bug Fixes

- fix(tui): drop the blank leading row from the startup banner (#113) (e4f8b018)

### 📦 Dependencies

- chore(deps): bump the dev-dependencies group with 2 updates (#109) (9cab6cbf)
- chore(deps): bump the production-dependencies group with 6 updates (#110) (f5d2e7a6)

### 📚 Documentation

- docs(memory): record the 2026-08-17 dependabot audit, no code changes needed (0f15cb89)
- docs(memory): rename two memories whose filenames contradicted their own bodies (5fe615e6)
- docs(repo-map): close the repo-map study, no index of any shape survives (#108) (069df04a)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


## v1.1.15 — 2026-08-16

### ✨ Features

- feat(explore): give the report an output contract, and a reading order to match (#105) (36ab72a2)
- feat(glob): teach Glob what find is reached for, and convert find with it (#104) (9e2e28c9)
- feat(bash-redirect): widen the redirect where the corpus says it pays (#103) (07039e7b)

### ⚡ Performance

- perf: cut a duplicate markdown lex per frame and fix the no-op GC hint (#107) (8a7e68ae)

### 📚 Documentation

- docs(rules): pin the commit and PR title format the release notes depend on (85b20727)
- docs(readme): offer the install script alongside the npm install (bff26498)

### 🧪 Tests

- test(bash): put the Bash validators under test, verified by mutation (#101) (a13cf36b)

### 🔧 Miscellaneous

- chore(funding): point a Sponsor button at the project's own tip jar (#106) (6f453b70)

### 👥 Contributors

- <a href="https://github.com/andersonviudes"><img src="https://github.com/andersonviudes.png?size=40" width="20" height="20" alt="@andersonviudes"></a> <a href="https://github.com/andersonviudes">@andersonviudes</a>


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

