# Roadmap — Claudio

Itens priorizados por ROI (ganho / esforço). Atualizado em 2026-05-16.

Convenção: cada item tem **Arquivo**, **Problema**, **Ganho**, **Esforço**, **Risco** e checkbox de status.

---

## Tier 1 — Quick wins (esforço baixo, risco baixo)

### [x] 1. Regex em escopo de módulo
- **Arquivos:** `src/services/api/providerConfig.ts:237-240,295,362,395,566`, `src/services/api/withRetry.ts:63`, `src/services/api/cacheMetrics.ts:147-152,526-527`
- **Problema:** Regex compilada dentro de funções em hot path. Viola `.claudio/rules/typescript-patterns.md`.
- **Ganho:** baixo (CPU) — **Esforço:** trivial — **Risco:** nenhum.

### [x] 2. Paralelizar dynamic imports do startup
- **Arquivo:** `src/entrypoints/cli.tsx`
- **Problema:** Imports dinâmicos sequenciais no boot; vários são independentes.
- **Ganho:** médio (cold start visível) — **Esforço:** baixo — **Risco:** baixo (preservar ordem onde houver dep).

### [x] 3. Cache de `isEnabled()` por tool
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

## Tier 3 — Saúde estrutural (PRIORIDADE — quebra de arquivos gigantes)

> Promovido a prioridade em 2026-05-17: arquivos acima de ~3k linhas estão virando gargalo de navegação, review e onboarding. Ordem proposta abaixo segue ROI/risco (utils primeiro, raízes Ink por último).

### [x] 11a. Split de `src/utils/messages.ts` (5.711 linhas, 198 KB)
- **Sugestão:** separar por responsabilidade — normalização, serialização, content-block helpers, render helpers, pricing/usage.
- **Ganho:** alto (util compartilhado em todo lugar) — **Esforço:** alto — **Risco:** médio (alto reuso → muitos call sites).

### [ ] 11b. Split de `src/cli/print.ts` (5.559 linhas, 206 KB)
- **Sugestão:** modo `--print` headless; isolar formatters, stream renderers, json/text emitters.
- **Ganho:** alto — **Esforço:** alto — **Risco:** baixo (entrypoint isolado).

### [ ] 11c. Split de `src/utils/sessionStorage.ts` (5.361 linhas, 183 KB)
- **Sugestão:** dividir em `{persistence, resume, indexing, migrations}`.
- **Ganho:** alto — **Esforço:** alto — **Risco:** médio (formato em disco; cobertura por snapshot antes).

### [ ] 11d. Split de `src/utils/hooks.ts` (5.210 linhas, 161 KB)
- **Sugestão:** um arquivo por tipo de hook (PreToolUse, PostToolUse, UserPromptSubmit, etc.) + core runner.
- **Ganho:** alto — **Esforço:** médio-alto — **Risco:** baixo (fronteira clara).

### [ ] 11e. Split de `src/screens/REPL.tsx` (5.015 linhas, 255 KB)
- **Sugestão:** extrair subcomponentes (input, transcript, status bar, overlays) e custom hooks.
- **Ganho:** alto — **Esforço:** alto — **Risco:** **alto** (cuidar de React identity — ver memória team `<Activity>`).

### [ ] 11f. Split de `src/utils/bash/bashParser.ts` (4.436 linhas, 128 KB)
- **Sugestão:** separar tokenizer, AST, validators, command-detection tables.
- **Ganho:** médio-alto — **Esforço:** médio — **Risco:** baixo (puro, testável).

### [ ] 11g. Split de `src/main.tsx` (4.379 linhas, 212 KB)
- **Sugestão:** extrair parsing de CLI args, montagem do app Ink, signal handlers, lifecycle.
- **Ganho:** alto — **Esforço:** alto — **Risco:** alto (entrypoint; muitos side effects no boot).

### [ ] 11h. Split de `src/utils/attachments.ts` (4.346 linhas, 138 KB)
- **Sugestão:** dividir por tipo (image, pdf, text, paste) + pipeline comum.
- **Ganho:** médio — **Esforço:** médio — **Risco:** baixo.

### [ ] 11i. Split de `src/services/mcp/client.ts` (3.366 linhas, 117 KB)
- **Sugestão:** transporte (stdio/sse/http) separado de gerenciamento de servidor/sessão.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (protocolo MCP; testes de integração).

### [ ] 11j. Split de `src/services/api/claude.ts` (3.218 linhas, 117 KB)
- **Sugestão:** isolar request builder, response parser, streaming, retries.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (hot path do provider Anthropic).

### [ ] 11k. Split de `src/services/api/openaiShim.ts` (~2.274 linhas)
- **Sugestão:** dividir em `{client, streamParser, messageConverter, toolConverter}`.
- **Ganho:** manutenibilidade, testabilidade — **Esforço:** alto — **Risco:** médio.

### [—] 11l. `src/bridge/bridgeMain.ts` (2.975 linhas) — **adiado**
- Vive sob `feature('BRIDGE_MODE')` desabilitado no build aberto. Refatorar não tem payoff em runtime atual.

### [—] 11m. `src/utils/ansiToPng.ts` (334 linhas, 210 KB) — **não refatorar**
- Tamanho vem de assets/fontes embutidas em base64, não de lógica. Quebrar não reduz nada.

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

## Ordem sugerida de execução

**Prioridade nova (Tier 3 — quebra de arquivos gigantes), por ROI/risco:**

1. 11a — `utils/messages.ts`
2. 11c — `utils/sessionStorage.ts`
3. 11d — `utils/hooks.ts`
4. 11h — `utils/attachments.ts`
5. 11f — `utils/bash/bashParser.ts`
6. 11b — `cli/print.ts`
7. 11i — `services/mcp/client.ts`
8. 11j — `services/api/claude.ts`
9. 11k — `services/api/openaiShim.ts`
10. 11e — `screens/REPL.tsx` (risco alto — depois de cobertura)
11. 11g — `main.tsx` (risco alto — por último)

**Tier 1/2 pendentes (executar em paralelo quando couber):**

- Item 1 — regex módulo-level (15 min, sem risco)
- Item 6 — cache `stableStringify` (maior gargalo medido)
- Item 2 — paralelizar dynamic imports (cold start)
- Item 7 — delta-write transcript (escala mal em turnos longos)
- Item 3 — cache `isEnabled()` (reduz custo do `useMemo` do REPL)
