---
name: relief-starved-compacts-keepalive-default
description: Since 2026-10-09 (branch fix/cache-census-2026-10-09) a relief clip must free one band, a starved window lane compacts on the same request, forks never run relief, and the 5m-tier keep-alive is on by default — the census fixes for $592 of sub-agent expiries, $142+$68 of ~4k clips and 3 fork-clip floors
type: project
scope: src/agent/compact/microCompact.ts, src/agent/compact/reliefPolicy.ts, src/agent/compact/autoCompact.ts, src/agent/cache/anthropic/keepAlive.ts
impact: functional
---

**Decision (user, 2026-10-09):** four changes from [[weekly-token-census-2026-10-09]].
- **Keep-alive on by default.** Only the 5m tier is pinged, so in practice it covers sub-agents;
  the 1h main thread is untouched. `CLAUDIN_CACHE_KEEPALIVE=0` turns it off. The user accepted
  that nobody knows yet how the subscription quota weighs a ping.
- **A starved relief lane compacts.** The user picked this over keeping 967k or setting a fixed
  lower ceiling. `CLAUDIN_RELIEF_STARVED_COMPACT=0` turns it off. On 1M a starved session
  compacts at ~735k instead of 967k; on 200k, at ~135k instead of 167k.
- **A clip must free one band.** `reliefEventFloor` = max(4k, trigger − target), replacing the
  flat 4k floor.
- **Only the prefix owner runs relief.** `ownsItsPrefix` allows the main thread, `sdk` and fresh
  `agent:*`. Forks are excluded because they share the parent's ids and its clipped set.

**Why:**
- Sub-agents left 400 prefixes to expire behind foreground waits: $592 in a week.
- 18 clips of ~4k each rewrote ~800k on a 1M main thread ($142). Most were followed by a floor
  rewrite on the next turn ($68).
- An `extract_memories` fork clip stubbed main's next request three times, unannounced ($22).

**What changes for a teammate:**
- Long 1M sessions now compact.
- The `[Cache:]` line shows `relief starved` and then a compaction where it used to show a run of
  `relief clip`s.
- A sub-agent waiting more than 5 minutes sends one ping every 4m30s, visible in the debug log as
  `[cache keep-alive] <agentId>`.

**Rejected:**
- Refusing long foreground waits inside sub-agents. It would reverse the 09-24 advisory-Bash
  decision and depends on the model obeying.
- "Clip only if the clip reaches the target, otherwise compact". Real-vs-estimate unit noise
  would compact on a clip 2% short of the target.

**Evidence:**
- Break-probe spec `scripts/migrations/probes/cacheCensus20261009.json`: 16 probes red, the
  control green.
- `relief-ceiling-sim.ts --main --session=ed9c2e1c`: one compaction, net reads saved $24 → $66,
  an upper bound.
- Live on Opus 5.5 (2026-10-09):
  - Main thread at 5m: with the keep-alive the prefix survived a 6-min pause; the session cost
    $0.57, against $0.94 with `=0`.
  - Sub-agent with a 6-min foreground wait (`--debug`): the ping read 33.9k for $0.007, and the
    next call read the prefix back.
  - Starved escalation with `CLAUDIN_AUTO_COMPACT_WINDOW=200000`: compacted at 147.8k, against
    168.4k with `=0`.
  - `ttl-wait-probe.ts`'s proxy drops the non-streaming ping. That is a gap in the probe, not
    in the keep-alive; its header has the details.
