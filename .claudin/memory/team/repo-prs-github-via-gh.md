---
name: PRs for this repo go to GitHub via gh (origin changed from Gitea)
description: origin is now github.com/claudio-labs/claudin; open PRs with gh. The old self-hosted Gitea (git.viudescloud.uk) + tea flow no longer applies to this checkout.
type: reference
---

As of **2026-07-13**, this checkout's `origin` is **`https://github.com/claudio-labs/claudin.git`** (verified via `git remote -v`).

**How to open a PR:**
1. `git push -u origin <branch>`
2. `gh pr create --base main --head <branch> --title "..." --body "$(cat <<'EOF' … EOF)"`

- `gh` is authed to `github.com` (account `andersonviudes`, keyring, scopes incl. `repo`/`workflow`) and works directly — no host mismatch. Example: PR #7 opened this way.

**`main` is protected but the owner can bypass it.** A ruleset requires "Changes must be made through a pull request", yet `git push` to `main` succeeds and prints `remote: Bypassed rule violations for refs/heads/main` (observed twice on 2026-07-29 for README-only commits). So: a direct push to `main` is technically possible and the user does authorize it for small docs changes ("pode comitar na main" / "pode comitar e fazer push"). Still never commit or push unprompted — wait for that explicit go-ahead, and default to the branch + `gh pr create` flow for anything touching `src/`.

**History (superseded):** until ~2026-07-06 `origin` was self-hosted **Gitea 1.26.4** at `https://git.viudescloud.uk/viudes/claudin.git`, and PRs went via `tea pr create --remote origin --base main` because `gh` targeted a different host. That is no longer the origin for this working copy — trust `git remote -v` over this note if it ever drifts again. If you find yourself on a clone whose origin really is git.viudescloud.uk, the old tea flow (login `git.viudescloud.uk`, `--description "$(cat file)"`, API base `/api/v1/`) still applies there.
