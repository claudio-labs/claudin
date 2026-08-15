# Bench A/B — effort (adaptive vs xhigh) x narracao

- Timestamp: 2026-05-30T01:39:17.538Z
- Model: `claude-opus-4-8`
- Bundle (A e B): `/home/dev/projects/claudio/dist/cli.mjs`
- Variante A: effort=`adaptive`
- Variante B: effort=`xhigh`
- Runs por prompt: 3
- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)

## Tabela por invocacao

| Prompt | V | eff | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |
|---|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | adaptive | 1 | Y | 5 | 668 | 5357 | 3967 | 0.7141 | 59.9 | 12 | Read=9 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | xhigh | 1 | Y | 7 | 973 | 6291 | 5766 | 2.0930 | 92.6 | 15 | Read=12 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | adaptive | 1 | Y | 0 | 0 | 5889 | 5490 | 3.6608 | 91.1 | 20 | Read=14 Grep=2 Glob=3 Bash=0 |
| explain-auto-memory | B | xhigh | 1 | N | 2 | 266 | 309 | 36608 | 1.7819 | 402.6 | 69 | Read=38 Grep=19 Glob=3 Bash=8 |
| explain-provider-resolution | A | adaptive | 1 | Y | 2 | 179 | 4199 | 2710 | 0.5331 | 42.0 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | xhigh | 1 | Y | 0 | 0 | 3451 | 3595 | 0.5461 | 47.5 | 5 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | A | adaptive | 2 | Y | 5 | 659 | 5250 | 4139 | 0.6745 | 65.5 | 11 | Read=9 Grep=0 Glob=0 Bash=1 |
| explain-openai-shim | B | xhigh | 2 | N | 2 | 283 | 308 | 10645 | 0.7640 | 155.6 | 38 | Read=21 Grep=1 Glob=5 Bash=10 |
| explain-auto-memory | A | adaptive | 2 | Y | 7 | 781 | 6410 | 6192 | 2.4437 | 90.6 | 22 | Read=16 Grep=2 Glob=3 Bash=0 |
| explain-auto-memory | B | xhigh | 2 | Y | 3 | 314 | 7132 | 7388 | 4.8009 | 124.1 | 23 | Read=16 Grep=3 Glob=3 Bash=0 |
| explain-provider-resolution | A | adaptive | 2 | Y | 3 | 280 | 4350 | 2937 | 0.5115 | 44.7 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | xhigh | 2 | Y | 3 | 249 | 3581 | 4083 | 0.4349 | 56.5 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | A | adaptive | 3 | Y | 4 | 464 | 6168 | 4210 | 0.8128 | 69.5 | 10 | Read=7 Grep=0 Glob=2 Bash=0 |
| explain-openai-shim | B | xhigh | 3 | Y | 11 | 1152 | 7012 | 6017 | 1.3149 | 105.8 | 16 | Read=13 Grep=0 Glob=2 Bash=0 |
| explain-auto-memory | A | adaptive | 3 | Y | 7 | 558 | 6917 | 6309 | 3.7208 | 102.9 | 21 | Read=15 Grep=2 Glob=3 Bash=0 |
| explain-auto-memory | B | xhigh | 3 | Y | 8 | 729 | 7565 | 8198 | 5.4097 | 152.5 | 30 | Read=20 Grep=6 Glob=3 Bash=0 |
| explain-provider-resolution | A | adaptive | 3 | Y | 3 | 266 | 4241 | 2775 | 0.3491 | 44.4 | 6 | Read=5 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | xhigh | 3 | Y | 3 | 217 | 4295 | 3057 | 0.3239 | 45.0 | 5 | Read=4 Grep=0 Glob=0 Bash=0 |

## Sumario

### A (effort=adaptive) (n=9)

- Avg narration blocks: 4.00
- Avg narration chars: 428
- Avg answer chars: 5420
- Avg output tokens: 4303
- Avg cost: $1.4912 (total $13.4204)
- Avg cache-creation tokens: 117096
- Avg turns: 12.7
- Tool totals: Read=85 Grep=6 Glob=13 Bash=1

### B (effort=xhigh) (n=7)

- Avg narration blocks: 5.00
- Avg narration chars: 519
- Avg answer chars: 5618
- Avg output tokens: 5443
- Avg cost: $2.1319 (total $14.9234)
- Avg cache-creation tokens: 169326
- Avg turns: 14.3
- Tool totals: Read=74 Grep=9 Glob=10 Bash=0

### Delta (A=adaptive -> B=xhigh)

- Narration chars: 428 -> 519 (rel 21.2%)
- Narration blocks: 4.00 -> 5.00 (rel 25.0%)
- Output tokens: 4303 -> 5443 (rel 26.5%)
- Answer chars: 5420 -> 5618 (rel 3.7%)
- Avg cost delta: 43.0%

### Kill criteria (meta usuario: -70 a -80% de narracao)

- SHIP (recomendar xhigh default p/ loops 4.8) se B reduz narration chars em >=70% rel E answer chars nao cai >15% E custo nao estoura (>+30%).
- PARCIAL/INVESTIGAR se narration cai mas <70%, OU cai >=70% porem custo sobe demais (>+30%) — comparar com Frente 1 (stripper determinístico).
- KILL (effort inerte p/ narracao) se reducao <25% — seguir com Frente 1.
- DEGRADOU se answer chars despenca >15% (modelo ficou mudo demais).

- Veredito: **INERTE p/ narracao -> seguir Frente 1**
  - narration chars delta: 21.2% (meta <=-70: nao)
  - answer chars delta: 3.7% (OK)
  - cost delta: 43.0% (caro)

> Ler runs BRUTAS, nao so medias. Narracao no mesmo baseline varia ~551-1037 chars
> entre runs identicas (ruido). Exigir efeito bem acima desse ruido.

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A (effort=adaptive) run#1** (5 blocks):

- The relevant directory is `src/services/api/openaiShim/`. Let me read the key files for tool call translation.
- I need the middle of messageConverter.ts (the tool_use → tool_calls emission) and the streamParser for the reverse direction.
- I need the core of both: the tool_use → tool_calls emission (messageConverter ~100-365) and the stream's tool_call reassembly (streamParser ~50-494).
- I still need two key middle sections: messageConverter ~150-320 (the tool_use pairing/scan + tool message emission) and streamParser ~100-444 (the tool_call delta reassembly). Let me read them.
- Now the core streaming loop where tool_call deltas are accumulated (streamParser ~150-394).

**Variant A (effort=adaptive) run#2** (5 blocks):

- Os arquivos relevantes para tradução de tool calls são `toolConverter.ts` (definições de tools), `messageConverter.ts` (tool_use/tool_result nas mensagens) e `streamParser.ts` (tool calls na resposta 
- Preciso do miolo dos dois arquivos — onde realmente acontece tool_use→tool_calls e a remontagem dos tool_calls do stream.
- The truncation keeps hiding the core (150-314). Let me grab exactly that — the tool_result→tool message emission and the pre-scan.
- Agora o miolo do streamParser (a remontagem dos tool_calls de volta para Anthropic).
- Falta o trecho onde os deltas de tool_call são acumulados (lines ~250-350) e a finalização (399-494).

**Variant A (effort=adaptive) run#3** (4 blocks):

- The directory exists alongside a barrel file. Let me read the most relevant files for tool call translation.
- I need the middle of messageConverter.ts (the tool_use → tool_calls emission and the stream parsing). Let me read the omitted section and the stream parser.
- Let me read the key middle sections: the tool_use → tool_calls emission and the stream's tool_call reassembly.
- Let me read the finish_reason / tool finalization path to complete the round-trip picture.

**Variant B (effort=xhigh) run#1** (7 blocks):

- Vou ler os arquivos relevantes. Primeiro deixa eu ver a estrutura.
- O `messageConverter.ts` veio truncado no miolo (onde está o tratamento de tool_use ↔ tool_result). Vou ler essa parte e o `streamParser.ts`.
- Ainda faltam os miolos. Preciso da parte do `messageConverter.ts` (linhas 100-361, onde monta os `tool_calls` do assistant e os `role:"tool"`) e do `streamParser.ts` (linhas 50-494, onde reassembla os
- Faltam os dois trechos centrais: o pre-scan/emissão de `role:"tool"` no converter (150-311) e o reassembly dos deltas de tool_call no parser (100-444).
- Falta o coração do parser: as linhas 150-394, onde os deltas de `tool_calls` chegam fragmentados e são reagrupados em blocos `tool_use`.
- O trecho 200-344 é exatamente onde um novo `tool_call` é detectado e os argumentos vão sendo acumulados. Preciso dele.
- Tenho o quadro completo. Só vou confirmar o que `hasToolFieldMapping`/`normalizeToolArguments` fazem, já que o `normalizeAtStop` depende disso.

**Variant B (effort=xhigh) run#3** (11 blocks):

- Há tanto um arquivo `openaiShim.ts` quanto um diretório `openaiShim/`. Vou focar no diretório, começando pelos arquivos centrais para tradução de tool calls.
- Agora os dois arquivos centrais: conversão de mensagens (request) e parsing do streaming (response).
- I need the middle of `messageConverter.ts` — that's where tool_use/tool_result handling lives.
- I still need the core loop (lines 100–365) where tool_use/tool_result pairing and assistant tool_calls mapping happens.
- The truncation keeps hiding the pre-scan and tool_result→tool message emission (lines 150–315). Reading that range explicitly.
- Now the response side: how OpenAI streaming tool_calls get reassembled into Anthropic `tool_use` blocks.
- The core stream loop (51–494) handles tool_call reassembly. Reading it.
- The tool-call reassembly logic is in 100–445. Reading that span.
- The middle (150–394) holds the per-chunk tool_call delta handling. Reading it.
- The actual tool_call delta-start handler (where activeToolCalls gets populated and content_block_start for tool_use is emitted) is in 200–344. Reading it.
- Vou conferir rapidamente a normalização de argumentos referenciada pelo streamParser.

### explain-auto-memory

**Variant A (effort=adaptive) run#2** (7 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo real.
- Vou ler os arquivos centrais de cada área.
- Preciso do miolo desses arquivos: a função que monta o prompt de memória, o executor de extração e o loop do session memory.
- Falta o miolo do `runExtraction` (a chamada real ao forked agent) e como os dois sistemas são disparados.
- Agora vou ver os gatilhos: onde `executeExtractMemories` é chamado (stopHooks) e onde `extractSessionMemory` é registrado (postSamplingHooks), além de como `findRelevantMemories` injeta no prompt.
- Tenho o suficiente para descrever o fluxo. Deixa eu confirmar dois pontos de integração: onde a `MEMORY.md` entra no system prompt e onde `findRelevantMemories` é chamada.
- Vou confirmar o gate do `loadMemoryPrompt` e a injeção de recall via attachment.

**Variant A (effort=adaptive) run#3** (7 blocks):

- Vou ler o código dos três módulos para descrever o fluxo real.
- Vou ler os arquivos centrais de cada módulo.
- Os trechos centrais foram omitidos. Vou ler o miolo de cada arquivo.
- Agora o miolo do `memdir.ts` (construção do prompt) e o gancho em `stopHooks`.
- Agora os ganchos: onde `loadMemoryPrompt` é consumido, onde `executeExtractMemories` é chamado, e o papel de `findRelevantMemories`.
- Agora os dois pontos de fiação: o attachment de recall e o gatilho em stopHooks.
- Tenho o quadro completo. Deixa eu confirmar onde o attachment de recall é disparado por turno.

**Variant B (effort=xhigh) run#2** (3 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- The middle of `runExtraction` keeps getting elided. Let me read it directly in smaller windows.
- I have enough to describe the flow. Let me confirm the two trigger points (stop hook for extraction, system-prompt injection of the guidelines).

**Variant B (effort=xhigh) run#3** (8 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo completo.
- Agora os dois serviços que dirigem a escrita das memórias:
- Agora as funções de guarda da extração e o `SessionMemory`:
- Now the SessionMemory service (past-session search) and the trigger point in stopHooks:
- Agora o gatilho (stopHooks) e o lado de recall (findRelevantMemories):
- Agora o gatilho de extração (stopHooks) e onde `findRelevantMemories` é chamado, mais o caminho do SessionMemory:
- Agora o lado de recall — como as memórias relevantes chegam ao prompt via attachment:
- Tenho o quadro completo das três áreas e seus pontos de integração. Deixa eu confirmar quem consome `loadMemoryPrompt` (injeção do MEMORY.md no system prompt) para fechar a ponta de leitura.

### explain-provider-resolution

**Variant A (effort=adaptive) run#1** (2 blocks):

- client.ts foi truncado no meio. Preciso ver a função que constrói o SDK por transport.
- The middle of `getAnthropicClient` (Bedrock/Vertex branches) is still hidden. Let me read it.

**Variant A (effort=adaptive) run#2** (3 blocks):

- client.ts foi truncado no meio (linhas 51–391). Preciso da parte que constrói o SDK por transport.
- Ainda falta o miolo de `getAnthropicClient` (101–341), que é o núcleo. Vou expandir o símbolo.
- Falta o bloco 145–327 (onde estão os branches Bedrock/Foundry/Vertex). Vou lê-lo direto.

**Variant A (effort=adaptive) run#3** (3 blocks):

- client.ts foi truncado no meio — preciso do trecho que monta os SDKs.
- Preciso do miolo de `getAnthropicClient` (linhas 100-341), onde a seleção real de SDK acontece.
- O trecho de decisão Bedrock/Vertex/Foundry (145-294) ainda está oculto. Vou ler exatamente essa fatia.

**Variant B (effort=xhigh) run#2** (3 blocks):

- O `client.ts` veio truncado no miolo. Preciso da parte que constrói o SDK por transport.
- The decision path lives in `getAnthropicClient` (lines 95-377). Let me read it.
- O miolo crítico (145-329) — onde escolhe Bedrock/Foundry/Vertex — continua oculto.

**Variant B (effort=xhigh) run#3** (3 blocks):

- Vou ler os dois arquivos para mapear o caminho de decisão.
- Agora o `getAnthropicClient`, que é onde o transport vira um SDK concreto.
- O miolo (145–334) é onde os SDKs Bedrock/Vertex/Foundry são escolhidos. Preciso dele.

