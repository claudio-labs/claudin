# packaging/

Distro packages built around the binaries a GitHub release already publishes.
Nothing here is part of the npm package or of `dist/` — the npm lane lives in
`scripts/release/assemble-packages.ts`.

## `aur/claudin-bin/` — Arch Linux

`claudin-bin` on the AUR, built from the `linux-x64` / `linux-arm64` release
tarballs. The directory is mirrored verbatim into the AUR git repository by the
`aur` job of `.github/workflows/release-binaries.yml` (`asset_dir`), so keep it
to exactly the three files the AUR needs:

| File | Why |
|---|---|
| `PKGBUILD` | version + checksums are rewritten by `bun run release:aur` |
| `claudin.sh` | `/usr/bin/claudin`; sets the two env defaults, then `exec`s the real binary |
| `claudin.install` | post-install warning when another `claudin` shadows it in `$PATH` |

`.SRCINFO` is deliberately **not** committed here — the deploy action
regenerates it inside an Arch container on every push.

### Why the binary is not in `/usr/bin`

The compiled binary resolves its two sidecars — the vendored `rg` and the
vendored `sharp` — against `dirname(realpath(process.execPath))`
(`src/shared/fs/ripgrep.ts`, `src/tools/FileReadTool/imageProcessor.ts`). So the
payload is installed whole under `/usr/lib/claudin/` and `/usr/bin/claudin` is a
wrapper that `exec`s it. Put the binary directly in `/usr/bin` and both lookups
miss: `Grep` silently falls back to the system `rg`, and reading or pasting an
image stops being resized. Both failures are silent, so neither shows up in a
`--version` smoke test.

The wrapper also defaults `CLAUDIN_SKIP_STARTUP_UPDATE=1` and
`DISABLE_AUTOUPDATER=1`: the startup notice tells the user to update through
npm, and the auto-updater would try to write into a directory pacman owns. Both
are plain defaults — a user who exports either variable keeps their own value.

### Releasing

The `aur` job runs after `publish` and needs one repository secret,
`AUR_SSH_PRIVATE_KEY` (the private half of a key registered on
aur.archlinux.org). **Without it the job no-ops** and the release still goes
green, which is what makes the bootstrap below safe to do later.

First publication is manual, once:

```bash
bun run release:aur                 # point the PKGBUILD at the current release
git clone ssh://aur@aur.archlinux.org/claudin-bin.git /tmp/aur-claudin
cp packaging/aur/claudin-bin/{PKGBUILD,claudin.sh,claudin.install} /tmp/aur-claudin/
cd /tmp/aur-claudin
makepkg --printsrcinfo > .SRCINFO   # required; the AUR rejects a stale one
git add PKGBUILD claudin.sh claudin.install .SRCINFO
git commit -m "claudin-bin 1.1.18-1"
git push origin master              # the AUR only accepts `master`
```

After that every release refreshes it automatically. For a PKGBUILD change that
is not a version bump, bump `pkgrel` instead:
`bun run release:aur <version> --pkgrel 2`.

### Checking a change locally

```bash
mkdir -p /tmp/claudin-aur && cp packaging/aur/claudin-bin/* /tmp/claudin-aur/
cd /tmp/claudin-aur && makepkg -f
bsdtar -tf claudin-bin-*.pkg.tar.zst | head                     # layout
bsdtar -tvf claudin-bin-*.pkg.tar.zst usr/lib/claudin/claudin   # mode, size
```

Beyond `--version`, the two things worth exercising are a `Grep` (proves the
vendored `rg` was found) and reading an image (proves the vendored `sharp`
loaded — the tool result should carry an `Image: original …, displayed at …`
annotation). Both degrade silently, so neither shows up in a smoke test.

## Omarchy

Omarchy has its own pacman repository (OPR). Packages get there through a PR to
[`omacom-io/omarchy-pkgs`](https://github.com/omacom-io/omarchy-pkgs), which is
how `claude-code`, `openai-codex-bin` and `crush-bin` are packaged there — all
three as AUR mirrors.

An AUR mirror carries **no PKGBUILD of its own**: their `bin/add-package
claudin-bin --fast` writes the metadata and then syncs the PKGBUILD from the AUR,
recording the AUR commit it took in `upstream_commit`. So the only file this repo
keeps is the metadata it proposes:

```
packaging/omarchy/claudin-bin/.omarchy/package.json
```

`release_ring: fast` means the package also builds straight for the `stable`
channel instead of being promoted from `edge` — the ring the other AI CLIs there
use. It is the Omarchy maintainers' call, not ours, so treat it as a proposal.

The PR only makes sense once `claudin-bin` is live on the AUR. Until then — and
after, for anyone who prefers it — Omarchy users install straight from the AUR
with `omarchy pkg aur add claudin-bin`.
