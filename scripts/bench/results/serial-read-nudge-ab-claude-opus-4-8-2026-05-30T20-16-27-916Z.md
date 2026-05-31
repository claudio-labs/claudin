# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T20:16:27.916Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 862 | 5224 | 0.00 | 0 | 5009 | 1.6955 | 78.9 | 18 | Read=12 Grep=3 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 1 | Y | 1353 | 6165 | 0.00 | 0 | 5313 | 1.3172 | 94.2 | 17 | Read=12 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 1 | Y | 741 | 6602 | 0.00 | 0 | 7907 | 3.0624 | 126.7 | 32 | Read=25 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 1 | Y | 650 | 5608 | 0.00 | 0 | 6349 | 1.8567 | 97.1 | 22 | Read=15 Grep=5 Glob=1 Bash=0 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 0 | 4071 | 0.00 | 0 | 2484 | 0.3896 | 37.4 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 168 | 3470 | 0.00 | 0 | 2285 | 0.2530 | 35.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 529 | 4675 | 0.00 | 0 | 3883 | 0.5854 | 60.1 | 11 | Read=9 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 2 | Y | 1425 | 6074 | 0.00 | 0 | 4855 | 0.6711 | 81.8 | 13 | Read=10 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 2 | Y | 659 | 5366 | 0.00 | 0 | 5625 | 1.1837 | 76.7 | 21 | Read=14 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | N | 344 | 308 | 0.00 | 1 | 51188 | 3.3088 | 615.0 | 62 | Read=31 Grep=9 Glob=7 Bash=13 Agent=1 |
| explain-provider-resolution | A | 2 | Y | 0 | 4028 | 0.00 | 0 | 2329 | 0.5656 | 37.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 0 | 4631 | 0.00 | 0 | 33416 | 1.5131 | 313.9 | 200 | Read=196 Grep=0 Glob=0 Bash=2 Agent=0 |
| explain-openai-shim | A | 3 | N | 271 | 308 | 0.00 | 0 | 24524 | 1.1715 | 279.5 | 24 | Read=9 Grep=7 Glob=0 Bash=7 Agent=0 |
| explain-openai-shim | B | 3 | N | 623 | 309 | 0.00 | 0 | 37114 | 1.8809 | 412.8 | 46 | Read=33 Grep=8 Glob=2 Bash=2 Agent=0 |
| explain-auto-memory | A | 3 | Y | 432 | 6007 | 0.00 | 0 | 6435 | 2.2445 | 97.1 | 23 | Read=14 Grep=5 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | Y | 490 | 5120 | 0.00 | 1 | 15965 | 3.3065 | 213.5 | 17 | Read=9 Grep=4 Glob=2 Bash=0 Agent=1 |
| explain-provider-resolution | A | 3 | Y | 215 | 4611 | 0.00 | 0 | 2716 | 0.3690 | 39.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 151 | 3708 | 0.00 | 0 | 2300 | 0.2249 | 39.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=8)

- Avg narration chars: 430
- Avg answer chars: 5073
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 4549
- Avg cost: $1.2619 (total $10.0956)
- Avg wall: 69.3s
- Avg turns: 15.0
- Tool totals: Read=86 Grep=14 Glob=11 Bash=1 Agent=0

### B (feature) (n=7)

- Avg narration chars: 605
- Avg answer chars: 4968
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.14
- Avg output tokens: 10069
- Avg cost: $1.3061 (total $9.1425)
- Avg wall: 125.2s
- Avg turns: 39.9
- Tool totals: Read=250 Grep=11 Glob=7 Bash=2 Agent=1

### Delta

- Narration chars: 430 -> 605 (rel 40.8%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.00 -> 0.14
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: -2.1%
- Cost delta: 3.5%
- Wall delta: 80.6%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: 40.8% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: -2.1% (OK)
  - cost: 3.5% (OK)
  - wall: 80.6% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (8 blocks):

- Vou ler os arquivos relevantes. Primeiro deixa eu mapear a estrutura.
- The most relevant files are toolConverter.ts and messageConverter.ts and streamParser.ts. Let me read them.
- I'll read messageConverter.ts in full, and streamParser.ts (the reverse direction — parsing OpenAI tool calls back to Anthropic format).
- Preciso ver o miolo do `convertMessages` (emissão de `tool_calls`) e o parser de stream reverso.
- Falta o miolo de ambos: a emissão de `tool_calls` (assistant) e a acumulação de deltas no stream.
- I need the core streaming loop where tool_call deltas are accumulated (lines ~187-437 of streamParser).
- The middle (236-390) is the actual tool_call delta accumulation logic — the heart of streaming tool calls. Let me read it precisely.
- Já tenho a imagem completa de ambas as direções. Vou verificar rapidamente o mapeamento de campos de tool em `helpers.ts`.

**Variant A run#2** (4 blocks):

- Vou ler os arquivos relevantes para a tradução de tool calls.
- Agora vou ler o `messageConverter.ts` (blocos de conteúdo e tool results) e o `streamParser.ts` (parsing das tool calls de volta).
- Vou ler o resto do `convertMessages` (a parte que emite `tool_calls` e mensagens `role: tool`) e a parte do `streamParser` que reconstrói os `tool_use` Anthropic.
- Vou ler a parte do `messageConverter` que emite os `tool_calls` no assistant (linhas 252-410) e a parte do `streamParser` que monta tool_use a partir do delta (linhas 286-450).

**Variant B run#1** (8 blocks):

- It's a directory. The tool-call translation lives mainly in `toolConverter.ts` and `messageConverter.ts`. Let me read both, plus the streaming side.
- I have the tool-schema side. Now the message side: how Anthropic `tool_use` / `tool_result` blocks become OpenAI `tool_calls` / `tool` messages, and the streaming reassembly.
- Now the rest of `convertMessages` (the tool_use → tool_calls and tool_result → role:tool emission), and the streaming reassembly of tool_calls back into Anthropic `tool_use`.
- The head/tail elision dropped the two cores I need: the assistant `tool_use` → `tool_calls` block (messageConverter ~258-410) and the streaming delta loop that reassembles tool_calls (streamParser ~13
- I have both message-direction halves. The missing piece is the streaming inbound loop (187–436) where OpenAI tool_call deltas get accumulated and converted to Anthropic `tool_use` events.
- The middle (236–386) — where tool_call deltas are actually opened and their argument fragments buffered — is still elided. That's the crux of inbound streaming. Reading it directly.
- Need the few lines just above 300 where a new tool_call is detected (the `delta.tool_calls` loop start).
- I now have the full picture of both directions. Let me check the `normalizeToolArguments` / `hasToolFieldMapping` helper referenced at stop-time.

**Variant B run#2** (7 blocks):

- Vou localizar os arquivos do openaiShim e ler as partes relevantes à tradução de tool calls.
- O diretório `openaiShim/` é o que importa. Vou ler os arquivos diretamente relacionados à tradução de tool calls.
- The toolConverter handles the schema-definition side. Now let me read the message conversion (request side: how Anthropic `tool_use`/`tool_result` blocks become OpenAI messages) and the stream parser 
- I have the schema-conversion and request-side message conversion. Now I need: (1) the rest of `convertMessages` showing how `tool_use`/`tool_result` blocks become OpenAI `assistant.tool_calls` and `ro
- The head-tail elision dropped the core logic. I need the request-side assistant `tool_use`→`tool_calls` block (lines 258–410) and the stream-parser body where tool_call deltas are processed (lines 137
- I have the request side fully. The streamParser middle (lines 187–436) — where OpenAI `tool_calls` deltas are buffered and emitted as Anthropic events — is still elided. Let me read it precisely.
- The crucial middle (236–385) — where streaming `delta.tool_calls` chunks are accumulated into `activeToolCalls` — is still elided. Let me read that narrow window.

### explain-auto-memory

**Variant A run#1** (8 blocks):

- Vou ler o código relevante. Começando por mapear os três diretórios.
- Agora os arquivos de extração e sessão, mais os símbolos-chave de `memdir.ts` e `paths.ts`.
- Agora vou expandir os símbolos centrais: o orquestrador de extração, o loop de recall e os gates.
- Falta o miolo de `runExtraction` (o fork que de fato escreve) e o lado da extração de sessão. Vou ler em paralelo.
- Agora vou ver os pontos de ligação: quem chama `loadMemoryPrompt`, `findRelevantMemories`, e onde os hooks de fim-de-turno disparam a extração.
- O recall e os stop hooks. Vou ler os pontos de injeção.
- O corpo de `handleStopHooks` não veio completo. Vou ler o range e os pontos de injeção em QueryEngine e prompts.
- Vou ler como o prefetch é consumido em query.ts (335 e 1780).

**Variant A run#2** (6 blocks):

- Vou ler o código relevante. Começo mapeando os três diretórios e o índice de memória da team que menciona como isso funciona no open build.
- Deixa eu ler os arquivos centrais de cada subsistema.
- Vou ler o coração da extração (`initExtractMemories`), o carregamento do prompt, o `isAutoMemoryEnabled`, e como se conecta no QueryEngine.
- Agora a lógica central de extração (linhas 347-531) e como o extractor é disparado no QueryEngine, mais o SessionMemory.
- Agora os dois gatilhos (stop hook de fim de turno + recall via attachments) e o SessionMemory.
- Por último, o gatilho de recall (quem chama `getRelevantMemoryAttachments`) e o corpo do extract do SessionMemory.

**Variant A run#3** (5 blocks):

- Vou ler o código relevante nesses três diretórios para descrever o fluxo real.
- Let me read the core extraction logic and find where these are wired into the agent loop.
- Let me find where the extraction hooks fire and where findRelevantMemories is invoked.
- Now the two key wiring points: the stop hook (extraction trigger) and the attachment (recall injection).
- Let me see the public entry that drives recall per-turn and the gate logic.

**Variant B run#1** (7 blocks):

- Vou mapear a estrutura desses três diretórios e ler o código relevante.
- Deixa eu ler os arquivos centrais em paralelo.
- Vou expandir as funções centrais e ver como o extractor é disparado e como o recall entra no loop.
- Vou ler o miolo de `runExtraction` (a lógica do agente forkado) e os gates de disparo, além de onde o hook chama o extractor.
- Vou ver onde o recall e o extractor são plugados no loop: `attachments/memory.ts`, `QueryEngine.ts` e `stopHooks.ts`.
- Vou ler a parte de recall (`startRelevantMemoryPrefetch`, `getRelevantMemoryAttachments`) e o contexto do stopHook.
- Vou ver como o prefetch é consumido no QueryEngine e o papel do SessionMemory.

**Variant B run#3** (5 blocks):

- Vou mapear o código dessas três áreas para descrever o fluxo de ponta a ponta. Começo explorando em paralelo.
- O mapa está completo. Vou confirmar os pontos-chave lendo diretamente o código (trigger de extração, write/read path, computação de path).
- Vou ler o coração do trigger de extração e onde `loadMemoryPrompt` entra no system prompt.
- Vou ler o miolo da `runExtraction` (throttle + fork) e o hook que a dispara no fim do turno.
- Vou achar o call site que dispara a extração no fim do turno.

### explain-provider-resolution

**Variant A run#3** (3 blocks):

- Vou ler os dois arquivos.
- `activeProvider.ts` está claro. Agora o `getAnthropicClient` em client.ts.
- Vou ler o miolo omitido (145–327), que contém a seleção de SDK para Bedrock/Vertex/Foundry e o ponto de divergência.

**Variant B run#1** (3 blocks):

- Vou ler os dois arquivos.
- Agora o corpo do `getAnthropicClient`, que faz o dispatch por transport.
- Preciso da seção do meio (145–327), onde mora o dispatch por transport.

**Variant B run#3** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do client.
- Vou ler o trecho do meio (145–327), que contém a lógica de seleção de transport/SDK.

