# Command: git add

**Match pattern:** `^git(\s+-[^\s]+)*\s+add\b`
**Família:** git
**Tier:** 2 (output mínimo na maioria; só `--dry-run` ou `-v` produz lista)
**Estratégia provável:** **passthrough** ou cap em maxLines
**Status:** analyzed (real data)
**Estimated reduction:** **~0% normal, ~50%+ em --dry-run em massa**

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra 1 — `git add <files>` SEM `--dry-run` ou `-v`

```
(silent)
```

Output vazio = sucesso. Filter não tem o que fazer.

### Amostra 2 REAL — `git add --dry-run docs/archive/discovery/` (1.674 bytes, 29 entradas)

```
add 'docs/archive/discovery/bash-output-filter/README.md'
add 'docs/archive/discovery/bash-output-filter/analysis.md'
add 'docs/archive/discovery/bash-output-filter/commands/README.md'
... (29 linhas total)
add 'docs/archive/discovery/bash-output-filter/commands/vitest.md'
add 'docs/archive/discovery/bash-output-filter/open-questions.md'
```

### Amostra 3 — `git add -A` em repo com 100+ arquivos novos

Silent. Mesmo `git add -A -v`:

```
add 'src/foo.ts'
add 'src/bar.ts'
... (1 linha por arquivo)
```

Pode chegar a 5-10KB.

---

## Sinal vs ruído

**Sinal:**
- Lista de arquivos adicionados (em `--dry-run` ou `-v`)
- Erros (`fatal: pathspec '...' did not match any files`) — preservar inteiro

**Ruído:**
- Praticamente nada — output já é mínimo

**Caso especial:**
- Em `--dry-run -A` em monorepo, lista pode ser enorme. Cap em maxLines vale.

---

## Estratégia proposta

### Pipeline declarativo trivial

```jsonc
{
  "name": "git-add",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+add\\b",
  "stripAnsi": true,
  "matchOutput": [
    {
      "pattern": "^add ",
      "message": "✓ added ${COUNT} files",
      "unless": "(?i)\\b(error|fatal|warning)\\b"
    }
  ],
  "maxLines": 30
}
```

**Nota:** `${COUNT}` exigiria contar matches no body — não suportado em pipeline declarativo simples. Alternativa: só usar `maxLines: 30` sem `match_output`.

### Versão mais simples

```jsonc
{
  "name": "git-add",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+add\\b",
  "maxLines": 30
}
```

Output curto passa intacto, output massivo fica capped a 30 linhas + marker.

---

## Edge cases / NÃO filtrar quando

- [x] Output vazio (caso normal) — nada a filtrar
- [x] `is_error: true` — passthrough (`fatal: pathspec did not match`)
- [x] `--dry-run` ou `-n` — gera lista, filter capa em 30
- [x] `-v` (verbose) — mesma lista
- [ ] **`-i` (interactive)** — interativo, fora de escopo
- [ ] **`-p` (patch mode)** — interativo, fora de escopo
- [ ] **`--ignore-errors`** flag — pode produzir warnings; preservar via `unless`
- [ ] **Output de pre-commit hook se hook rodar em add** (raro mas possível) — preservar

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| `git add file.ts` (success silent) | 0 | 0 | 0% (nada a fazer) |
| **`git add --dry-run` 29 arquivos REAL** | **1.674** | 1.674 (passa, abaixo de 30 linhas) | **0%** |
| `git add --dry-run` 200 arquivos | ~12.000 | ~1.800 (cap 30) | ~85% (mas perde info) |
| `git add -A -v` 50 arquivos | ~3.000 | 3.000 | 0% |

**Achado:** ROI quase nulo no uso normal. `git add` raramente é o gargalo.

---

## Open questions

- [ ] Vale a pena criar filter pra `git add`? Provavelmente **não** — Tier 2/3.
- [ ] **`git rm`** / **`git mv`** têm padrões similares — agrupar?
- [ ] Considerar adicionar ao **zero-roi-skiplist** se análise de uso real confirmar.

---

## Comparativo com rtk

- rtk: nenhum filtro específico para `git add` em `cmds/git/git.rs` — confirma ROI baixo.

---

## Findings empíricos

1. **`git add` normalmente é silent** — filter não tem o que fazer.
2. **`--dry-run` ou `-v`** geram lista linear, baixo ROI exceto em casos massivos.
3. **Recomendação:** mover pra **zero-ROI skiplist** ou Tier 2 baixíssima prioridade.
4. **Cumulativo:** mesmo agente fazendo 50 `git add`/sessão, ganho total <1KB.
