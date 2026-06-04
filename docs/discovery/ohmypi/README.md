# oh-my-pi (omp) — análise comparativa

Discovery comparando `oh-my-pi` (repo em `/home/viudes/projects/oh-my-pi`) com Claudin. Objetivo: extrair padrões/ideias que valem investigação aprofundada, não paridade de features.

Snapshot de exploração: 2026-05-25.

## Pipeline

Três ondas de agents:

1. **insight** (raw, `0X-*.md`) — primeira leitura comparativa.
2. **deep** (`deep/0X-*.md`) — aprofundamento técnico de cada insight.
3. **fit** (`fit/0X-*.md`) — análise de encaixe + ganhos reais medidos no codebase Claudin.
4. **gap** (`gap/0X-*.md`) — varredura final por ideias laterais que não entraram nas ondas anteriores.

## Estrutura

- [`00-overview.md`](00-overview.md) — comparação lado-a-lado por área
- [`01-bm25-tool-gating.md`](01-bm25-tool-gating.md) — discovery dinâmico via BM25
- [`02-two-tier-ttl-cache.md`](02-two-tier-ttl-cache.md) — cache soft/hard TTL com revalidação em background
- [`03-prompts-as-md-textimport.md`](03-prompts-as-md-textimport.md) — prompts em `.md` via text-import
- [`04-report-tool-issue.md`](04-report-tool-issue.md) — self-feedback estruturado
- [`05-cas-blob-store.md`](05-cas-blob-store.md) — content-addressed storage de artifacts
- [`07-tree-sitter-ast-edits.md`](07-tree-sitter-ast-edits.md) — `FileEditTool` baseado em AST
- [`08-cow-filesystem-isolation.md`](08-cow-filesystem-isolation.md) — APFS clone / btrfs/zfs reflink
- [`10-inline-terminal-images.md`](10-inline-terminal-images.md) — Sixel / Kitty / iTerm2

## Descartados após deep-dive

- ~~**09 h2-fetch**~~ — Claudin já tem implementação superior (undici 8.3 + pool per-provider + sticky h1-fallback).

## Descartados após fit analysis

- ~~**06 multi-format proxy mode**~~ — LiteLLM já cobre. Custo 2-3k LOC + zero demanda interna. Revisitar com ≥3 issues pedindo.

## Vereditos atuais

Todos CONDICIONAL.

| # | Insight | Trigger |
|---|---|---|
| 1 | BM25 tool gating | Default ON só em OpenAI-compat (DeepSeek/Groq/OpenRouter/Codex/Ollama). 1P já tem gating. |
| 2 | Two-tier TTL cache | Começar WebFetch in-memory com contadores. Sem persistência em disco na v1 (privacidade). |
| 3 | Prompts em `.md` | Só 5 cirúrgicos. Hardening do stub silencioso antes. |
| 4 | report_tool_issue | JSONL local-only. Settings checked-in liga no próprio repo (dogfooding). |
| 5 | CAS blob store | Não tocar `toolResultStorage`. Só se entrar fluxo de imagens/anexos binários. |
| 7 | AST edits | 3 quick wins SEM tree-sitter entregam ~70% do valor. |
| 8 | COW isolation | Hook já existe. Doc + reflink opcional pra seedar `node_modules`. Não Rust. |
| 10 | Inline images | `ink-picture` atrás de feature flag, Kitty + iTerm2 only. Esperar demanda. |

## Síntese executiva (priorização cross-ondas)

Inclui ideias dos gaps que escaparam do escopo original dos 10 insights.

### Quick wins (esforço pequeno, alto retorno)

| Item | Origem |
|---|---|
| Terminal breadcrumb (auto-resume por tty, ~50 LOC) | gap #5 |
| Draft persistence (Ctrl+C buffer + restore) | gap #5 |
| `titleSource: user` (1 bool no header) | gap #5 |
| IRC dedupe (anti-loop OpenAI-compat) | gap #4 |
| Guard test prompt-size em `src/tools/*/prompt.ts` | gap #3 |
| `createIf` capability gate no `buildTool` | gap #1 |
| Wall-clock runtime cap sub-agents | gap #8 |
| Recursion prevention sub-agents | gap #8 |

### P0 — alto valor, esforço médio

| Item | Origem |
|---|---|
| **Checkpoint/Rewind tool** (sandbox cognitivo) | gap #4 |
| **Late LSP diagnostics injection** (80% infra já existe) | gap #4 |
| 3 quick wins AST sem tree-sitter (`add_import` TS puro + `scope_hint` + `skip_comments_and_strings`) | fit #7 |
| 5 prompts cirúrgicos em `.md` (TeamCreate, ToolSearch, TodoWrite, exploreAgent, planAgent) | fit #3 |
| `prompt.format` + CI check (normaliza RFC2119, ~150 LOC sem engine) | gap #3 |

### P1 — condicional

| Item | Trigger |
|---|---|
| BM25 tool gating | Vácuo do `openaiShim` (sem `defer_loading`) |
| WebFetch in-memory contadores | Medir hit-ratio primeiro, sem disco na v1 |
| MCP tool-list cache 30d + config-hash | Gap real — Claudin só tem `authCache` |
| Prefix-invalidation triggers em `toolResultCache` | Hoje só mtime do file próprio |
| `report_tool_issue` JSONL local-only | Dogfooding settings checked-in |
| Reviewer structured findings (confidence + priority) | Estende `/review` |
| Worker pool + Semáforo (cap concurrency) | Claudin usa Promise.all sem cap |
| Memories pipeline 2-stage `.md` | Migra `extractMemories/prompts.ts` |

### P2 — nicho ou bloqueado

| Item | Bloqueio |
|---|---|
| Structural summary AST elisão | Maior ROI mas grande |
| LSPTool write-ops (rename, code_actions) | Resolve dor do AstEdit sem WASM |
| CAS blob store | Só se entrar fluxo de imagens/anexos |
| COW reflink seedar `node_modules` | Hook já existe |
| SQLite + FTS5 history | Substitui scan jsonls em `/resume` |
| Compaction entry tipada no JSONL | Pré/pós-compact navegável |
| Hindsight reflect-only | Precisa backend 100% local |
| Oracle agent (second-opinion) | Útil com fallback chain |
| Inline terminal images | Demanda baixa |

## Achados laterais (limpeza pendente)

- **gRPC em `CLAUDE.md:40-41,90` e `README.md:66` é vaporware** — `src/grpc/`, `src/proto/`, `dev:grpc*` não existem. Registrado em team memory `grpc-vaporware-in-docs.md`. Sugerida limpeza ~5 linhas.
- **`FileEditTool` quase sem teste unitário direto** — único `.test.ts` cobre só LSP diagnostics. Lógica de match / `replace_all` / quote-normalization sem cobertura.
- **Loader `.md`** em `scripts/build.ts:397-431` subaproveitado — só `src/skills/bundled/` usa.

## Padrão emergente

Todos os "viáveis" iniciais perderam força no fit. Nada vira default-on direto: todos viraram MVPs cirúrgicos com flag, ou ficaram com trigger específico. As **melhores ideias apareceram nos gaps** (Checkpoint/Rewind, Late LSP injection, Structural summary, LSPTool write-ops, prefix-invalidation, terminal breadcrumb) — sugerem que vale revisitar áreas adjacentes do omp não cobertas nos 10 insights originais (TUI, hooks, slash commands, MCP, modes, mental-models).
