# Command: git status

**Match pattern:** `^git(\s+-[^\s]+)*\s+status\b`
**Família:** git
**Tier:** 1
**Estratégia provável:** declarative pipeline (line strip + replace)
**Status:** analyzed
**Estimated reduction:** ~70% (rtk reporta 80% no README, ajustamos pra ser conservador)

---

## Saída crua representativa

### Amostra 1 — trivial, repo limpo (~120 bytes)

```
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

### Amostra 2 — médio, alguns arquivos modificados (~600 bytes)

```
On branch feature/bash-output-filter
Your branch is up to date with 'origin/feature/bash-output-filter'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        modified:   src/utils/toolResultSummarizer.ts

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   src/tools/BashTool/BashTool.tsx
        modified:   docs/archive/discovery/bash-output-filter/README.md

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        docs/archive/discovery/bash-output-filter/commands/

no changes added to commit (use "git add" and/or "git commit -a")
```

### Amostra 3 — grande, repo cheio (estimativa ~4-8KB)

Não capturado ainda — coletar em repo com 50+ untracked files. Estimativa: ~6KB com 80%+ sendo nomes de arquivo.

---

## Sinal vs ruído

**Sinal (manter):**
- Nome do branch atual (`On branch <name>`)
- Tracking info (`up to date | ahead by N | behind by N | diverged`)
- Nomes de arquivo modificados / staged / untracked
- Linha final ("nothing to commit" / "X files changed")
- Conflict markers (`Unmerged paths:`, `both modified:`) — preservar inteiro

**Ruído (remover):**
- Hints `(use "git restore --staged <file>...")` etc — modelo já sabe esses comandos
- Cabeçalhos repetitivos `Changes to be committed:`, `Changes not staged for commit:`, `Untracked files:` — podem virar prefixo curto (`S:`, `M:`, `?:`)
- Linhas em branco entre seções

**Ambíguo:**
- O texto inteiro é em inglês — manter ou normalizar pro modelo?
- Indentação de 8 espaços antes do `modified:` — economiza ~2% se removida, mas pode atrapalhar parsing visual

---

## Estratégia proposta

### Opção A — pipeline declarativo (recomendada)

```jsonc
{
  "name": "git-status",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+status\\b",
  "matchCommandReject": "--porcelain|--short|-s\\b|--json",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*\\(use \"git ",
    "^\\s*$"
  ],
  "replace": [
    { "pattern": "^Changes to be committed:$", "replacement": "[STAGED]" },
    { "pattern": "^Changes not staged for commit:$", "replacement": "[MODIFIED]" },
    { "pattern": "^Untracked files:$", "replacement": "[UNTRACKED]" },
    { "pattern": "^\\s+modified:\\s+", "replacement": "  M " },
    { "pattern": "^\\s+new file:\\s+", "replacement": "  A " },
    { "pattern": "^\\s+deleted:\\s+", "replacement": "  D " },
    { "pattern": "^\\s+renamed:\\s+", "replacement": "  R " }
  ],
  "matchOutput": [
    {
      "pattern": "nothing to commit, working tree clean",
      "message": "On branch ${BRANCH}\\nClean working tree.",
      "unless": "Unmerged|conflict"
    }
  ]
}
```

Saída esperada da Amostra 2 com esse filtro:

```
On branch feature/bash-output-filter
Your branch is up to date with 'origin/feature/bash-output-filter'.
[STAGED]
  M src/utils/toolResultSummarizer.ts
[MODIFIED]
  M src/tools/BashTool/BashTool.tsx
  M docs/archive/discovery/bash-output-filter/README.md
[UNTRACKED]
        docs/archive/discovery/bash-output-filter/commands/
no changes added to commit
```

~310 bytes vs 600 bytes originais → ~48% de redução.

### Opção B — forçar `--porcelain` por trás

Mais agressivo: substituir o comando do user por `git status --porcelain --branch` e usar saída nativa compacta:

```
## main...origin/main
M  src/utils/toolResultSummarizer.ts
 M src/tools/BashTool/BashTool.tsx
?? docs/archive/discovery/bash-output-filter/commands/
```

**Pró:** muito mais compacto (~150 bytes), zero parsing.
**Contra:** muda o comando que o user pediu — princípio do menor surpresa quebrado. Modelo pode ter pedido `git status` esperando hint humanizado.

**Recomendação:** Opção A. Manter a intenção do comando, só limpar.

---

## Edge cases / NÃO filtrar quando

- [x] `--porcelain`, `--short`, `-s` → passthrough (já é compacto)
- [x] `--json` (raro mas existe via plugins) → passthrough
- [x] `is_error: true` → passthrough
- [ ] **Conflict markers (`Unmerged paths:`)** — preservar seção inteira incluindo hints. Adicionar regra `keepLinesMatching` que sobrescreve `stripLinesMatching` em modo conflict.
- [ ] **Locale ≠ en** — `LANG=fr_FR.UTF-8` quebra todos os regex. Decisão: tentar, se não casar nada → passthrough (não tentar i18n na v1).
- [ ] **Nome de arquivo com espaço ou newline** — `git status` quota nomes problemáticos (`"file with space"`). Regex `^\s+modified:\s+` deve casar mesmo assim.
- [ ] **Submodules** — output tem indentação extra (`Changes in submodule X:`). Não tratado na proposta atual, deixar passar bruto.

---

## Estimativa de redução

Validado empiricamente no claudin repo (5 May 2026):

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| trivial (clean) | 120 | ~50 (via `match_output`) | ~58% |
| **médio (REAL: 5 modificados + 1 untracked)** | **574** | ~310 | **~46%** |
| grande (50+ files) | ~6.000 (estimado) | ~3.500 (estimado) | ~42% |

**Comparativo com `git status --short`:**

A mesma situação que dá 574 bytes em formato default dá **175 bytes em `--short`** (`git status -s`). Ou seja, o nativo `--short` já é 70% menor que default. Forçar `--short` por trás (Opção B) seria mais compacto que nossa Opção A (~310 bytes).

**Trade-off Opção A vs B revisitado:** Opção A produz output ainda 1.8× maior que `--short`. Vale revisitar se queremos preservar forma humanizada ou se forçar `-s` é OK.

Redução percentual cai conforme o output cresce porque os nomes de arquivo (sinal puro) dominam. **A maior parte do ganho vem dos hints** — se o user já roda muito `git status`, ganho cumulativo grande.

---

## Open questions

- [ ] Manter cabeçalhos `[STAGED]` / `[MODIFIED]` / `[UNTRACKED]` ou só prefixar cada arquivo (`A `, `M `, `?? `)?
- [ ] Tratar `Your branch is ahead by N commits` separadamente — vale comprimir?
- [ ] `git -C <path> status` ou `git --git-dir=... status` — regex de match precisa cobrir flags globais. Padrão proposto (`^git(\s+-[^\s]+)*\s+status\b`) cobre, mas `--git-dir=...` com `=` precisa teste.
- [ ] Como detectar `git status` rodado dentro de `git rebase`/`merge`/`bisect` em curso? Output diferente, talvez precise filtro separado.

---

## Comparativo com rtk

- rtk não tem filtro TOML específico pro `git status` — está dentro do módulo nativo `src/cmds/git/git.rs` (função `run_status`).
- rtk faz parsing nativo + reformat para o estilo `--porcelain` colorido. Mais agressivo que nossa Opção A.
- **O que copiamos:** ideia de strip dos hints `(use "git ...")`.
- **O que mudamos:** rtk reescreve o comando pra `--porcelain`; nós preservamos a forma humanizada e só limpamos.
