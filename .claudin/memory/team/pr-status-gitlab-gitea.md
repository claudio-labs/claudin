---
name: Footer PR pill supports GitLab + Gitea (feat/pr-status-gitlab-gitea)
description: How the prompt-input PR/MR status pill resolves host → CLI, and the accepted review-state limitations for GitLab/Gitea
type: project
---

The footer PR pill (`src/utils/ghPrStatus.ts` → `usePrStatus` → `buildPrPill`)
now works for GitHub (`gh`), GitLab (`glab`), and Gitea/Forgejo (`tea`), not just
GitHub. Shipped on branch `feat/pr-status-gitlab-gitea` (off main, 2026-06-15).

**Architecture:** `fetchPrStatus()` is a host dispatcher — `getRemoteUrl()` →
`parseGitRemote().host` → `resolveHostKind()` → one of three thin CLI adapters.
Each adapter = a **pure mapper** (`mapGhJson`/`mapGlabJson`/`mapTeaList`, exported
+ unit-tested with zero mocking, dodging the Bun mock.module leak) + a spawn
wrapper. `PrStatus` gained a `label: 'PR' | 'MR'` field threaded through
`usePrStatus` state and `buildPrPill(…, labelText)`. CLI spawns pass
`useCwd: true` (the old gh call relied on `process.cwd()`).

**Why these design choices (not obvious from code):**
- **Default unknown host → `github`** (`resolveHostKind`): preserves GitHub
  Enterprise (custom hostname) users who got the pill before; gh fails open if
  the host isn't actually GitHub.
- **`prStatusHosts` config map** (`GlobalConfig`, `Record<host, 'github'|'gitlab'|'gitea'|'none'>`):
  self-hosted GitLab/Gitea can't be told apart by hostname, so a config entry
  routes them; `'none'` silences a host; map overrides auto-detection.
  ⚠️ **This key lives in `~/.claudin/config.json` (what `getGlobalConfig()` reads),
  NOT `~/.claudin/settings.json`.** Putting it in settings.json is silently ignored
  (cost a full debug session 2026-06-16). settings.json = settings layer (perms/
  profiles); config.json = the 40-key GlobalConfig.
- **Auto-detect (commit 97fe2bce, 2026-06-16) — `prStatusHosts` is now usually
  unnecessary:** for a host that isn't statically classified (would default to
  `github`), `fetchPrStatus` probes the installed CLIs IN PARALLEL with a dedicated
  identity command (`gh repo view --json nameWithOwner`, `glab mr list -F json`,
  `tea pr list`) — JSON of the expected shape ⇒ that CLI owns the repo. Picks by
  priority gh > glab > tea, caches `host→kind` in a session `Map` (`'none'` = no
  pill, no re-probe). `tea`'s probe doubles as its PR fetch (1 call). Probes capped
  at 3000ms so the parallel fan-out stays under the 4s `usePrStatus` guard. Identity
  probe (not stderr sniffing) because `gh pr view`/`glab mr view` can't tell
  "right host, no open PR" from "foreign" — both give empty stdout + nonzero exit;
  only `tea` returns `[]`. `staticHostKind()` returns `{kind, confident}` to mark
  the unknown-host fallthrough. ⚠️ glab path is fixture-tested only (glab not
  installed on this machine); the override remains the escape hatch.
- **One CLI call, best-effort review state (accepted limitation):** neither
  `glab mr view` nor `tea pr list` reliably expose a review decision, so GitLab/
  Gitea pills are usually neutral `pending` (GitLab shows `approved` only when
  `approvals_left == 0` is present); there is NO `changes_requested` for them.
  Avoids a 2nd API call that would trip the 4s slow-disable guard.
- **Bitbucket deferred:** no CLI returns the current branch's PR as JSON (acli
  lacks PRs; bbt v0.1.0 has no JSON). A Bitbucket remote shows no pill (gh exits
  non-zero, fails open). A future `'bitbucket'` value slots into the dispatch.

Config label relabeled "Show PR/MR status footer". Tests:
`src/utils/ghPrStatus.test.ts` (pure-function units) + `ghPrStatus.integration.test.ts`
(boundary-mocked dispatch/detection; reuse the `setup({git,hosts,exec})` +
`importFresh()` + `calls[]` harness). Live-verified 2026-06-16: pill `[ PR #81 ]`
auto-detects on the then-origin Gitea host `git.viudescloud.uk` with `tea` logged in and
NO `prStatusHosts` config. glab/gitea-via-glab still user-driven (glab not installed).

**Update 2026-07-13:** this repo's origin migrated to **GitHub** (`github.com/claudio-labs/claudin`), so the pill now resolves via `gh` here — the Gitea auto-detect above is historical, not the current live path. The `glab`/`tea` dispatch branches are unchanged and still serve users whose origin really is GitLab/Gitea; only this repo's own host moved.
