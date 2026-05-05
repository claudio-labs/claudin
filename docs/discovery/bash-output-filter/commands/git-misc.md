# Command family: git branch / tag / remote / config / reflog / worktree / stash list / fetch / clean

**Família:** git (informational)
**Tier:** 1 (validados) — todos passthrough confirmado
**Estratégia:** **NÃO criar filter** — outputs já compactos by design
**Status:** **VALIDATED** — samples reais
**Estimated reduction:** ~0%

---

## Por que agrupar

Esses 9 git subcommands têm output **já compacto** por design (1 entrada por linha, sem decoração desnecessária). Não justificam filter dedicado individual. Documentado em arquivo único pra evitar 9 stubs com `predictedReductionPct: 0`.

## Cada comando — sample real

### `git branch -a` (1.202 bytes, claudio repo)

```
* fix/user-agent-openai-shim
  remotes/origin/fix/user-agent-openai-shim
  main
  remotes/origin/HEAD -> origin/main
  remotes/origin/main
  ...
```

1 branch por linha, prefix `*` indica current. Compacto.

### `git tag --list` (71 bytes)

```
v0.1.10
v0.1.9
v0.1.8
...
```

1 tag por linha. Mínimo absoluto.

### `git remote -v` (131 bytes)

```
origin	ssh://git@git.house.server:2222/viudes/claudio.git (fetch)
origin	ssh://git@git.house.server:2222/viudes/claudio.git (push)
```

2 linhas por remote. Mínimo.

### `git config --list` (3.382 bytes)

```
core.editor=nvim
alias.co=checkout
alias.br=branch
init.defaultbranch=master
pull.rebase=true
diff.algorithm=histogram
...
```

`key=value` por linha. Volume vem da quantidade de configs do user (3.4KB com aliases + diff/merge config). **Filtrar arriscaria perder config relevante** (ex: alias custom que user pediu).

### `git reflog` (804 bytes)

```
a200d7d HEAD@{0}: commit: fix(providers): retry transient 404s
eed74e1 HEAD@{1}: commit: fix(providers): use claudio branding
bb98dbf HEAD@{2}: reset: moving to HEAD
3c1ce42 HEAD@{5}: pull --rebase origin main (finish): returning to refs/heads/main
...
```

Formato `hash HEAD@{N}: action: message` — já compacto. Cada linha é coordenada única (action + state).

### `git worktree list` (197 bytes)

```
/home/viudes/projects/claudio                                  a200d7d [fix/user-agent-openai-shim]
/home/viudes/projects/claudio/.claude/worktrees/agent-ab5c48be aad73b1 [worktree-agent-ab5c48be]
```

1 worktree por linha. Compacto.

### `git stash list`

Vazio quando não há stashes (caso comum). Quando tem:

```
stash@{0}: WIP on main: abc1234 last commit message
stash@{1}: On main: working changes
```

1 entrada por stash, mínimo.

### `git fetch --dry-run` (0 bytes)

Vazio quando nada a fetch. Quando há, formato similar a push (compacto).

### `git clean -nd` (101 bytes)

```
Would remove path/to/file1.txt
Would remove path/to/file2.tmp
...
```

1 entrada por arquivo. Compacto.

---

## Estratégia validada

**Nenhum filter** — match-pattern global do filter system deve **passthrough** todos esses subcommands ao serem detectados.

```jsonc
// Não criar filter dedicado. Subcommands cobertos pelo passthrough natural.
```

---

## ROI medido

Todos validados em 0-1% no harness. **Documentando aqui pra evitar reanálise futura.**

| Comando | Bytes | ROI medido |
|---|---|---|
| `git tag --list` | 71 | **0%** |
| `git remote -v` | 131 | 0% |
| `git worktree list` | 197 | 0% |
| `git branch -a` | 1.202 | **0%** |
| `git reflog` | 804 | 0% |
| `git config --list` | 3.382 | 0% |
| `git fetch --dry-run` | 0 | 0% |
| `git clean -nd` | 101 | 0% |
| `git stash list` (empty) | 0 | 0% |

---

## Findings empíricos

1. **git é compacto por design em comandos informativos** — equipe de design do git foi cuidadosa com output.
2. **`git config --list`** é o maior volume (3.4KB) mas filtrar arriscaria perder info de alias/config.
3. **Match-pattern do filter system v1** deve **explicitamente passthrough** esses subcommands — evita custo de tentar aplicar filter inútil.
