# Python smart-router prototype (archived)

Five Python modules that sat at `python/` in the repo root until 2026-08-16.
They are **not** wired into anything: `smart_router.py` documents its entry
point as `from smart_router import SmartRouter` inside a `server.py` that does
not exist in this repository, and no TypeScript, script or workflow imports
them. Archived here rather than deleted so the design survives — the idea is
still legible and the code is short.

## What it was

A proxy-era design for provider selection, from before `/provider` existed:

- `smart_router.py` — pings every configured provider at startup, scores them by
  latency, cost and health, routes each request to the best one, falls back
  automatically on failure and learns from real request timings. Configured by
  `ROUTER_MODE`, `ROUTER_STRATEGY` (`latency` | `cost` | `balanced`) and
  `ROUTER_FALLBACK`.
- `ollama_provider.py`, `atomic_chat_provider.py` — the two provider adapters it
  routed between.
- `tests/` — pytest coverage for all three.

## What replaced it

Provider selection now lives in TypeScript and is user-driven rather than
automatic: `/provider` inside the REPL, with profiles persisted in
`~/.claudin/settings.json` and resolved by
`src/providers/presets/activeProvider.ts`. Health checks are `/provider doctor`.
There is no automatic scoring or failover — the cost-routing idea is item R1 of
the 2026-07 product roadmap, still unbuilt.

## If you revive it

It is Python 3 with `requirements.txt` beside it, and it expects an HTTP proxy
in front of the model APIs — an architecture this fork does not have. Treat it
as a specification, not as code to run.
