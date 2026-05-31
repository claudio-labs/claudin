# Bench A/B — steering anti-narracao

- Timestamp: 2026-05-30T00:30:58.658Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 2
- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)

## Tabela por invocacao

| Prompt | V | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 6 | 649 | 6321 | 4571 | 0.6918 | 71.4 | 10 | Read=7 Grep=1 Glob=0 Bash=1 |
| explain-openai-shim | B | 1 | Y | 6 | 799 | 6103 | 4961 | 1.9851 | 82.2 | 13 | Read=10 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 1 | Y | 5 | 551 | 6180 | 5772 | 1.4254 | 87.8 | 18 | Read=15 Grep=1 Glob=0 Bash=1 |
| explain-auto-memory | B | 1 | Y | 7 | 778 | 6293 | 6067 | 2.0842 | 99.4 | 22 | Read=17 Grep=3 Glob=0 Bash=1 |
| explain-openai-shim | A | 2 | Y | 7 | 1037 | 6524 | 5120 | 0.8696 | 82.9 | 13 | Read=10 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | 2 | Y | 6 | 659 | 6008 | 4482 | 0.9497 | 69.3 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 2 | Y | 7 | 736 | 7395 | 6095 | 1.6642 | 97.1 | 20 | Read=12 Grep=4 Glob=3 Bash=0 |
| explain-auto-memory | B | 2 | Y | 8 | 661 | 7047 | 6342 | 2.7696 | 101.9 | 20 | Read=12 Grep=4 Glob=3 Bash=0 |

## Sumario

### A (baseline) (n=4)

- Avg narration blocks: 6.25
- Avg narration chars: 743
- Avg answer chars: 6605
- Avg output tokens: 5390
- Avg cost: $1.1628 (total $4.6510)
- Avg cache-creation tokens: 122425
- Avg turns: 15.3
- Tool totals: Read=44 Grep=6 Glob=5 Bash=2

### B (feature) (n=4)

- Avg narration blocks: 6.75
- Avg narration chars: 724
- Avg answer chars: 6363
- Avg output tokens: 5463
- Avg cost: $1.9471 (total $7.7886)
- Avg cache-creation tokens: 150472
- Avg turns: 16.8
- Tool totals: Read=48 Grep=7 Glob=7 Bash=1

### Delta

- Narration chars: 743 -> 724 (rel -2.6%)
- Narration blocks: 6.25 -> 6.75 (rel 8.0%)
- Output tokens: 5390 -> 5463 (rel 1.4%)
- Avg cost delta: 67.5%

### Kill criteria

- SHIP se B reduz narration chars em >=25% rel E answer chars nao cai >15% (resposta nao ficou pior) E cost nao piora >+5%.
- KILL se reducao de narration <25% rel (steering inerte — ver memorias de nudges inertes).
- INVESTIGAR se narration cai mas answer chars tambem despenca (modelo ficou mudo demais).

- Veredito: **INERT/REVERT**
  - narration chars delta: -2.6% (fail)
  - answer chars delta: -3.7% (OK)
  - cost delta: 67.5% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (6 blocks):

- There's a directory now. The tool-call-relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Let me read the omitted middle of messageConverter.ts (the core tool_use ↔ tool_result handling) and the streamParser.
- I need the core section (lines 100-360) where tool_use → tool_calls mapping happens. Let me read it precisely.
- Need lines 150-310 — the pre-scan and tool_result emission logic.
- Now the streamParser — the reverse direction (OpenAI tool_calls deltas → Anthropic tool_use blocks).
- The core streaming tool-call reassembly is in the omitted middle. Let me read the tool_call delta handling section.

**Variant A run#2** (7 blocks):

- Vou localizar os arquivos do shim primeiro.
- Há um diretório `openaiShim/`. Os arquivos relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- O `messageConverter.ts` foi truncado no meio — preciso ver `convertMessages` (a parte central da tradução tool_use → tool_calls). E o `streamParser.ts` para o caminho de volta (resposta OpenAI → bloco
- I need the core middle sections of both files: the tool_use→tool_calls emission in `convertMessages` (lines ~100-364) and the tool_call assembly logic in the stream parser (lines ~51-494).
- Falta o núcleo de ambos: o pré-scan e emissão de tool_use/tool_result (messageConverter 150-315) e a montagem incremental dos tool_calls no streaming (streamParser 101-444).
- The remaining gap is the live tool_call accumulation loop in the stream parser (lines ~151-394) — how `activeToolCalls` is populated from streamed deltas.
- Falta apenas o trecho onde os deltas de `tool_calls` chegam e populam `activeToolCalls` (linhas ~201-344).

**Variant B run#1** (6 blocks):

- The most relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- The middle of `messageConverter.ts` (the heavy `convertMessages` pass) was elided. Let me read it plus the stream parser (reverse direction).
- I need the middle of both files: the `tool_use → tool_calls` emission in `messageConverter.ts` (lines 100-365) and the tool-call delta reassembly in `streamParser.ts` (lines 51-494).
- Still need the core loop of `streamParser.ts` (tool_call delta reassembly) and the `convertMessages` tool_use detection block (lines 150-314).
- I have the outbound path fully. Need the inbound SSE loop where tool_call deltas are reassembled (streamParser 150-394).
- The core SSE chunk-parsing block (200-344) where tool_call deltas are first registered is still elided.

**Variant B run#2** (6 blocks):

- Vou localizar os arquivos do shim primeiro.
- The directory exists. Let me read the key files for tool call translation.
- O miolo do `messageConverter` (linhas 51–411) é onde mora a conversão de tool_use/tool_result. Vou lê-lo junto do streamParser (direção inversa).
- Preciso do núcleo de ambos: a emissão de `tool_calls` no request (msgConverter 101–360) e a reassembly no streaming (streamParser 51–340).
- Faltam dois trechos-chave: o pre-scan tool_use↔tool_result (msgConverter 151–320) e a finalização de argumentos no finish_reason (streamParser 350–494).
- Falta o trecho de finalização (finish_reason → flush dos argumentos do tool_call) no streamParser, 350–494.

### explain-auto-memory

**Variant A run#1** (5 blocks):

- Vou ler o código relevante. Começando pela estrutura das três áreas.
- Vou ler as partes centrais que foram omitidas — a lógica de montagem do prompt em memdir.ts, o fork de extração, e o scan/recall.
- Vou ler o miolo da extração (o fork do agente, prompt e limiares) e o scan/recall.
- Vou mapear os pontos de injeção (onde o prompt é montado, onde o recall é consumido, e como a SessionMemory dispara).
- Agora vou ver os pontos de injeção que ligam tudo: a montagem no system prompt (prompts.ts), o recall via attachment (memory.ts), e o disparo no stopHooks.

**Variant A run#2** (7 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais de cada área.
- Os arquivos são grandes e foram truncados. Vou ler as seções centrais que ficaram de fora.
- Agora vou ler o `findRelevantMemories.ts` e a parte central do `memdir.ts` (construção do prompt) que ficou de fora.
- Tenho um quadro claro. Deixa eu confirmar onde a recall (`findRelevantMemories`) é chamada e onde os hooks são registrados, para fechar o fluxo de ponta a ponta.
- Deixa eu ver os dois pontos de wiring: o stopHooks (que dispara extractMemories) e o attachment de recall (`src/utils/attachments/memory.ts`).
- Vou ler a seção do `memory.ts` onde `findRelevantMemories` é invocado para montar o attachment de recall.

**Variant B run#1** (7 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Vou ler os trechos centrais omitidos e os outros módulos.
- Now let me read the SessionMemory module and the findRelevantMemories + memoryScan for the read-side, plus the stopHooks wiring.
- Let me read the SessionMemory core logic, memoryScan, and find the wiring points for read-side injection and extraction triggering.
- Now let me find where these are wired: where `findRelevantMemories` is invoked at query time, and where `executeExtractMemories` is triggered in stopHooks.
- The read-side recall lives in `src/utils/attachments/memory.ts` and `src/query/stopHooks.ts` triggers extraction. Let me read both.
- Let me read the recall logic in the middle of memory.ts (the `relevant_memories` attachment builder).

**Variant B run#2** (8 blocks):

- Vou explorar os três módulos para traçar o fluxo de ponta a ponta.
- The summarizer keeps eliding the core. Let me read the heart of each file in narrower windows.
- Now the memdir system-prompt injection and the supporting scanners.
- Now the trigger point (stopHooks) and the relevance scanner.
- Now the trigger wiring (stopHooks) and where findRelevantMemories gets surfaced (the attachment).
- Now the relevant-memories attachment builder and SessionMemory's scheduling core.
- Now the SessionMemory hook registration/extraction core and the relevant-memories attachment builder.
- I have the full picture. Let me confirm where SessionMemory writes (distinct from auto-memory).

