# Bench A/B - token-efficient tools (FC v3 JSON tool_use)

- Timestamp: 2026-05-31T15:51:53.615Z
- Model: `claude-opus-4-8`
- Entry: `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 4
- A = baseline; B = DISABLE_EXPERIMENTAL_BETAS=false + JSON_TOOL_USE=1

## Tabela por invocacao

| Prompt | V | Run | OK | out tok | write tok | in tok | cache read | narr chars | answer chars | turns | tool turns | cost $ | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-auto-memory | A | 1 | Y | 13723 | 465178 | 6444 | 341059 | 252 | 5177 | 5 | 4 | 3.4532 | Read=3 Grep=0 Glob=0 Bash=0 other=1 |
| explain-auto-memory | B | 1 | Y | 14475 | 598809 | 14199 | 209973 | 151 | 6256 | 4 | 3 | 4.2804 | Read=2 Grep=0 Glob=0 Bash=0 other=1 |
| explain-auto-memory | B | 2 | Y | 19602 | 1169891 | 13035 | 1013175 | 244 | 5477 | 7 | 6 | 8.3736 | Read=5 Grep=0 Glob=0 Bash=0 other=1 |
| explain-auto-memory | A | 2 | Y | 42063 | 183827 | 16185 | 176456 | 271 | 7729 | 59 | 58 | 2.3696 | Read=41 Grep=11 Glob=0 Bash=6 |
| explain-auto-memory | A | 3 | Y | 17999 | 1099992 | 4449 | 1381292 | 210 | 5306 | 3 | 2 | 8.0378 | Read=0 Grep=0 Glob=0 Bash=1 other=1 |
| explain-auto-memory | B | 3 | Y | 6256 | 141127 | 4683 | 404820 | 543 | 7214 | 20 | 19 | 1.2643 | Read=15 Grep=3 Glob=1 Bash=0 |
| explain-auto-memory | B | 4 | Y | 13668 | 471401 | 6201 | 314769 | 82 | 4549 | 2 | 1 | 3.4763 | Read=0 Grep=0 Glob=0 Bash=0 other=1 |
| explain-auto-memory | A | 4 | Y | 19077 | 725367 | 13545 | 981962 | 315 | 5430 | 5 | 4 | 5.5692 | Read=1 Grep=0 Glob=0 Bash=2 other=1 |

## Sumario

### A (baseline) (n=4)

- Avg output tokens: 23216
- Avg cache-creation (write) tokens: 618591
- Avg input tokens: 10156
- Avg cache-read tokens: 720192
- Avg narration chars: 262
- Avg narration blocks: 2.25
- Avg answer chars: 5911
- Avg cost: $4.8575 (total $19.4298)
- Avg total turns: 18.0 (tool_use turns: 17.0)
- Tool totals: Read=45 Grep=11 Glob=0 Bash=9 other=3

### B (feature) (n=4)

- Avg output tokens: 13500
- Avg cache-creation (write) tokens: 595307
- Avg input tokens: 9530
- Avg cache-read tokens: 485684
- Avg narration chars: 255
- Avg narration blocks: 2.75
- Avg answer chars: 5874
- Avg cost: $4.3487 (total $17.3947)
- Avg total turns: 8.3 (tool_use turns: 7.3)
- Tool totals: Read=22 Grep=3 Glob=1 Bash=0 other=3

### Delta

- **Output tokens: 23216 -> 13500 (rel -41.8%)** [PRIMARIO]
- **Write (cache_creation): 618591 -> 595307 (rel -3.8%)** [PRIMARIO]
- Narration chars: 262 -> 255 (rel -2.7%)
- Answer chars: 5911 -> 5874 (rel -0.6%)
- Cost: -10.5%
- Total turns: 18.0 -> 8.3 (rel -54.2%)
- Tool_use turns: 17.0 -> 7.3 (rel -57.4%)

### Kill criteria

- SHIP se B reduz output tokens em >=3% rel E answer chars nao cai >15% E cost nao piora.
- INERT se output delta fica em [-2%, +2%] (provavelmente provider nao 1P, header sendo dropado).
- INVESTIGAR se narration baixa muito (>=20%) sem que output baixe — efeito colateral inesperado.

- Veredito: **SHIP candidate**
  - output delta: -41.8% (OK)
  - answer delta: -0.6% (OK)
  - cost delta: -10.5% (OK)

## Amostras de narracao (texto fora da resposta final)

### explain-auto-memory

**Variant A run#1** (2 blocks):

- Vou ler o código dessas três áreas para traçar o fluxo de ponta a ponta. Como cruza vários arquivos, vou disparar um agente de exploração focado.
- Vou confirmar os dois pontos mais críticos do caminho (recall e write) direto no código antes de descrever.

**Variant A run#2** (3 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Os arquivos têm nomes diferentes do que tentei. Agora vou ler os corretos.
- Tenho a maior parte. Faltam quatro peças-chave: o gatilho em `stopHooks`, o recall via attachments, `loadMemoryPrompt`, e a resolução de path.

**Variant A run#3** (2 blocks):

- Vou ler o código relevante. Começo mapeando os três diretórios.
- Vou dispachar um agente Explore para mapear o fluxo ponta a ponta de forma abrangente, já que cruza esses três módulos e seus pontos de integração.

**Variant A run#4** (2 blocks):

- Vou mapear os três subsistemas lendo o código. Começo pela estrutura de cada diretório.
- O Explore mapeou bem, mas afirmou que `extractMemories/prompts.ts:108` está com dano de build (`if (!true)`). O git status inicial só mostrava `betas.ts` modificado, não esse arquivo. Vou verificar an

**Variant B run#1** (2 blocks):

- Vou explorar o código dessas três áreas para descrever o fluxo de ponta a ponta.
- Vou confirmar os dois pontos mais críticos do trace antes de descrever.

**Variant B run#2** (2 blocks):

- Vou mapear os três subsistemas lendo o código. Como abrange várias pastas, disparo um Explore para investigar em paralelo enquanto eu leio os pontos-chave.
- Vou confirmar os pontos de cola mais críticos antes de descrever, para garantir precisão.

**Variant B run#3** (6 blocks):

- Vou mapear os três diretórios e ler o código relevante.
- Vou ler os corpos centrais: o loop de extração, o gate de habilitação, recall e SessionMemory.
- Vou ler o miolo elidido do `runExtraction` (linhas 347-531) e o restante do arquivo de extração (hook registration, fork agent).
- Agora o gate de tools do agente forkado, o loadMemoryPrompt (injeção no system prompt) e quem dispara o hook + SessionMemory.
- Quem dispara a extração (hook turn-end) e o recall por turno.
- Quem chama `getRelevantMemoryAttachments` (gatilho de recall) e o SessionMemory.

**Variant B run#4** (1 blocks):

- Vou explorar os três subsistemas em paralelo para mapear o fluxo de ponta a ponta.

