# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T19:30:08.648Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/dev/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 929 | 5281 | 0.00 | 0 | 5403 | 1.9182 | 89.0 | 21 | Read=14 Grep=4 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 1 | N | 210 | 308 | 0.00 | 0 | 24256 | 0.8481 | 254.6 | 25 | Read=12 Grep=6 Glob=2 Bash=4 Agent=0 |
| explain-auto-memory | A | 1 | N | 292 | 309 | 0.00 | 0 | 42587 | 2.4278 | 424.0 | 100 | Read=54 Grep=25 Glob=2 Bash=18 Agent=0 |
| explain-auto-memory | B | 1 | Y | 1255 | 5234 | 0.00 | 1 | 14789 | 4.0426 | 204.1 | 21 | Read=11 Grep=2 Glob=3 Bash=0 Agent=1 other=3 |
| explain-provider-resolution | A | 1 | Y | 187 | 4141 | 0.00 | 0 | 2534 | 0.3641 | 38.3 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 138 | 3599 | 0.00 | 0 | 2237 | 0.2506 | 34.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 1228 | 6897 | 0.00 | 0 | 5580 | 1.1762 | 87.6 | 15 | Read=11 Grep=1 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 2 | Y | 926 | 5952 | 0.00 | 0 | 4645 | 0.6675 | 69.5 | 12 | Read=10 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 2 | Y | 176 | 6711 | 0.00 | 1 | 20569 | 4.6638 | 267.0 | 4 | Read=2 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 2 | Y | 720 | 5839 | 0.00 | 0 | 6237 | 1.9389 | 93.9 | 22 | Read=15 Grep=2 Glob=3 Bash=1 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 0 | 4223 | 0.00 | 0 | 2582 | 0.3918 | 36.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 205 | 4349 | 0.00 | 0 | 2621 | 0.2336 | 38.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 847 | 5634 | 0.00 | 0 | 4977 | 1.5408 | 82.6 | 16 | Read=11 Grep=3 Glob=1 Bash=0 Agent=0 |
| explain-openai-shim | B | 3 | N | 429 | 309 | 0.00 | 0 | 38996 | 1.6971 | 394.7 | 100 | Read=71 Grep=1 Glob=0 Bash=27 Agent=0 |
| explain-auto-memory | A | 3 | Y | 368 | 7368 | 0.00 | 1 | 17192 | 5.3075 | 257.1 | 6 | Read=4 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 3 | Y | 628 | 5025 | 0.00 | 0 | 5850 | 1.7336 | 89.7 | 23 | Read=16 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 3 | Y | 199 | 3941 | 0.00 | 0 | 10465 | 0.8981 | 127.1 | 22 | Read=10 Grep=4 Glob=0 Bash=7 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 182 | 4005 | 0.00 | 0 | 2513 | 0.2309 | 38.4 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=8)

- Avg narration chars: 492
- Avg answer chars: 5525
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.25
- Avg output tokens: 8663
- Avg cost: $2.0326 (total $16.2605)
- Avg wall: 123.2s
- Avg turns: 11.8
- Tool totals: Read=60 Grep=12 Glob=5 Bash=7 Agent=2

### B (feature) (n=7)

- Avg narration chars: 579
- Avg answer chars: 4858
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.14
- Avg output tokens: 5556
- Avg cost: $1.2997 (total $9.0977)
- Avg wall: 81.3s
- Avg turns: 13.3
- Tool totals: Read=64 Grep=7 Glob=9 Bash=2 Agent=1 other=3

### Delta

- Narration chars: 492 -> 579 (rel 17.8%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.25 -> 0.14
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: -12.1%
- Cost delta: -36.1%
- Wall delta: -34.0%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: 17.8% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: -12.1% (OK)
  - cost: -36.1% (OK)
  - wall: -34.0% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (8 blocks):

- Vou investigar a estrutura do openaiShim primeiro.
- Há um diretório e o arquivo principal. Os mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- I'll read the messageConverter symbols and the stream parser to cover both directions of translation.
- `convertMessages` é o coração da tradução. Vou lê-lo por completo, junto com o stream parser (direção inversa).
- I need the middle of convertMessages (215-410) where tool_use/tool_result mapping happens, and the streaming tool_call accumulation in the parser.
- I need the streaming middle section (137-486) where tool_call deltas are accumulated into Anthropic content blocks.
- The key middle section (187-436) handling tool_call delta accumulation is still elided. Let me read just that range.
- Tenho o quadro completo de ambas as direções. Deixe-me confirmar rapidamente os helpers de mapeamento de campos referenciados.

**Variant A run#2** (8 blocks):

- Vou ler os arquivos relevantes do shim. Primeiro deixa eu ver a estrutura.
- The relevant files for tool call translation are likely `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read those plus the main shim entry.
- The toolConverter handles the schema/definitions side. Now I need the messageConverter (how assistant tool_use blocks and tool_result blocks are converted) and the streamParser (how OpenAI streaming t
- I need the middle of messageConverter (the tool_use → tool_calls logic, lines ~105-411) and the streamParser's main generator. Let me read those specific ranges.
- Os trechos centrais (a construção do `tool_calls` no assistant e a remontagem em streaming) foram elididos. Vou ler esses ranges específicos.
- Now the streaming reassembly — the core of how OpenAI's chunked `tool_calls` deltas get rebuilt into Anthropic tool_use blocks. Let me read lines 137-486 of streamParser.
- I need the rest of the tool-call streaming logic (337-486), where argument deltas accumulate and tool calls close.
- Vou ler o `helpers.ts` para entender `normalizeToolArguments`/`hasToolFieldMapping`, que é a peça de "normalize at stop".

**Variant A run#3** (6 blocks):

- Vou explorar os arquivos do openaiShim para entender a tradução de tool calls.
- Vou ler o resto do `convertMessages` (a parte que monta `tool_calls` na mensagem assistant e as mensagens `tool`) e o parser de streaming que reconstrói os tool calls.
- The summaries elided the core logic I need. Let me read the two key middle sections: the assistant `tool_use` → `tool_calls` mapping, and the streaming tool-call reconstruction loop.
- I have the outbound conversion fully. I still need the streaming inbound section (187–436) where tool-call deltas are accumulated. Let me read that range narrowly.
- The middle (236–385) is the actual tool-call delta accumulation — the heart of inbound parsing. Let me read it precisely.
- Tenho o quadro completo. Vou verificar rapidamente o `hasToolFieldMapping`/`normalizeToolArguments` para fechar a parte de normalização.

**Variant B run#2** (6 blocks):

- It's a directory now. The relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Let me read the full bodies of the relevant conversion functions.
- The middle of the stream parser (the tool-call accumulation loop) was elided. Let me read it, plus the `convertMessages` body and the request-building side where assistant `tool_use` blocks become Ope
- I still need two key middle sections: the request-side mapping of assistant `tool_use` → OpenAI `tool_calls` (messageConverter lines 215-411) and the stream accumulation loop (streamParser lines 187-4
- Now the streaming accumulation loop (the inbound direction: OpenAI `tool_calls` deltas → Anthropic `tool_use` events), lines 187-436.
- The middle of the streaming loop (237-386) is where `delta.tool_calls` chunks are accumulated into `activeToolCalls`. Let me read that.

### explain-auto-memory

**Variant A run#2** (2 blocks):

- Vou investigar os três subsistemas em paralelo para mapear o fluxo de ponta a ponta.
- Vou confirmar alguns pontos-chave do relatório lendo o código diretamente antes de explicar.

**Variant A run#3** (4 blocks):

- Vou explorar o código relevante para mapear o fluxo de ponta a ponta.
- O trace voltou bem completo, mas a parte do meio (fluxo interno do `extractMemories`) foi elidida. Vou ler os trechos-chave para fechar essa lacuna.
- Vou expandir o coração da extração (`initExtractMemories`) e o gate de sessão.
- Vou ler o restante (coalescing/trailing-run e o ponto de engate da hook).

**Variant B run#1** (7 blocks):

- Vou ler o código relevante. Como abrange três subsistemas, vou mapear a estrutura primeiro e em paralelo verificar o que a memória de equipe já registrou (extração em background supostamente inerte no
- Vou dispachar um agente Explore para mapear o fluxo end-to-end com excertos, em paralelo com leituras diretas dos arquivos centrais de cada subsistema.
- O agente Explore afirma algo que **contradiz a memória de equipe**: que `extractMemories` está LIVE no open build (via `tengu_passport_quail: true` em `_openBuildDefaults`), enquanto a memória diz que
- O outline de `no-telemetry-plugin.ts` **não mostra** nenhum `_openBuildDefaults` (só `stubs` e `noTelemetryPlugin`). O agente pode ter alucinado. Vou verificar onde os flags GrowthBook realmente resol
- A memória de equipe está mesmo desatualizada. Vou confirmar lendo o bloco do resolver e o caller da extração (stopHooks).
- Confirmado — a memória de equipe está desatualizada. Vou ler o caller (`stopHooks`) e o trecho de injeção no prompt para fechar a cadeia, e depois respondo.
- Cadeia completa confirmada. Antes de responder, vou corrigir a memória de equipe que está comprovadamente errada (verifiquei direto no código).

**Variant B run#2** (7 blocks):

- Vou ler o código relevante. Começo mapeando os três diretórios em paralelo.
- Agora expando os corpos centrais: a orquestração da extração e o carregamento do prompt de recall.
- O coração da extração (linhas 347–531) ficou omitido. Vou lê-lo, mais o recall e o SessionMemory.
- Agora vejo onde isso é enganchado: quem chama o extractor (hook de fim de turno), o recall, e o que o SessionMemory faz de diferente.
- Falta o wiring: onde o hook de fim de turno dispara a extração e onde `findRelevantMemories` é injetado em runtime. Vou localizar.
- Agora os dois pontos-chave: o gatilho no stopHooks e a injeção de recall em runtime.
- Vou ler o gate de ferramentas do agente forkado e a detecção de escrita direta, que completam o quadro.

**Variant B run#3** (7 blocks):

- Vou mapear os três subsistemas lendo o código. Começo localizando os arquivos.
- Vou ler os arquivos centrais de cada subsistema em paralelo.
- Agora os corpos-chave: o pipeline de extração e o de load/recall.
- O núcleo da extração (linhas 347–531) ficou omitido. Vou lê-lo, mais os corpos do SessionMemory e os pontos de chamada.
- Agora os pontos de fiação: onde os hooks de turn-end e o recall são chamados.
- Os dois pontos finais: o recall por query (attachments/memory.ts) e o gatilho de turn-end (stopHooks.ts).
- Tenho o quadro completo. Deixa eu confirmar onde o recall por query é disparado (quem chama `getRelevantMemoryAttachments`).

### explain-provider-resolution

**Variant A run#1** (3 blocks):

- Vou ler os dois arquivos.
- `activeProvider.ts` está claro. Agora a função principal do client.
- Preciso ver o miolo da função (linhas 145–327), onde está a ramificação Bedrock/Vertex/Foundry.

**Variant A run#3** (3 blocks):

- Vou ler os dois arquivos.
- Vou ler o corpo de `client.ts` para entender a seleção de SDK.
- Faltou o miolo de `getAnthropicClient` (linhas 145–327), onde estão os branches Bedrock/Vertex/Foundry. Vou ler.

**Variant B run#1** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do `client.ts`.
- Preciso ver o miolo (145–327) onde estão os branches de transport.

**Variant B run#2** (3 blocks):

- Vou ler os dois arquivos.
- Agora o corpo de `getAnthropicClient`, que é onde o transport vira SDK.
- Falta o miolo (linhas 145–327), onde os outros transports são tratados (Bedrock, Foundry, OpenAI shim, etc.).

**Variant B run#3** (3 blocks):

- Vou ler os dois arquivos.
- `activeProvider.ts` está claro. Agora o `getAnthropicClient` em client.ts.
- Vou ler o trecho do meio (145–327), que é onde fica a seleção de SDK por transport.

