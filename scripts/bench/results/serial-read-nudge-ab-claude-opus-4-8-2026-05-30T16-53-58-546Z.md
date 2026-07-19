# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T16:53:58.546Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/dev/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 921 | 5604 | 0.00 | 0 | 4956 | 1.5629 | 80.0 | 13 | Read=10 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 1 | Y | 955 | 5737 | 0.00 | 0 | 5381 | 1.8515 | 92.0 | 17 | Read=12 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 1 | Y | 612 | 5688 | 0.00 | 0 | 5666 | 1.9529 | 83.6 | 19 | Read=13 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 1 | Y | 687 | 6897 | 0.00 | 0 | 6582 | 1.9695 | 98.3 | 24 | Read=20 Grep=2 Glob=0 Bash=1 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 298 | 3938 | 0.00 | 0 | 2777 | 0.5305 | 43.5 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 0 | 3335 | 0.00 | 0 | 2137 | 0.3788 | 33.1 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 671 | 5589 | 0.00 | 0 | 4536 | 1.0634 | 70.9 | 12 | Read=9 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 2 | Y | 467 | 5026 | 0.00 | 0 | 4033 | 0.5536 | 65.2 | 11 | Read=8 Grep=1 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 2 | Y | 1119 | 5919 | 0.00 | 0 | 6069 | 3.8828 | 119.6 | 24 | Read=16 Grep=4 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | Y | 634 | 6099 | 0.00 | 0 | 7122 | 2.8650 | 109.4 | 28 | Read=15 Grep=9 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 333 | 3911 | 0.00 | 0 | 2630 | 0.5230 | 37.5 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 160 | 3704 | 0.00 | 0 | 2320 | 0.3570 | 37.3 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 704 | 5147 | 0.00 | 0 | 4148 | 1.0892 | 68.1 | 12 | Read=9 Grep=0 Glob=1 Bash=1 Agent=0 |
| explain-openai-shim | B | 3 | Y | 762 | 5994 | 0.00 | 0 | 4599 | 0.6760 | 69.4 | 12 | Read=9 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 3 | Y | 749 | 7071 | 0.00 | 0 | 6479 | 2.9916 | 111.6 | 21 | Read=15 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | Y | 136 | 5252 | 0.00 | 1 | 14876 | 4.6424 | 226.8 | 2 | Read=0 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-provider-resolution | A | 3 | Y | 242 | 3564 | 0.00 | 0 | 2521 | 0.4577 | 44.1 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 170 | 3532 | 0.00 | 0 | 2304 | 0.3839 | 38.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=9)

- Avg narration chars: 628
- Avg answer chars: 5159
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 4420
- Avg cost: $1.5616 (total $14.0540)
- Avg wall: 73.2s
- Avg turns: 13.2
- Tool totals: Read=87 Grep=8 Glob=14 Bash=1 Agent=0

### B (feature) (n=9)

- Avg narration chars: 441
- Avg answer chars: 5064
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.11
- Avg output tokens: 5484
- Avg cost: $1.5197 (total $13.6777)
- Avg wall: 85.6s
- Avg turns: 12.1
- Tool totals: Read=76 Grep=14 Glob=7 Bash=2 Agent=1

### Delta

- Narration chars: 628 -> 441 (rel -29.7%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.00 -> 0.11
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: -1.8%
- Cost delta: -2.7%
- Wall delta: 16.9%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: -29.7% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: -1.8% (OK)
  - cost: -2.7% (OK)
  - wall: 16.9% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (7 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- Os arquivos mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou ler em paralelo.
- O meio do `messageConverter.ts` (linhas 51–411) foi omitido — é justamente onde está a conversão de `tool_use`/`tool_result`. Vou ler esse trecho e o `streamParser.ts` (direção inversa: resposta OpenA
- Preciso dos trechos centrais: a conversão `tool_use` → `tool_calls` (messageConverter 101–361) e a remontagem dos `tool_calls` no stream (streamParser 51–501).
- Ainda faltam os núcleos: o pre-scan e a montagem da mensagem assistant (messageConverter 150–312) e o loop de remontagem dos `tool_calls` no stream (streamParser 100–452).
- Falta o miolo do loop de stream (150–401), onde os `tool_call` deltas são acumulados.
- Falta só o trecho 200–352, onde os deltas de `tool_calls` são abertos/acumulados por índice.

**Variant A run#2** (5 blocks):

- Há tanto um `openaiShim.ts` quanto um diretório `openaiShim/`. Para tool calls, os arquivos-chave são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- I need the middle of `messageConverter.ts` (the tool_use ↔ tool_result handling) and the streaming parser. Let me read those.
- Preciso do miolo de ambos: o mapeamento `tool_use`/`tool_result` em messageConverter e a remontagem de tool_calls no streamParser.
- Falta o núcleo: o pre-scan e emissão de `tool` messages no messageConverter (150-314) e o loop de deltas no streamParser (100-451).
- Falta o coração do streaming: o loop que recebe `tool_call` deltas e remonta os argumentos (linhas ~200-400).

**Variant A run#3** (6 blocks):

- Vou investigar a estrutura do openaiShim primeiro.
- The key files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Preciso ver o miolo do `convertMessages` (50–411) e o `streamParser` para a direção de resposta.
- I need the middle sections — the request-side tool_use→tool_calls mapping (messageConverter 100-361) and the response-side tool_call assembly in streamParser (50-501).
- Faltam dois trechos centrais: o pré-scan tool_use↔tool_result (msgConverter 150-319) e o coração do stream parser que monta os tool_calls a partir dos deltas (streamParser 150-454).
- O último trecho que falta é o coração do stream parser (200-404): onde os deltas de tool_call são acumulados.

**Variant B run#1** (8 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- O diretório existe. Os arquivos relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- Vou ler o `messageConverter.ts` completo e o `streamParser.ts` (parte de tool calls).
- The middle of `messageConverter.ts` (the tool_use → tool_calls emission, lines 51-411) got elided. Let me read that range and the stream parser's tool-call assembly.
- Faltam os trechos centrais. Vou ler a emissão de `tool_use→tool_calls` (linhas 155-360 do messageConverter) e a montagem incremental dos tool_calls no stream (linhas 137-486).
- Falta o núcleo da montagem incremental dos tool_calls no stream (linhas 187-436).
- Ainda falta o coração: onde lê `delta.tool_calls` e abre os blocos `tool_use` (linhas 236-390).
- Tenho o quadro completo das duas direções. Deixa eu confirmar o `normalizeToolArguments`/`hasToolFieldMapping` em helpers, que aparece no `normalizeAtStop`.

**Variant B run#2** (4 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- Agora vou ler o messageConverter completo e a parte de parsing do stream que reconstrói as tool calls.
- Vou ler o trecho do messageConverter que monta as `tool_calls` do assistant e os `role: 'tool'` results, mais o trecho do streamParser que reconstrói os blocos.
- Vou ler o trecho omitido (258–410) do messageConverter — onde monta as `tool_calls` do assistant — e o fechamento das tool calls no streamParser (370–460).

**Variant B run#3** (6 blocks):

- Vou ler os arquivos relevantes. Deixa eu primeiro mapear a estrutura.
- The most relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read those.
- Now let me read the messageConverter symbols and the streamParser (which handles the reverse direction — parsing OpenAI tool calls back to Anthropic).
- Let me read the rest of convertMessages (the tool_use/tool_result emission logic) and the stream parser's tool-call assembly.
- The summarizer cut the two most important sections. Let me read the assistant `tool_use` emission and the streaming tool-call assembly directly.
- The summarizer keeps eliding the core streaming tool-call accumulation (lines ~250-440). Let me read that exact block — it's the heart of the reverse translation.

### explain-auto-memory

**Variant A run#1** (7 blocks):

- Vou ler o código relevante. Começo mapeando os três diretórios em paralelo.
- I need the middle sections. Let me read the core extraction logic and the prompt builder in memdir.
- Let me read the core extraction loop, the forked-agent execution, and the prompt builders.
- Let me read the system-prompt injection path and how extraction is triggered.
- Now the recall (system-prompt injection) side and the trigger hook, plus the SessionMemory core to see how it differs.
- Now the recall injection point and the SessionMemory core to distinguish the two systems.
- Now the recall attachment and the SessionMemory extraction core.

**Variant A run#2** (10 blocks):

- Vou explorar os três diretórios para entender o fluxo de ponta a ponta.
- Os arquivos são grandes. Vou ler as partes centrais omitidas e os módulos de extração/sessão.
- The `extractMemories.ts` core logic (51–560) is the heart of the write path. Let me read it, plus the rest of `memdir.ts`, and the SessionMemory entry point.
- The summarizer keeps eliding the core logic (lines 100–509). Let me read it in smaller chunks.
- Now the read path: how memories get injected. Let me read `findRelevantMemories.ts`, `memoryScan.ts`, and the SessionMemory entry point, plus where extraction is triggered (stopHooks) and where loadMe
- Let me read the SessionMemory core, memoryScan, and find the trigger/wiring points.
- Now let me find the wiring/trigger points: where `loadMemoryPrompt`, `findRelevantMemories`, and `executeExtractMemories` get called.
- Now let me read the recall attachment (the query-time injection path) and the stopHooks trigger.
- Let me read the recall attachment middle section to understand the query-time injection.
- I have enough to describe the full flow. Let me confirm the recall trigger point.

**Variant A run#3** (9 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Vou ler os arquivos núcleo de cada módulo.
- Os arquivos vieram resumidos. Preciso ler as seções centrais — a montagem do system prompt em memdir.ts e os runners de extração.
- O summarizer continua cortando o meio. Vou ler em janelas menores o núcleo de cada runner.
- Agora o núcleo de memdir.ts (montagem do system prompt) e sessionMemory.ts.
- Agora o core do SessionMemory e onde os dois sistemas são disparados.
- Por fim, os pontos de disparo: onde `loadMemoryPrompt` entra no system prompt e onde `executeExtractMemories` é chamado.
- Vou fechar com o gatilho no `stopHooks` e o caminho de recall (`findRelevantMemories`).
- Onde o recall (`findRelevantMemories`) é disparado em runtime.

**Variant B run#1** (8 blocks):

- Vou mapear os três subsistemas e ler o código relevante.
- Vou ler os arquivos centrais de cada subsistema em paralelo.
- Agora os arquivos de extração, recall e sessão, mais os símbolos centrais de `memdir.ts`.
- Vou expandir os símbolos-chave de cada subsistema.
- Vou ler o miolo de `runExtraction` (347-531) e os disparadores de sessão, mais o ponto de integração no REPL.
- Vou ver os pontos de integração: o hook que dispara extração, e onde o recall (findRelevantMemories) e o prompt são injetados.
- O símbolo só retornou a assinatura. Vou ler o corpo de `handleStopHooks` e o `executeExtractMemories`.
- Tenho o panorama. Vou conferir o gate de ferramentas da extração e como o prefetch é consumido.

**Variant B run#2** (6 blocks):

- Vou mapear os três subsistemas e ler o código relevante.
- Há dois subsistemas distintos. Vou ler os corpos das funções-chave.
- Vou ler o miolo do `runExtraction` e a construção do prompt de memória, além das partes-chave do SessionMemory.
- Agora vou ver o cabeamento (onde o hook dispara, onde o prompt é injetado, onde a relevância é consultada) e as partes-chave do SessionMemory.
- Vou ver os pontos de cabeamento: o hook que dispara extractMemories, a injeção do prompt no system prompt, e a consulta de relevância por turno.
- I have enough to describe the full flow. Let me confirm where the prefetch is consumed in the attachment pipeline.

**Variant B run#3** (1 blocks):

- Vou mapear o fluxo lendo o código desses três módulos. Como é uma investigação que cruza vários arquivos, vou despachar o Explore agent.

### explain-provider-resolution

**Variant A run#1** (3 blocks):

- O `activeProvider.ts` ficou completo, mas o miolo de `client.ts` (linhas 51–391) é onde mora a construção do SDK. Vou ler.
- O resumo continua cortando o corpo de `getAnthropicClient` (101–341). Vou expandir só esse símbolo.
- Falta o trecho 145–327 (branches Bedrock/Foundry e o `ARGS`). Vou ler direto.

**Variant A run#2** (4 blocks):

- Vou ler os dois arquivos.
- O `client.ts` veio truncado no meio. Preciso ler as linhas 51–391 onde está a construção real do SDK.
- Ainda falta o miolo do `getAnthropicClient` (linhas 100–342), que é onde a seleção Bedrock/Vertex/Foundry acontece.
- Falta ainda o trecho 148–289, onde estão os branches Bedrock/Foundry e a montagem de `ARGS`.

**Variant A run#3** (3 blocks):

- O `client.ts` veio truncado no meio (linhas 51–391). Preciso da parte que monta o SDK por transport.
- The core is `getAnthropicClient` (lines 95–377). Let me read it.
- Falta a parte central (145–329) onde estão os branches Bedrock/Foundry/Vertex.

**Variant B run#2** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do client.ts.
- Faltou o miolo (145–327), que é onde mora a lógica de escolha de SDK. Vou ler esse trecho.

**Variant B run#3** (3 blocks):

- Vou ler os dois arquivos.
- Agora vou ler o corpo principal do `client.ts`, onde a transport vira SDK.
- Faltou o miolo (145–327), onde estão os branches de transport. Vou ler.

