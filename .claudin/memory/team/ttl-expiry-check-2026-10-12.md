---
name: ttl-expiry-check-2026-10-12
description: TTL-expiry check of the 13 sessions over 1h on 10-08..12 — no unexpected expiry; every main-thread write is 1h; 22 rewrites ~$83, only ~$18 TTL (idle >1h, sub-agents woken after 5m); the rest pre-PR-280 relief clips, two next-turn floors after a clip, one resume on a rebuilt binary
type: project
---

Asked 2026-10-12: "are long sessions re-creating the cache because it expires?" Answer: no
unexpected expiry. Method: every transcript over 1h (13; claudin, ferrous-dns, infra-home-lab),
main + `subagents/`, deduped by `message.id`. A rewrite = read ≥2k below the previous call's
read+write AND wrote ≥20k. Classified by gap and by the previous write's tier
(`cache_creation.ephemeral_1h/5m`). Prices are API list, premium = write − read.

- **Every main-thread write was 1h tier** (5m=0 on every call). The 1h TTL works.
- **Expected expiries, ~$18:** 6 main-thread rewrites after 1.5–9h idle ($15.7). 3 sub-agents
  woken by SendMessage 5–29 min after finishing ($2.1). Keep-alive only covers a RUNNING tool,
  so an idle agent's 5m prefix expiring is by design.
- **Labelled as TTL, but not TTL:** two floors in f46c4a97 after 9–17 min on a 1h prefix ($12.8)
  carry "possible 5min TTL expiry". The old detector assumed 5m. Current code passes the real
  TTL (`promptCacheBreakDetection.ts` ~935). Both landed on the first request of the next human
  turn after a relief-clip turn, with no process restart and the same thinking-drop set. This is
  the "one clip costs two rewrites" pattern from [[weekly-token-census-2026-10-09]], and its
  cause is **still unexplained**.
- **Biggest bucket, $45:** 8 relief clips in 85a6c4ac/f46c4a97, each rewriting 470–760k. The build
  those sessions ran predates PR 280: a "~4k" clip and repeated `relief starved` without a
  compaction only exist before it. No session since then has crossed ~735k, so the post-280
  behavior on 1M is still unexercised in real use.
- 111424f5 06:05Z: a resume 3 min after the turn, on a claudindev rebuilt at 05:54, read only
  9.9k, below the 12.7k system+tools floor ($5.9). Dogfooding artifact, not a §7 bug.

**How to apply:** before blaming TTL, check the previous write's tier. A "5min TTL" label on a
main thread from before the ttlMs fix is wrong. `lookback-miss-census.ts` covers main threads
only; it does not read `subagents/`.
