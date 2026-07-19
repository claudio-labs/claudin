# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T23:15:21.885Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/dev/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 5
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 946 | 4958 | 0.00 | 0 | 4713 | 1.4175 | 78.4 | 15 | Read=12 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 1 | Y | 912 | 5833 | 0.00 | 0 | 4637 | 1.4605 | 70.6 | 14 | Read=11 Grep=1 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 1 | Y | 243 | 6075 | 0.00 | 1 | 16251 | 5.3656 | 238.9 | 7 | Read=4 Grep=0 Glob=1 Bash=0 Agent=1 |
| explain-auto-memory | B | 1 | Y | 494 | 6952 | 0.00 | 0 | 7305 | 2.4101 | 112.2 | 25 | Read=19 Grep=2 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 1 | Y | 0 | 3777 | 0.00 | 0 | 2362 | 0.3875 | 33.2 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | Y | 171 | 4164 | 0.00 | 0 | 2576 | 0.3661 | 36.3 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 2 | Y | 540 | 6159 | 0.00 | 0 | 4654 | 1.1682 | 68.7 | 13 | Read=10 Grep=1 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 2 | N | 215 | 308 | 0.00 | 1 | 74256 | 5.6355 | 797.0 | 54 | Read=41 Grep=1 Glob=3 Bash=7 Agent=1 |
| explain-auto-memory | A | 2 | Y | 753 | 5274 | 0.00 | 1 | 18696 | 6.7639 | 280.7 | 10 | Read=6 Grep=1 Glob=1 Bash=0 Agent=1 |
| explain-auto-memory | B | 2 | Y | 671 | 6865 | 0.00 | 0 | 6111 | 1.9597 | 84.6 | 21 | Read=14 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 2 | Y | 233 | 4008 | 0.00 | 0 | 2478 | 0.3642 | 43.4 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | N | 176 | 308 | 0.00 | 0 | 14587 | 0.6140 | 151.5 | 57 | Read=38 Grep=3 Glob=0 Bash=15 Agent=0 |
| explain-openai-shim | A | 3 | Y | 849 | 5730 | 0.00 | 0 | 4832 | 1.2601 | 72.0 | 14 | Read=11 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 3 | Y | 828 | 5586 | 0.00 | 0 | 4781 | 1.0891 | 70.0 | 15 | Read=13 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 3 | Y | 449 | 7363 | 0.00 | 1 | 16080 | 5.0896 | 219.8 | 15 | Read=10 Grep=0 Glob=3 Bash=0 Agent=1 |
| explain-auto-memory | B | 3 | Y | 812 | 5803 | 0.00 | 0 | 6573 | 2.0416 | 94.5 | 26 | Read=19 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-provider-resolution | A | 3 | Y | 159 | 3118 | 0.00 | 0 | 2070 | 0.3536 | 32.6 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 164 | 3698 | 0.00 | 0 | 2383 | 0.3885 | 36.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 4 | Y | 1216 | 5208 | 0.00 | 0 | 5009 | 1.2056 | 82.1 | 16 | Read=12 Grep=2 Glob=1 Bash=0 Agent=0 |
| explain-openai-shim | B | 4 | Y | 474 | 7724 | 0.00 | 0 | 58423 | 2.9153 | 535.1 | 400 | Read=393 Grep=0 Glob=1 Bash=4 Agent=0 |
| explain-auto-memory | A | 4 | Y | 244 | 5892 | 0.00 | 1 | 18208 | 5.9435 | 255.1 | 5 | Read=2 Grep=1 Glob=0 Bash=0 Agent=1 |
| explain-auto-memory | B | 4 | Y | 333 | 5558 | 0.00 | 1 | 17131 | 4.2116 | 225.4 | 4 | Read=2 Grep=0 Glob=0 Bash=0 Agent=1 |
| explain-provider-resolution | A | 4 | Y | 204 | 4230 | 0.00 | 0 | 2626 | 0.3955 | 40.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 4 | Y | 0 | 4163 | 0.00 | 0 | 2395 | 0.3881 | 37.0 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 5 | Y | 1220 | 5876 | 0.00 | 0 | 4781 | 1.2551 | 77.5 | 14 | Read=11 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 5 | Y | 802 | 5937 | 0.00 | 0 | 4345 | 0.8237 | 70.7 | 12 | Read=9 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 5 | Y | 173 | 5397 | 0.00 | 1 | 82930 | 4.8122 | 891.4 | 41 | Read=29 Grep=5 Glob=0 Bash=5 Agent=1 |
| explain-auto-memory | B | 5 | N | 549 | 308 | 0.00 | 1 | 196369 | 10.9372 | 1983.3 | 41 | Read=23 Grep=11 Glob=0 Bash=5 Agent=1 |
| explain-provider-resolution | A | 5 | Y | 159 | 3459 | 0.00 | 0 | 2216 | 0.5374 | 39.9 | 5 | Read=4 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 5 | Y | 0 | 3717 | 0.00 | 1 | 23913 | 2.6249 | 298.2 | 57 | Read=47 Grep=4 Glob=0 Bash=4 Agent=1 |

## Sumario

### A (baseline) (n=15)

- Avg narration chars: 493
- Avg answer chars: 5102
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.33
- Avg output tokens: 12527
- Avg cost: $2.4213 (total $36.3195)
- Avg wall: 163.6s
- Avg turns: 11.7
- Tool totals: Read=127 Grep=10 Glob=12 Bash=6 Agent=5

### B (feature) (n=12)

- Avg narration chars: 472
- Avg answer chars: 5500
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.17
- Avg output tokens: 11714
- Avg cost: $1.7233 (total $20.6791)
- Avg wall: 139.3s
- Avg turns: 49.1
- Tool totals: Read=539 Grep=13 Glob=12 Bash=10 Agent=2

### Delta

- Narration chars: 493 -> 472 (rel -4.2%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.33 -> 0.17
- Prompts com explore>=1 em B: 0/3
- Answer chars delta: 7.8%
- Cost delta: -28.8%
- Wall delta: -14.9%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: -4.2% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=0/3 (fail)
  - answerChars: 7.8% (OK)
  - cost: -28.8% (OK)
  - wall: -14.9% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (7 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- Há um arquivo `openaiShim.ts` e um diretório `openaiShim/`. Os mais relevantes para tradução de tool calls são `toolConverter.ts` e `messageConverter.ts`. Vou lê-los junto com os tipos e o parser de s
- Vou ler as funções específicas de conversão de mensagens e o parser de stream que lidam com tool calls.
- O corpo do parser de stream foi elidido (137-486) — é exatamente onde tool calls são remontados. Vou ler esse range e a montagem da request (tool_use → tool_calls).
- Falta o núcleo do parser (187-436), onde os deltas de `tool_calls` são acumulados. Vou ler esse range e a função `convertMessages` (tool_use → tool_calls na request).
- Falta o range 237-386 (acúmulo de tool_calls) e a montagem de `tool_calls` na request. Vou ler ambos.
- The core of the request-side conversion (215-411) is elided — that's where `tool_use` → `tool_calls` and `tool_result` → `role: tool` happen. Let me read it.

**Variant A run#2** (5 blocks):

- Vou ler os arquivos relevantes do openaiShim.
- Agora vou ler o resto do `convertMessages` (a parte que monta `tool_calls`/`tool`) e o `streamParser` que remonta tool calls na resposta.
- Vou ler a parte do `convertMessages` que monta os `tool_calls` (linhas 252-410) e o gerador `openaiStreamToAnthropic`.
- Vou ler a parte central do streamParser (137-336) que detecta o início de tool calls e a finalização (386-460).
- Tenho o quadro completo. Vou checar rapidamente o `hasToolFieldMapping`/`normalizeToolArguments` que explica o `normalizeAtStop`.

**Variant A run#3** (7 blocks):

- Vou localizar os arquivos do openaiShim primeiro.
- Os arquivos mais relevantes para tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los junto com o arquivo principal.
- Vou ler o messageConverter completo e o streamParser, que cobrem o caminho de volta (tool_use no histórico e tool calls no streaming).
- Preciso do corpo elidido do `convertMessages` (linhas 51-411) e do gerador de stream `openaiStreamToAnthropic`.
- Faltam os trechos centrais: o mapeamento `tool_use → tool_calls` (linhas 100-361) e a acumulação de deltas de tool call no streaming (137-486).
- Faltam dois trechos centrais: o pre-scan/emissão de `tool_calls` no `convertMessages` (150-311) e a acumulação dos deltas de tool call durante o stream (187-436).
- Falta o trecho do streaming onde os deltas de tool call são acumulados no buffer (linhas 237-386).

**Variant A run#4** (8 blocks):

- Vou ler os arquivos relevantes do openaiShim.
- A tradução de tool calls está espalhada por `toolConverter.ts` (schema das ferramentas e parsing dos argumentos), `messageConverter.ts` (mensagens contendo tool_use/tool_result) e `streamParser.ts` (m
- Vou ler o corpo completo de `messageConverter.ts` e o `streamParser.ts` (a parte de tool calls).
- Vou ler o restante de `convertMessages` (a parte que monta `tool_calls` no assistant e mensagens `role: tool`) e o stream parser que remonta tool calls no caminho de volta.
- Faltam dois trechos centrais: a montagem de `tool_calls` no assistant (linhas 258-410 do messageConverter) e o parsing incremental dos tool calls do stream (linhas 137-486 do streamParser). Vou ler am
- O trecho central do parsing incremental dos tool_calls do stream (187-436) ainda está elidido. Vou lê-lo.
- O núcleo do parsing incremental (236-385) ainda está elidido — é onde os deltas de `tool_calls` são acumulados. Vou ler exatamente esse intervalo.
- Tenho o quadro completo das três direções. Deixa eu confirmar rapidamente as funções de mapeamento de campos (`normalizeToolArguments`, `hasToolFieldMapping`) que aparecem no `normalizeAtStop`.

**Variant A run#5** (7 blocks):

- Vou explorar a estrutura do openaiShim primeiro.
- O converter de tools fica em `toolConverter.ts` e a tradução de mensagens em `messageConverter.ts`. Vou ler ambos, além do streamParser (que reconstrói tool calls vindas em streaming) e os types.
- The toolConverter handles tool *definitions*. Now I need the message-level translation: how an assistant `tool_use` block becomes an OpenAI `tool_calls`, and `tool_result` becomes a `tool` role messag
- I need the elided middle of messageConverter (the tool_use → tool_calls emission) and the streamParser body for the reverse (tool_calls → tool_use). Let me read both ranges.
- Preciso do miolo de ambos: a emissão `tool_use → tool_calls` (messageConverter 100-360) e a acumulação de deltas de `tool_calls` no streaming (streamParser 137-486).
- Faltam dois blocos centrais: messageConverter 150-320 (pré-scan de pares tool_use↔tool_result, drop de órfãos, emissão da tool message) e streamParser 187-436 (acumulação dos deltas de tool_calls).
- Falta o último bloco do streamParser (237-386): como os deltas de `tool_calls` chegam e são abertos como `content_block_start` / acumulados no `jsonBuffer`.

**Variant B run#1** (7 blocks):

- Vou explorar os arquivos relevantes.
- It's now a directory. The most relevant files for tool call translation: `toolConverter.ts`, `messageConverter.ts`, and the streaming parse in `streamParser.ts`. Let me read them.
- Now let me read the messageConverter functions and the streamParser (for the reverse direction - parsing tool calls from OpenAI back to Anthropic).
- Now let me read the rest of convertMessages (the assistant tool_use → tool_calls conversion, the key part) and the stream parser's tool-call assembly logic.
- Let me read the elided sections: the assistant tool_use → tool_calls conversion (lines 258-410) and the stream parser's tool-call start logic (lines 137-336).
- Let me see the closing of tool calls at finish (lines 386-440) and the `normalizeAtStop` field-mapping logic.
- I have a complete picture. Let me check `hasToolFieldMapping`/`normalizeToolArguments` to round out the `normalizeAtStop` path.

**Variant B run#3** (8 blocks):

- Vou explorar os arquivos relevantes do shim.
- É um diretório modularizado. Vou ler os arquivos centrais para a tradução de tool calls.
- Agora os blocos de conversão de mensagens e o stream parser (que reconstrói as tool calls do lado da resposta).
- The `convertMessages` body got truncated. Let me read it fully along with the stream parser.
- Preciso do meio de `convertMessages` (215-411), onde tool_use/tool_result viram mensagens OpenAI, e do corpo de `openaiStreamToAnthropic`.
- Falta o coração do stream parser (137-486), onde os `tool_calls` em delta são montados e remontados em `tool_use`. Vou ler esse trecho.
- O núcleo (187-436) ainda está elidido — é onde os deltas de `tool_calls` são acumulados. Vou ler exatamente esse intervalo.
- O trecho 236-387 é exatamente onde os deltas de tool_call são detectados e bufferizados. Vou ler.

**Variant B run#4** (5 blocks):

- Vou localizar e ler os arquivos relevantes do openaiShim.
- The relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- I already have `toolConverter.ts`. Let me read the remaining function bodies.
- Tenho quase tudo. Faltam os dois núcleos: o corpo de `convertMessages` (onde `tool_use`→`tool_calls` acontece) e o loop de reassembly do `openaiStreamToAnthropic`.
- Os dois trechos centrais continuam elididos. Vou ler em blocos menores.

**Variant B run#5** (5 blocks):

- Há tanto `openaiShim.ts` quanto o diretório `openaiShim/`. Os arquivos mais relevantes para tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou lê-los.
- I'll read the messageConverter symbols and the streamParser (which handles the reverse direction — parsing OpenAI tool calls back into Anthropic blocks).
- I need the rest of `convertMessages` (where Anthropic tool_use/tool_result map to OpenAI), and the stream parser's tool-call assembly. Let me read both.
- Let me read the elided middle sections — the core mapping logic in both files (the request-direction tool_use/tool_result handling, and the response-direction tool-call start detection).
- Vou ler o trecho final do `streamParser` (fechamento dos tool calls, onde o `normalizeAtStop` é aplicado) para completar o quadro.

### explain-auto-memory

**Variant A run#1** (2 blocks):

- Vou mapear o código dos três diretórios para descrever o fluxo de ponta a ponta.
- Deixa eu confirmar os dois pontos mais importantes diretamente no código — onde a extração dispara e como o agente é restringido a só escrever na pasta de memória.

**Variant A run#2** (6 blocks):

- Vou mapear o fluxo lendo o código nos três diretórios. Começo despachando uma exploração focada e em paralelo verifico a estrutura.
- O relatório cobriu memdir e SessionMemory, mas a seção do `extractMemories` foi elidida. Vou ler os arquivos-chave para fundamentar a explicação com precisão.
- Vou ler o coração do pipeline de extração: `initExtractMemories` e `executeExtractMemories`, mais o `createAutoMemCanUseTool`.
- The core elided. Let me read the `initExtractMemories` body (the trigger/decide/fork logic) and the canUseTool.
- Falta o miolo da decisão e o fork do agente. Vou ler o range elidido e o `createAutoMemCanUseTool`.
- Vou confirmar o `createAutoMemCanUseTool` (limites de permissão do agente forkado) e os dois pontos de wiring no loop principal.

**Variant A run#3** (4 blocks):

- Vou ler o código relevante nas três áreas. Deixa eu mapear a estrutura primeiro.
- Deixa eu dispatchar um Explore agent para mapear o wiring (quem chama o quê, gates de feature flag) enquanto leio os arquivos centrais em paralelo.
- Tenho o wiring. Deixa eu confirmar os miolos: o agente de extração, a montagem do prompt de memória, e o SessionMemory (que é distinto).
- Deixa eu ler o miolo da extração (a parte que dispara o subagente) e os gates de modo.

**Variant A run#4** (3 blocks):

- Vou explorar os três diretórios para traçar o fluxo de ponta a ponta.
- Vou confirmar os dois call sites mais críticos — o gatilho de extração e o ponto de injeção do recall.
- Confirmado. Vou ver o gatilho em `stopHooks.ts` para precisar a condição.

**Variant A run#5** (2 blocks):

- Vou mapear o código relevante antes de descrever o fluxo.
- O agente mapeou bem. Vou confirmar os pontos de integração críticos direto no código antes de escrever a explicação.

**Variant B run#1** (5 blocks):

- Vou mapear os três módulos e ler o código relevante.
- The elided middle of `runExtraction` is the core. Let me read it plus the trigger/recall helpers.
- Now the trigger helpers, the tool-permission gate, and where these hook into the REPL.
- Let me see the REPL trigger (stopHooks), recall injection (attachments/memory), and the SessionMemory path.
- I have enough to describe the full flow. Let me confirm one detail — where the `MEMORY.md` index content is injected and the SessionMemory inert status.

**Variant B run#2** (6 blocks):

- Vou mapear os três diretórios e ler o código relevante. Começando pela estrutura.
- Vou ler o miolo elidido do `runExtraction` (linhas 347-531) e o `executeExtractMemoriesImpl`, que é onde o forked agent é disparado.
- Agora a parte de recall (findRelevantMemories), onde o hook é disparado, e como o SessionMemory difere.
- Os pontos de disparo: stopHooks (extração), housekeeping (init), e onde findRelevantMemories injeta no prompt. Mais o miolo do SessionMemory.
- Por fim, a injeção de recall no query-time (attachments/memory.ts) e onde loadMemoryPrompt entra no system prompt.
- Tenho o quadro completo. Deixa eu confirmar os gates (`isAutoMemoryEnabled`, `isExtractModeActive`).

**Variant B run#3** (8 blocks):

- Vou mapear os três subsistemas e ler o código relevante. Começo descobrindo a estrutura dos diretórios.
- Agora leio os arquivos centrais de cada subsistema em paralelo.
- Vou expandir as funções centrais: a carga em contexto, os gates e o trigger de extração.
- Vou ler o miolo elidido de `runExtraction` (347–531) e as funções de orquestração restantes.
- Vejo bem o lado da extração. Agora o lado do recall (findRelevantMemories), o trigger no REPL e o papel do SessionMemory.
- Falta o wiring do recall (findRelevantMemories) e do system prompt (loadMemoryPrompt), e onde o hook de sessão é registrado.
- Vejo o recall injetado via attachments. Vou ler o injetor e o registro do hook de sessão.
- Tenho o quadro completo. Deixa eu confirmar o gatilho do recall (quem chama `getRelevantMemoryAttachments`) e o scan de frontmatter.

**Variant B run#4** (2 blocks):

- Vou mapear o fluxo lendo o código. Como abrange três subsistemas, vou disparar uma exploração focada e em paralelo ler os pontos de entrada principais.
- O mapa está completo. Vou confirmar os dois pontos mais críticos (o gatilho de fim-de-turno e a lógica de "fork como rede de segurança") lendo o código diretamente antes de escrever.

### explain-provider-resolution

**Variant A run#2** (3 blocks):

- Vou ler os dois arquivos.
- `activeProvider.ts` está claro. Vou ler o corpo de `getAnthropicClient` em client.ts, que é onde o transport vira SDK.
- Vou ler a parte elidida (145–327) que cobre Bedrock/Vertex/OpenAI shim e a seleção de SDK.

**Variant A run#3** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal de `client.ts`.
- Vou ler o trecho elidido (145-327) para ver os ramos Bedrock/Vertex/Foundry e o `ARGS`.

**Variant A run#4** (3 blocks):

- Vou ler os dois arquivos para traçar o caminho de decisão.
- Agora o `client.ts` para ver como o `transport` vira um SDK concreto.
- Vou ler o trecho elidido (onde provavelmente está o branching por transport).

**Variant A run#5** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do `client.ts`.
- Preciso ver o trecho elidido (145-327), onde fica a ramificação por transport/provider.

**Variant B run#1** (3 blocks):

- Vou ler os dois arquivos.
- `client.ts` é grande. Vou ler a função principal `getAnthropicClient`.
- Vou ler a parte elidida (145-327), que contém o roteamento entre transports.

**Variant B run#3** (3 blocks):

- Vou ler os dois arquivos.
- Vou expandir a função principal do `client.ts`.
- O miolo (145-327) foi elidido — é onde estão os branches de Bedrock/Foundry/Vertex. Vou ler.

