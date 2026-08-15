# Gap Analysis — Caches/TTL/Persistence (omp não cobertos)

Padrões adicionais de cache no omp que não entraram em `02-*` insight/deep/fit.

> **Errata 2026-05-27 — prefix-invalidation (§1.5, §2, §3):** o gap "toolResultCache faz mtime mas não invalida vizinhos" estava **errado**. `src/agent/tools/toolExecution.ts:1245` já chama `invalidateCacheForWrite` após cada tool, e o dispatcher em `:1762-1779` cobre `FileEditTool`/`FileWriteTool`/`NotebookEditTool` (→ `invalidateForPath`) e `BashTool`/`PowerShellTool` (→ `invalidateAll`). `invalidateForPath` faz prefix-match bidirecional (`toolResultCache.ts:150-164`), então write em vizinho derruba Grep/Glob cacheado. `LSPTool/workspaceEdit.ts` estende o padrão para rename/edit LSP. Roadmap T5.10 foi descartado por isso.

## 1. Caches omp não cobertos pelas análises anteriores

### 1.1 `packages/ai/src/model-cache.ts` — SQLite cross-process modelCache
- DB: `getModelDbPath()`, WAL + `busy_timeout=3000` (`model-cache.ts:50-51`).
- Schema 3 com migration in-place via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` (`:69-75`) — não dropa tabela, evolui.
- **Static fingerprint**: hash do catálogo estático embutido na row (`:35`, `:91`). Permite bypass da re-merge quando estático não mudou — eviction lógica por mudança de catálogo, não por tempo.
- `fresh` é computado por TTL no read; row persiste indefinidamente como stale fallback.

### 1.2 `packages/coding-agent/src/edit/file-read-cache.ts` — per-session line snapshots
- `LRUCache max=30` paths por session (`file-read-cache.ts:21,30`).
- **Conflict-driven invalidation**: ao gravar, compara linhas existentes — se diferem, dropa snapshot inteiro e recomeça (`:62-68`, `hasConflict :79-85`). Pattern novo: cache se auto-invalida via observação em vez de mtime.
- Usado para anchor-stale recovery em 3-way merge de edits.

### 1.3 `packages/coding-agent/src/mcp/tool-cache.ts` — MCP tool definitions
- TTL 30 dias (`tool-cache.ts:12`).
- **Config-hash invalidation**: SHA-256 do config estável (stableStringify ordenando keys) — mudou config → cache miss (`:47-51, :86`).
- Backing store: `AgentStorage.setCache` (SQLite kv table, ver §1.4).

### 1.4 `packages/ai/src/auth-storage.ts` — generic SQLite KV cache
- Tabela `cache(key, value, expires_at)` com `idx_cache_expires` (`auth-storage.ts:3291-3296`).
- Statement prepared para `DELETE FROM cache WHERE expires_at <= unixepoch()` (`:3259`).
- `AuthStorageUsageCache` (`:510-535`) implementa **stale-on-demand explicit**: `getStale(key, {includeExpired:true})` retorna valor expirado; durable retention = `max(expiresAt, now + USAGE_LAST_GOOD_RETENTION_MS)` — duas TTLs sobrepostas (real vs durável), padrão novo vs github-cache.

### 1.5 `crates/pi-natives/src/fs_cache.rs` — Rust DashMap fs scan cache
- DashMap concurrent, evict por oldest `created_at` quando size > `MAX_CACHE_ENTRIES=16` (`fs_cache.rs:136-145`).
- **Negative caching com fast-recheck**: `empty_recheck_ms=200`, se query devolveu zero matches e cache > 200ms, força rescan via `force_rescan(store=false)` opcional (`:80-82, :444-446, :491-513`). Pattern novo.
- **Invalidation por path-prefix**: `invalidate_path` remove toda entry cuja `root` é prefixo do path mutado (`:523-532`). Chamada via `fs-cache-invalidation.ts:5-28` após write/delete/rename — triggers explícitos do agente, não watcher.
- TTL global muito curto (1000ms default) para casar com cadência tool call.
- Config via env vars (`FS_SCAN_CACHE_TTL_MS`, `FS_SCAN_EMPTY_RECHECK_MS`, `FS_SCAN_CACHE_MAX_ENTRIES`).

### 1.6 `packages/coding-agent/src/extensibility/plugins/marketplace/cache.ts` — plugin install cache
- File-system tree cache `<cacheDir>/<marketplace>___<plugin>___<version>/`.
- **Atomic staging-rename** (`cache.ts:77-81`): `cp` para staging, `rm` target, `rename`. Resiliente a falha mid-copy.
- **Path-traversal hardening**: regex whitelist + `..` reject em version (`:23-29`).
- `cleanOrphanedCache` (`:117-136`): GC dirigido por set de paths instalados — eviction por reachability, não TTL.

### 1.7 `packages/coding-agent/src/modes/theme/mermaid-cache.ts` — render memoization
- `Map<string,string|null>` sem TTL nem cap (`mermaid-cache.ts:3`). **Negative caching**: armazena `null` para falhas explicitamente (`:19-21`). Cresce sem bound — risco em sessão longa, mas conteúdo é bounded por mermaid blocks no transcript.

## 2. Padrões novos a considerar

| Padrão | omp file:line | Adotar Claudin? |
|---|---|---|
| **Negative caching** (cache de "null"/"empty") | `mermaid-cache.ts:19-21`, `fs_cache.rs:444-446` | Sim, condicional. WebFetch 404/timeout merece cache curto. |
| **Empty-result fast recheck** (cache curto + bust se age > N) | `fs_cache.rs:80-82,447-484` | Condicional — útil em GrepTool/GlobTool quando atualizam logo após write. |
| **Config-hash invalidation** (SHA-256 stable stringify) | `tool-cache.ts:20-51,86` | Sim para `modelCache` (já tem version mas não hash de presets) e cache MCP. |
| **Static fingerprint embed** (versão do input estático na row) | `model-cache.ts:35,91,116` | Sim — substitui hard-invalidate por dataset versionado. |
| **Prefix-based invalidation triggers** chamados por tool sites | `fs-cache-invalidation.ts:5-28`, `fs_cache.rs:523-532` | Sim, alto valor. Falta total em Claudin — toolResultCache faz mtime mas não invalida vizinhos. |
| **Conflict-driven self-invalidation** (compare-then-drop) | `file-read-cache.ts:62-68,79-85` | Não — Claudin `fileReadCache` já usa mtime; pattern só ganha sem mtime confiável. |
| **`getStale()` API explícita + durable retention** (>1 TTL) | `auth-storage.ts:519-529` | Sim — mais simples que soft/hard se quiser "last-good" fallback. |
| **In-place schema migration via ALTER COLUMN** | `model-cache.ts:69-75` | Sim se algum cache Claudin for a SQLite. Atual JSON-per-key drop+rebuild. |
| **Atomic staging-rename para tree caches** | `cache.ts:77-81` | Não aplicável hoje, mas referência se v8cache/paste mudar. |
| **Path-component whitelist em cache keys** | `cache.ts:23-29` | Sim se houver cache por nome de plugin/skill em disco. |
| **Cross-process via SQLite WAL + busy_timeout** | `model-cache.ts:50-51`, `auth-storage.ts:3284-3286` | Não — repo evita `bun:sqlite` runtime (build/verify constraints). |
| **`idx_cache_expires` + statement-prepared GC** | `auth-storage.ts:3259,3296` | Condicional — só se migrar para SQLite. |
| **LRU por oldest-`created_at` (sem touch on read)** | `fs_cache.rs:136-145` | Não — Claudin já usa `lru-cache` proper. |
| **Env-var-driven cache policy** | `fs_cache.rs:62-68` | Condicional — settings.json é mais discoverable que env. |
| **Cache stats/observability** | (omp tem `cache_age_ms`, sem dashboard) | Claudin já tem `cacheStatsTracker.ts`, `cacheMetrics.ts`, `/cache-probe` — mais avançado que omp. |
| **Stampede protection além de `queueMicrotask`** | (não usado em omp) | Sim — já flagado no fit (in-flight `Map<key,Promise>` obrigatório). |
| **Two-tier hard TTL durable (last-good)** | `auth-storage.ts:527-528` | Sim — variante mais simples que soft/hard com refresh ativo. |

## 3. Encaixe Claudin (caches relacionados)

- **Negative cache + path-prefix invalidate** → `src/agent/tools/toolResultCache.ts:63` (Grep/Glob/Read). Não tem invalidate por write-em-vizinho; hoje só mtime do file próprio.
- **Config-hash invalidation** → `src/utils/model/modelCache.ts:20,47` (hoje só `version` numérico) e `src/platform/settings/settingsCache.ts`.
- **Atomic staging-rename / path whitelist** → `src/plugins/zipCache.ts`, `src/plugins/cacheUtils.ts`.
- **`getStale()` durable retention** → `src/platform/install/latestVersionCache.ts:38,53` (banner serve último valor bom indefinidamente, refresh em background).
- **Empty-result fast recheck** → `src/tools/GlobTool/` + `src/tools/GrepTool/`.
- **MCP tool cache (config-hash + TTL longo)** → gap real: `src/mcp/client/authCache.ts:6,29` cobre só "needs auth"; não existe cache de tool-list/schema MCP. omp tem 30 dias com config-hash.
- **Native fs cache layer** → Claudin evita native deps; replicar empty-recheck e prefix-invalidate em **TypeScript layer** sobre `GrepTool`/`GlobTool` é viável e barato.
- **Stale-on-demand explicit API** → todos os caches Claudin hoje são fresh-or-miss. Padronizar `getStale()` opcional é refactor de baixo risco.

## 4. Síntese do que é NOVO em relação ao deep/fit

1. **Negative caching + empty-recheck** (`fs_cache.rs`) — pattern ausente da análise anterior.
2. **Config-hash invalidation** com stable-stringify (`tool-cache.ts`) — não estava no scope.
3. **Static fingerprint embedded na row** (`model-cache.ts`) — versionamento de dado-fonte, não de schema.
4. **`getStale()` + durable retention** (`auth-storage.ts`) — alternativa mais simples à soft/hard.
5. **Prefix-invalidation triggers explícitos** chamados por edit/write tools (`fs-cache-invalidation.ts`) — gap real em `toolResultCache.ts`.
6. **Conflict-driven self-invalidation** (`file-read-cache.ts`) — pattern curioso, não recomendado.
7. **Atomic staging-rename** para tree caches (`marketplace/cache.ts`) — referência futura.
