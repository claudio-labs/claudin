---
name: codex-cross-session-prefix-rejected
description: Sharing Claudin's prompt prefix across NEW sessions on the ChatGPT Codex backend (scratchpad line moved out of instructions, stable prompt_cache_key) was probed and NOT built on 2026-11-23 — same key + same prefix still missed 3 s apart
type: project
scope: providers/codex
impact: rejected
---

**Decision:** Claudin's first request in a new Codex session stays cold. The user stopped this part
on 2026-11-23, after the pre-registered gate failed.

**Why:** the 11-23 capture against Codex CLI 0.171 put the whole cache gap in the first request of each
session (Claudin 0 of 28k, Codex 72%). From the 2nd request on, Claudin led, 97% to 94%. Two candidate
fixes were probed with Claudin's real body (`scripts/bench/tokens/codex-shared-prefix-probe.ts`, N=1):
- moving the scratchpad line from `instructions` to an `input[0]` developer message;
- a stable `prompt_cache_key` instead of the session id.

Results:
- S1, the line moved, cold: 0%.
- S2, the same with a new session: 81% (20992/26027). A hit reads a checkpoint, not the whole prefix.
- S3 and S4, a stable key with the line moved, 3 s apart: 0% and 0%. The gate asked for ≥ 80%.
- S5, the stable key with the line left in `instructions`: 0%.
- The backend's routing is not something the request can steer, and a 1-sample win cannot be told from
  routing luck.
- Repeating the probe at N=3 would cost ~35% of a free plan's window, because cold requests are ~2.4%
  each.

Codex's 72% is a server-side warm prefix shared by every Codex CLI user. Claudin's prefix belongs to one
user and one project.

**What changes for a teammate:** nothing ships. Reopen it only with a lever the probe did not try, such
as a `session-id` header that stays stable across sessions (untested, and it changes WS continuity and
rate-limit signals), and with a budget for N ≥ 3.

**Evidence:** the probe's header (per-arm numbers), PR #362, the capture in [[codex-0.162-wire-diff]].
