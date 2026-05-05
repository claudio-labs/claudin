# Command: git commit

**Match pattern:** `^git(\s+-[^\s]+)*\s+commit\b`
**Família:** git
**Tier:** 1 (alta frequência em workflow de agente)
**Estratégia provável:** **`match_output` agressivo** — colapsar sucesso para uma linha
**Status:** analyzed (rtk como referência, dry-run capturado)
**Estimated reduction:** **~85-95%** no caso comum

---

## Saída crua representativa

### Amostra 1 — commit normal (estimado, ~150-300 bytes)

```
[fix/user-agent-openai-shim a3f8c9d] fix(api): use claudio branding in User-Agent
 7 files changed, 30 insertions(+), 4 deletions(-)
 create mode 100644 src/utils/userAgent.ts
```

### Amostra 2 — commit com hooks (típico, ~400-2KB+)

Hooks (husky, pre-commit, lefthook) executam ANTES e seu output entra no stdout:

```
husky - pre-commit
✓ ESLint passed (47ms)
✓ Prettier formatting OK
✓ TypeScript check (1.23s)
✓ Tests (3.45s — 47 passed)

[main a3f8c9d] feat: add new endpoint
 12 files changed, 247 insertions(+), 23 deletions(-)
 create mode 100644 src/api/endpoint.ts
 create mode 100644 src/api/endpoint.test.ts
```

### Amostra 3 — `git commit --dry-run` (REAL no claudio, 520 bytes)

```
On branch fix/user-agent-openai-shim
Your branch is up to date with 'origin/fix/user-agent-openai-shim'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   src/services/api/claude.ts
	modified:   src/services/api/withRetry.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/discovery/

no changes added to commit (use "git add" and/or "git commit -a")
```

**Insight:** `--dry-run` SEM staged changes é virtualmente idêntico a `git status` — pode reusar o filtro `git-status.md`.

### Amostra 4 — falha (hooks rejeitam)

```
husky - pre-commit
✗ ESLint failed
  src/foo.ts:42:15  error  Unexpected console.log  no-console

husky - pre-commit hook exited with code 1 (error)
```

---

## Sinal vs ruído

**Sinal (manter):**
- **Hash do commit** — `[branch abc1234]` — crítico para follow-up
- **Subject do commit** — `fix(api): ...` — confirmação de que mensagem foi aceita
- **Resumo de stats** — `7 files changed, 30 insertions(+), 4 deletions(-)` — sanity check
- **`create mode` / `delete mode`** — saber que novos arquivos foram criados/deletados (útil pra modelo confirmar intenção)
- **Hook output FAILURES** — preservar inteiro
- **Errors do git** (não-fast-forward, conflito não-resolvido, etc.)

**Ruído potencial (estratégia rtk):**
- Tudo acima **menos** o hash, na visão do rtk
- Hook output SUCESSO (`✓ ESLint passed`) — modelo já confiou no hook quando rodou

**Ambíguo:**
- Stats de file changes — modelo poderia re-derivar de `git diff --stat HEAD~`. Mas custa um comando extra.

---

## Estratégia proposta

### Opção A — rtk-style: ultra-agressivo (`match_output`)

```jsonc
{
  "name": "git-commit",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+commit\\b",
  "matchCommandReject": "--dry-run|--amend\\s+--no-edit",
  "stripAnsi": true,
  "matchOutput": [
    {
      "pattern": "^\\[\\S+\\s+([0-9a-f]{7,40})\\]",
      "message": "✓ committed $1",
      "unless": "(?i)\\b(error|fail|hook exited)\\b|✗"
    },
    {
      "pattern": "nothing to commit, working tree clean",
      "message": "✓ nothing to commit",
      "unless": "(?i)\\berror\\b"
    }
  ]
}
```

**Saída esperada Amostra 1:**

```
✓ committed a3f8c9d
```

~20 bytes vs ~200 bytes → **90% redução**.

### Opção B — preservar stats, descartar `create mode`

```jsonc
{
  "name": "git-commit",
  "stripLinesMatching": [
    "^\\s*(create|delete|rename) mode \\d+",
    "^husky - pre-commit hook exited with code 0$"
  ]
}
```

**Saída esperada:**

```
[fix/user-agent-openai-shim a3f8c9d] fix(api): use claudio branding in User-Agent
 7 files changed, 30 insertions(+), 4 deletions(-)
```

~120 bytes vs ~200 → ~40% redução.

### Opção C — híbrida: detectar hooks, preservar quando há

Se output contém `husky |  pre-commit | lefthook | running tests | running prettier`, usar Opção B (preservar visibilidade do hook). Senão, usar Opção A (colapsar).

**Não dá pra expressar em pipeline declarativo simples** — adiar pra v2 ou implementar como native filter pequeno.

### Recomendação

**Opção A (rtk-style)** com cuidado especial em `unless`:

- `unless` precisa cobrir: `error`, `fail`, `failed`, `hook exited`, `✗`, `denied`, `rejected`
- O hash no `message` (`✓ committed $1`) é o único sinal indispensável

---

## Edge cases / NÃO filtrar quando

- [x] `--dry-run` → passthrough (output similar a `git status`, deixar p/ filtro git-status)
- [x] `--amend --no-edit` (re-commit silencioso) — output same shape, filter funciona
- [x] `is_error: true` → passthrough (errors preservados)
- [ ] **`--allow-empty`** — output como commit normal, OK
- [ ] **`-S` (signed)** com problema GPG — output com `error: gpg failed to sign the data` — `unless` precisa cobrir `gpg failed`
- [ ] **Commit em rebase em curso** — output adicional `Continuing rebase...`. Preservar?
- [ ] **Hook output que escreve sem prefixo conhecido** — não detectável, vai colapsar. Trade-off aceito (Opção A).
- [ ] **`--no-verify`** (skip hooks) — output mais limpo, filter same
- [ ] **Commit com mensagem multi-linha** — primeira linha é subject, resto é body; output tem só primeira linha em `[branch hash]` formato.

---

## Estimativa de redução

Validado contra rtk + estimativa pra claudio:

| Cenário | Antes (bytes) | Depois (Opção A) | Redução |
|---|---|---|---|
| Commit simples | ~200 | ~20 | **90%** |
| Commit com 5 hooks ok | ~600 | ~20 | **97%** |
| Commit grande (50 arquivos) | ~2.000 | ~20 | **99%** |
| Commit com hook FAILED | ~500 | ~500 (passthrough via `unless`) | 0% |
| `nothing to commit` | ~80 | ~25 | 69% |

**Achado:** Commit normal já é compacto (~200 bytes) então redução absoluta é pequena. Mas commits acontecem MUITO (várias por turno em workflow ativo) → **ganho cumulativo significativo**.

---

## Open questions

- [ ] **Preservar stats de file changes?** rtk descarta. Argumento contra rtk: modelo às vezes precisa confirmar "X arquivos foram alterados conforme planejei".
- [ ] **Como tratar hooks lentos?** Hook output é grande mas user PRECISA ver se algo passou ou falhou. `unless` cobre falhas, mas hooks que printam warnings sem `error` slip through.
- [ ] **`git commit --amend`** que reescreve mensagem — output igual, OK.
- [ ] **Commit com `signed-off-by` automático** — output igual.
- [ ] **Manter `[branch hash]` ou só `hash`?** Branch é redundante (geralmente o user/agente está ciente), hash é único.

---

## Comparativo com rtk

- rtk: `cmds/git/git.rs::run_commit` — implementação nativa.
- **rtk faz exatamente Opção A:** colapsa pra `ok abc1234`.
- **Diferenças propostas:**
  - Usar `✓ committed abc1234` em vez de `ok abc1234` (mais informativo)
  - `unless` mais robusto (incluir `gpg failed`, `denied`, `rejected`, `✗`)
  - Reuso do filtro `git-status.md` para `--dry-run`

---

## Findings empíricos

1. **`git commit --dry-run`** (sem staged) é literalmente `git status` com mensagem final diferente — reusar filtro existente.
2. **rtk vai full-aggressive** colapsando pra `ok HASH` — confirma que mesmo perdendo stats, ROI vale.
3. **Hooks são o caso de cuidado** — `unless` precisa ser robusto pra não engolir hook failure.
4. **Cumulative win > per-call win**: 90% de 200 bytes = 180 bytes/commit, mas em sessão com 20 commits = 3.6KB economizados.
