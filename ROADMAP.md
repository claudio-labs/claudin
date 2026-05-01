# Claudio — Roadmap Técnico

> Última auditoria: 2026-05-02 | ROI honesto, sem itens marginais

Roadmap enxuto após auditoria contra o código real. Itens marginais, obsoletos e overengineering foram removidos. Mantém só o que **vale a pena de verdade** + histórico do que já foi feito.

---

## Ativos (3 itens)

### 2.4 — Gerenciamento de memória em sessões longas
- **Esforço:** M
- **Estado:** `fileReadCache` sem check de tamanho por entrada (1000 × ficheiros grandes = >1 GB); `invalidate()` nunca chamado após writes — coerência depende só de mtime granularity. Listeners em REPL.tsx estão corretos (2 on + 2 off balanceados).
- **Ganho:** Cap de memória previsível em sessões longas; elimina risco de stale read em writes rápidos.
- **Arquivos:** `src/utils/fileReadCache.ts`, `src/utils/file.ts`

### 3.12 — Wildcard permission rules (last-match-wins)
- **Esforço:** M (~80 LoC + revisão de UX `/permissions`)
- **Estado:** `tools.allow`/`deny` é all-or-nothing por tool. Sem padrão `bash:rm -rf /* → deny`, `bash:git push → ask`, `bash:* → allow`.
- **Ganho:** Granularidade real para usuários em modo `--auto`. Único item de feature de produto no roadmap.
- **Inspirado em:** OpenCode `permission/evaluate.ts:9-15` (`findLast` sobre regras `{permission, pattern, action}`).
- **Arquivos:** `src/permission/`, `src/commands/permissions/`

### 4.1 — Testes para caminhos críticos
- **Esforço:** L
- **Prioridade:** P0
- **Estado:** Sem testes em `QueryEngine.ts` (core agent loop), `coordinator/`, `grpc/server.ts`, `tools/AgentTool/`, `main.tsx`, `screens/REPL.tsx`, `bridge/`.
- **Ganho:** Reduz risco de regressão silenciosa no core.

---

## Concluídos ✅

### 3.6 — Keep-alive por provider (não global)
`let keepAliveDisabled` → `Map<string, boolean>` em `proxy.ts`. `disableKeepAlive(provider)` e `getProxyFetchOptions({ provider })` agora são scoped por provider. Callers atualizados: `withRetry.ts` passa `getAPIProvider()`, `openaiShim.ts` passa a variável `provider` local, `codexShim.ts` passa `'codex'`, `client.ts` passa `'anthropic'`. Test isolado garante que ECONNRESET no DeepSeek não afeta o Anthropic.

### 1.8 — `countTokensViaHaikuFallback` agora usa `countTokens` (free)
`anthropic.beta.messages.create` (cobrava input + 1 output token por chamada de fallback) trocado por `anthropic.beta.messages.countTokens`, que é gratuito e suporta os mesmos parâmetros (thinking, tools, betas) que precisávamos. Test em `tokenEstimation.test.ts` garante que `create` nunca é chamado nesse caminho.

### 1.7 — Remover dead code de ContentType / compression ratios (54ce9a9)
`ContentType`, `COMPRESSION_RATIOS`, `detectContentType()`, `getCompressionRatio()`, `estimateWithBounds()` (~95 linhas) deletados; único caller em `staticDedup.integration.test.ts` agora chama `roughTokenCountEstimation(s, 2)` direto.

### 4.4 — Error boundary real (substituir SentryErrorBoundary) (61d8e5b)
`SentryErrorBoundary` substituído por `ErrorBoundary` real com fallback visível + `logError` em crash. `SentryErrorBoundary.ts` virou re-export de `ErrorBoundary` para manter os 4 callsites sem mudança. Testes em `ErrorBoundary.test.tsx`.

### 4.8 — Renomeado `writeFileSyncAndFlush_DEPRECATED` → `writeFileSyncAndFlush` (9ec5c63)
A deprecação era aspiracional — os 3 callers (config writes, settings writes, file edit writes) são sync por design. Renomear + atualizar jsdoc remove o marcador enganoso sem refactor M-L de propagar async.

### 1.1 — Strip progressivo de thinking blocks (de7b67d)
`stripOldThinkingBlocks()` agora roda em todos os providers, não só Bedrock/Vertex.

### 1.2 — Estimativa de tokens por modelo
`roughTokenCountEstimation()` já usa `getActiveModelBytesPerToken()` memoizado, com `MODEL_TOKENIZER_CONFIGS` cobrindo 19 famílias de modelo. Auditoria descobriu que estava feito mas não marcado.

### 1.4 — Stable-stub tool_result compression (7b6b374, 2e6c638, ed80303, ff59bc3)
Set monotônico per-sessão de tool_use_ids clipados, byte-stable cross-turn. Funciona em Anthropic native, Bedrock, Vertex, OpenAI shim, Codex shim. Permitiu deletar `compressToolHistory.ts` (~1.8k linhas).

### 1.6 — Tabela de preços para modelos não-Claude (163a180)
`NON_CLAUDE_MODEL_COSTS` cobre 30+ patterns (gpt/gemini/deepseek/grok/cohere/phi/...). DeepSeek a $0.14/Mtok não aparece mais como $5/Mtok.

### 1.9 — Estimativa de imagens por provider (14f0416)
Per-provider implementado (Anthropic, OpenAI, Gemini com fórmulas próprias).

### 3.11 — `retry-after-ms` + HTTP-date no `Retry-After` (3dace3a)
`parseRetryAfterValue` aceita integer/decimal seconds + RFC 7231 HTTP-date. `getRetryAfterMs` prefere `retry-after-ms` (extensão Anthropic/OpenAI) sobre `retry-after`. 21 testes.

---

## Oportunidades — pesquisa de comunidade (2026-05-01)

> Fonte: GitHub issues, HN, Reddit (r/LocalLLaMA, r/ClaudeAI), RedMonk, Stack Overflow Survey 2025, JetBrains 2025.  
> Ainda não priorizados; listados para avaliação de ROI.

| ID | Feature | Esforço est. | Evidência |
|----|---------|-------------|-----------|
| C1 | **AGENTS.md** — ler `.agents/skills/` além de `.claude/skills/` | XS | 3 000+ upvotes anthropics/claude-code#31005; Cursor, Codex, Amp já suportam; Anthropic parada há 7+ meses |
| C2 | **Hidden CLAUDE.md** — aceitar `.claude/CLAUDE.md` como fallback | XS | anthropics/claude-code#54183; mudança mínima de lookup |
| C3 | **Custo inline por turno** — `$0.xx` no status bar em tempo real | S | 66% dos devs citam custo imprevisível como bloqueador; `/cost` existe mas não é inline |
| C4 | **Local-first UX** — wizard de setup Ollama + docs proeminentes | S | Ollama já funciona; r/LocalLLaMA (266k membros) busca ativamente isso |
| C5 | **Issue tracker via MCP** — bundles pré-configurados GitHub Issues + Linear no `/provider` | M | anthropics/claude-code#10998; "implement issue #64" sem copy-paste |
| C6 | **`/spec <file>`** — pinar requirements.md ao contexto que sobrevive à compactação | M | Devs querem requirements como fonte de verdade cross-compaction |
| C7 | **Session rollback / checkpoint** — `/rewind` equivalente sem precisar de git | M | Claude Code tem `/rewind`; Zed tem restore por edição; Claudio não tem nada |
| C8 | **Wildcard permission rules** | M | Já em roadmap ativo como 3.12 — mencionado aqui por correlação com C9 |
| C9 | **Sandboxing / least-privilege** — scoping de permissão por tool/agente | L | 30+ CVEs em AI coding tools; prompt injection via MCP (CVE-2025-61260) |
| C10 | **Multi-agent dashboard** — progresso de agentes paralelos visível | L | RedMonk #5 de 10 necessidades agentic IDE; coordinator mode existe mas sem UI de visibilidade |

---

## Removidos da auditoria

**Já feitos (movidos para Concluídos):** 1.2, 1.6.

**Bug do roadmap:** 2.6 e 4.6 eram o **mesmo item duplicado** ("preprocessamento de feature flags") em pilares diferentes — removidos. SIGINT/SIGTERM já tratado no `build.ts`; SIGKILL é raro o bastante para aceitar `git checkout --`.

**Premissa falsa:**
- **3.5** (rate-limit headers Bedrock/Vertex/Gemini) — esses providers **não emitem** `x-ratelimit-reset-*`. Bedrock usa AWS SDK error metadata, Gemini usa `RetryInfo` em gRPC details. Não é "estamos ignorando", é "não existe pra ignorar". Escopo real >> M.

**Parcialmente cobertos por código existente:**
- **3.1** (resposta parcial em streaming) e **3.8** (timeout configurável) — `STREAM_IDLE_TIMEOUT_MS` já existe em `claude.ts:1840`, configurável via env, com warning intermediário. Resume-from-checkpoint é caro de implementar (L) para ganho marginal.

**Overengineering / ganho hipotético:**
- 1.3 (redução de tool schemas) — vai pra cache 1h; ganho só nos misses
- 1.5 (threshold cache 8k→4k) — sessões reais já passam de 8k logo
- 1.10 (filtragem dinâmica de tools) — Cron/Worktree custam <300 tokens cada
- 2.1 (defer imports main.tsx) — Anthropic-internal já são stubs no-op
- 2.2 (bundle 21MB) — Node parseia em <100ms
- 2.3 (decompor REPL.tsx) — feio mas funciona
- 2.5 (sync I/O 530 calls) — quase todas em bootstrap, ganho zero
- 2.7 (cache CWD) — 1ms total, abaixo do ruído
- 2.8 (Yoga layout) — sem evidência de gargalo
- 3.2 (failover cross-provider) — UX manual via `/provider` é aceitável
- 3.3 (hardening gRPC) — uso nicho, sem demanda
- 3.4 (retry por provider) — curva única funciona
- 3.9 (classificação erros) — catch-all >=408 raramente erra
- 3.10 (OAuth refresh async) — refresh raro, bloqueio invisível
- 3.13 (protected paths TCC) — usuários macOS já têm TCC OS-level
- 4.2 (decompor arquivos gigantes) — manutenibilidade pura, sem ganho funcional
- 4.3 (eliminar double casts) — refactor preventivo, código funciona
- 4.5 (limpeza TODOs) — cosmético
- 4.7 (validação schema settings.json) — settings.json editado quase só via `/provider`

---

## Total

**3 ativos** (1× P0, 2× P2) + **11 concluídos**.
