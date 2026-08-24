---
name: aur-omarchy-packaging
description: claudin-bin AUR package (PR #134) — the /usr/lib layout that keeps the vendored rg+sharp working, and the two manual steps still pending before it goes live
type: project
---

`claudin-bin` was added on 2026-08-23 (branch `feat/aur-package`, PR #134) as an
Arch `-bin` package over the `linux-x64` / `linux-arm64` tarballs the release
already attaches. Mechanics live in `packaging/README.md`; this is the state and
the parts that are not in the tree.

**BLOCKED — the package is NOT on the AUR, and cannot be as of 2026-08-23:**

1. **AUR account registration is closed** and has been since the 2026-06-12
   "Active AUR malicious packages incident"; still closed at the aurweb v6.5.0
   deploy (2026-08-12), with `adoption` disabled too. aur-general, 2026-08-13:
   *"there's no break glass / manual process to register account in AUR for
   now"*, and account-request mails to the list *"will be ignored"*. No ETA. Do
   not script retries against the registration page — the 503 page asks not to,
   and says the Arch news feed / aur-general will announce it first. The names
   `claudin` and `claudin-bin` were both free, so nothing was lost by waiting.
2. Add `AUR_SSH_PRIVATE_KEY` to the repository secrets. The `aur` job of
2. Flip `AUR_PUBLISH` to `'true'` at the top of the `aur` job in
   `release-binaries.yml` **and** add the `AUR_SSH_PRIVATE_KEY` secret. The job
   is gated on both and **no-ops** if either is missing, on purpose: releases
   stay green while the lane is dead, since a red job there would read as a
   broken release. The flag exists so the off state is a decision in the file
   rather than an accident of a missing secret.
3. PR `omacom-io/omarchy-pkgs` for the OPR mirror.

**Omarchy does not want a PKGBUILD from us.** Their `bin/add-package <name>
--fast` syncs the PKGBUILD straight from the AUR and records the AUR commit in
`upstream_commit`, so an OPR mirror is just `.omarchy/package.json` with
`{"source":"aur","release_ring":"fast"}` — the shape `claude-code`,
`openai-codex-bin` and `crush-bin` all use there. The AUR package has to exist
first. Until the PR lands, `omarchy pkg aur add claudin-bin` already works.

**Why the binary is under `/usr/lib/claudin/` and `/usr/bin/claudin` is a
wrapper**: both sidecar lookups resolve against
`dirname(realpath(process.execPath))`, so a binary installed straight into
`/usr/bin` finds neither `vendor/ripgrep` nor `vendor/sharp`. Both degrade
**silently** — Grep falls back to the system `rg`, images stop being resized —
so `--version` and `--help` pass either way. Verified empirically with a
mutation check on both (move the vendor dir away, watch the live run change).
The same wrapper defaults `CLAUDIN_SKIP_STARTUP_UPDATE=1` and
`DISABLE_AUTOUPDATER=1`, since the startup notice advises an npm update and the
auto-updater would write into a pacman-owned directory.

Related: [[compile-binary-distribution]], [[binary-release-rollout-state]].
