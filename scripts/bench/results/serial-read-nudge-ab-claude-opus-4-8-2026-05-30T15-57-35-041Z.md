# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T15:57:35.042Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 899 | 5287 | 0.00 | 0 | 4223 | 0.9863 | 65.7 | 11 | Read=8 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 1 | Y | 911 | 6646 | 0.00 | 0 | 4989 | 1.6288 | 86.0 | 12 | Read=9 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 1 | Y | 572 | 6189 | 0.00 | 0 | 6862 | 2.7510 | 114.6 | 26 | Read=18 Grep=4 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 1 | Y | 159 | 7689 | 0.00 | 1 | 17520 | 6.2340 | 265.2 | 6 | Read=4 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-provider-resolution | A | 1 | Y | 334 | 3550 | 0.00 | 0 | 2719 | 0.7038 | 45.3 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 328 | 3993 | 0.00 | 0 | 2808 | 0.4754 | 46.3 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 914 | 6217 | 0.00 | 0 | 4218 | 0.8317 | 68.8 | 10 | Read=7 Grep=1 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 2 | Y | 918 | 5640 | 0.00 | 0 | 4477 | 1.0369 | 72.3 | 12 | Read=9 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 2 | Y | 737 | 8181 | 0.00 | 0 | 6790 | 2.6666 | 104.6 | 23 | Read=16 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | N | 559 | 308 | 0.00 | 0 | 54657 | 3.2556 | 509.9 | 37 | Read=23 Grep=6 Glob=5 Bash=2 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 351 | 3954 | 0.00 | 0 | 2753 | 0.6935 | 46.0 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 290 | 3966 | 0.00 | 0 | 2727 | 0.4730 | 41.0 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 623 | 5745 | 0.00 | 0 | 4302 | 0.7823 | 60.6 | 11 | Read=8 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 3 | Y | 571 | 5903 | 0.00 | 0 | 4242 | 0.5574 | 63.7 | 11 | Read=8 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 3 | Y | 740 | 5458 | 0.00 | 0 | 6785 | 2.9153 | 113.1 | 24 | Read=17 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | N | 317 | 308 | 0.00 | 1 | 206954 | 12.6848 | 2649.9 | 45 | Read=25 Grep=4 Glob=5 Bash=9 Agent=1 |
| explain-provider-resolution | A | 3 | Y | 390 | 4381 | 0.00 | 0 | 2963 | 0.7089 | 47.0 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 398 | 3385 | 0.00 | 0 | 2581 | 0.4712 | 40.7 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=9)

- Avg narration chars: 618
- Avg answer chars: 5440
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 4624
- Avg cost: $1.4488 (total $13.0393)
- Avg wall: 74.0s
- Avg turns: 13.7
- Tool totals: Read=89 Grep=11 Glob=13 Bash=1 Agent=0

### B (feature) (n=7)

- Avg narration chars: 511
- Avg answer chars: 5317
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.14
- Avg output tokens: 5621
- Avg cost: $1.5538 (total $10.8768)
- Avg wall: 87.9s
- Avg turns: 8.4
- Tool totals: Read=45 Grep=0 Glob=6 Bash=0 Agent=1

### Delta

- Narration chars: 618 -> 511 (rel -17.3%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.00 -> 0.14
- Prompts com explore>=1 em B: 1/3
- Answer chars delta: -2.3%
- Cost delta: 7.2%
- Wall delta: 18.9%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: -17.3% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=1/3 (fail)
  - answerChars: -2.3% (OK)
  - cost: 7.2% (fail)
  - wall: 18.9% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (5 blocks):

- Vou ler os arquivos relevantes. Primeiro localizo a estrutura.
- Há tanto `openaiShim.ts` quanto o diretório modular. As traduções de tool calls estão concentradas em `toolConverter.ts` e `messageConverter.ts`. Vou ler os arquivos centrais.
- The middle of `messageConverter.ts` was elided — that's exactly where the tool_use → tool_calls translation happens. Let me read it, plus the streaming side where OpenAI tool_call deltas get reassembl
- Preciso do miolo de ambos: a parte de `messageConverter.ts` que emite `tool_calls` (≈linhas 290–366) e o loop em `streamParser.ts` que reassembla `tool_call` deltas (≈linhas 200–480). Vou ler os trech
- Faltam dois trechos-chave: o pré-scan de pares tool_use↔tool_result e a emissão de `role:"tool"` em `messageConverter.ts` (≈150–319), e a reassembleia dos deltas de `tool_calls` em `streamParser.ts` (

**Variant A run#2** (7 blocks):

- Vou ler os arquivos relevantes do openaiShim para entender a tradução de tool calls.
- The directory exists (contrary to the older single-file description). Let me read the most relevant files: toolConverter.ts, messageConverter.ts, and the tool-call parts of streamParser.ts and message
- The middle of messageConverter.ts was omitted. Let me read the full middle section which contains the tool_use → tool_calls conversion logic.
- The summary keeps truncating the key middle section (lines 100-359) which contains the actual tool_use → tool_calls mapping. Let me read that specific range tightly.
- Now the assistant tool_use mapping (lines 260-368).
- Now let me look at the streamParser to cover the reverse direction (OpenAI tool_calls deltas → Anthropic blocks), since "tool calls" translation is bidirectional.
- Let me read the streamParser tool_calls reassembly section (280-370) to cover the reverse direction.

**Variant A run#3** (4 blocks):

- The relevant files are `toolConverter.ts` (tool schema + tool_use → tool_calls), `messageConverter.ts` (message translation), and `streamParser.ts` (streaming tool_calls back to Anthropic). Let me rea
- The middle of `messageConverter.ts` (the tool_use → tool_calls conversion) was omitted. Let me read it plus the streaming reverse path.
- Need the core middle: the assistant tool_use → tool_calls block in messageConverter, and the streaming tool_call accumulation in streamParser.
- Let me read the remaining gaps: the tool_call delta accumulation in streamParser and the pre-scan/tool_result emission in messageConverter.

**Variant B run#1** (8 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- O foco está em `toolConverter.ts` (definições), `messageConverter.ts` (tool_use/tool_result) e `streamParser.ts` (parse da resposta). Vou ler esses mais o `types.ts`.
- O miolo do `convertMessages` (linhas 51-411) foi omitido — é exatamente onde está a conversão tool_use ↔ tool_calls. Vou ler esse trecho e o `streamParser.ts`.
- Preciso do miolo de ambos: o trecho que emite `tool_calls` no `convertMessages` e o parser de tool_calls do stream. Vou ler as duas seções centrais.
- Ainda falta o coração do pareamento tool_use↔tool_result (linhas 150-311). Vou ler exatamente esse intervalo e o parser de stream (51-360).
- Agora o parser do stream (inbound). Vou ler o miolo do `streamParser.ts`.
- O trecho central do parser (101-451) — onde tool_calls fragmentados são remontados — ainda falta. Vou ler.
- O bloco 151-401 (acúmulo de deltas de tool_call) ainda falta. Vou ler.

**Variant B run#2** (6 blocks):

- Vou localizar os arquivos relevantes primeiro.
- Vou ler os arquivos centrais para a tradução de tool calls.
- O trecho central de `convertMessages` (linhas 51-411) foi omitido — é exatamente onde acontece a tradução tool_use→tool_calls. Vou ler essa seção e o streamParser (direção reversa, resposta).
- I read the heads/tails but need the core tool-mapping logic. Let me read the middle of both files — the assistant tool_calls emission in messageConverter (100-362) and the tool_call streaming reassemb
- Falta o coração de cada direção: o pre-scan de pareamento tool_use↔tool_result (messageConverter 150-311) e a acumulação de deltas de tool_call no stream (streamParser 101-451).
- One more gap: the streamParser tool_call delta accumulation loop (lines ~250-400) where OpenAI `tool_calls[].function.arguments` fragments get buffered and mapped to Anthropic `content_block_start`/`i

**Variant B run#3** (3 blocks):

- The middle of `messageConverter.ts` was elided — that's the core of the tool_use↔tool_result handling. Let me read it plus the response-direction parser.
- I need the elided middle sections — those contain the actual tool_use→tool_calls emission and the streaming tool_call reassembly. Let me read both ranges plus the field-normalization helper.
- I still need: the tool_use→tool_calls assembly in messageConverter (lines 150-319, which has the tool_result pre-scan and orphan dropping) and the streaming tool_call reassembly in streamParser (lines

### explain-auto-memory

**Variant A run#1** (6 blocks):

- Vou ler o código dos três módulos para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais de cada módulo.
- Os arquivos foram truncados. Deixa eu ler as seções centrais (a lógica principal) de cada um.
- O resumo continua cortando o meio. Deixa eu ver o outline para localizar as funções-chave e ler a lógica de gatilho.
- Agora vou ler as funções-chave: o gatilho de extração (`initExtractMemories`), o canUseTool, e o lado da session memory.
- Agora vou ver o wiring (stopHooks), a `loadMemoryPrompt` (lado de injeção no system prompt), e a `findRelevantMemories`.

**Variant A run#2** (8 blocks):

- Vou ler o código dos três módulos para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais de cada módulo em paralelo.
- Agora os módulos de extração e sessão, mais o miolo do memdir.ts e o scanner.
- Vou ler o miolo da extração e da session memory, mais os prompts de extração.
- Vou ler o restante da implementação da extração, os prompts e a fiação no system prompt / hooks.
- Agora a fiação: onde a extração é disparada, onde `loadMemoryPrompt` entra no system prompt, e onde `findRelevantMemories` roda em query-time.
- Vou ler os pontos de integração: o stop hook, a injeção no system prompt e o attachment de recall.
- Tenho o quadro completo das três áreas. Vou confirmar onde `getRelevantMemoryAttachments` é disparado por turno.

**Variant A run#3** (8 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Vou ler os arquivos-chave de cada subsistema.
- Os arquivos são grandes e foram truncados. Vou ler as seções centrais que importam para o fluxo.
- O tool está truncando por tamanho. Vou ler em blocos menores o núcleo de `runExtraction`.
- Agora o lado de leitura/injeção. Vou ler `findRelevantMemories`, `memoryScan`, e a pasta `SessionMemory`.
- Vou ler `memoryScan`, o miolo de `memdir.ts` (construção do prompt), o miolo de `sessionMemory.ts`, e onde isso é disparado.
- Vou ler o ponto de injeção na leitura (attachments/memory.ts), o disparo em stopHooks.ts, e o miolo do SessionMemory.
- Vou ler o prefetch de leitura, como ele é acionado, e o miolo do SessionMemory (extração + registro de hook).

**Variant B run#1** (2 blocks):

- Vou explorar os três diretórios e mapear o fluxo de ponta a ponta.
- Vou confirmar os pontos centrais lendo diretamente o trigger de extração e o core de escrita.

### explain-provider-resolution

**Variant A run#1** (4 blocks):

- Vou ler os dois arquivos para mapear o caminho de decisão.
- O miolo do `client.ts` (linhas 51–391) é onde a construção do SDK acontece. Vou lê-lo.
- Vou ler o corpo do `getAnthropicClient` (100–345) que define os branches Bedrock/Vertex/Foundry/Anthropic.
- Falta o trecho 148–295 com os branches de seleção (Bedrock/Foundry/Vertex). Vou ler.

**Variant A run#2** (3 blocks):

- O `client.ts` foi truncado no meio (linhas 51–391), justo onde mora a construção do SDK. Vou ler esse trecho.
- O núcleo do `getAnthropicClient` (linhas 101–340) ainda está omitido. Vou ler esse trecho — é onde os branches por transporte de fato escolhem o SDK.
- O trecho 150–294 (onde ficam os branches Bedrock/Foundry/Vertex) ainda está omitido. Vou ler.

**Variant A run#3** (4 blocks):

- Vou ler os dois arquivos para mapear o caminho de decisão.
- O `client.ts` foi truncado (linhas 51–391). Preciso ver o miolo, onde o SDK é construído por transport.
- O miolo de `getAnthropicClient` (101–341) ainda está oculto — é onde mora o switch de transport. Vou ler diretamente.
- Falta o trecho 145–294, onde provavelmente está o branch Bedrock/Foundry/Vertex e a leitura do `activeProvider`.

**Variant B run#1** (4 blocks):

- Vou ler os dois arquivos.
- O `client.ts` veio truncado. Preciso ver o miolo (51–391) que é onde a construção do SDK acontece.
- O núcleo de `getAnthropicClient` (linhas 100–341) ainda está omitido. Vou ler esse bloco.
- The tool keeps truncating lines 145–289 — that's the Bedrock/Foundry/Vertex branching core. Let me grab it directly.

**Variant B run#2** (4 blocks):

- Vou ler os dois arquivos.
- O miolo de `client.ts` (linhas 51–391) foi omitido — preciso dele para explicar a montagem do SDK por transporte.
- Falta o corpo de `getAnthropicClient` (101–341), onde a seleção real de SDK acontece.
- Falta o trecho 151–291, que tem os branches Bedrock/Foundry/Vertex.

**Variant B run#3** (4 blocks):

- Vou ler os dois arquivos para mapear o caminho de decisão.
- O miolo de `client.ts` (linhas 51–391) foi omitido — é onde a construção real do SDK acontece. Vou ler essa parte.
- A função `getAnthropicClient` (101–341) ainda está omitida — é o coração do branching. Vou lê-la inteira.
- The summarizer keeps eliding lines 145–294 — that's the Bedrock/Foundry/Vertex branching. Let me grab exactly that range.

