# Cache progression — 20260601-113003

Model: claude-opus-4-8
Read file: `src/screens/REPL.tsx` (6 sequential turns, identical prompt)
Edit file: `src/platform/bridge/bridgeEnabled.ts` (3 sequential turns, file reset between each)

Cache TTL is 5 min — turn 1 may be cold or warm depending on prior activity.
Look for: (a) does cache_read plateau? (b) does cache_write drop to ~0 after turn 1?

## claudiodev

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 6 | 24891 | 68080 | 542 | 0.2965 | 16734 |
| 2 | 4 | 1138 | 54620 | 532 | 0.0520 | 11481 |
| 3 | 6 | 8358 | 83043 | 541 | 0.1387 | 12509 |
| 4 | 6 | 9179 | 83063 | 674 | 0.1502 | 14468 |
| 5 | 4 | 1120 | 54620 | 468 | 0.0502 | 10347 |
| 6 | 6 | 8365 | 83040 | 583 | 0.1398 | 12470 |

### Edits (same file, reset+edit, 3×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 6 | 19927 | 71272 | 396 | 0.2448 | 13036 |
| 2 | 6 | 4928 | 86259 | 332 | 0.1007 | 12451 |
| 3 | 6 | 4933 | 86264 | 357 | 0.1014 | 12029 |

## claude

### Reads (same prompt, 6×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 2233 | 39059 | 97210 | 465 | 0.3160 | 10572 |
| 2 | 2233 | 30529 | 105742 | 510 | 0.2681 | 12356 |
| 3 | 4 | 0 | 138498 | 452 | 0.0811 | 15198 |
| 4 | 4 | 0 | 138498 | 522 | 0.0829 | 11685 |
| 5 | 4 | 0 | 138498 | 429 | 0.0805 | 11626 |
| 6 | 4 | 0 | 138500 | 536 | 0.0832 | 12188 |

### Edits (same file, reset+edit, 3×)

| Turn | input | cache_write | cache_read | output | cost USD | ms |
|-----:|------:|------------:|-----------:|-------:|---------:|---:|
| 1 | 2235 | 8947 | 154923 | 342 | 0.1537 | 8575 |
| 2 | 2235 | 0 | 163870 | 342 | 0.1022 | 15161 |
| 3 | 6 | 4396 | 169527 | 299 | 0.1203 | 9009 |

