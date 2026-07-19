# Bench A/B - token-efficient tools (FC v3 JSON tool_use)

- Timestamp: 2026-05-31T14:12:35.383Z
- Model: `claude-opus-4-8`
- Entry: `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 2
- A = baseline; B = DISABLE_EXPERIMENTAL_BETAS=false + JSON_TOOL_USE=1

## Tabela por invocacao

| Prompt | V | Run | OK | out tok | write tok | in tok | cache read | narr chars | answer chars | turns | tool turns | cost $ | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-openai-shim | A | 1 | Y | 68372 | 442573 | 7092 | 118879 | 0 | 4488 | 26 | 25 | 4.5703 | Read=4 Grep=1 Glob=4 Bash=15 other=1 |
| explain-openai-shim | B | 1 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-auto-memory | B | 1 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-auto-memory | A | 1 | Y | 19600 | 1087404 | 8278 | 689375 | 291 | 7190 | 7 | 6 | 7.6724 | Read=5 Grep=0 Glob=0 Bash=0 other=1 |
| explain-provider-resolution | A | 1 | Y | 2340 | 36891 | 8 | 198105 | 150 | 3760 | 5 | 4 | 0.3882 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 1 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | B | 2 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-openai-shim | A | 2 | Y | 4234 | 45251 | 18 | 527939 | 196 | 5482 | 14 | 13 | 0.6527 | Read=9 Grep=2 Glob=2 Bash=0 |
| explain-auto-memory | A | 2 | Y | 7048 | 486063 | 3681 | 553874 | 788 | 6031 | 30 | 29 | 3.5094 | Read=20 Grep=6 Glob=3 Bash=0 |
| explain-auto-memory | B | 2 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | B | 2 | N | 0 | 0 | 0 | 0 | 0 | 572 | 1 | 0 | 0.0000 | Read=0 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | A | 2 | Y | 2373 | 13464 | 8 | 221502 | 75 | 3932 | 5 | 4 | 0.2543 | Read=4 Grep=0 Glob=0 Bash=0 |

## Sumario

### A (baseline) (n=6)

- Avg output tokens: 17328
- Avg cache-creation (write) tokens: 351941
- Avg input tokens: 3181
- Avg cache-read tokens: 384946
- Avg narration chars: 250
- Avg narration blocks: 3.17
- Avg answer chars: 5147
- Avg cost: $2.8412 (total $17.0472)
- Avg total turns: 14.5 (tool_use turns: 13.5)
- Tool totals: Read=46 Grep=9 Glob=9 Bash=15 other=2

### B (feature)

Sem runs validas.

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

**Variant A run#2** (2 blocks):

- Agora a direção inversa — como o streaming OpenAI vira tool_use Anthropic.
- Tenho o quadro completo. Vou ler rapidamente o `helpers.ts` para confirmar `hasToolFieldMapping`/`normalizeToolArguments`.

### explain-auto-memory

**Variant A run#1** (3 blocks):

- Vou ler o código dessas três áreas para descrever o fluxo de ponta a ponta.
- O relatório do agente perdeu o miolo (Partes 2 e 3, sobre extractMemories e SessionMemory). Vou ler os arquivos-chave diretamente para fechar o fluxo.
- Vou ler o miolo da extração (a lógica central que estava elidida).

**Variant A run#2** (9 blocks):

- Vou ler o código relevante nesses três diretórios para descrever o fluxo de ponta a ponta.
- Deixa eu ler os arquivos centrais em paralelo.
- Vou expandir as funções-chave de cada subsistema.
- Vou ler o miolo elidido de `runExtraction` e as funções centrais do SessionMemory.
- Vou ler as peças restantes: o gating de ferramentas do agente forkado, a recall (`findRelevantMemories`), os paths, e onde os hooks são registrados no REPL.
- Vou ver como os hooks são acionados no fim de turno no REPL.
- Vou ler os pontos de disparo: stopHooks (extractMemories) e os consumidores de `loadMemoryPrompt`/`findRelevantMemories`.
- Vou ler o recall em runtime (`attachments/memory.ts`) e o `memoryScan`, fechando o ciclo.
- Tenho o quadro completo. Deixa eu confirmar onde o recall é injetado e o gate do SessionMemory.

### explain-provider-resolution

**Variant A run#1** (3 blocks):

- Vou ler os dois arquivos.
- Vou ler a função principal de construção do client.
- Vou ler o trecho do meio que ficou elidido (Bedrock/Foundry/shim routing).

**Variant A run#2** (2 blocks):

- Vou ler os dois arquivos.
- Vou ler o trecho central que decide entre os SDKs.

