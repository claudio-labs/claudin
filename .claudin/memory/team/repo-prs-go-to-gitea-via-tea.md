---
name: PRs for this repo go to GitHub via gh
description: origin is github.com/claudio-labs/claudin; use the gh CLI to open PRs. Migrated off self-hosted Gitea on 2026-07-08.
type: reference
---

This repo's `origin` is **GitHub** at `https://github.com/claudio-labs/claudin.git`.

**History:** origin was self-hosted Gitea (`git.viudescloud.uk/viudes/claudin.git`) until **2026-07-08**, when it was switched to GitHub and the Gitea remote was removed. Older PRs (e.g. pulls/88) were opened against Gitea via `tea`.

**How to open a PR:**
1. `git push -u origin <branch>`
2. `gh pr create --base main --head <branch> --title "..." --body "..."`

- `gh` was previously authed to a *different* github.com account (`andersonviudes`) than this repo (`claudio-labs`) — verify `gh auth status` targets an account with access to `claudio-labs/claudin` before opening a PR.
