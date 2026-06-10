# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-06-10T17:58:58.606Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudin/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudin/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 579 | 5882 | 0.00 | 0 | 4748 | 0.9389 | 85.4 | 12 | Read=7 Grep=3 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 1 | Y | 421 | 6316 | 0.00 | 0 | 4132 | 0.4997 | 58.9 | 10 | Read=8 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 1 | Y | 0 | 5553 | 0.00 | 1 | 14999 | 1.5966 | 193.1 | 3 | Read=0 Grep=1 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 1 | Y | 0 | 5499 | 0.00 | 0 | 7236 | 0.9886 | 103.2 | 21 | Read=17 Grep=2 Glob=0 Bash=1 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 0 | 3514 | 0.00 | 0 | 2053 | 0.4327 | 30.9 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 0 | 3674 | 0.00 | 0 | 2109 | 0.2967 | 31.1 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 0 | 5887 | 0.00 | 0 | 3638 | 0.4335 | 55.8 | 8 | Read=6 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 2 | Y | 0 | 5052 | 0.00 | 0 | 3532 | 0.4626 | 55.2 | 10 | Read=7 Grep=1 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 2 | Y | 0 | 4589 | 0.00 | 1 | 14682 | 1.6753 | 197.1 | 7 | Read=4 Grep=1 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 2 | Y | 0 | 5684 | 0.00 | 0 | 5722 | 0.8208 | 84.0 | 21 | Read=15 Grep=4 Glob=0 Bash=1 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 0 | 4102 | 0.00 | 0 | 2298 | 0.3017 | 32.8 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 0 | 3801 | 0.00 | 0 | 2196 | 0.2993 | 31.4 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 172 | 5330 | 0.00 | 0 | 4284 | 0.5665 | 70.4 | 13 | Read=9 Grep=2 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 3 | Y | 509 | 6517 | 0.00 | 0 | 4131 | 0.5101 | 65.9 | 10 | Read=8 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 3 | Y | 241 | 6192 | 0.00 | 0 | 6212 | 0.8629 | 87.5 | 22 | Read=17 Grep=2 Glob=0 Bash=2 Agent=0 |
| explain-auto-memory | B | 3 | Y | 0 | 9982 | 0.00 | 1 | 19252 | 2.1892 | 251.8 | 5 | Read=3 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-provider-resolution | A | 3 | Y | 0 | 3784 | 0.00 | 0 | 2216 | 0.3001 | 31.3 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 0 | 3792 | 0.00 | 0 | 2200 | 0.2994 | 30.7 | 4 | Read=3 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=9)

- Avg narration chars: 110
- Avg answer chars: 4981
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.22
- Avg output tokens: 6126
- Avg cost: $0.7898 (total $7.1082)
- Avg wall: 87.1s
- Avg turns: 8.6
- Tool totals: Read=52 Grep=9 Glob=0 Bash=5 Agent=2

### B (feature) (n=9)

- Avg narration chars: 103
- Avg answer chars: 5591
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.11
- Avg output tokens: 5612
- Avg cost: $0.7074 (total $6.3663)
- Avg wall: 79.1s
- Avg turns: 9.9
- Tool totals: Read=67 Grep=7 Glob=0 Bash=5 Agent=1

### Delta

- Narration chars: 110 -> 103 (rel -6.3%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.22 -> 0.11
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: 12.2%
- Cost delta: -10.4%
- Wall delta: -9.2%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: -6.3% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: 12.2% (OK)
  - cost: -10.4% (OK)
  - wall: -9.2% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (4 blocks):

- The directory is split into modules. Let me read the ones most relevant to tool-call translation.
- Now let me read the message converter and stream parser, which handle the request-direction (tool_use/tool_result) and response-direction (tool_calls) translation.
- The real per-message assembly (tool_use → `tool_calls`, tool_result → `role:"tool"`) must be in messagesClient.ts. Let me find those plus the response-direction parsing in streamParser.ts.
- Now the response-direction parsing in streamParser.ts and the non-stream path in messagesClient.ts. Let me read those key sections.

**Variant A run#3** (2 blocks):

- Now the response side — how OpenAI `tool_calls` deltas are reassembled back into Anthropic `tool_use` blocks:
- Let me read the streaming tool-call reassembly logic in detail:

**Variant B run#1** (3 blocks):

- The relevant files are `messageConverter.ts`, `toolConverter.ts`, and `streamParser.ts` (for the response side). Let me read them.
- Let me read the key symbols: the request-side conversion in `messageConverter.ts` (especially tool_use/tool_result handling) and the response-side parsing in `streamParser.ts`.
- Let me read the full `convertMessages` body where tool_use → `tool_calls` and tool_result → `role: "tool"` happens.

**Variant B run#3** (4 blocks):

- The directory is split into modules. Let me read the ones directly involved in tool-call translation, in both directions.
- The tool-call translation spans two directions. Let me read the request-side symbols and the response-side stream parser.
- The `convertMessages` body was truncated. Let me read the full body and the stream parser (reverse direction: OpenAI → Anthropic).
- The reverse direction (OpenAI stream → Anthropic events) is in `openaiStreamToAnthropic`. Let me read the tool-call accumulation portion.

### explain-auto-memory

**Variant A run#3** (2 blocks):

- Agora vou ler os pontos-chave: `initExtractMemories` e `loadMemoryPrompt`, mais a orquestração de SessionMemory.
- Vou confirmar onde esses hooks são acionados no loop e como os dois subsistemas (extractMemories vs SessionMemory) se relacionam.

### explain-provider-resolution

