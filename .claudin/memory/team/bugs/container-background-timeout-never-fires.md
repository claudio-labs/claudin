---
name: container-background-timeout-never-fires
description: ContainerTool's background build/logs pass a wall timeout to exec that background() clears, so a backgrounded docker op never times out — the mechanism a red test proved for Monitor on 2026-11-01; not fixed
type: project
---

**Symptom:** a backgrounded ContainerTool op (`docker build`, `docker logs -f`) runs past its
`timeout` (default `DEFAULT_WALL_TIMEOUT_MS`) with no kill and no notice.

**Where:** `spawnBackground` in `src/tools/ContainerTool/run.ts` hands `timeout` to `exec`, then
`spawnShellTask` calls `shellCommand.background()`, whose `#cleanupListeners` clears that timer
(`src/shared/proc/ShellCommand.ts`, `background()` → `#cleanupListeners`).

**Evidence:** by reading. The same path made Monitor's 30-minute timeout dead; the red test
`MonitorTool.call > timeout_ms kills the monitor and says it expired` proved it before Monitor got
its own deadline in `monitorStream.ts` (branch `fix/tool-texts-match-tools`).

**Status:** open (2026-11-01). Found while fixing Monitor, out of that PR's scope. A fix must not
reuse `monitorStream` as is: it streams output lines, which a docker build would flood — only the
deadline part applies.
