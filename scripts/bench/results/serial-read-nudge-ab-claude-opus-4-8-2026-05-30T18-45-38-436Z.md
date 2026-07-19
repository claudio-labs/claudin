# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T18:45:38.436Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/dev/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | N | 557 | 308 | 0.00 | 1 | 69205 | 4.3255 | 670.5 | 33 | Read=24 Grep=5 Glob=2 Bash=0 Agent=1 |
| explain-openai-shim | B | 1 | N | 258 | 308 | 0.00 | 0 | 33248 | 1.3568 | 377.4 | 53 | Read=31 Grep=7 Glob=0 Bash=14 Agent=0 |
| explain-auto-memory | A | 1 | Y | 282 | 7805 | 0.00 | 1 | 90916 | 5.7139 | 1250.8 | 43 | Read=13 Grep=10 Glob=3 Bash=15 Agent=1 |
| explain-auto-memory | B | 1 | Y | 482 | 5289 | 0.00 | 0 | 6236 | 1.8840 | 93.2 | 22 | Read=17 Grep=3 Glob=0 Bash=1 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 158 | 3602 | 0.00 | 0 | 2323 | 0.3579 | 39.6 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 199 | 3777 | 0.00 | 0 | 2325 | 0.2253 | 36.6 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 1099 | 4496 | 0.00 | 0 | 4394 | 1.5452 | 73.4 | 15 | Read=10 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 2 | Y | 867 | 5652 | 0.00 | 0 | 5110 | 1.3263 | 76.8 | 15 | Read=10 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 2 | Y | 614 | 6149 | 0.00 | 0 | 6305 | 1.7676 | 94.3 | 22 | Read=15 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | Y | 850 | 6196 | 0.00 | 0 | 6886 | 2.1629 | 107.3 | 25 | Read=17 Grep=4 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 0 | 3626 | 0.00 | 0 | 2220 | 0.3813 | 35.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | N | 119 | 308 | 0.00 | 0 | 10383 | 0.5816 | 132.8 | 25 | Read=8 Grep=5 Glob=3 Bash=8 Agent=0 |
| explain-openai-shim | A | 3 | Y | 683 | 5468 | 0.00 | 0 | 4446 | 1.1578 | 74.6 | 13 | Read=8 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 3 | Y | 994 | 5262 | 0.00 | 0 | 4969 | 1.0974 | 73.8 | 16 | Read=13 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 3 | Y | 543 | 5972 | 0.00 | 0 | 5975 | 1.7947 | 87.3 | 20 | Read=14 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | N | 331 | 309 | 0.00 | 0 | 32892 | 1.7708 | 358.8 | 64 | Read=38 Grep=20 Glob=3 Bash=0 Agent=0 other=2 |
| explain-provider-resolution | A | 3 | Y | 202 | 3729 | 0.00 | 0 | 2406 | 0.3878 | 37.0 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 0 | 3601 | 0.00 | 0 | 2246 | 0.2500 | 40.4 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=8)

- Avg narration chars: 448
- Avg answer chars: 5106
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.13
- Avg output tokens: 14873
- Avg cost: $1.6383 (total $13.1062)
- Avg wall: 211.6s
- Avg turns: 16.0
- Tool totals: Read=72 Grep=19 Glob=13 Bash=15 Agent=1

### B (feature) (n=6)

- Avg narration chars: 565
- Avg answer chars: 4963
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 4629
- Avg cost: $1.1576 (total $6.9458)
- Avg wall: 71.4s
- Avg turns: 14.7
- Tool totals: Read=65 Grep=9 Glob=7 Bash=1 Agent=0

### Delta

- Narration chars: 448 -> 565 (rel 26.3%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.13 -> 0.00
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: -2.8%
- Cost delta: -29.3%
- Wall delta: -66.3%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: 26.3% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: -2.8% (OK)
  - cost: -29.3% (OK)
  - wall: -66.3% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#2** (7 blocks):

- Há tanto `openaiShim.ts` quanto o diretório `openaiShim/`. Os arquivos mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- I'll read the full messageConverter and the stream parser to understand both directions (request and response).
- The middle of `convertMessages` (the tool_use → tool_calls emission) got elided. Let me read that range plus the stream parser's tool-call assembly.
- Os trechos centrais — a emissão `tool_use → tool_calls` (linhas ~165-360) e a montagem incremental de tool calls no parser (linhas ~137-486) — continuam elididos. Vou ler exatamente esses intervalos.
- The streaming tool-call assembly (lines 187-436) is still elided — that's where incoming OpenAI tool_call deltas get reassembled into Anthropic blocks. Let me read it.
- The core delta-accumulation loop (lines 237-386) is still elided. That's the part that handles incoming `delta.tool_calls`. Let me read it.
- Tenho o quadro completo das duas direções. Deixa eu confirmar o `normalizeToolArguments`/`hasToolFieldMapping` (o "field mapping") em helpers.

**Variant A run#3** (6 blocks):

- Vou localizar e ler os arquivos relevantes do shim.
- The most relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Now let me read the message-converter functions and the stream-parser body that handle tool calls/results.
- Let me read the omitted stream-parser middle (tool-call start) and the `convertMessages` body.
- The core of the request→response tool conversion is in the omitted middle of `convertMessages` (215–411). Let me read it.
- I have the complete picture across the three layers. Let me quickly confirm what `normalizeAtStop`/`hasToolFieldMapping` does, since it affects how streamed args are emitted.

**Variant B run#2** (7 blocks):

- Vou localizar e ler os arquivos relevantes do shim.
- Há um diretório e um arquivo. Os mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou ler em paralelo.
- I'll read the relevant symbols: the message conversion functions and the stream parser body.
- O miolo do stream parser (137-486) é onde a tradução inbound de tool_calls acontece. Vou ler esse trecho e localizar onde o `tool_use` outbound vira `tool_calls`.
- Falta o trecho central do stream parser (187-436, onde os deltas de tool_call são montados) e o caminho outbound (assistant `tool_use` → `tool_calls`). Vou ler o miolo do parser e procurar o outbound.
- The key outbound path is `convertContentBlocks`'s sibling in messageConverter (lines 253-371). Let me read that region.
- The middle (215-410) holds the core outbound mapping. Let me read it precisely.

**Variant B run#3** (7 blocks):

- Vou localizar os arquivos relevantes do openaiShim.
- Há um diretório `openaiShim/` com módulos focados. Os mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- Agora o conversor de mensagens (que lida com `tool_use`/`tool_result`) e o parser de streaming (que reconstrói tool calls da resposta).
- The middle of the stream parser (137-486) holds the core tool-call reconstruction logic. Let me read the key functions and the message converter's tool-related symbols.
- Faltam: `convertMessages` (direção outbound de tool_use/tool_result), `convertToolResultContent`, e o miolo do stream parser (187-436) onde os tool calls são reconstruídos.
- Preciso ainda do corpo de `convertMessages` (elidido) e do trecho 237-386 do stream parser onde os deltas de `tool_calls` são acumulados.
- Faltam o início da detecção de `tool_calls` no stream (≈280-300) e o miolo de `convertMessages` (215-410) com a conversão outbound de tool_use/tool_result.

### explain-auto-memory

**Variant A run#1** (3 blocks):

- Vou explorar os três módulos para descrever o fluxo de ponta a ponta.
- O agente entregou o trace completo. Vou confirmar os pontos-chave lendo os arquivos centrais diretamente antes de escrever a resposta.
- Tenho o suficiente. Confirmando os dois últimos pontos de injeção/orquestração.

**Variant A run#2** (7 blocks):

- Vou ler o código relevante nos três diretórios para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos principais de cada subsistema em paralelo.
- Vou expandir as funções centrais de cada subsistema.
- Vou ler o núcleo do `runExtraction` (a lógica do forked agent) e as funções-chave do SessionMemory.
- Agora vou ver onde os hooks são registrados e como a leitura (findRelevantMemories/scan) entra no contexto.
- Vou ver onde os hooks de extração são disparados (REPLHook) e como `loadMemoryPrompt` entra no system prompt.
- Vou ver o recall em runtime (`memory.ts` attachment) e o scan, mais o `findRelevantMemories`.

**Variant A run#3** (7 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Vou ler os arquivos-chave em paralelo.
- Vou expandir as funções centrais de orquestração.
- Vou ler o miolo de `runExtraction` (347-531) e onde o extractor é disparado.
- Vou ler o gatilho no stopHooks, o lado de recall (`findRelevantMemories`) e o miolo do SessionMemory para distinguir os dois sistemas.
- Vou confirmar onde `findRelevantMemories` é injetado no prompt e onde o hook de SessionMemory é registrado.
- Vou ler o injetor de recall (`attachments/memory.ts`) para fechar o lado de leitura.

**Variant B run#1** (5 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Now let me find the integration points — where these are wired into the REPL/query loop — and how SessionMemory relates.
- Let me read the recall-side and trigger-side integration, plus SessionMemory's core to see how it differs from extractMemories.
- Let me check SessionMemory's init/file setup and the recall entry point to complete the picture.
- I have enough to describe the full picture. Let me confirm the recall trigger point.

**Variant B run#2** (8 blocks):

- Vou explorar os três subsistemas em paralelo para mapear o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais de cada subsistema.
- Vou expandir as funções centrais do fluxo de extração e carregamento.
- Vou ler o miolo do `runExtraction` (a lógica de fork) e as funções do SessionMemory, além de como tudo é disparado no REPL.
- Agora vou ver os pontos de disparo: onde `executeExtractMemories` é chamado no REPL e como `findRelevantMemories`/scan funcionam.
- Vou achar o ponto de injeção principal do prompt de memória no system prompt e onde `executeExtractMemories` é registrado como hook.
- Vou ler o ponto de recall por query (memory.ts attachment) e o `buildMemoryPrompt`/`buildMemoryLines` para completar o lado da injeção.
- Tenho o quadro completo. Deixa eu confirmar os gates (`isAutoMemoryEnabled`, `isExtractModeActive`, `getAutoMemPath`) e o flag.

### explain-provider-resolution

**Variant A run#1** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir o símbolo principal do client.ts.
- Vou ler o trecho do meio (145–327), onde fica a lógica de seleção de SDK por transport.

**Variant A run#3** (3 blocks):

- Vou ler os dois arquivos.
- `activeProvider.ts` está claro. Agora preciso do corpo de `getAnthropicClient` em client.ts.
- Faltou o miolo (145–327), onde devem estar os ramos de Bedrock/Foundry/shim. Vou ler.

**Variant B run#1** (3 blocks):

- Vou ler os dois arquivos.
- `client.ts` é grande; vou ler a função principal `getAnthropicClient` e o `buildFetch`.
- Vou ler o trecho do meio (145–327), que é onde a decisão de SDK por transport acontece.

