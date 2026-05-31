# Bench A/B — serial-read nudge (Explore + parallel Reads)

- Timestamp: 2026-05-30T14:28:52.455Z
- Model: `claude-opus-4-8`
- Baseline (A): `/home/viudes/projects/claudio/dist-bench-baseline/cli.mjs`
- Feature  (B): `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3
- KPIs: narrationChars, parallelReadFraction, exploreInvocations

## Tabela por invocacao

| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 469 | 5871 | 0.00 | 0 | 4368 | 0.7550 | 72.1 | 11 | Read=9 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-openai-shim | B | 1 | Y | 323 | 5598 | 0.00 | 0 | 4187 | 0.4535 | 63.9 | 9 | Read=7 Grep=0 Glob=0 Bash=1 Agent=0 |
| explain-auto-memory | A | 1 | Y | 399 | 6188 | 0.00 | 0 | 14017 | 1.7626 | 178.0 | 26 | Read=17 Grep=4 Glob=1 Bash=3 Agent=0 |
| explain-auto-memory | B | 1 | N | 197 | 308 | 0.00 | 1 | 69855 | 4.7858 | 812.4 | 34 | Read=14 Grep=4 Glob=6 Bash=8 Agent=1 |
| explain-provider-resolution | A | 1 | Y | 278 | 3210 | 0.00 | 0 | 2420 | 0.6979 | 40.7 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 1 | N | 207 | 308 | 0.00 | 0 | 10108 | 0.8289 | 132.7 | 30 | Read=7 Grep=10 Glob=2 Bash=10 Agent=0 |
| explain-openai-shim | A | 2 | Y | 683 | 5738 | 0.00 | 0 | 5056 | 1.3234 | 84.8 | 15 | Read=7 Grep=5 Glob=2 Bash=0 Agent=0 |
| explain-openai-shim | B | 2 | Y | 527 | 5257 | 0.00 | 0 | 3933 | 0.7752 | 56.6 | 11 | Read=8 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 2 | Y | 856 | 5916 | 0.00 | 0 | 5890 | 3.1454 | 100.8 | 22 | Read=17 Grep=1 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 2 | Y | 333 | 7873 | 0.00 | 1 | 18580 | 6.5048 | 275.4 | 8 | Read=5 Grep=0 Glob=1 Bash=0 Agent=1 |
| explain-provider-resolution | A | 2 | Y | 290 | 3917 | 0.00 | 0 | 2802 | 0.7078 | 45.0 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 2 | Y | 398 | 4037 | 0.00 | 0 | 2796 | 0.5245 | 46.5 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-openai-shim | A | 3 | Y | 844 | 4768 | 0.00 | 0 | 3999 | 1.1471 | 70.4 | 12 | Read=8 Grep=1 Glob=0 Bash=2 Agent=0 |
| explain-openai-shim | B | 3 | Y | 665 | 4955 | 0.00 | 0 | 3688 | 0.7791 | 57.3 | 11 | Read=8 Grep=0 Glob=2 Bash=0 Agent=0 |
| explain-auto-memory | A | 3 | Y | 789 | 5303 | 0.00 | 0 | 6078 | 2.7233 | 95.2 | 24 | Read=17 Grep=3 Glob=3 Bash=0 Agent=0 |
| explain-auto-memory | B | 3 | Y | 352 | 7014 | 0.00 | 1 | 16350 | 5.8882 | 249.6 | 10 | Read=6 Grep=0 Glob=2 Bash=0 Agent=1 |
| explain-provider-resolution | A | 3 | Y | 326 | 4074 | 0.00 | 0 | 2800 | 0.5302 | 45.3 | 6 | Read=5 Grep=0 Glob=0 Bash=0 Agent=0 |
| explain-provider-resolution | B | 3 | Y | 409 | 4359 | 0.00 | 0 | 2931 | 0.5849 | 48.8 | 7 | Read=5 Grep=1 Glob=0 Bash=0 Agent=0 |

## Sumario

### A (baseline) (n=9)

- Avg narration chars: 548
- Avg answer chars: 4998
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.00
- Avg output tokens: 5270
- Avg cost: $1.4214 (total $12.7926)
- Avg wall: 81.4s
- Avg turns: 14.2
- Tool totals: Read=90 Grep=14 Glob=9 Bash=6 Agent=0

### B (feature) (n=7)

- Avg narration chars: 430
- Avg answer chars: 5585
- Avg parallelReadFraction: 0.000
- Avg exploreInvocations: 0.29
- Avg output tokens: 7495
- Avg cost: $2.2158 (total $15.5103)
- Avg wall: 114.0s
- Avg turns: 8.9
- Tool totals: Read=44 Grep=1 Glob=7 Bash=1 Agent=2

### Delta

- Narration chars: 548 -> 430 (rel -21.6%)
- ParallelReadFraction: 0.000 -> 0.000 (abs 0.000)
- ExploreInvocations avg: 0.00 -> 0.29
- Prompts com explore>=1 em B: 1/3
- Answer chars delta: 11.7%
- Cost delta: 55.9%
- Wall delta: 40.2%

### Kill criteria

- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.
- KILL se narrationChars cai <20% rel OU wall sobe >+15%.

- Veredito: **KILL**
  - narrationChars: -21.6% (ship>=−30 fail)
  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=0.000 hit=1/3 (fail)
  - answerChars: 11.7% (OK)
  - cost: 55.9% (fail)
  - wall: 40.2% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (6 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- The relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Agora os outros dois arquivos centrais.
- Preciso da parte central (tool_use → tool_calls). Vou ler o miolo.
- Agora a parte final (350-411) e o streamParser (caminho de volta: tool_calls OpenAI → tool_use Anthropic).
- Vou ler o miolo do streamParser — onde os `tool_calls` fragmentados viram `tool_use` blocks Anthropic.

**Variant A run#2** (6 blocks):

- Vou ler os arquivos relevantes em `src/services/api/openaiShim/`.
- The most relevant files are `toolConverter.ts` and `messageConverter.ts`. Let me read those plus the streamParser and types.
- Vou ler o miolo do `messageConverter.ts` (a passagem pesada de conversão) e o `streamParser.ts` para a direção de resposta.
- I still need the core tool_use → tool_calls mapping (lines ~100–362). Let me read that range and the streamParser for the response direction.
- I need lines 150–311 (the tool_use/tool_result pre-scan and assistant message build) and the streamParser for the inbound direction.
- Now let me read the inbound (response) tool_call reassembly in streamParser.ts around those lines.

**Variant A run#3** (7 blocks):

- Vou localizar e ler os arquivos do openaiShim.
- It's a directory. The most relevant files for tool call translation: `toolConverter.ts`, `messageConverter.ts`, `streamParser.ts`. Let me read them.
- Vou ler o miolo do `convertMessages` (tool_use → tool_calls) e o `streamParser` (resposta OpenAI → Anthropic).
- The core tool_use → tool_calls mapping (lines ~100-365) keeps getting truncated. Let me read that exact window with grep to find the key section.
- Falta o trecho 150-314 (pré-scan e a parte que monta a mensagem `tool`). Vou ler exatamente essa janela.
- Agora o lado da resposta (streaming): como o shim reconstrói tool_calls do OpenAI de volta para `tool_use` Anthropic. Vou ler o streamParser.
- Tenho o quadro completo dos dois sentidos. Vou dar uma olhada rápida no `toolArgumentNormalization` e `types` para fechar os detalhes de normalização.

**Variant B run#1** (3 blocks):

- Vou explorar a estrutura do openaiShim primeiro.
- Preciso das seções centrais que foram omitidas. Vou ler os trechos de tradução de tool_use/tool_result e a reassemblagem dos tool_calls no stream.
- Faltam dois trechos-chave: a acumulação dos deltas de tool_call no stream e o pré-scan de pares tool_use/tool_result. Vou lê-los.

**Variant B run#2** (4 blocks):

- The directory has a `toolConverter.ts` — that's the core. Let me read the key files.
- The middle of messageConverter.ts (the tool_use ↔ tool_result handling) was elided. Let me read that section, plus the streamParser (which reconstructs tool calls from the OpenAI response).
- Both files' tool-call cores are still elided. Let me read those middle sections plus the argument normalization helper.
- Let me read the streamParser middle section (170-370) where tool_call deltas are accumulated, and the toolArgumentNormalization helper.

**Variant B run#3** (5 blocks):

- Vou explorar os arquivos relevantes do openaiShim.
- The most relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Preciso ver a parte central do messageConverter (conversão tool_use → tool_calls) e o streamParser (lado da resposta).
- I need the core sections that were elided: the request-side tool_use→tool_calls mapping (msgConverter ~100-360) and the stream-side tool_call reassembly (streamParser ~50-501).
- Faltam dois trechos centrais: o pré-scan de pares tool_use↔tool_result e a emissão das `tool` messages (msgConverter ~170-320), e a abertura/roteamento dos blocos de tool_call no stream (streamParser 

### explain-auto-memory

**Variant A run#1** (4 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo real. Começo mapeando os diretórios.
- Vou ler os arquivos centrais de cada módulo em paralelo.
- Vou ler as partes centrais omitidas dos três arquivos principais para completar o fluxo (injeção de recall, gatilho de extração, e o hook do session memory).
- Vou ler o ponto de injeção de recall (attachments/memory.ts) para fechar o ciclo de leitura.

**Variant A run#2** (9 blocks):

- Vou ler o código relevante das três áreas. Começando pelo mapeamento dos diretórios.
- Vou ler os arquivos principais de cada área em paralelo.
- Os arquivos foram truncados. Vou ler as seções centrais que ficaram omitidas, mais os auxiliares de scan e relevância.
- O summarizer continua cortando o miolo. Vou ler em janelas menores as funções centrais.
- Agora as peças centrais de extractMemories e o scan/relevância.
- Agora o scan, a relevância e o SessionMemory (que é distinto). Vou ler memoryScan, findRelevantMemories e o miolo de sessionMemory.
- Onde `findRelevantMemories` e `loadMemoryPrompt` são chamados, e o miolo do SessionMemory.
- Agora as pontas de integração: o recall via attachment, o stopHook que dispara extractMemories, e o registro do hook do SessionMemory.
- Por fim, o stopHook que dispara a extração e o ponto do system prompt que injeta o MEMORY.md.

**Variant A run#3** (10 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais de cada área em paralelo.
- Os middles foram omitidos. Vou ler as seções centrais — a lógica de extração, o build do prompt, e a sessão.
- O tool segue truncando. Vou usar leitura por símbolo para as funções centrais.
- Vou ler as funções centrais corretas por símbolo.
- Falta o corpo de `runExtraction` (linhas 347–531) e os prompts. Vou ler.
- Vou ler o restante de memdir, findRelevantMemories, e como os hooks são registrados.
- Vou ver onde `findRelevantMemories` é chamado (recall) e onde `executeExtractMemories` é disparado.
- Vou ver os pontos de integração: recall no QueryEngine, trigger em stopHooks, e injeção no system prompt.
- Vou ler a parte de recall (attachments) para fechar o ciclo.

**Variant B run#2** (3 blocks):

- Vou ler o código relevante para descrever o fluxo. Começo mapeando os três diretórios.
- Vou dispatchar um Explore para mapear o fluxo end-to-end enquanto leio os arquivos centrais em paralelo.
- O Explore deu o mapa completo. Vou confirmar dois pontos centrais lendo o miolo do extract (o fork que escreve os `.md`) e o builder do prompt.

**Variant B run#3** (3 blocks):

- Vou mapear os três subsistemas lendo o código. Como abrange várias pastas, vou disparar exploração focada.
- Deixa eu confirmar alguns pontos-chave direto no código — o gate de runtime, o trigger de extração e o que é o SessionMemory (que o report descreveu como sistema separado).
- Vou ler o núcleo da extração e do SessionMemory para precisar a descrição.

### explain-provider-resolution

**Variant A run#1** (2 blocks):

- O `client.ts` veio truncado no meio (linhas 51–391) — preciso ver como o SDK é efetivamente construído a partir do provider resolvido.
- O núcleo de `getAnthropicClient` (101–341) ainda está oculto — é onde mora a lógica de branch Bedrock/Vertex/Foundry. Vou ler em fatias menores.

**Variant A run#2** (3 blocks):

- `client.ts` veio truncado. Vou ler o miolo (onde os clientes são construídos por transporte).
- Ainda falta o miolo de `getAnthropicClient` (101–340). Vou expandir esse símbolo.
- O bloco central de `getAnthropicClient` (145–327) — onde ficam ARGS, Bedrock e Foundry — segue oculto. Lendo direto.

**Variant A run#3** (4 blocks):

- Vou ler os dois arquivos.
- `client.ts` veio truncado no meio (linhas 51–391). Preciso do trecho que constrói os SDKs.
- Ainda falta o corpo de `getAnthropicClient` (linhas 100–341), onde está o branching real. Vou expandir esse símbolo.
- The core branching (lines 145–327) keeps getting summarized away. Let me read that exact range.

**Variant B run#2** (4 blocks):

- Vou ler os dois arquivos.
- O `activeProvider.ts` está completo, mas o `client.ts` foi truncado no meio (linhas 51–391), que é justamente onde mora a construção do SDK. Vou ler essa parte.
- O núcleo do `getAnthropicClient` (linhas 100–344) ainda está sendo omitido. Vou expandir só essa função.
- O miolo do branching (linhas 145–327 — Bedrock/Foundry/Vertex) ainda foi omitido. Vou ler em janelas menores.

**Variant B run#3** (4 blocks):

- Vou ler os dois arquivos.
- O `client.ts` veio truncado no meio (linhas 51–391). Preciso dessa parte — é onde os SDKs são construídos.
- Ainda falta o miolo do `getAnthropicClient` (linhas 100–341), onde está o branching Bedrock/Vertex/Foundry.
- The repeated truncation is dropping lines 145–294 — the Bedrock/Foundry/Vertex branch entry points. Let me grab exactly that, plus check who actually consumes `transport`.

