# Cache progression — 20260601-121200

Model: claude-opus-4-8
Read file: `src/screens/REPL.tsx` (6 sequential turns, identical prompt)
Edit file: `src/platform/bridge/bridgeEnabled.ts` (3 sequential turns, file reset between each)

Cache TTL is 5 min — turn 1 may be cold or warm depending on prior activity.
Look for: (a) does cache_read plateau? (b) does cache_write drop to ~0 after turn 1?

## claudiodev

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 6 | 24962 | 68239 | 582 | 0.2983 | 16452 |
| 2 | 6 | 9933 | 83273 | 587 | 0.1557 | 16485 |
| 3 | 6 | 9965 | 83277 | 557 | 0.1552 | 14859 |
| 4 | 4 | 0 | 55890 | 422 | 0.0385 | 11011 |
| 5 | 6 | 7043 | 84392 | 619 | 0.1281 | 14414 |
| 6 | 6 | 7881 | 84392 | 631 | 0.1368 | 12853 |

### Edits (same file, reset+edit, 3×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 6 | 20023 | 71440 | 358 | 0.2449 | 11774 |
| 2 | 6 | 0 | 91463 | 374 | 0.0551 | 13318 |
| 3 | 6 | 0 | 91463 | 361 | 0.0548 | 11157 |

## claude

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 3106 | 17299 | 107928 | 722 | 0.1962 | 16433 |
| 2 | 3106 | 9074 | 116164 | 693 | 0.1482 | 15184 |
| 3 | 627 | 2187 | 125542 | 739 | 0.0986 | 17288 |
| 4 | 4 | 28303 | 56022 | 533 | 0.2188 | 12115 |
| 5 | 629 | 8357 | 150268 | 943 | 0.1546 | 20658 |
| 6 | 629 | 8323 | 150203 | 868 | 0.1525 | 19775 |

### Edits (same file, reset+edit, 3×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 3104 | 15142 | 75047 | 296 | 0.1557 | 7944 |
| 2 | 3104 | 2981 | 79414 | 328 | 0.0826 | 10177 |
| 3 | 6 | 619 | 92668 | 296 | 0.0582 | 8253 |

