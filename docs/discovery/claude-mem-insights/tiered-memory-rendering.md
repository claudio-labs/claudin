# Tiered Memory Rendering — two-tier render (+ proposta de token budget)

> **Fonte:** `claude-mem` repo, `src/services/context/TimelineRenderer.ts`, `src/services/context/ObservationCompiler.ts`, `src/services/context/ContextBuilder.ts`, `src/services/context/TokenCalculator.ts`.
> **Verificado contra o repo em 2026-05-19** — o "token budget com auto-degradação" que o rascunho anterior atribuía ao claude-mem **NÃO existe lá**. Ver "Correções pós-verificação".

## O que o claude-mem REALMENTE faz

Ao montar o bloco de memória para o system prompt no boot (hook `SessionStart`), o `claude-mem` renderiza em **dois níveis**, mas a escolha é **por contagem fixa**, não por orçamento de tokens:

1. **Tier compacto:** uma linha de tabela por observação (`renderAgentTableRow`)
2. **Tier expandido:** inclui o detail field — `narrative` ou `facts` (`renderAgentFullObservation`)

A decisão item-a-item (`TimelineRenderer.ts:64-71`):

```ts
const shouldShowFull = fullObservationIds.has(obs.id);
if (shouldShowFull) { /* tier expandido */ } else { /* tier compacto */ }
```

`fullObservationIds` é precomputado (`ObservationCompiler.ts:288-294`) — simplesmente **as primeiras N observações**:

```ts
export function getFullObservationIds(observations, count) {
  return new Set(observations.slice(0, count).map(obs => obs.id));
}
```

Controlado por settings de inteiro puro:

- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` — default `'50'` — total de observações mostradas
- `CLAUDE_MEM_CONTEXT_FULL_COUNT` — default `'0'` — quantas ganham o tier expandido. **Default 0 = por padrão tudo é compacto**, expansão é opt-in
- `CLAUDE_MEM_CONTEXT_FULL_FIELD` — default `'narrative'` — qual campo o tier expandido mostra

**Não há teto de tokens, não há degradação por tamanho.** O único "limite" é o `.slice(0, count)` estático. Se `input.full` é true, as contagens viram `999999` (`ContextBuilder.ts:112-115`) — o design é "mostra tudo", o oposto de budget-aware.

### O estimador de tokens é um red herring

`TokenCalculator.ts` existe (`CHARS_PER_TOKEN_ESTIMATE = 4`, `types.ts:99`; `calculateObservationTokens`, `TokenCalculator.ts:6-12`), mas só alimenta uma **estatística cosmética** de "tokens saved" no header/footer (`calculateTokenEconomics`, `:14-37`). **Não** dimensiona nem limita o contexto injetado. O campo `tokenBudget` em `context-pack.ts:10` é schema morto — nunca lido por nenhum renderer.

## O insight aproveitável

O que vale copiar do claude-mem aqui é **modesto**: o conceito de renderizar memória em níveis (linha compacta vs detalhe completo) num único bloco de boot. O **token budget** é uma melhoria que o Claudio adicionaria **por cima** — o claude-mem não tem.

## Como o Claudio faz hoje

`src/memdir/` injeta o `MEMORY.md` inteiro (já é one-liner por entrada — isso já é "tier compacto" de fato) **mais** os arquivos `.md` de memória julgados relevantes, em conteúdo completo.

O que falta:

- **Sem teto de tokens.** Se muitos arquivos forem julgados relevantes, todos entram completos.
- **Truncamento cego.** O system prompt avisa "linhas após 200 do `MEMORY.md` são truncadas" — corte por posição, não por relevância nem budget.
- **Sem estágio intermediário.** É tudo (índice one-liner) ou nada (arquivo completo).

## Proposta (vai além do claude-mem)

Renderer de memória com 3 tiers e budget explícito, em `src/memdir/` (renderer):

| Tier | Conteúdo | Custo/item |
|---|---|---|
| `index` | linha do `MEMORY.md` (title + hook) | ~20-40 tok |
| `summary` | + `description` do frontmatter + 1ª linha do corpo | ~80-120 tok |
| `full` | arquivo `.md` completo | ~200-600 tok |

Algoritmo de boot:

1. Todas as memórias entram no tier `index` (barato, sempre cabe)
2. Promove memórias `feedback` + `user` para `full` (sempre relevantes, poucas)
3. Promove memórias `project`/`reference` para `summary` enquanto `budget` permitir
4. Para no teto — restante fica em `index`

Budget configurável, default conservador (ex: ~4-6k tokens para o bloco de memória inteiro). Esta é a parte que o claude-mem **não** tem — o Claudio entrega a degradação por budget que falta lá.

## Relação com os outros docs

- Esta técnica e [`progressive-memory-recall.md`](progressive-memory-recall.md) atacam o mesmo problema (memória custa caro no boot) por ângulos diferentes:
  - **Tiered rendering** = decide *quanto* de cada memória mostrar no boot (estático)
  - **Progressive recall** = move a carga para *sob demanda* via tool (dinâmico)
- São **complementares**: tiered rendering define o que entra no system prompt; recall busca o resto. Implementar tiered rendering primeiro é mais barato e baixo risco, e já dá ganho mesmo sem a tool de recall.

## Decisões abertas

1. **Estimador de tokens:** `4 chars/token` (heurística do claude-mem) é grosseiro mas zero-custo. Claudio já tem contagem real de tokens em `src/utils/` — usar a real ou a heurística no caminho de boot (onde latência importa)? Recomendação: heurística no boot, é só pra caber no budget.
2. **Budget fixo ou % do context window?** Provider abstraction do Claudio expõe context window por modelo — budget como `min(6k, 3% do window)` adapta a modelos pequenos (Haiku) vs grandes.
3. **Tier `summary` exige campo novo?** Precisa de `description` no frontmatter (já existe) + 1ª linha do corpo (derivável). Sem schema change.

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| Two-tier render gated por **token budget**, com auto-degradação | ❌ | É gated por **contagem fixa** (`CLAUDE_MEM_CONTEXT_FULL_COUNT`, primeiras N obs). Sem budget, sem degradação |
| `TokenCalculator.ts:14-37` estima tokens do contexto injetado | ⚠️ | `:14-37` é `calculateTokenEconomics` (stat cosmética "tokens saved"). Estimativa real em `:6-12`; constante `4` em `types.ts:99` |
| Session-start tem teto de tokens configurável | ❌ | Não existe. Configurável só por *contagens* de inteiro. `tokenBudget` em `context-pack.ts:10` é schema morto |
| `TimelineRenderer.ts:40-76` two-tier | ⚠️ | Two-tier existe, mas o switch é `fullObservationIds.has(id)` (`:64-71`), set por contagem (`ObservationCompiler.ts:288-294`) |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| Two-tier switch | `src/services/context/TimelineRenderer.ts:64-71` |
| Set de IDs expandidos (por contagem) | `src/services/context/ObservationCompiler.ts:288-294` |
| Settings de contagem | `src/shared/SettingsDefaultsManager.ts:83,109` |
| Estimador de tokens (só cosmético) | `src/services/context/TokenCalculator.ts:6-12`; `types.ts:99` |
