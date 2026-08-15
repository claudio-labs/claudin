# CLI token footprint — 20260601-111606

Workload: 10 read turns + 5 edit turns per CLI.
Model: claude-opus-4-8.

**Read files:**
- `src/agent/repl/REPL.tsx` (220K)
- `src/terminal/image/ansiToPng.ts` (212K)
- `src/platform/headless/print/runHeadless.ts` (160K)
- `src/platform/bridge/bridgeMain.ts` (112K)
- `src/platform/bash/ast.ts` (112K)
- `src/services/plugins/pluginLoader.ts` (112K)
- `src/terminal/prompt-input/PromptInput.tsx` (104K)
- `src/commands/insights.ts` (104K)
- `src/tools/BashTool/bashSecurity.ts` (104K)
- `src/platform/bridge/replBridge.ts` (96K)

**Edit files** (copied to scratch dir; real files untouched):
- `src/platform/bridge/bridgeEnabled.ts` (12K)
- `src/platform/bridge/bridgePointer.ts` (8.0K)
- `src/platform/bridge/bridgeStatusUtil.ts` (8.0K)
- `src/platform/bridge/createSession.ts` (16K)
- `src/platform/bridge/envLessBridgeConfig.ts` (8.0K)

## claudiodev

### Per-turn token usage (reads)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 92866 | 6 | 37219 | 55641 | 602 | 0.4151 | 15293 |
| ansiToPng.ts | 149183 | 10 | 24056 | 125117 | 715 | 0.3210 | 17468 |
| runHeadless.ts | 120778 | 8 | 24585 | 96185 | 680 | 0.3110 | 15586 |
| bridgeMain.ts | 133382 | 8 | 38189 | 95185 | 893 | 0.4518 | 18131 |
| ast.ts | 92691 | 6 | 23873 | 68812 | 510 | 0.2859 | 13546 |
| pluginLoader.ts | 55723 | 4 | 16098 | 39621 | 411 | 0.1911 | 8569 |
| PromptInput.tsx | 84067 | 6 | 16816 | 67245 | 547 | 0.2155 | 12518 |
| insights.ts | 86067 | 6 | 17810 | 68251 | 514 | 0.2251 | 13967 |
| bashSecurity.ts | 55999 | 4 | 16373 | 39622 | 352 | 0.1924 | 8234 |
| replBridge.ts | 132895 | 8 | 38239 | 94648 | 956 | 0.4537 | 22192 |
| **TOTAL reads** | **1003651** | 66 | 253258 | 750327 | 6180 | 3.0626 | |

### Per-turn token usage (edits)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| 00_bridgeEnabled.ts | 83191 | 6 | 15944 | 67241 | 403 | 0.2032 | 12905 |
| 01_bridgePointer.ts | 83405 | 6 | 16151 | 67248 | 411 | 0.2054 | 12805 |
| 02_bridgeStatusUtil.ts | 83050 | 6 | 15773 | 67271 | 378 | 0.2008 | 13243 |
| 03_createSession.ts | 83442 | 6 | 16133 | 67303 | 418 | 0.2055 | 12512 |
| 04_envLessBridgeConfig.ts | 83214 | 6 | 15937 | 67271 | 370 | 0.2023 | 11684 |
| **TOTAL edits** | **416302** | 30 | 79938 | 336334 | 1980 | 1.0172 | |

### GRAND TOTAL (reads + edits)

| | Sent | input | cache write | cache read | output | cost USD |
|-|-----:|------:|------------:|-----------:|-------:|---------:|
| **claudiodev** | **1419953** | 96 | 333196 | 1086661 | 8160 | **4.0798** |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 3.3k |
| System tools | 9k |
| MCP tools (deferred) | 1.3k |
| System tools (deferred) | 8.5k |
| Memory files | 9.7k |
| Skills | 416 |
| Messages | 8 |
| Free space | 144.6k |
| Autocompact buffer | 33k |
| **Active total (excl. free/buffer)** | **22424** |

## claude

### Per-turn token usage (reads)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| REPL.tsx | 138416 | 2233 | 83356 | 52827 | 443 | 0.5702 | 13512 |
| ansiToPng.ts | 111097 | 2233 | 9413 | 99451 | 425 | 0.1309 | 8613 |
| runHeadless.ts | 136501 | 2233 | 34816 | 99452 | 521 | 0.2921 | 11980 |
| bridgeMain.ts | 134608 | 2233 | 32923 | 99452 | 548 | 0.2809 | 11122 |
| ast.ts | 133703 | 2233 | 32020 | 99450 | 527 | 0.2747 | 9920 |
| pluginLoader.ts | 135429 | 2233 | 33741 | 99455 | 422 | 0.2828 | 11100 |
| PromptInput.tsx | 134510 | 2233 | 32821 | 99456 | 431 | 0.2773 | 9456 |
| insights.ts | 132407 | 2233 | 30727 | 99447 | 446 | 0.2646 | 11334 |
| bashSecurity.ts | 135113 | 2233 | 33424 | 99456 | 514 | 0.2832 | 11551 |
| replBridge.ts | 134891 | 2233 | 33208 | 99450 | 573 | 0.2833 | 11843 |
| **TOTAL reads** | **1326675** | 22330 | 356449 | 947896 | 4850 | 2.9400 | |

### Per-turn token usage (edits)

| File | Sent (in+cw+cr) | input | cache write | cache read | output | cost USD | ms |
|------|----------------:|------:|------------:|-----------:|-------:|---------:|---:|
| 00_bridgeEnabled.ts | 173781 | 2235 | 12852 | 158694 | 288 | 0.1786 | 8284 |
| 01_bridgePointer.ts | 166023 | 2235 | 8989 | 154799 | 340 | 0.1538 | 8803 |
| 02_bridgeStatusUtil.ts | 165955 | 2235 | 8943 | 154777 | 360 | 0.1540 | 8703 |
| 03_createSession.ts | 166032 | 2235 | 8990 | 154807 | 330 | 0.1536 | 8982 |
| 04_envLessBridgeConfig.ts | 166049 | 2235 | 8985 | 154829 | 310 | 0.1531 | 9005 |
| **TOTAL edits** | **837840** | 11175 | 48759 | 777906 | 1628 | 0.7931 | |

### GRAND TOTAL (reads + edits)

| | Sent | input | cache write | cache read | output | cost USD |
|-|-----:|------:|------------:|-----------:|-------:|---------:|
| **claude** | **2164515** | 33505 | 405208 | 1725802 | 6478 | **3.7331** |

### /context (static overhead, fresh session)

| Category | Tokens |
|----------|-------:|
| System prompt | 2.3k |
| System tools | 30.6k |
| MCP tools | 12.1k |
| Memory files | 5.8k |
| Skills | 1.8k |
| Messages | 8 |
| Free space | 947.4k |
| **Active total (excl. free/buffer)** | **52608** |

