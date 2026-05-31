# Bench A/B — steering anti-narracao

- Timestamp: 2026-05-30T00:14:04.428Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 2
- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)

## Tabela por invocacao

| Prompt | V | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 6 | 736 | 6318 | 4559 | 0.6761 | 69.3 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | 1 | Y | 4 | 481 | 5998 | 4095 | 1.0966 | 63.1 | 10 | Read=7 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 1 | Y | 13 | 1249 | 5495 | 6103 | 2.5365 | 104.3 | 25 | Read=19 Grep=2 Glob=3 Bash=0 |
| explain-auto-memory | B | 1 | Y | 2 | 128 | 9668 | 89813 | 5.6384 | 1042.6 | 46 | Read=34 Grep=1 Glob=3 Bash=6 other=1 |
| explain-openai-shim | A | 2 | Y | 5 | 440 | 5871 | 4159 | 0.6902 | 75.4 | 10 | Read=7 Grep=1 Glob=0 Bash=1 |
| explain-openai-shim | B | 2 | Y | 5 | 901 | 6049 | 4685 | 0.5523 | 67.6 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 2 | Y | 11 | 805 | 7396 | 7520 | 2.9070 | 126.3 | 24 | Read=18 Grep=2 Glob=3 Bash=0 |
| explain-auto-memory | B | 2 | Y | 8 | 796 | 5802 | 6009 | 2.7778 | 102.0 | 22 | Read=17 Grep=1 Glob=3 Bash=0 |

## Sumario

### A (baseline) (n=4)

- Avg narration blocks: 8.75
- Avg narration chars: 808
- Avg answer chars: 6270
- Avg output tokens: 5585
- Avg cost: $1.7024 (total $6.8098)
- Avg cache-creation tokens: 199410
- Avg turns: 17.8
- Tool totals: Read=53 Grep=5 Glob=8 Bash=1

### B (feature) (n=4)

- Avg narration blocks: 4.75
- Avg narration chars: 577
- Avg answer chars: 6879
- Avg output tokens: 26151
- Avg cost: $2.5163 (total $10.0651)
- Avg cache-creation tokens: 159711
- Avg turns: 22.5
- Tool totals: Read=67 Grep=2 Glob=10 Bash=6 other=1

### Delta

- Narration chars: 808 -> 577 (rel -28.6%)
- Narration blocks: 8.75 -> 4.75 (rel -45.7%)
- Output tokens: 5585 -> 26151 (rel 368.2%)
- Avg cost delta: 47.8%

### Kill criteria

- SHIP se B reduz narration chars em >=25% rel E answer chars nao cai >15% (resposta nao ficou pior) E cost nao piora >+5%.
- KILL se reducao de narration <25% rel (steering inerte — ver memorias de nudges inertes).
- INVESTIGAR se narration cai mas answer chars tambem despenca (modelo ficou mudo demais).

- Veredito: **INERT/REVERT**
  - narration chars delta: -28.6% (OK)
  - answer chars delta: 9.7% (OK)
  - cost delta: 47.8% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (6 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- Os arquivos mais relevantes para tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- The middle of messageConverter.ts (the tool_use → tool_calls logic) was truncated. Let me read it, plus the stream parser which handles the reverse direction.
- Preciso das seções centrais: a conversão `tool_use` → `tool_calls` em messageConverter e a remontagem de tool_calls no streamParser.
- Faltam ainda dois trechos centrais: o pré-scan de pares tool_use↔tool_result em messageConverter (150-319) e o loop de remontagem de tool_calls no streamParser (100-444).
- Falta o núcleo do streamParser: onde os deltas de `tool_calls` chegam e são acumulados (linhas ~150-394).

**Variant A run#2** (5 blocks):

- The directory exists. Let me read the most relevant files for tool call translation.
- I need the middle section where tool_use → tool_calls conversion happens.
- Now the tool_call mapping detail (lines 309-411) and the stream parser (response side).
- Now the response side — how OpenAI streaming `tool_calls` deltas are reassembled into Anthropic `tool_use` blocks.
- I need the core stream loop where tool_call deltas are processed (~lines 150-450).

**Variant B run#1** (4 blocks):

- The most relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`.
- I need the middle of messageConverter.ts (the tool_use → tool_calls emission) and the streamParser for the reverse direction.
- Now the tool_use→tool_calls context in messageConverter (lines ~270-320) and the streamParser's tool-call reassembly (the middle).
- Tenho o suficiente. Deixa eu ver o final do fechamento das tool calls (linhas 399-460) para fechar o ciclo.

**Variant B run#2** (5 blocks):

- The most relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- `messageConverter.ts` got truncated — I need the middle (the `convertMessages` core). Let me read that range plus the stream parser (the reverse direction).
- I need the core sections still hidden: the `tool_use → tool_calls` mapping in `messageConverter.ts` (lines ~100-368) and the streamed `tool_calls` reassembly in `streamParser.ts` (lines ~51-494).
- The two key middle sections are still hidden: `messageConverter.ts` 150-319 (the tool_use/tool_result pre-scan and assistant-message build) and `streamParser.ts` 101-444 (the tool_call reassembly loop
- The last hidden piece is the streamParser tool_call accumulation loop (lines ~151-394) — how OpenAI streamed `tool_calls` deltas get assembled into Anthropic `tool_use` content blocks.

### explain-auto-memory

**Variant A run#1** (13 blocks):

- Vou ler o código dos três módulos para descrever o fluxo de ponta a ponta.
- Vou ler os arquivos centrais de cada módulo.
- Vou ler o miolo de `memdir.ts` (construção do prompt) e os módulos de extração/sessão.
- Vou ver a estrutura de `memdir.ts` e ler os módulos de extração e sessão.
- Vou ler o miolo de `extractMemories.ts` (a lógica central) e os blocos-chave de `memdir.ts`.
- The summarizer keeps trimming the core. Let me read the central `runExtraction` logic and the `buildMemoryLines`/`buildMemoryPrompt` functions directly.
- O miolo de `runExtraction` (150-459) ainda está oculto. Vou lê-lo em pedaço menor.
- Vou ler a função `runExtraction` (327-459) e as funções de prompt em `memdir.ts`.
- Agora os módulos de leitura (recall) e SessionMemory. Vou ler `buildMemoryLines`/`buildMemoryPrompt`, `findRelevantMemories`, e `sessionMemory.ts`.
- Vou ver a estrutura de `sessionMemory.ts` e ler o módulo de recall (`findRelevantMemories`) e `memoryScan`.
- Vou rastrear quem chama `findRelevantMemories` e `loadMemoryPrompt`, e ler o núcleo do `extractSessionMemory`.
- Agora vou ler o recall-side (`utils/attachments/memory.ts`) e o núcleo de `extractSessionMemory` para fechar o fluxo.

**Variant A run#2** (11 blocks):

- Vou ler o código relevante. Começo mapeando os três diretórios em paralelo.
- Deixa eu ler os arquivos centrais de cada diretório.
- Vou ler o miolo do `memdir.ts` e os arquivos principais de extração e sessão.
- Agora os orquestradores centrais.
- Vou ler o miolo de `runExtraction` (347-531) e os hooks de gating.
- Vou ler o gate de permissão de tool, e os pontos de integração no REPL, mais o núcleo do SessionMemory.
- Agora os pontos de wiring no REPL e o núcleo de SessionMemory + recall.
- Vou ler o gatilho no stopHook, o attachment de recall, e o núcleo do SessionMemory.
- Agora o attachment de recall e o núcleo do SessionMemory.
- Vou ler o `extractSessionMemory`, sua inicialização, e onde é disparado.
- Vou confirmar onde fica o arquivo do SessionMemory e seu uso na compactação, mais o gatilho do attachment de recall.

**Variant B run#1** (2 blocks):

- Vou ler o código dos três módulos para descrever o fluxo de ponta a ponta.
- Os arquivos têm nomes diferentes. Vou ler os corretos.

**Variant B run#2** (8 blocks):

- Vou ler o código dessas três áreas para mapear o fluxo completo.
- Os arquivos vieram truncados no meio. Preciso das seções centrais que contêm a lógica de fato.
- O middle continua sendo cortado. Vou ler em blocos menores para forçar o conteúdo completo.
- Agora a leitura/recall e o scan. Vou ler os arquivos do lado de recall e o miolo do memdir.
- Agora o miolo do memdir.ts (build do prompt do system) e onde isso é injetado/chamado.
- Agora as integrações: onde `loadMemoryPrompt`, `findRelevantMemories` e `executeExtractMemories` são chamados, e o miolo do SessionMemory.
- Falta o miolo do SessionMemory (extração de fato) e o recall via attachments. Vou ler esses dois pontos.
- Tenho o quadro completo. Vou confirmar o gate principal de `loadMemoryPrompt` (linha 419+) e a chamada no stopHooks rapidamente.

