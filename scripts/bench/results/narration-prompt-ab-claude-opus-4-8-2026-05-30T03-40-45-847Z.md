# Bench A/B — steering anti-narracao

- Timestamp: 2026-05-30T03:40:45.847Z
- Model: `claude-opus-4-8`
- Baseline (A): `dist-bench-baseline/cli.mjs`
- Feature  (B): `dist/cli.mjs`
- Runs por prompt: 3
- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)

## Tabela por invocacao

| Prompt | V | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 5 | 494 | 5619 | 4059 | 0.7230 | 62.3 | 11 | Read=8 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | 1 | Y | 4 | 635 | 5699 | 4287 | 1.2046 | 66.1 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 1 | Y | 10 | 880 | 7116 | 6775 | 2.1854 | 108.6 | 23 | Read=14 Grep=5 Glob=3 Bash=0 |
| explain-auto-memory | B | 1 | Y | 5 | 540 | 6416 | 5672 | 3.6917 | 98.1 | 18 | Read=14 Grep=2 Glob=1 Bash=0 |
| explain-provider-resolution | A | 1 | Y | 2 | 146 | 4150 | 2877 | 0.5278 | 46.8 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 1 | Y | 2 | 205 | 3923 | 2617 | 0.5344 | 40.3 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | A | 2 | Y | 6 | 762 | 5321 | 4104 | 0.7649 | 65.7 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | 2 | Y | 4 | 694 | 5895 | 3894 | 0.6478 | 62.1 | 10 | Read=7 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | 2 | N | 0 | 0 | 0 | 0 | 0.0000 | 2092.8 | 0 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-auto-memory | B | 2 | Y | 6 | 707 | 6568 | 5878 | 3.1562 | 95.6 | 20 | Read=13 Grep=3 Glob=3 Bash=0 |
| explain-provider-resolution | A | 2 | Y | 1 | 85 | 3785 | 2653 | 0.5218 | 41.4 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 2 | Y | 0 | 0 | 3677 | 2320 | 0.5169 | 36.8 | 5 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | A | 3 | Y | 6 | 782 | 6209 | 4461 | 0.7779 | 69.9 | 11 | Read=9 Grep=0 Glob=1 Bash=0 |
| explain-openai-shim | B | 3 | Y | 4 | 621 | 5041 | 3857 | 0.9505 | 63.8 | 11 | Read=9 Grep=0 Glob=0 Bash=1 |
| explain-auto-memory | A | 3 | Y | 9 | 764 | 5998 | 6432 | 3.1479 | 113.8 | 21 | Read=17 Grep=2 Glob=0 Bash=1 |
| explain-auto-memory | B | 3 | Y | 7 | 726 | 7123 | 6751 | 5.4029 | 125.0 | 26 | Read=16 Grep=6 Glob=3 Bash=0 |
| explain-provider-resolution | A | 3 | Y | 4 | 268 | 4124 | 2748 | 0.4733 | 42.7 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 3 | Y | 2 | 139 | 3804 | 2472 | 0.3252 | 40.8 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |

## Sumario

### A (baseline) (n=8)

- Avg narration blocks: 5.38
- Avg narration chars: 523
- Avg answer chars: 5290
- Avg output tokens: 4264
- Avg cost: $1.1403 (total $9.1220)
- Avg cache-creation tokens: 134409
- Avg turns: 12.0
- Tool totals: Read=72 Grep=7 Glob=8 Bash=1

### B (feature) (n=9)

- Avg narration blocks: 3.78
- Avg narration chars: 474
- Avg answer chars: 5350
- Avg output tokens: 4194
- Avg cost: $1.8256 (total $16.4301)
- Avg cache-creation tokens: 151173
- Avg turns: 12.7
- Tool totals: Read=82 Grep=11 Glob=11 Bash=1

### Delta

- **Input tokens: 2982 -> 3357 (rel 12.6%)**
- **Cache-creation tokens: 134409 -> 151173 (rel 12.5%)**
- Cache-read tokens: 357401 -> 384398 (rel 7.6%)
- Narration chars: 523 -> 474 (rel -9.3%)
- Narration blocks: 5.38 -> 3.78 (rel -29.7%)
- Output tokens: 4264 -> 4194 (rel -1.6%)
- Avg cost delta: 60.1%

### Kill criteria

- SHIP se B reduz narration chars em >=25% rel E answer chars nao cai >15% (resposta nao ficou pior) E cost nao piora >+5%.
- KILL se reducao de narration <25% rel (steering inerte — ver memorias de nudges inertes).
- INVESTIGAR se narration cai mas answer chars tambem despenca (modelo ficou mudo demais).

- Veredito: **INERT/REVERT**
  - narration chars delta: -9.3% (fail)
  - answer chars delta: 1.1% (OK)
  - cost delta: 60.1% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (5 blocks):

- Vou localizar e ler os arquivos do shim.
- The shim is split into a directory plus a top-level file. Let me read the key files for tool-call translation.
- The middle of messageConverter.ts was elided. Let me read the core conversion section (the tool_use → tool_calls part) and the stream parser (response side).
- Let me read the core tool-translation sections that were elided.
- Let me read the remaining core sections: the tool_result emission in messageConverter and the streaming tool_call assembly.

**Variant A run#2** (6 blocks):

- Vou localizar os arquivos do openaiShim.
- The most relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- Preciso da parte central do messageConverter (51-411) e do streamParser para a direção inversa (resposta OpenAI → Anthropic).
- I need the middle parts: messageConverter lines 101-361 (the tool_use → tool_calls mapping) and streamParser lines 51-494 (the tool_call reassembly). Let me read those targeted ranges.
- Faltam os trechos centrais: o pre-scan/montagem de tool_calls (messageConverter 151-311) e a remontagem dos tool_call deltas no stream (streamParser 101-444).
- The last gap is the streaming tool_call accumulation logic — streamParser lines 151-394, the heart of the OpenAI→Anthropic tool-call reassembly.

**Variant A run#3** (6 blocks):

- Vou ler os arquivos relevantes do openaiShim para entender a tradução de tool calls.
- É um diretório, não um arquivo único. Os mais relevantes para tool calls são `toolConverter.ts`, `messageConverter.ts` e `streamParser.ts`. Vou ler em paralelo.
- I need to read the omitted middle of messageConverter.ts (the tool_use↔tool_result handling) and the streamParser.
- I need the core middle sections: messageConverter lines 100-360 (the tool_use→tool_call mapping) and streamParser lines 51-494 (the tool_call reassembly).
- Faltam os núcleos: o pré-scan de pares e a emissão de `tool` messages (messageConverter 150–319) e o loop de reassembly dos tool_calls (streamParser 101–444).
- The last gap is the streamParser delta-handling loop (lines ~250-395) where tool_call fragments are accumulated.

**Variant B run#1** (4 blocks):

- I need the omitted middle of `messageConverter.ts` (the tool_use/tool_result handling) and the stream parser (where OpenAI tool_calls become Anthropic blocks).
- I have the converters but need the core of both: the tool_use→tool_calls emission in `messageConverter.ts` (lines ~100-360) and the tool_call assembly in `streamParser.ts` (lines ~51-494).
- I still need the two cores: the tool_use→tool_calls construction in messageConverter (~150-320) and the streaming tool_call assembly loop in streamParser (~101-444).
- The last gap is the streaming tool_call delta-assembly loop (~151-395) where fragmented `tool_calls` arrive chunk by chunk.

**Variant B run#2** (4 blocks):

- The relevant files are split across a few modules. Let me read the key ones for tool-call translation.
- I need the middle of messageConverter.ts (the tool_use → tool_calls emission) and the stream parser (where OpenAI deltas become Anthropic tool_use blocks).
- I have the schema and message-converter halves. Let me read the two key middle sections: the `tool_use` → `tool_calls` emission in messageConverter (~lines 250-367) and the streaming tool-call reassem
- I have the outbound path fully. Let me read the inbound streaming tool-call delta handling (streamParser ~200-370) where OpenAI `tool_calls` deltas get turned into Anthropic `tool_use` content blocks.

**Variant B run#3** (4 blocks):

- The relevant files for tool-call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`. Let me read them.
- I need the middle sections that were elided — the actual tool_call emission in `convertMessages` and the tool_call reassembly in the stream loop.
- I still need the core middle sections: messageConverter lines 100-360 (the tool_use→tool_calls emission and tool_result handling) and streamParser lines 100-444 (the tool_call delta reassembly).
- Two more gaps: messageConverter 150-320 (tool_use/tool_result pre-scan and emission) and streamParser 200-395 (the tool_call delta accumulation loop).

### explain-auto-memory

**Variant A run#1** (10 blocks):

- Vou mapear os três diretórios e ler os arquivos-chave em paralelo.
- Vou ler os arquivos centrais de cada módulo.
- Os arquivos foram truncados. Vou ler as seções centrais e os módulos de suporte.
- Vou ler a lógica central restante: a execução do forked agent no extractMemories, o `buildMemoryLines` do memdir e o memoryScan.
- Vou ler o núcleo do `buildMemoryLines` (montagem do system prompt) e do sessionMemory.
- Vou ler o `buildMemoryLines` e onde recall/extract são acionados.
- Vou ver os pontos de entrada: o stop hook (extract) e onde o recall (`findRelevantMemories`) é chamado no QueryEngine.
- O recall vem de `attachments/memory.ts`. Vou ler esse e o restante do sessionMemory (núcleo).
- Vou ver a função de recall em attachments e o gatilho (hook) do sessionMemory.
- Vou ler as duas funções-chave de recall (`getRelevantMemoryAttachments`) e o gatilho do sessionMemory para fechar o fluxo.

**Variant A run#3** (9 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Os arquivos são grandes; vou ler as partes centrais que ficaram omitidas e os arquivos restantes.
- O filtro está cortando o miolo. Vou ler em blocos menores.
- Agora os arquivos de SessionMemory e as peças restantes do memdir.
- Vou ler o miolo de memdir.ts (buildMemoryLines / getMemorySystemPrompt) e de sessionMemory.ts, mais quem chama o quê.
- Agora vou ver o wiring: quem chama `loadMemoryPrompt`, `executeExtractMemories`, `findRelevantMemories`, e o miolo do sessionMemory.
- Vou ver os call sites de recall e do stop hook.
- Vou ler o attachment de recall, o stopHook, e o núcleo do `extractSessionMemory`.
- Tenho o quadro completo. Vou confirmar os dois pontos de injeção (QueryEngine e stopHooks).

**Variant B run#1** (5 blocks):

- Now the read side and the extract/session side. Let me read those.
- Now the core of extractMemories (the forked-agent extraction logic, lines 51-560) and how findRelevantMemories is wired into a turn.
- Now let me find where `findRelevantMemories` is called per-turn and where SessionMemory's hook is registered, to complete the read-path wiring.
- Now the read-path wiring: how `findRelevantMemories` is consumed in QueryEngine and where SessionMemory registers its hook.
- Let me read the query-time recall attachment path to complete the read side.

**Variant B run#2** (6 blocks):

- Vou ler o código dos três diretórios para descrever o fluxo real, não o documentado.
- Deixa eu ler os arquivos centrais de cada subsistema.
- Os arquivos são grandes. Vou ler as seções centrais — a construção do prompt em `memdir.ts`, o impl de extração e o hook de sessão — além dos helpers de scan/relevância.
- Vou ler o miolo da extração (350-514) e o hook de sessão (50-431), além de como `loadMemoryPrompt` é consumido no system prompt e os helpers de scan/relevância.
- Vou ler o restante do hook de sessão, o `findRelevantMemories`, e onde `loadMemoryPrompt`/`executeExtractMemories` são plugados.
- Falta a ponta de recall (injeção das memórias relevantes via attachment) e o gatilho no stopHooks. Vou confirmar.

**Variant B run#3** (7 blocks):

- Vou ler o código relevante nessas três áreas.
- Vou ler o miolo do `memdir.ts` e os arquivos de extractMemories/SessionMemory.
- Preciso do miolo desses arquivos para entender o fluxo. Vou ler as partes centrais.
- Agora vou ler o miolo do SessionMemory e como o extractMemories é registrado no stopHooks, além de buildMemoryLines em memdir.
- Agora vou ver onde extractMemories é registrado (stopHooks) e onde loadMemoryPrompt/findRelevantMemories são consumidos, mais buildMemoryLines.
- Vou ver como o stopHooks chama extractMemories e como QueryEngine/prompts consomem loadMemoryPrompt e findRelevantMemories.
- Tenho o quadro completo. Vou ver rapidamente onde o attachment de memória (recall por query) é montado para confirmar o gatilho.

### explain-provider-resolution

**Variant A run#1** (2 blocks):

- Preciso ler o miolo do `client.ts` (a parte que monta o SDK por transport).
- Falta o trecho central (148–292) com o dispatch Bedrock/Foundry/Vertex.

**Variant A run#2** (1 blocks):

- Preciso ver o miolo do `client.ts` (linhas 51-391) onde a construção do SDK acontece.

**Variant A run#3** (4 blocks):

- Vou ler os dois arquivos.
- O miolo de `client.ts` (linhas 51–391) foi omitido — é onde a construção do SDK acontece. Vou ler.
- Falta o núcleo de `getAnthropicClient` (101–345). Vou ler.
- Falta o trecho 145–299 — onde ficam as ramificações de Bedrock/Foundry/Vertex. Vou ler.

**Variant B run#1** (2 blocks):

- client.ts foi truncado no miolo. Vou ler a parte central que constrói os clients por transport.
- Falta o miolo de `getAnthropicClient` (linhas 145–327), onde os branches por transport/provider são decididos.

**Variant B run#3** (2 blocks):

- client.ts foi truncado no meio. Preciso ver a parte que constrói os SDKs.
- O miolo (Bedrock/Vertex branch, escolha de SDK) ainda está oculto.

