---
name: Launcher jemalloc LD_PRELOAD leaked to all child processes
description: bin/claudin heap-bump re-exec injects LD_PRELOAD=jemalloc; before 2026-06-11 fix it leaked to every spawned child — Chromium browsers segfault under it, silently breaking OAuth browser opening on Linux
type: project
---

`bin/claudin` re-execs node with `LD_PRELOAD=libjemalloc.so.2` (RSS tuning). LD_PRELOAD inherits to every child the REPL spawns (openBrowser, Bash tool commands, MCP servers). Chromium-based browsers (Brave 1.91 confirmed) SIGSEGV under jemalloc (crash in libjemalloc via glib `g_slice_free_chain_with_offset`), so every OAuth flow "didn't open the browser" — `coredumpctl list brave` showed one core per attempt.

**Why:** there is no per-process-only LD_PRELOAD; the fix (2026-06-11, bin/claudin) passes `_CLAUDIN_LD_PRELOAD_ORIG` through the re-exec and the child restores `process.env.LD_PRELOAD` immediately — jemalloc stays active for the node process (loaded at exec) but children get a clean env.

**How to apply:** `/proc/<pid>/environ` shows exec-time env, NOT the mutated process.env — verify the fix by spawning a child, not by reading environ. The published npm `claudin` release predating this fix still has the leak; workaround there is `CLAUDIN_MALLOC=default`. If a user reports "browser doesn't open" + Chromium browser + Linux, check `coredumpctl list <browser>` first.
