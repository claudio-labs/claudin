# 02 — Two-tier TTL cache (soft/hard)

## O que omp faz

`packages/agent/src/tools/github-cache.ts`: cada entrada tem dois TTLs.

- Dentro do soft TTL: serve do cache, sem revalidar.
- Entre soft e hard: serve stale imediatamente, dispara refresh em background.
- Após hard: cache miss, força fetch síncrono.

Pattern stale-while-revalidate, mas explícito como camada interna do agente.

## Por que importa para Claudio

- `WebFetchTool` hoje tem cache de 15min auto-clean (segundo a doc do tool) — mas é binário.
- `WebSearchTool` (DuckDuckGo ou Firecrawl) não cacheia entre chamadas.
- Provider metadata (`providerConfig.ts` presets, modelo→capabilities) é recomputado por sessão.
- LLM frequentemente revisita a mesma URL em turnos consecutivos durante research.

## Perguntas em aberto

- Onde mora o cache? `~/.claudio/cache/` ou SQLite?
- Política de invalidação cruzada (ex: usuário muda profile → invalidar metadata?)
- Vale para resultados de Grep/Glob em monorepos grandes?
- Como interagir com `Firecrawl` que já tem seu próprio cache?

## Referência

- `packages/agent/src/tools/github-cache.ts` (omp)
- `src/tools/WebFetchTool/`, `src/tools/WebSearchTool/` (claudio)
