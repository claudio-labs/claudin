# Cache progression (per-call) — 20260601-123013

Model: `claude-opus-4-8` · STRICT_MCP=1
Read file: `src/screens/REPL.tsx` · Edit file: `src/bridge/bridgeEnabled.ts`

Cache TTL is 1h on first-party. The per-call table is the signal:
a healthy cache shows the SAME cache_read at a fixed Call # across
invocations. The aggregate table varies with agent step count
(num_turns) and is kept only for reference.

## claudiodev

### Reads (3 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2 | 14786 | 12349 | 31 |
| 1 | 2 | 2 | 1109 | 27135 | 24 |
| 1 | 3 | 2 | 8836 | 28244 | 26 |
| 2 | 1 | 2 | 0 | 27135 | 37 |
| 2 | 2 | 2 | 1115 | 27135 | 28 |
| 2 | 3 | 2 | 8819 | 28250 | 1 |
| 3 | 1 | 2 | 0 | 27135 | 35 |
| 3 | 2 | 2 | 1113 | 27135 | 30 |
| 3 | 3 | 2 | 8862 | 28248 | 1 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 3 | 24731 | 67728 |
| 2 | 3 | 9934 | 82520 |
| 3 | 3 | 9975 | 82518 |

### Edits (2 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2 | 14825 | 12349 | 63 |
| 1 | 2 | 2 | 4240 | 27174 | 47 |
| 1 | 3 | 2 | 709 | 31414 | 2 |
| 2 | 1 | 2 | 0 | 27174 | 1 |
| 2 | 2 | 2 | 4247 | 27174 | 49 |
| 2 | 3 | 2 | 709 | 31421 | 4 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 3 | 19774 | 70937 |
| 2 | 3 | 4956 | 85769 |

