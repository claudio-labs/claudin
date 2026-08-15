# Cache progression — 20260601-114816

Model: claude-opus-4-8
Read file: `src/screens/REPL.tsx` (6 sequential turns, identical prompt)
Edit file: `src/bridge/bridgeEnabled.ts` (0 sequential turns, file reset between each)

Cache TTL is 5 min — turn 1 may be cold or warm depending on prior activity.
Look for: (a) does cache_read plateau? (b) does cache_write drop to ~0 after turn 1?

## claudiodev

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 6 | 23979 | 68135 | 587 | 0.2886 | 17554 |
| 2 | 6 | 10306 | 83123 | 658 | 0.1611 | 14250 |
| 3 | 4 | 1109 | 54672 | 485 | 0.0506 | 10744 |
| 4 | 6 | 9959 | 83116 | 585 | 0.1558 | 13333 |
| 5 | 6 | 9960 | 83118 | 543 | 0.1548 | 14951 |
| 6 | 6 | 9918 | 83119 | 604 | 0.1559 | 13531 |

### Edits (same file, reset+edit, 0×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|

