# Bench A/B - token-efficient tools (FC v3 JSON tool_use)

- Timestamp: 2026-05-31T15:21:24.921Z
- Model: `claude-opus-4-8`
- Entry: `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 2
- A = baseline; B = DISABLE_EXPERIMENTAL_BETAS=false + JSON_TOOL_USE=1

## Tabela por invocacao

| Prompt | V | Run | OK | out tok | write tok | in tok | cache read | narr chars | answer chars | turns | tool turns | cost $ | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 4609 | 61365 | 16 | 439933 | 773 | 6135 | 11 | 10 | 0.7188 | Read=7 Grep=2 Glob=0 Bash=1 |
| explain-openai-shim | B | 1 | Y | 4350 | 155458 | 16 | 258027 | 879 | 4984 | 14 | 13 | 1.2095 | Read=11 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | B | 1 | Y | 6501 | 312064 | 8748 | 312226 | 901 | 6162 | 23 | 22 | 2.3128 | Read=16 Grep=3 Glob=3 Bash=0 |
| explain-auto-memory | A | 1 | Y | 16550 | 702753 | 10111 | 666484 | 4303 | 572 | 8 | 7 | 5.1898 | Read=3 Grep=2 Glob=0 Bash=0 other=2 |
| explain-provider-resolution | A | 1 | Y | 2298 | 32323 | 8 | 203205 | 187 | 3626 | 5 | 4 | 0.3611 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 1 | Y | 2448 | 56242 | 8 | 130988 | 0 | 3955 | 5 | 4 | 0.4782 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | B | 2 | Y | 4452 | 107587 | 24 | 512489 | 486 | 4952 | 13 | 12 | 1.0401 | Read=8 Grep=3 Glob=0 Bash=1 |
| explain-openai-shim | A | 2 | Y | 21376 | 180428 | 7097 | 248806 | 704 | 6067 | 30 | 29 | 1.8220 | Read=24 Grep=3 Glob=0 Bash=2 |
| explain-auto-memory | A | 2 | N | 271240 | 1640586 | 22857 | 397919 | 50 | 33 | 19 | 18 | 17.3479 | Read=4 Grep=5 Glob=4 Bash=4 other=1 |
| explain-auto-memory | B | 2 | N | 0 | 0 | 0 | 0 | 0 | 33 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 2 | N | 0 | 0 | 0 | 0 | 0 | 33 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | A | 2 | N | 0 | 0 | 0 | 0 | 0 | 33 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |

## Sumario

### A (baseline) (n=4)

- Avg output tokens: 11208
- Avg cache-creation (write) tokens: 244217
- Avg input tokens: 4308
- Avg cache-read tokens: 389607
- Avg narration chars: 1492
- Avg narration blocks: 4.25
- Avg answer chars: 4100
- Avg cost: $2.0229 (total $8.0916)
- Avg total turns: 13.5 (tool_use turns: 12.5)
- Tool totals: Read=38 Grep=7 Glob=0 Bash=3 other=2

### B (feature) (n=4)

- Avg output tokens: 4438
- Avg cache-creation (write) tokens: 157838
- Avg input tokens: 2199
- Avg cache-read tokens: 303433
- Avg narration chars: 567
- Avg narration blocks: 5.00
- Avg answer chars: 5013
- Avg cost: $1.2601 (total $5.0406)
- Avg total turns: 13.8 (tool_use turns: 12.8)
- Tool totals: Read=39 Grep=6 Glob=5 Bash=1

### Delta

- **Output tokens: 11208 -> 4438 (rel -60.4%)** [PRIMARIO]
- **Write (cache_creation): 244217 -> 157838 (rel -35.4%)** [PRIMARIO]
- Narration chars: 1492 -> 567 (rel -62.0%)
- Answer chars: 4100 -> 5013 (rel 22.3%)
- Cost: -37.7%
- Total turns: 13.5 -> 13.8 (rel 1.9%)
- Tool_use turns: 12.5 -> 12.8 (rel 2.0%)

### Kill criteria

- SHIP se B reduz output tokens em >=3% rel E answer chars nao cai >15% E cost nao piora.
- INERT se output delta fica em [-2%, +2%] (provavelmente provider nao 1P, header sendo dropado).
- INVESTIGAR se narration baixa muito (>=20%) sem que output baixe — efeito colateral inesperado.

- Veredito: **SHIP candidate**
  - output delta: -60.4% (OK)
  - answer delta: 22.3% (OK)
  - cost delta: -37.7% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#1** (5 blocks):

- Vou investigar a estrutura do openaiShim primeiro.
- The key files are `toolConverter.ts` (tool schema translation), `messageConverter.ts` (message/tool_use/tool_result translation), and `streamParser.ts` (parsing OpenAI tool_calls back to Anthropic). L
- I need the elided middle of convertMessages (215-411) where assistant tool_use → tool_calls happens, and the streamParser plus the non-stream response handling.
- Now the reverse direction: parsing OpenAI tool_calls back to Anthropic. Let me read streamParser.ts (incremental streaming tool_calls) and the non-stream handler in messagesClient.ts around line 928.
- I have enough to explain both directions. Let me read the streaming tool_call assembly core (lines 285-450) to be precise on incremental reassembly.

**Variant A run#2** (4 blocks):

- The relevant files are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts` (for the response direction). Let me read them.
- I have toolConverter. Now let me read the two key functions for the request and response direction of tool calls: `convertContentBlocks`/`convertToolResultContent` (request) and the streamParser body 
- I need the elided middle of streamParser (the tool-call streaming logic, lines 137-486) and the `convertMessages` body (165-460) which assembles the assistant tool_use → OpenAI tool_calls.
- Falta a parte central de `convertMessages` (215-410) onde os blocos `tool_use` do assistant viram `tool_calls` e os `tool_result` viram mensagens `role: "tool"`. Vou ler.

**Variant B run#1** (7 blocks):

- Vou localizar e ler os arquivos relevantes do openaiShim.
- Os conversores ficam em arquivos dedicados. Vou ler os relevantes em paralelo.
- Vou ler o messageConverter completo e o streamParser (que faz o caminho inverso, parseando tool_calls da resposta).
- Vou ler o corpo do `convertMessages` (linhas 165-411) e o `openaiStreamToAnthropic` para cobrir os dois sentidos da tradução.
- Preciso do miolo de ambos: a parte do `convertMessages` que emite `tool_calls` e trata `tool_result`, e a parte do streamParser que acumula os deltas de tool_call.
- Faltam dois trechos centrais: o `convertMessages` (155-314 do messageConverter) que monta tool_calls e tool messages, e o miolo do streamParser (187-436) que acumula os deltas de tool_call.
- Falta o trecho do streamParser (237-386) onde os deltas de `tool_calls` chegando do provider são acumulados e mapeados para blocos `tool_use` Anthropic.

**Variant B run#2** (4 blocks):

- The directory exists. The key files for tool call translation are `toolConverter.ts`, `messageConverter.ts`, and `streamParser.ts`.
- The critical middle section (215-411) is elided. That's where tool_use→tool_calls and tool_result→role:tool happens. Let me read it.
- Now the response/streaming side — how OpenAI tool_calls get parsed back into Anthropic tool_use. Let me read the relevant parts.
- Now the streaming side, where tool_call deltas are reassembled. Let me look at streamParser.ts.

### explain-auto-memory

**Variant A run#1** (5 blocks):

- Vou explorar os três diretórios para mapear o fluxo completo.
- Deixa eu confirmar os pontos de integração centrais antes de descrever.
- Confirmado. Vou verificar rapidamente o núcleo da extração.
- Tudo confere. Aqui está o fluxo de ponta a ponta.  ## Visão geral  Há **três subsistemas distintos**, e só dois estão realmente ativos no open build:  | Subsistema | Papel | Estado no open build | |--
- Essa memória está correta e completa sobre os gates. Vou só adicionar uma linha sobre TEAMMEM, que é um fato novo verificado.

**Variant B run#1** (9 blocks):

- Vou ler o código dos três subsistemas. Começo mapeando os diretórios.
- Deixa eu dispachar um agente Explore para mapear o fluxo completo enquanto leio os arquivos-chave em paralelo.
- Agora os fluxos principais. Vou expandir as funções-chave de cada subsistema.
- Vou ler o miolo da extração (o que de fato roda o agente forkado) e a parte de SessionMemory.
- Agora vou ver a fiação: quem chama `executeExtractMemories`, `loadMemoryPrompt`, `findRelevantMemories`, e o que `createAutoMemCanUseTool` restringe.
- Vou ver os pontos de fiação: o hook que dispara extração, onde o prompt de memória é injetado, e onde `findRelevantMemories` é chamado.
- Vou ler o gatilho de recall (attachments/memory.ts) e o stopHook que dispara a extração, mais o SessionMemory core para o contraste.
- Agora o caller do recall e o SessionMemory para contraste.
- Vou confirmar o gatilho do recall (quando dispara) e os gates de feature flag.

### explain-provider-resolution

**Variant A run#1** (3 blocks):

- Vou ler os dois arquivos para traçar o caminho de decisão.
- Vou expandir a função principal do client.ts.
- Vou ler a parte do meio (145-327), onde fica a seleção entre Bedrock/Vertex/Foundry.

