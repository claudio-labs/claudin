#!/bin/sh
# /usr/bin/claudin — entry point for the pacman-managed install.
#
# Two defaults, both overridable by the user's own environment:
#
#   CLAUDIN_SKIP_STARTUP_UPDATE  the startup notice checks npm for a newer
#                                version and tells the user to update through
#                                npm — wrong advice for a pacman install.
#   DISABLE_AUTOUPDATER          the auto-updater would try to write into
#                                /usr/lib/claudin, which pacman owns.
#
# `exec` keeps process.execPath pointing at the real binary, which is what the
# vendored ripgrep and sharp lookups resolve their sidecars against.
export CLAUDIN_SKIP_STARTUP_UPDATE="${CLAUDIN_SKIP_STARTUP_UPDATE:-1}"
export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"
exec /usr/lib/claudin/claudin "$@"
