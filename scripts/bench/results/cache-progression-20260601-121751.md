# Cache progression — 20260601-121751

Model: claude-opus-4-8
Read file: `src/agent/repl/REPL.tsx` (6 sequential turns, identical prompt)
Edit file: `src/platform/bridge/bridgeEnabled.ts` (0 sequential turns, file reset between each)

Cache TTL is 5 min — turn 1 may be cold or warm depending on prior activity.
Look for: (a) does cache_read plateau? (b) does cache_write drop to ~0 after turn 1?

## claudiodev

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 0 | 0 | 0 | 0 | 0.0000 | 2490 |
| 2 | 0 | 0 | 0 | 0 | 0.0000 | 2356 |
| 3 | 0 | 0 | 0 | 0 | 0.0000 | 2539 |
| 4 | 0 | 0 | 0 | 0 | 0.0000 | 2428 |
| 5 | 0 | 0 | 0 | 0 | 0.0000 | 2483 |
| 6 | 0 | 0 | 0 | 0 | 0.0000 | 2169 |

### Edits (same file, reset+edit, 0×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|

