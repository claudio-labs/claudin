# Roadmap — Claudio

Itens priorizados por ROI (ganho / esforço). Atualizado em 2026-05-16.

Convenção: cada item tem **Arquivo**, **Problema**, **Ganho**, **Esforço**, **Risco** e checkbox de status.

---

## Tier 1 — Quick wins (esforço baixo, risco baixo)

### [x] 1. Regex em escopo de módulo
- **Arquivos:** `src/services/api/providerConfig.ts:237-240,295,362,395,566`, `src/services/api/withRetry.ts:63`, `src/services/api/cacheMetrics.ts:147-152,526-527`
- **Problema:** Regex compilada dentro de funções em hot path. Viola `.claudio/rules/typescript-patterns.md`.
- **Ganho:** baixo (CPU) — **Esforço:** trivial — **Risco:** nenhum.

### [ ] 2. Paralelizar dynamic imports do startup
- **Arquivo:** `src/entrypoints/cli.tsx`
- **Problema:** Imports dinâmicos sequenciais no boot; vários são independentes.
- **Ganho:** médio (cold start visível) — **Esforço:** baixo — **Risco:** baixo (preservar ordem onde houver dep).

### [ ] 3. Cache de `isEnabled()` por tool
- **Arquivos:** `src/tools.ts:179-249`, consumido em `src/screens/REPL.tsx:703`
- **Problema:** `useMemo` invalida por turn e escaneia ~30 tools chamando `isEnabled()` (toca env/config/flags).
- **Ganho:** médio — **Esforço:** baixo (invalidação por evento de config) — **Risco:** baixo.

### [ ] 4. Imports relativos → alias `src/...`
- **Arquivo:** `src/services/api/openaiShim.ts:26-34` (8 imports)
- **Problema:** Viola regra do projeto; quebra em moves.
- **Ganho:** manutenibilidade — **Esforço:** trivial — **Risco:** nenhum.

### [ ] 5. `any` → `unknown` + guard em `isQuotaExhausted`
- **Arquivo:** `src/services/api/withRetry.ts:109`
- **Problema:** `any` no hot path de retry, sem type safety.
- **Ganho:** correção / segurança de tipos — **Esforço:** trivial — **Risco:** baixo.

---

## Tier 2 — Alto impacto (esforço médio, payoff grande)

### [ ] 6. Cache de `stableStringify` para prefixo imutável de mensagens
- **Arquivo:** `src/services/api/openaiShim.ts:1811-1815`
- **Problema:** `stableStringify(body)` rodado duas vezes consecutivas; `body` contém histórico inteiro. **Maior gargalo CPU/turn** já identificado por bench do próprio repo.
- **Ganho:** alto — **Esforço:** médio — **Risco:** médio (preservar byte-identity para prefix caching).

### [ ] 7. Delta-write no `recordTranscript`
- **Arquivo:** `src/QueryEngine.ts:733-762`
- **Problema:** Re-serializa array inteiro de mensagens por content block do stream — N×M.
- **Ganho:** alto em sessões longas — **Esforço:** médio — **Risco:** médio (resume/recovery depende do formato).

### [ ] 8. `WeakMap` cache para `JSON.stringify(tu.input)` na conversão
- **Arquivo:** `src/services/api/openaiShim.ts:585-589`
- **Problema:** Re-stringify de tool_use inputs a cada conversão; escala com histórico × tool calls.
- **Ganho:** médio — **Esforço:** baixo — **Risco:** baixo.

### [ ] 9. Write-coalescing no `void recordTranscript`
- **Arquivo:** `src/QueryEngine.ts:760`
- **Problema:** Fire-and-forget enfileira closures retendo referência ao `messages` (cresce a cada bloco) — pressão de GC.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (durability/resume).

### [ ] 10. Extrair `tryParseMailboxMessage<T>` (7 `catch {}` duplicados)
- **Arquivo:** `src/services/teammateMailbox.ts` (a partir da linha 438)
- **Problema:** Padrão repetido de `catch {}` engole diagnóstico; viola regra "no silent error swallow".
- **Ganho:** robustez — **Esforço:** baixo — **Risco:** baixo.

---

## Tier 3 — Saúde estrutural (esforço alto, débito de longo prazo)

### [ ] 11. Split de `src/services/api/openaiShim.ts` (~2.274 linhas)
- **Sugestão:** dividir em `{client, streamParser, messageConverter, toolConverter}`.
- **Ganho:** manutenibilidade, testabilidade — **Esforço:** alto — **Risco:** médio.

### [ ] 12. Cobertura de testes para `src/QueryEngine.ts`
- **Arquivo:** `src/QueryEngine.ts` (1.346 linhas, **sem `.test.ts` colocalizado**)
- **Problema:** Coração do agent loop sem cobertura unitária.
- **Ganho:** alto — **Esforço:** alto — **Risco:** baixo.

### [ ] 13. Cobertura de tools sem teste
- **Tools alvo:** `WebSearchTool`, `MonitorTool`, `ScheduleCronTool`, `WorkflowTool`, `SkillTool`, MCP tools, Worktree tools, PlanMode tools (~38 dirs sem `.test.ts`).
- **Ganho:** alto — **Esforço:** alto — **Risco:** baixo.

### [ ] 14. Reconciliar doc vs código sobre flag `--provider`
- **Arquivos:** `CLAUDE.md` diz removido; `src/main.tsx:992` ainda enumera providers.
- **Ganho:** clareza — **Esforço:** baixo — **Risco:** baixo.

### [ ] 15. `checkAutoModeClassifierPrompts()` deveria falhar, não apenas warn
- **Arquivo:** `scripts/build.ts`
- **Problema:** Se `TRANSCRIPT_CLASSIFIER=true` e `.txt` faltar, auto-mode cai silenciosamente para auto-allow. **Risco de segurança.**
- **Ganho:** segurança — **Esforço:** baixo — **Risco:** baixo.

---

## Limpeza oportunista

- [ ] **CHICAGO_MCP cleanup duplicado** em `src/query.ts:1060` e `1621` — flag está `false` em `build.ts`; código morto no open build. Unificar ou gate explícito.
- [ ] **`useMemo(() => false, [])`** em `src/screens/REPL.tsx:618` — slot de hook gasto para constante.

---

## Ordem sugerida de execução (top 5 ROI)

1. Item 1 — regex módulo-level (15 min, sem risco)
2. Item 6 — cache `stableStringify` (maior gargalo medido)
3. Item 2 — paralelizar dynamic imports (cold start)
4. Item 7 — delta-write transcript (escala mal em turnos longos)
5. Item 3 — cache `isEnabled()` (reduz custo do `useMemo` do REPL)
