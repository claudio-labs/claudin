# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-31T00:31:09.926Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 1137 | 5318 | 0.00 | 0 | 4425 | 1.8042 | 83.2 | 13 | Read=11 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 1 | Y | 1329 | 5077 | 0.00 | 0 | 5342 | 1.8168 | 80.8 | 17 | Read=12 Grep=2 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 1 | Y | 232 | 4642 | 0.00 | 1 | 17845 | 5.4892 | 266.9 | 6 | Read=2 Grep=2 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 1 | Y | 733 | 5701 | 0.00 | 0 | 6666 | 2.1613 | 96.2 | 23 | Read=16 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 0 | 3575 | 0.00 | 0 | 2258 | 0.3852 | 32.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 0 | 3742 | 0.00 | 0 | 2350 | 0.3882 | 34.1 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | N | 236 | 308 | 0.00 | 1 | 78271 | 4.7937 | 927.6 | 30 | Read=18 Grep=1 Glob=1 Bash=8 Agent=1 |
| explain-openai-shim | B | 2 | Y | 725 | 5587 | 0.00 | 0 | 4295 | 1.1521 | 70.1 | 13 | Read=10 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 2 | Y | 496 | 5369 | 0.00 | 0 | 6314 | 2.1524 | 93.0 | 26 | Read=16 Grep=6 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | Y | 674 | 6396 | 0.00 | 0 | 6560 | 2.2385 | 97.8 | 24 | Read=17 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 157 | 4190 | 0.00 | 0 | 2687 | 0.3967 | 36.6 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 199 | 3955 | 0.00 | 0 | 2402 | 0.3628 | 36.5 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 841 | 6711 | 0.00 | 0 | 5162 | 0.7527 | 81.1 | 15 | Read=13 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 3 | Y | 830 | 5605 | 0.00 | 0 | 5134 | 1.6951 | 89.3 | 17 | Read=11 Grep=3 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 3 | Y | 744 | 7184 | 0.00 | 0 | 6772 | 2.2366 | 106.1 | 25 | Read=19 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | Y | 573 | 6015 | 0.00 | 0 | 5775 | 1.6057 | 81.2 | 21 | Read=15 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 3 | Y | 0 | 3829 | 0.00 | 1 | 31575 | 3.2104 | 348.9 | 56 | Read=38 Grep=11 Glob=0 Bash=5 Agent=1 |
| explain-provider-resolution | B | 3 | N | 136 | 308 | 0.00 | 1 | 92804 | 6.4753 | 954.3 | 26 | Read=8 Grep=3 Glob=4 Bash=9 Agent=1 |

## Sumario

### A (baseline) (n=8)

- Avg narration chars: 451
- Avg answer chars: 5102
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.25
- Avg output tokens: 9630
- Avg cost: $2.0534 (total $16.4275)
- Avg wall: 131.1s
- Avg turns: 18.9
- Tool totals: Read=107 Grep=21 Glob=6 Bash=7 Agent=2

### B (feature) (n=8)

- Avg narration chars: 633
- Avg answer chars: 5260
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 4816
- Avg cost: $1.4276 (total $11.4204)
- Avg wall: 73.2s
- Avg turns: 15.6
- Tool totals: Read=89 Grep=13 Glob=15 Bash=0 Agent=0

### Delta

- Narration chars: 451 -> 633 (rel 40.4%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.25 -> 0.00
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: 3.1%
- Cost delta: -30.5%
- Wall delta: -44.1%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: 40.4% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: 3.1% (OK)
  - cost: -30.5% (OK)
  - wall: -44.1% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (10 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- The directory exists with several files. The most relevant for tool call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Now the message converter and stream parser, which handle the actual tool *calls* (request and response directions).
- The middle was elided. Let me read the key conversion sections — the tool_result body conversion, content blocks, and the heavyweight convertMessages pass.
- I need the elided 100-279 range — that's the core of convertMessages (pre-scan, tool_use/tool_result pairing, the assistant tool_calls emission lead-up, and the tail after 329).
- Now the section after 329 (Gemini thought_signature, push assistant msg) up to the coalescing pass at ~412.
- Now the reverse direction — parsing OpenAI streamed tool_calls back into Anthropic format. Let me read streamParser.ts.
- The core tool-call streaming logic is in lines 137-486. Let me read it.
- The crucial part — the per-delta tool_call accumulation — is in 187-436. Let me read that.
- The middle (236-387) holds the tool_call delta-to-block mapping. Let me read it.

**Variant A run#3** (6 blocks):

- Vou localizar e ler os arquivos relevantes do openaiShim.
- O `openaiShim` virou um diretório. Vou ler os arquivos centrais para a tradução de tool calls.
- Agora vou ler as funções específicas do `messageConverter.ts` (lado da requisição: tool_use/tool_result → OpenAI) e a parte do `streamParser.ts` que monta tool calls a partir do stream (lado da respos
- Preciso do corpo de `convertMessages` (montagem de tool_use → tool_calls e tool_result → role:tool) e do miolo do stream parser (linhas 137-486) onde os tool calls são acumulados.
- Faltam os dois miolos: a montagem de `tool_use → tool_calls` / `tool_result → role:tool` em `convertMessages` (215-410) e o acúmulo incremental dos tool calls no stream (187-436).
- Falta o trecho central do streamParser (237-386) onde os deltas de `tool_calls` são acumulados — o coração da tradução de saída.

**Variant B run#1** (9 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- Os arquivos mais relevantes para tradução de tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- Vou ler as funções relevantes desses dois arquivos maiores: a conversão de blocos de mensagem (que inclui `tool_use`/`tool_result`) e o parser de streaming (que reconstrói tool calls vindas do OpenAI)
- Preciso ver o miolo do stream parser (linhas 137-486), onde as tool calls são reconstruídas a partir dos deltas do OpenAI. Também quero ver como `convertMessages`/o cliente monta as mensagens com `too
- O núcleo da reconstrução das tool calls está em 187-436. Vou ler esse trecho e também `convertMessages` + onde o cliente monta `tool_calls`/`role: tool`.
- Falta o miolo do delta de tool calls (237-386) e onde a request de saída monta `tool_calls`/`role: tool` — provavelmente em `messagesClient.ts`.
- O caminho de saída (request) — onde `tool_use` vira `tool_calls` e `tool_result` vira `role: tool` — está em `messagesClient.ts`. Vou ver esses trechos.
- `convertMessages` foi truncado. Vou ler o corpo completo (165-461) onde acontece a conversão de saída `tool_use`→`tool_calls` e `tool_result`→`role: tool`.
- The key middle section (215-411) has the actual tool_use→tool_calls and tool_result→role:tool conversion. Reading it.

**Variant B run#2** (7 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- The relevant files are toolConverter.ts and messageConverter.ts. Let me read them along with the streamParser for the response direction.
- Vou ler o messageConverter completo e o streamParser (direção de resposta).
- Falta a parte de assistant tool_use → OpenAI tool_calls (no convertMessages) e a direção de resposta (streaming). Vou ler ambos.
- Preciso do miolo das duas funções: o assistant tool_use → tool_calls (linhas 258-410 do messageConverter) e o parsing de tool_calls no stream (137-486 do streamParser).
- O miolo do streamParser (187-436) é o que processa os deltas de tool_calls. Vou ler.
- O miolo (237-386) é onde os deltas de tool_call são acumulados. Vou ler essa faixa.

**Variant B run#3** (8 blocks):

- Vou explorar a estrutura do openaiShim primeiro.
- Há tanto um arquivo `openaiShim.ts` quanto um diretório `openaiShim/`. As partes relevantes a tool calls estão em `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou ler.
- I'll read the messageConverter symbols and the streamParser for the response side.
- Agora vou ler o `convertMessages` (caminho de saída, que gera `tool_calls` a partir de `tool_use`) e o gerador de stream (caminho de entrada).
- I need the elided ranges — the core of both directions. Let me read them.
- Falta o miolo do stream parser (linhas 187-436) onde os `tool_calls` chegando são acumulados.
- O núcleo que acumula os `tool_calls` chegando (237-386).
- Tenho o quadro completo. Deixa eu confirmar rapidamente o que `hasToolFieldMapping`/`normalizeToolArguments` fazem, já que são referenciados no parser.

### explain-auto-memory

**Variant A run#1** (2 blocks):

- Vou mapear o fluxo lendo os três subsistemas. Como abrange vários arquivos, despacho um Explore agent para traçar ponta a ponta.
- Deixa eu confirmar os pontos mais críticos antes de descrever (o skip da fork e os gates do open build).

**Variant A run#2** (5 blocks):

- Vou mapear os três subsistemas lendo o código. Começo pela estrutura de cada diretório.
- Vou dispatchar um Explore agent para mapear o fluxo end-to-end de forma abrangente, e em paralelo leio os arquivos-núcleo de cada subsistema.
- Agora expando os símbolos-chave de cada subsistema.
- Vou ler o núcleo elidido de `runExtraction` (a lógica de extração real) e o `createAutoMemCanUseTool`, mais os símbolos centrais do SessionMemory.
- Agora vejo o lado do recall e onde os hooks são registrados/disparados.

**Variant A run#3** (7 blocks):

- Vou ler o código dessas três áreas. Começo mapeando os arquivos.
- Vou expandir os símbolos centrais e ler os arquivos restantes.
- Preciso da lógica central elidida do `runExtraction` (linhas 347-531) e dos símbolos do SessionMemory.
- Agora o que falta: o ponto de injeção no REPL (hook que dispara o extractor), o sandbox de permissão de escrita, e onde `findRelevantMemories` é chamado no recall. Vou rastrear.
- Falta o lado do recall (attachments/memory.ts), a injeção no system prompt (prompts.ts) e o gancho de turn-end (stopHooks.ts).
- handleStopHooks só retornou a assinatura. Vou ler o corpo e onde o extractor é disparado.
- Tenho o quadro completo. Vou fechar entendendo onde o prefetch/recall é consumido e como o system prompt injeta o MEMORY.md.

**Variant B run#1** (8 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Deixa eu ler os arquivos centrais de cada subsistema em paralelo.
- Vou expandir as funções principais de cada arquivo.
- Vou ler o trecho central da extração (347-531) e o gatekeeper de tools.
- Agora vou ver os pontos de ligação: quem chama o extractor (hook de fim de turno) e quem chama findRelevantMemories (recall), além do SessionMemory.
- Vou localizar os pontos de disparo no REPL: o stop hook que chama o extractor e onde o recall injeta memórias.
- Tenho o quadro completo. Deixa eu confirmar o gatilho do recall (onde `getRelevantMemoryAttachments` é chamado) e o registro do housekeeping.
- Tenho o que preciso para descrever o fluxo completo. Deixa eu confirmar o gatilho do recall.

**Variant B run#2** (9 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Let me read the core files in parallel.
- Let me read the key function bodies and the other core files.
- Let me read the core extraction logic (the elided range) and `loadMemoryPrompt`.
- Now let me see the wiring: where extraction is triggered, where memories are recalled, and the canUseTool guard.
- Let me find the recall-path caller and the extraction trigger hook.
- Now the recall path (attachments/memory.ts) and the extraction trigger (stopHooks.ts).
- Now let me see what triggers the recall attachments per user turn.
- Let me quickly check the SessionMemory side (the "inert" safety-net fork) and the directory/paths semantics.

**Variant B run#3** (7 blocks):

- Vou mapear os três subsistemas e ler o código relevante.
- Vou ler os arquivos centrais de cada subsistema em paralelo.
- Vou expandir as funções-chave do fluxo em paralelo.
- Vou ler o miolo do `runExtraction` (347-531) e a extração do SessionMemory.
- Agora vou ver como tudo se conecta: onde os hooks são registrados, onde `loadMemoryPrompt` entra no system prompt, e quem chama `findRelevantMemories`.
- Os resultados estão poluídos por arquivos de bench. Vou restringir a `src/`.
- Vou ler os pontos de ligação: o stop hook (fim de turno), `initSessionMemory` e o recall em attachments.

### explain-provider-resolution

**Variant A run#2** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do `client.ts`.
- Vou ler o trecho elidido (145-327), onde fica a maior parte da decisão de transporte.

**Variant B run#2** (3 blocks):

- Vou ler os dois arquivos.
- Vou ler o corpo de `getAnthropicClient` que é onde o transport decide o SDK.
- Vou ler o trecho elidido (145-327), que tem a ramificação Bedrock/Vertex e onde o transport entra.

