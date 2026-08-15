# CLI token footprint — 20260531-174145

Workload: read + 3-sentence summary, one turn per file.
Model: each CLI default. Files:
- `src/agent/repl/REPL.tsx` (220K)
- `src/terminal/image/ansiToPng.ts` (212K)
- `src/platform/headless/print/runHeadless.ts` (160K)

## claudiodev

### Per-turn token usage

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 101646 | 4 | 51377 | 50265 | 408 | 0.3565 | 9796 |
| ansiToPng.ts | 258038 | 10 | 24847 | 233181 | 771 | 0.2912 | 17527 |
| runHeadless.ts | 161084 | 2590 | 28968 | 129526 | 2756 | 0.3277 | 38928 |
| **TOTAL** | **520768** | 2604 | 105192 | 412972 | 3935 | 0.9753 | |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 6.8k |
| System tools | 20.8k |
| MCP tools | 1.7k |
| Memory files | 17.1k |
| Skills | 416 |
| Messages | 13 |
| Free space | 120.2k |
| Autocompact buffer | 33k |
| **Active total (excl. free/buffer)** | **46829** |

## claude

### Per-turn token usage

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 83827 | 2335 | 38763 | 42729 | 528 | 0.2890 | 11450 |
| ansiToPng.ts | 86266 | 3094 | 11710 | 71462 | 618 | 0.1404 | 12412 |
| runHeadless.ts | 81893 | 2335 | 36826 | 42732 | 482 | 0.2758 | 9546 |
| **TOTAL** | **251986** | 7764 | 87299 | 156923 | 1628 | 0.7052 | |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 2.3k |
| System tools | 15.2k |
| System tools (deferred) | 11.2k |
| Memory files | 5.8k |
| Skills | 1.8k |
| Messages | 8 |
| Free space | 974.9k |
| **Active total (excl. free/buffer)** | **36308** |

