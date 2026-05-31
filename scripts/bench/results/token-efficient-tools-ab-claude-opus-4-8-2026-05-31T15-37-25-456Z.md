# Bench A/B - token-efficient tools (FC v3 JSON tool_use)

- Timestamp: 2026-05-31T15:37:25.456Z
- Model: `claude-opus-4-8`
- Entry: `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 2
- A = baseline; B = DISABLE_EXPERIMENTAL_BETAS=false + JSON_TOOL_USE=1

## Tabela por invocacao

| Prompt | V | Run | OK | out tok | write tok | in tok | cache read | narr chars | answer chars | turns | tool turns | cost $ | tools |
|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| explain-auto-memory | A | 2 | Y | 5558 | 259044 | 4363 | 294671 | 663 | 5961 | 19 | 18 | 1.9271 | Read=14 Grep=3 Glob=1 Bash=0 |
| explain-auto-memory | B | 2 | Y | 18909 | 1333244 | 12217 | 865526 | 169 | 5287 | 5 | 4 | 9.2993 | Read=0 Grep=1 Glob=0 Bash=2 other=1 |
| explain-provider-resolution | B | 2 | Y | 2253 | 56300 | 8 | 131033 | 78 | 3524 | 5 | 4 | 0.4738 | Read=4 Grep=0 Glob=0 Bash=0 |
| explain-provider-resolution | A | 2 | Y | 2383 | 68234 | 8 | 167018 | 0 | 3915 | 5 | 4 | 0.5696 | Read=4 Grep=0 Glob=0 Bash=0 |

## Sumario

### A (baseline) (n=2)

- Avg output tokens: 3971
- Avg cache-creation (write) tokens: 163639
- Avg input tokens: 2186
- Avg cache-read tokens: 230845
- Avg narration chars: 332
- Avg narration blocks: 3.50
- Avg answer chars: 4938
- Avg cost: $1.2484 (total $2.4967)
- Avg total turns: 12.0 (tool_use turns: 11.0)
- Tool totals: Read=18 Grep=3 Glob=1 Bash=0

### B (feature) (n=2)

- Avg output tokens: 10581
- Avg cache-creation (write) tokens: 694772
- Avg input tokens: 6113
- Avg cache-read tokens: 498280
- Avg narration chars: 124
- Avg narration blocks: 2.00
- Avg answer chars: 4406
- Avg cost: $4.8866 (total $9.7731)
- Avg total turns: 5.0 (tool_use turns: 4.0)
- Tool totals: Read=4 Grep=1 Glob=0 Bash=2 other=1

### Delta

- **Output tokens: 3971 -> 10581 (rel 166.5%)** [PRIMARIO]
- **Write (cache_creation): 163639 -> 694772 (rel 324.6%)** [PRIMARIO]
- Narration chars: 332 -> 124 (rel -62.7%)
- Answer chars: 4938 -> 4406 (rel -10.8%)
- Cost: 291.4%
- Total turns: 12.0 -> 5.0 (rel -58.3%)
- Tool_use turns: 11.0 -> 4.0 (rel -63.6%)

### Kill criteria

- SHIP se B reduz output tokens em >=3% rel E answer chars nao cai >15% E cost nao piora.
- INERT se output delta fica em [-2%, +2%] (provavelmente provider nao 1P, header sendo dropado).
- INVESTIGAR se narration baixa muito (>=20%) sem que output baixe — efeito colateral inesperado.

- Veredito: **INVESTIGAR**
  - output delta: 166.5% (fail)
  - answer delta: -10.8% (OK)
  - cost delta: 291.4% (fail)

## Amostras de narracao (texto fora da resposta final)

### explain-openai-shim

### explain-auto-memory

**Variant A run#2** (7 blocks):

- Vou mapear o código dos três subsistemas. Começando pela estrutura.
- Boa, estrutura mapeada. Vou ler os arquivos-núcleo em paralelo.
- Vou expandir os símbolos-chave de cada um e ver os gates/triggers.
- Falta o miolo do `runExtraction` (forquilha do agente) e como o hook é disparado. Lendo o trecho elidido e os pontos de registro.
- Falta o handler do stop hook (onde extração e session memory são chamadas) e o recall (`findRelevantMemories`). Lendo.
- Falta ver onde o stop hook dispara a extração e onde `findRelevantMemories` é consumido por turno. Dois últimos reads.
- Vou ver o consumidor do recall em query-time (`attachments/memory.ts`) para fechar a ponta de leitura.

**Variant B run#2** (2 blocks):

- Vou mapear o fluxo lendo os três subsistemas. Começando com exploração das estruturas.
- Vou confirmar os pontos centrais (gating e gatilho da extração) antes de descrever.

### explain-provider-resolution

**Variant B run#2** (2 blocks):

- Vou ler os dois arquivos.
- Vou ler o trecho do meio que ficou elidido (145-327).

