# Command: git diff

**Match pattern:** `^git(\s+-[^\s]+)*\s+diff\b`
**Família:** git
**Tier:** 1
**Estratégia provável:** **passthrough quase total** + strip de index hashes
**Status:** analyzed
**Estimated reduction:** **~5-15%** (medido — muito menos que rtk reporta)

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra 1 — `git diff --stat` (291 bytes)

```
 src/services/api/claude.ts     | 15 +++++++++++----
 src/services/api/codexShim.ts  |  2 ++
 src/services/api/openaiShim.ts |  3 +++
 src/services/api/withRetry.ts  | 19 +++++++++++++++++--
 src/services/api/userAgent.ts         | 11 +++++++++++
 5 files changed, 44 insertions(+), 6 deletions(-)
```

Já compacto, **passthrough**.

### Amostra 2 — `git diff` (6.677 bytes, 5 arquivos)

Trecho representativo de um arquivo:

```
diff --git i/src/services/api/claude.ts w/src/services/api/claude.ts
index c0da81f..2c4ed0c 100644
--- i/src/services/api/claude.ts
+++ w/src/services/api/claude.ts
@@ -227,6 +227,7 @@ import {
   getAssistantMessageFromError,
   getErrorMessageIfRefusal,
 } from './errors.js'
+import { extractOpenAICategoryMarker } from './openaiErrorClassification.js'
 import {
   EMPTY_USAGE,
   type GlobalCacheStrategy,
@@ -2531,18 +2532,24 @@ async function* queryModel(
     // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
...
```

### Amostra 3 — `git diff -- src/withRetry.ts` (single file, ~1KB)

Não capturada, mas estrutura idêntica ao trecho de Amostra 2.

---

## Sinal vs ruído

**Sinal (manter — quase tudo):**
- Header `diff --git` — informa qual arquivo
- `---`/`+++` paths
- Hunk headers `@@ -X,Y +Z,W @@`
- Linhas `+`/`-` (alterações reais) — **isso é o conteúdo todo**
- Linhas de contexto (3 antes/depois) — modelo precisa pra entender mudança

**Ruído mínimo:**
- `index c0da81f..2c4ed0c 100644` — hash de blobs antes/depois, raramente útil pro modelo
- Prefixos `i/` e `w/` em vez de `a/` e `b/` (config local) — modelo entende ambos

**NADA mais é seguro de remover.** Tentei imaginar o que cortar e não acho nada significativo.

---

## Estratégia proposta

### Pipeline declarativo conservador

```jsonc
{
  "name": "git-diff",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+diff\\b",
  "matchCommandReject": "--stat|--numstat|--shortstat|--name-only|--name-status",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^index [0-9a-f]+\\.\\.[0-9a-f]+\\s+\\d+$"
  ]
}
```

**Estimativa:** ~3-5% de redução. Index hashes são ~50 bytes/arquivo. Em diff de 5 arquivos = ~250 bytes / 6.677 = 4%.

### Estratégia mais agressiva: reduzir contexto `-U1`

Forçar `git diff -U1` em vez de `-U3` (default). Reduz contexto de 3 linhas pra 1.

**Tradeoff brutal:** modelo perde contexto pra entender o que mudou. Em hunks pequenos, 3 linhas de contexto é o que dá pro modelo encaixar a mudança no arquivo. **Não recomendado.**

### Estratégia "stat-first then diff"

rtk faz: roda `git diff --stat` primeiro, mostra, depois roda diff completo. Total seria *maior* que só o diff (adiciona o stat). Faz sentido só se o user pediu `git diff` cego e o stat ajuda a navegar — é UX, não compressão.

**Para LLM, o stat é desnecessário** porque os headers `diff --git` já listam todos os arquivos.

---

## Edge cases / NÃO filtrar quando

- [x] `--stat`, `--numstat`, `--shortstat` → passthrough
- [x] `--name-only`, `--name-status` → passthrough (já compacto)
- [x] `--quiet` → passthrough (sem output)
- [ ] `git diff --cached` / `--staged` → mesmo filtro
- [ ] `git diff <ref>..<ref>` → mesmo filtro, possivelmente output enorme
- [ ] `git diff -- pathspec` → mesmo filtro
- [ ] **Binary files** → linha `Binary files i/foo.png and w/foo.png differ` aparece em vez de hunks. Preservar.
- [ ] **Renames detectados** (`rename from`, `rename to`, `similarity index`) → preservar inteiro
- [ ] **Diff vazio** → `match_output` com mensagem curta `"no changes"`
- [ ] **`git diff --color`** com cores forçadas — `stripAnsi` deve ser idempotente
- [ ] **Diff de arquivos auto-gerados** (`*.lock`, `dist/`, `*.snap`) — rtk não trata especialmente; nós também não na v1

---

## Estimativa de redução

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| `--stat` | 291 | 291 (passthrough) | 0% |
| `git diff` 5 arquivos | 6.677 | ~6.400 (strip index lines) | ~4% |
| `git diff` 50 arquivos (estimado) | ~80.000 | ~75.000 | ~6% |

**ACHADO IMPORTANTE:** rtk reporta 75% de savings em `git diff` mas nossa análise não consegue chegar nem perto. Possíveis explicações:

1. rtk faz **stat + diff truncated to N lines** — agressivo, perde contexto
2. rtk inclui **strip de arquivos noise** (lock files, dist/) que não estão na nossa proposta
3. Tabela do rtk pode ser média de `git diff --stat` (mostly stat-only) com casos onde stat já cobre

**Recomendação:** Reclassificar `git diff` como **NÃO Tier 1** após este achado. ROI muito baixo.

---

## Open questions

- [ ] **Reclassificar pra Tier 2?** Análise empírica diz sim.
- [ ] Adicionar lista configurável de "noise files" pra strip diff inteiro (lock files, snapshots, dist)?
- [ ] `git diff --binary` (output binary patches) — tratar como passthrough ou descartar?
- [ ] Tratar diff super grande (>50KB) com truncate "[N more files omitted]" — mas isso já é o summarizer existente.

---

## Comparativo com rtk

- rtk: `cmds/git/git.rs::run_diff` — implementa `--stat` first então diff. Verificar exatamente o que o filtro faz no body (não inspecionei completo).
- **O que copiamos:** ideia de strip de index hashes.
- **O que NÃO copiamos:** rewrite pra mostrar `--stat` antes — adiciona bytes em vez de remover.
- **Crítica honesta:** a tabela rtk de 75% reduction parece **otimista demais**. Nossa medição em diff real (5 arquivos, 6.7KB) deu 4%. A não ser que rtk esteja truncando contexto agressivamente.

---

## Findings empíricos

1. **Diff é puro sinal.** Não há "fluff" pra remover sem perder informação.
2. **Index hashes são o único corte seguro** e dão 4-6%.
3. **Reduzir contexto (-U1) é tentador mas perigoso** — modelo perde ancoragem.
4. **Stat-first não economiza tokens, gasta** — duplica overview.
5. **Reclassificar:** `git diff` deveria ir pra Tier 2 ou ser tratado só pelo summarizer existente quando >8KB.
