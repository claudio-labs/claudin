# 05 — Gaps session storage / artifacts / persistence / transcripts

Varredura de `packages/coding-agent/src/session/` omp além do CAS blob store já analisado.

## 1. Sistemas do omp (file:line)

### ArtifactManager — texto, session-local, IDs sequenciais
- `session/artifacts.ts:20-135` — IDs numéricos (`#nextId++`), arquivo `{id}.{toolType}.log`.
- Scan no boot reaproveita o maior ID (`:56-68`).
- Subagents adotam manager do pai (`adoptArtifactManager` `session-manager.ts:2382-2394`) → parent+filhos partilham 1 ID space.
- URLs `artifact://<id>` (`:130-134`).

### Session format / dump / transcripts
- `session-dump-format.ts:64-209` — `formatSessionDumpText` renderiza markdown.
- `session-manager.ts:213-226` — `SessionEntry` discriminated union 13 variantes.
- `:58` `CURRENT_SESSION_VERSION = 3`. `:312-371` migrations v1→v2→v3 in-place.

### Compaction inline no transcript (não destrutivo)
- `session-manager.ts:107-119` — `CompactionEntry` mantém `tokensBefore`, `summary`, `details` no JSONL.
- Append-only: branch pós-compact tem `parentId` apontando pro entry; árvore pré-compact continua navegável.

### Branching / fork / leaf pointer
- `:1929-1973` `fork()` — novo `sessionId`, header `parentSession: oldSessionId`.
- `:3060-3098` `branch(id)` — move `#leafId`, próximo append vira filho.
- `:3011-3048` `getTree()`. `:3105-3190` `createBranchedSession(leafId)` exporta caminho root→leaf.

### Resume / checkpoint
- `:1738-1762` `resolveResumableSession` — match por id/prefix/"latest".
- `:760-784` `readTerminalBreadcrumb` + `:745-754` write — qual session-file pertence a cada terminal/cwd.
- `:954-1001` `recoverOrphanedBackups` — varre `.bak` órfãs (crash entre rename).

### Draft persistence
- `:2458-2508` `saveDraft`/`consumeDraft` — `draft.txt` no dir; single-shot read+unlink no resume.

### Title metadata
- `:2510-2555` `titleSource: "auto" | "user"`. User sobrescreve permanentemente.
- `:60-69` SessionHeader: version, id, title, titleSource, timestamp, cwd, parentSession.

### Move / rename projeto
- `:1980-2068` `moveTo(newCwd)` — move JSONL + artifact dir + reescreve header.

### Persistence engine atomicidade
- `:1279-1419` `NdjsonFileWriter` — append assíncrono com fila, `.bak` antes de rewrite atômico, fsync.
- `:2557-2603` `_persist` — hot path `fs.writeSync` (sobrevive SIGKILL); cold path rewrite atômico.
- `session-storage.ts:48-56` `FinalizationRegistry` cleanup de FDs vazados.

### History DB SQLite + FTS5
- `history-storage.ts:1-312` — `~/.claudin/history.db` SQLite + FTS5 `unicode61`, substring search com escape LIKE, prepared stmts cacheados.
- Histórico de **prompts** global, não outputs.

### Concurrency
- `:2160-2191` `#queuePersistTask` + `#ensurePersistWriter` — uma sessão = um writer, fila linear.

## 2. Vale pra Claudin?

| omp tem | Claudin tem? | Vale portar? |
|---|---|---|
| ArtifactManager IDs sequenciais | Não — `toolResultStorage.ts` chaveia por `toolUseId` UUID | **Não.** UUID já é único; ganho marginal |
| Subagents share parent artifact dir | Parcial — `sessionStorage/resume/subagents.ts` separado | **Diagnóstico primeiro** |
| `formatSessionDumpText` markdown | Sim — `src/commands/export/export.tsx` | Não |
| **Compaction inline append-only** | **Parcial** — transcript fica pré-compact mas sem entry tipado; sem tooling pra navegar pré/pós | **Sim, baixo custo** |
| Branch / leaf pointer / tree | Parcial — `src/commands/branch/branch.ts:61-173` `createFork` por cópia; sem árvore navegável | **Talvez** — `parentEntryId` em cada msg = árvore grátis. Mudança de schema, risco |
| **Terminal breadcrumb** | Não | **Sim, ~50 linhas** — DX win |
| `recoverOrphanedBackups` | Não — Claudin append-only | N/A |
| **Draft persistence** | Não | **Sim, pequeno** — buffer no Ctrl+C |
| **`titleSource: auto\|user`** | Parcial — title existe, flag "user set" não | **Sim, trivial** — 1 bool impede extractMemories sobrescrever título manual |
| `moveTo(newCwd)` | Não | Condicional — nicho |
| **NdjsonFileWriter sync hot path** | Parcial — async append, sem sync sobrevivente SIGKILL | **Sim** — Claudin perde últimos turns em crash |
| **History DB SQLite + FTS substring** | Parcial — `liteMetadata.ts` JSON; `transcriptSearch.ts` faz scan | **Sim, médio** — substitui scan de N jsonls toda vez `/resume` |

## 3. Encaixe (file:line)

| Feature | Inserir em | Mudança |
|---|---|---|
| **Compaction entry tipada** | `src/agent/compact/compact.ts` + `src/sessions/pure/typeGuards.ts` | Schema-add. Nova variante de message no JSONL |
| **Terminal breadcrumb** | Novo `src/sessions/breadcrumb.ts` + hook em `src/commands/resume/resume.tsx` | Aditivo ~50 LOC |
| **Draft persistence** | Novo `src/sessions/persistence/draft.ts`, hook em Ctrl+C/shutdown, leitura em `useResumeSession*` | Aditivo, sidecar `draft.txt` |
| **`titleSource: user`** | `src/sessions/persistence/metadata.ts` — 1 campo + 1 guard em quem escreve auto | Trivial |
| Sync hot-path writer | `src/sessions/persistence/project.ts` — write sync + fsync diferido no último turn | Médio risco — snapshot testing obrigatório |
| Tree / parentEntryId | Schema-change em todo SessionEntry | **Adiar.** Migration + UI nova sem driver |
| SQLite + FTS substring | Novo `src/sessions/indexing/historyDb.ts`, ler em `transcriptSearch.ts` + lista `/resume` | Médio. Dep `bun:sqlite` disponível. Coexiste com `liteMetadata` |
| Subagent artifact dir | Verificar `src/sessions/resume/subagents.ts:1-189` | Diagnóstico, talvez 0 mudança |
| ArtifactManager seq IDs | — | Skip. UUID atual já é correto |
| `moveTo` | Comando novo `/move` ~80 LOC | Nicho, baixa prio |

## Veredito por gap

1. **Quick wins (dias):** terminal breadcrumb, draft persistence, `titleSource: user`.
2. **Médio (semanas):** compaction-entry tipada no JSONL, SQLite+FTS history.
3. **Caro / não vale agora:** seq IDs, parentEntryId tree, sync hot-path (só se houver relato real de perda de turn).
4. **Skip total:** dump format (já existe), branch-from-leaf (já existe via `branch.ts`).
