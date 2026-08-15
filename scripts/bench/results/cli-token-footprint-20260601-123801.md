# CLI token footprint — 20260601-123801

Workload: 3 read turns + 2 edit turns per CLI.
Model: claude-opus-4-8.

**Read files:**
- `src/screens/REPL.tsx` (220K)
- `src/Tool.ts` (32K)
- `src/QueryEngine.ts` (48K)

**Edit files** (copied to scratch dir; real files untouched):
- `src/bridge/bridgeEnabled.ts` (12K)
- `src/services/api/betas.ts` (16K)

## claudiodev

### Per-turn token usage (reads)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 92781 | 6 | 24857 | 67918 | 741 | 0.3011 | 15587 |
| Tool.ts | 85229 | 6 | 17634 | 67589 | 506 | 0.2228 | 12499 |
| QueryEngine.ts | 91106 | 6 | 23341 | 67759 | 568 | 0.2815 | 14549 |
| **TOTAL reads** | **269116** | 18 | 65832 | 203266 | 1815 | 0.8054 | |

### Per-turn token usage (edits)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| 00_bridgeEnabled.ts | 90903 | 6 | 19841 | 71056 | 402 | 0.2440 | 13331 |
| 01_betas.ts | 83018 | 6 | 15936 | 67076 | 361 | 0.2020 | 11702 |
| **TOTAL edits** | **173921** | 12 | 35777 | 138132 | 763 | 0.4460 | |

### GRAND TOTAL (reads + edits)

| | Sent | input | cache write | cache read | output | cost USD |
|-|-----:|------:|------------:|-----------:|-------:|---------:|
| **claudiodev** | **443037** | 30 | 101609 | 341398 | 2578 | **1.2514** |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 3.5k |
| System tools | 9k |
| System tools (deferred) | 8.5k |
| Memory files | 9.7k |
| Skills | 416 |
| Messages | 8 |
| Free space | 144.3k |
| Autocompact buffer | 33k |
| **Active total (excl. free/buffer)** | **22624** |

## claude

### Per-turn token usage (reads)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 84119 | 2200 | 38914 | 43005 | 470 | 0.2880 | 11360 |
| Tool.ts | 70528 | 2200 | 25327 | 43001 | 442 | 0.2024 | 9113 |
| QueryEngine.ts | 77720 | 2200 | 32516 | 43004 | 426 | 0.2469 | 11038 |
| **TOTAL reads** | **232367** | 6600 | 96757 | 129010 | 1338 | 0.7373 | |

### Per-turn token usage (edits)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| 00_bridgeEnabled.ts | 84525 | 2202 | 11125 | 71198 | 303 | 0.1243 | 7306 |
| 01_betas.ts | 84395 | 2202 | 11057 | 71136 | 310 | 0.1240 | 7932 |
| **TOTAL edits** | **168920** | 4404 | 22182 | 142334 | 613 | 0.2483 | |

### GRAND TOTAL (reads + edits)

| | Sent | input | cache write | cache read | output | cost USD |
|-|-----:|------:|------------:|-----------:|-------:|---------:|
| **claude** | **401287** | 11004 | 118939 | 271344 | 1951 | **0.9856** |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 2.5k |
| System tools | 15.2k |
| System tools (deferred) | 11.7k |
| Memory files | 5.9k |
| Skills | 1.8k |
| Messages | 8 |
| Free space | 974.6k |
| **Active total (excl. free/buffer)** | **25408** |

