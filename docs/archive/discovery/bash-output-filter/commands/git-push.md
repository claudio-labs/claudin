# Command: git push

**Match pattern:** `^git(\s+-[^\s]+)*\s+push\b`
**Família:** git
**Tier:** 1 (alta frequência em workflow de agente)
**Estratégia provável:** **`match_output` agressivo** — colapsar sucesso para uma linha
**Status:** analyzed (rtk como referência, `--dry-run` capturado, push real bloqueado por permissão)
**Estimated reduction:** **~85-95%** no caso comum

---

## Saída crua representativa

### Amostra 1 — `git push --dry-run` (REAL claudin, 22 bytes)

```
Everything up-to-date
```

Já mínimo absoluto. Passthrough.

### Amostra 2 — push de feature branch nova (estimado, ~700-1500 bytes)

```
Enumerating objects: 47, done.
Counting objects: 100% (47/47), done.
Delta compression using up to 8 threads
Compressing objects: 100% (25/25), done.
Writing objects: 100% (29/29), 4.32 KiB | 4.32 MiB/s, done.
Total 29 (delta 18), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (18/18), completed with 11 local objects.
remote:
remote: Create a pull request for 'feature/foo' on GitHub by visiting:
remote:      https://github.com/owner/repo/pull/new/feature/foo
remote:
To github.com:owner/repo.git
 * [new branch]      feature/foo -> feature/foo
```

### Amostra 3 — push update simples (estimado, ~500 bytes)

```
Enumerating objects: 12, done.
Counting objects: 100% (12/12), done.
Delta compression using up to 4 threads
Compressing objects: 100% (7/7), done.
Writing objects: 100% (7/7), 1.23 KiB | 1.23 MiB/s, done.
Total 7 (delta 4), reused 0 (delta 0), pack-reused 0
To github.com:owner/repo.git
   abc1234..def5678  feature/foo -> feature/foo
```

### Amostra 4 — push rejeitado (não-fast-forward) (~400-800 bytes)

```
To github.com:owner/repo.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'github.com:owner/repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
```

### Amostra 5 — push com hook server-side warning

```
... (progress lines)
remote:
remote: Some lint issues found in pre-receive:
remote:   src/foo.ts: missing semicolon (line 42)
remote:
To github.com:owner/repo.git
   abc1234..def5678  feature/foo -> feature/foo
```

### Amostra 6 — `Everything up-to-date`

```
Everything up-to-date
```

Já mínimo. Passthrough.

---

## Sinal vs ruído

**Sinal (manter):**
- Linha de **resultado** (`To <remote>` + `abc..def branch -> branch` ou `* [new branch]`)
- **`remote:` lines com warnings/errors do server** (lint, hooks, security)
- **PR creation URL** (`Create a pull request ... visiting: <url>`) — útil pra agente saber o link
- **Rejected** lines + hints (em caso de erro)
- **Auth errors** (preservar inteiro)

**Ruído pesado (objetos do git transfer protocol):**
- `Enumerating objects: N, done.`
- `Counting objects: 100% (N/N), done.`
- `Delta compression using up to N threads`
- `Compressing objects: 100% ...`
- `Writing objects: 100% ...`
- `Total N (delta M), reused X (delta Y), pack-reused Z`
- `remote: Resolving deltas: 100% ...`

Nenhum desses dá info acionável **depois** do push terminar.

---

## Estratégia proposta

### Opção A — rtk-style ultra-agressivo (`match_output`)

```jsonc
{
  "name": "git-push",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+push\\b",
  "matchCommandReject": "--dry-run",
  "stripAnsi": true,
  "matchOutput": [
    {
      "pattern": "Everything up-to-date",
      "message": "✓ push: up-to-date",
      "unless": "(?i)\\berror\\b"
    },
    {
      "pattern": "^To\\s+\\S+$\\n.*->\\s*(\\S+)\\s*$",
      "message": "✓ pushed -> $1",
      "unless": "(?i)\\b(error|reject|fail|denied)\\b|^remote:\\s+(WARN|ERROR)|^\\s*!\\s+\\[rejected\\]"
    }
  ]
}
```

**Tradeoff:** colapsar perde a URL de PR creation. **Aceitável** se modelo pode regenerar via `gh pr create` ou similar.

### Opção B — pipeline declarativo (preserva remote: + URL)

```jsonc
{
  "name": "git-push",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+push\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^Enumerating objects",
    "^Counting objects",
    "^Delta compression",
    "^Compressing objects",
    "^Writing objects",
    "^Total \\d+ \\(delta",
    "^remote: Resolving deltas",
    "^\\s*$"
  ]
}
```

**Saída esperada Amostra 2:**

```
remote:
remote: Create a pull request for 'feature/foo' on GitHub by visiting:
remote:      https://github.com/owner/repo/pull/new/feature/foo
remote:
To github.com:owner/repo.git
 * [new branch]      feature/foo -> feature/foo
```

~280 bytes vs 1.500 → ~80% redução. **Preserva PR URL.**

### Recomendação

**Opção B** (preservar PR URL e remote: warnings).

Opção A é mais agressiva mas perde info real (URL de PR), e o ganho de B (~80%) já é bom o suficiente.

---

## Edge cases / NÃO filtrar quando

- [x] `--dry-run` → passthrough (output já mínimo)
- [x] `is_error: true` → passthrough (rejection, auth, etc. preservados inteiros)
- [ ] **`-u origin <branch>`** (set upstream) — output igual + linha extra `Branch '<x>' set up to track '<y>'`. Preservar.
- [ ] **`--force` / `--force-with-lease`** — output igual em sucesso, com `+ abc..def` em vez de `abc..def`. Preservar.
- [ ] **`--tags` / `--all`** — output similar mas pode ter múltiplas linhas `branch -> branch`. Filter funciona, só não colapsa pra single-line.
- [ ] **Push delete** (`git push origin --delete branch`) — output `- [deleted]` em vez de hash range. Preservar.
- [ ] **Pre-receive hook server-side** com warnings — `remote: WARNING:` etc. — `unless` cobre.
- [ ] **Auth interativo (SSH key prompt)** — não chega no BashTool de forma significativa, fora de escopo.
- [ ] **Push em repo com Git LFS** — output adicional `Uploading LFS objects: ...`. Não cobrimos especificamente; provavelmente preservar.

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois (Opção B) | Redução |
|---|---|---|---|
| `Everything up-to-date` | 22 | 22 | 0% (passthrough) |
| Push update simples | ~500 | ~120 | ~76% |
| Push branch nova com PR URL | ~1.500 | ~280 | **~81%** |
| Push grande (1000 commits) | ~3.000 | ~150 | ~95% |
| Push rejeitado | ~600 | ~600 (passthrough) | 0% |
| Push com warnings remote | ~800 | ~250 | ~69% |

---

## Open questions

- [ ] **Capturar amostra real de push** com auth funcional (claudin repo no gitea local poderia funcionar, ou usar repo público).
- [ ] **Opção A vs Opção B** definitiva — vale perder PR URL pra ganhar 10% extra de redução? Provável que não.
- [ ] **Push de tags** — output específico, talvez precise stripping diferente.
- [ ] **LFS objects** upload progress — strip sim/não?

---

## Comparativo com rtk

- rtk: `cmds/git/git.rs::run_push` — implementação nativa.
- **rtk faz Opção A:** colapsa pra `ok branch -> branch` ou `ok (up-to-date)`.
- **Diferença proposta:** preferimos Opção B (preserva PR URL + remote: warnings).
- rtk emite `FAILED: git push` em stderr quando push falha — info redundante (exit code já indica), removível.

---

## Findings empíricos

1. **rtk é mais agressivo que precisa** — perde PR creation URL.
2. **`Enumerating/Counting/Compressing/Writing/Total` são pure noise** — alvo principal.
3. **`remote:` lines preservar SEMPRE** — incluem warnings de server-side hooks (segurança crítica).
4. **`Everything up-to-date` é 22 bytes** — nada a fazer.
5. **PR creation URL** é provavelmente o item mais valioso pro agente — Opção B preserva, Opção A descarta.
