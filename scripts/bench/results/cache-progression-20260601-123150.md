# Cache progression (per-call) — 20260601-123150

Model: `claude-opus-4-8` · STRICT_MCP=1
Read file: `src/screens/REPL.tsx` · Edit file: `src/bridge/bridgeEnabled.ts`

Cache TTL is 1h on first-party. The per-call table is the signal:
a healthy cache shows the SAME cache_read at a fixed Call # across
invocations. The aggregate table varies with agent step count
(num_turns) and is kept only for reference.

## claudiodev

### Reads (5 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2 | 14812 | 12349 | 39 |
| 1 | 2 | 2 | 1109 | 27161 | 31 |
| 1 | 3 | 2 | 7688 | 28270 | 1 |
| 2 | 1 | 2 | 0 | 27161 | 51 |
| 2 | 2 | 2 | 1113 | 27161 | 54 |
| 2 | 3 | 2 | 8843 | 28274 | 28 |
| 3 | 1 | 2 | 0 | 27161 | 37 |
| 3 | 2 | 2 | 1107 | 27161 | 36 |
| 3 | 3 | 2 | 8853 | 28268 | 35 |
| 4 | 1 | 2 | 0 | 27161 | 22 |
| 4 | 2 | 2 | 1111 | 27161 | 31 |
| 4 | 3 | 2 | 8829 | 28272 | 1 |
| 5 | 1 | 2 | 0 | 27161 | 47 |
| 5 | 2 | 2 | 1125 | 27161 | 32 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 3 | 23609 | 67780 |
| 2 | 3 | 9956 | 82596 |
| 3 | 3 | 9960 | 82590 |
| 4 | 3 | 9940 | 82594 |
| 5 | 2 | 1125 | 54322 |

### Edits (3 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2 | 14854 | 12349 | 62 |
| 1 | 2 | 2 | 4243 | 27203 | 47 |
| 1 | 3 | 2 | 715 | 31446 | 2 |
| 2 | 1 | 2 | 0 | 27203 | 62 |
| 2 | 2 | 2 | 0 | 31446 | 47 |
| 2 | 3 | 2 | 0 | 32161 | 2 |
| 3 | 1 | 2 | 0 | 27203 | 52 |
| 3 | 2 | 2 | 0 | 31446 | 47 |
| 3 | 3 | 2 | 0 | 32161 | 2 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 3 | 19812 | 70998 |
| 2 | 3 | 0 | 90810 |
| 3 | 3 | 0 | 90810 |

## claude

### Reads (5 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2198 | 8307 | 17303 | 3 |
| 1 | 2 | 2 | 30499 | 25610 | 4 |
| 2 | 1 | 2198 | 0 | 25610 | 4 |
| 2 | 2 | 2 | 30496 | 25610 | 5 |
| 3 | 1 | 2 | 0 | 27806 | 1 |
| 3 | 2 | 2 | 0 | 56106 | 2 |
| 4 | 1 | 2 | 0 | 27806 | 1 |
| 4 | 2 | 2 | 0 | 56106 | 4 |
| 5 | 1 | 2 | 0 | 27806 | 1 |
| 5 | 2 | 2 | 0 | 56106 | 4 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 2 | 38806 | 42913 |
| 2 | 2 | 30496 | 51220 |
| 3 | 2 | 0 | 83912 |
| 4 | 2 | 0 | 83912 |
| 5 | 2 | 0 | 83912 |

### Edits (3 invocations, same prompt)

Per-API-call (compare cache_read down a fixed Call # — stable = healthy):

| Inv | Call | input | cache_write | cache_read | output |
|----:|-----:|------:|------------:|-----------:|-------:|
| 1 | 1 | 2198 | 8346 | 17303 | 3 |
| 1 | 2 | 2 | 6333 | 25649 | 49 |
| 1 | 3 | 2 | 276 | 31982 | 2 |
| 2 | 1 | 2198 | 0 | 25649 | 3 |
| 2 | 2 | 2 | 2382 | 25649 | 73 |
| 2 | 3 | 2 | 276 | 28031 | 2 |
| 3 | 1 | 2 | 0 | 27845 | 2 |
| 3 | 2 | 2 | 246 | 27845 | 73 |
| 3 | 3 | 2 | 276 | 28091 | 2 |

Aggregate per invocation (what the old per-invocation view showed):

| Inv | num_turns | agg cache_write | agg cache_read |
|----:|----------:|----------------:|---------------:|
| 1 | 3 | 14955 | 74934 |
| 2 | 3 | 2658 | 79329 |
| 3 | 3 | 522 | 83781 |

