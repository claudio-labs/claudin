# Command: git show

**Match pattern:** `^git(\s+-[^\s]+)*\s+show\b`
**Família:** git
**Tier:** 1 (validado)
**Estratégia provável:** declarative (mesmo do git diff, baixo ROI)
**Status:** **VALIDATED** — sample real
**Estimated reduction:** **3% (--stat) / 2% (full)** (medido)

---

## Saída crua representativa (REAL: claudio repo, 5 May 2026)

### Amostra 1 — `git show HEAD --stat` (1.353 bytes)

Header de commit + stat summary. Estrutura idêntica a `git log -1 --stat`.

### Amostra 2 — `git show HEAD` (full, 9.946 bytes)

Header de commit + diff inteiro. Equivalente a `git log -1 -p`.

```
commit a200d7d5b6fadf11043aa46455713b2b03428e0c
Author: Viudes <andersonvieiraviudes@gmail.com>
Date:   Tue May 5 15:11:45 2026 -0300

    fix(providers): retry transient 404s from OpenAI-compat providers
    
    OpenAI-compat providers sometimes return transient 404s (model loading,
    routing blip). ...

diff --git a/src/services/api/claude.ts b/src/services/api/claude.ts
index abc123..def456 100644
... (diff body)
```

---

## Sinal vs ruído

`git show` é essencialmente `git log -1` + `git diff` em um comando único. Como **diff é puro sinal** (ver [`git-diff.md`](git-diff.md)) e log já tem padrão conhecido (ver [`git-log.md`](git-log.md)), o ROI é baixo.

**Sinal (manter):**
- Hash, autor (nome só, sem email), data
- Subject + body do commit
- Diff inteiro (header + hunks)

**Ruído mínimo:**
- Email do autor (`<...@...>`)
- Index hashes do diff (`index abc..def 100644`)

---

## Estratégia validada

```jsonc
{
  "name": "git-show",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+show\\b",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^Author: ([^<]+) <[^>]+>$", "replacement": "Author: $1" }
  ],
  "stripLinesMatching": [
    "^index [0-9a-f]+\\.\\.[0-9a-f]+\\s+\\d+$"
  ]
}
```

---

## Edge cases

- [x] `--stat` → mesmo filter (passthrough do diff body)
- [x] `--name-only` / `--name-status` → passthrough
- [x] `--format=...` → passthrough
- [x] Multiple commits (`git show HEAD HEAD~1`) → mesmo filter
- [ ] **Tag annotation** (`git show v1.0`) — output diferente (tag info), filter degrada graceful
- [ ] **Merge commit** (`Merge: abc def`) — preservar

---

## ROI medido

| Cenário | Antes | Depois | Redução |
|---|---|---|---|
| **`git show HEAD --stat` (REAL)** | **1.353** | ~1.310 | **3%** |
| **`git show HEAD` full (REAL)** | **9.946** | ~9.700 | **2%** |
| Show de big merge | ~50.000 | ~49.500 | ~1% |

---

## Findings empíricos

1. **Confirma análise do `git diff`** — diff é puro sinal, ROI < 5%.
2. **Mover pra Tier 2 ou descartar?** ROI minimal não justifica filter dedicado. Caso para deixar pro summarizer existente quando >8KB.
3. **Recomendação:** Tier 1 técnico (validado) mas baixa prioridade na implementação v1.
