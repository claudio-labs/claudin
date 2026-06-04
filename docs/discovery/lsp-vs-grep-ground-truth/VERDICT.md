# Veredito — LSP vs Grep ground truth

**Data**: 2026-05-27
**Branch**: `feat/t6.1-lsp-grep-descriptions`
**Repo de medição secundário**: `~/projects/openclaude` (2452 arquivos TS)

## TL;DR

Durante a tentativa de medir cobertura/ruído de LSP vs Grep nos 5 prompts canônicos do Tier 6.1, **descobrimos um bug crítico no roteamento de servidor LSP** que invalidava qualquer experimento prévio: o servidor `biome` (linter-only) shadowava o `typescript-language-server` em arquivos `.ts/.tsx`, fazendo `findReferences`, `hover`, `goToDefinition`, `documentSymbol` e `prepareCallHierarchy` retornarem `Method not found`.

Após corrigir o bug (`src/services/lsp/builtinServers.ts` — ordem determinística em `getBuiltinLspServers`), repetimos o bench A/B em openclaude com descriptions neutras nas duas variantes. Resultado: **LSP=0 em todas as 8 runs**. O agente não usa LSP organicamente sem incentivo explícito.

## Bug encontrado e corrigido

`getBuiltinLspServers` usava `Promise.allSettled` com inserção direta em um `Record`, ficando dependente da ordem de resolução das Promises (não-determinística). Em ambientes onde `biome` é instalado globalmente junto com `typescript-language-server` (caso comum em projetos TS modernos), biome podia ser inserido primeiro no Record. Depois, `LSPServerManager.getServerForFile` escolhia o "primeiro servidor que reivindica a extensão" — biome — que só responde diagnósticos.

**Fix**: coletar `Promise.all` em um array indexado, iterar `SERVER_DEFINITIONS` em ordem fixa para popular o Record. Paralelismo preservado, ordem garantida.

**Teste de regressão**: `src/services/lsp/builtinServers.test.ts` — "preserves SERVER_DEFINITIONS order regardless of detection latency".

## Benches

Modelo em todas as rodadas: `claude-sonnet-4-6`. Harness: `scripts/bench/lsp-grep-descriptions-ab.ts`.

### Rodada 1 — descriptions editadas, repo claudin (pré-fix LSP)
5 prompts × 2 runs. LSP A=2, B=3 (delta +1, irrelevante). 4/5 prompts sem mudança.

### Rodada 2 — descriptions editadas, openclaude ~2452 arquivos (pré-fix LSP)
2 prompts × 2 runs. Grep caiu 29→11 (-62%) mas agente migrou para Read+Glob, **não** para LSP (A=0, B=1). Output tokens dobraram, custo +57%, wall +95%. Convergência funcional.

### Rodada 3 — descriptions LSP-first + fix LSP vs main puro, openclaude (definitiva)
2 prompts × 2 runs. A = `main` puro (sem fix, descriptions originais). B = fix LSP + descriptions LSP-first reaplicadas.

| Métrica | A (main) | B (fix + LSP-first) | Delta |
|---|---|---|---|
| LSP calls | 0 | **0** | 0 |
| Grep calls | 8 | 6 | -2 |
| Avg duration | 252s | 197s | -22% |
| Avg input tokens | 289 | 105 | -64% |
| Total cost | $6.72 | $5.02 | -25% |

B foi mais barato (menos turns: 4.3 vs 6.8) mas pelo motivo *errado*: convergiu mais rápido via Grep, **não migrou para LSP**.

## Conclusões

1. **Bug LSP corrigido** independentemente do experimento (`getBuiltinLspServers` em `src/services/lsp/builtinServers.ts` — ordem determinística). Ganho universal para qualquer usuário com `biome` global instalado em monorepos TS.

2. **Descriptions globais não movem o agente para LSP** — provado em 3 rodadas, $20+ gastos, com e sem o bug, com e sem tabela LSP-first explícita. T6.1 dropado do ROADMAP.

3. **Variância de runs cross-file é alta** com n=2 — um único loop multi-turno em uma das 4 runs B da rodada 2 dominou as médias daquela rodada. Para sinais sutis, n≥5 + prompts mais controlados.

4. **Prompts testados estavam errados para "ground truth"**. Todos eram resolvíveis por Grep+filtros. Cenários genuinamente "symbol-hard" (call hierarchy 3+ níveis, refs de tipo com homônimo variável) ficaram fora — testar antes de qualquer próxima iteração no Tier 6.

## Próximos passos

- **Tier 6.1**: dropado (descrito no ROADMAP).
- **Tier 6.6** (description do FileReadTool com cross-ref para `outgoingCalls`): testar se "view='outline' / symbol='X'" + LSP `outgoingCalls` desloca leitura de arquivos inteiros para leitura simbólica. Description é no ponto de leitura, não de busca — mais perto da decisão que T6.1.
- **System prompt do Explore agent** (originalmente vetado): reavaliar agora que temos evidência empírica de que description global não basta.
- **Bench focado em queries onde Grep falha** antes de qualquer próximo A/B.

## Reports brutos

- `scripts/bench/results/lsp-grep-ab-2026-05-27T19-49-25-888Z.md` (rodada 1)
- `scripts/bench/results/lsp-grep-ab-2026-05-27T20-26-38-658Z.md` (rodada 2)
- `scripts/bench/results/lsp-grep-ab-2026-05-27T22-17-05-614Z.md` (rodada 3, definitiva)
