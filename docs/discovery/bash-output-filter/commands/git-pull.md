# Command: git pull

**Match pattern:** `^git(\s+-[^\s]+)*\s+pull\b`
**Família:** git
**Tier:** 1
**Estratégia provável:** **P+M** (pipeline strip + match_output)
**Status:** validated com sample sintético (real fetch retorna 0 bytes — repo já up-to-date)
**Estimated reduction:** **~85-90%** (sample sintético confirma)

---

## Saída crua representativa

### Amostra REAL — `git pull` quando up-to-date (0 bytes, com `--ff-only` ou já em sync)

Já mínimo absoluto. Passthrough.

### Amostra sintética típica — pull com fast-forward (507 bytes)

```
remote: Enumerating objects: 47, done.
remote: Counting objects: 100% (47/47), done.
remote: Compressing objects: 100% (25/25), done.
remote: Total 29 (delta 18), reused 0 (delta 0), pack-reused 0
Unpacking objects: 100% (29/29), 4.32 KiB | 1.08 MiB/s, done.
From git.example.com:dev/claudin
   3c1ce42..bb98dbf  main       -> origin/main
Updating 3c1ce42..bb98dbf
Fast-forward
 src/foo.ts | 12 ++++++++----
 src/bar.ts |  5 ++---
 src/baz.ts |  3 +++
 3 files changed, 11 insertions(+), 6 deletions(-)
```

### Amostra com merge conflict

```
remote: ... (mesmas progress lines)
From github.com:owner/repo
   abc..def  main       -> origin/main
Auto-merging src/foo.ts
CONFLICT (content): Merge conflict in src/foo.ts
Automatic merge failed; fix conflicts and then commit the result.
```

---

## Sinal vs ruído

**Sinal (manter):**
- `From <remote>` linha
- `<hash>..<hash>  branch -> origin/branch` (ref update)
- `Updating <hash>..<hash>`
- `Fast-forward` ou `Merge made by ...`
- **Diff stat** (último bloco — `N files changed, +X -Y`)
- **Conflict markers** (preservar inteiro)

**Ruído alto (mesmo padrão de `git push`):**
- `remote: Enumerating objects: ...`
- `remote: Counting objects: 100% ...`
- `remote: Compressing objects: ...`
- `remote: Total N (delta M)`
- `Unpacking objects: 100% ...`

---

## Estratégia proposta

### Pipeline declarativo (Opção P)

```jsonc
{
  "name": "git-pull",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+pull\\b",
  "matchCommandReject": "--dry-run|--no-ff",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^remote: Enumerating objects",
    "^remote: Counting objects",
    "^remote: Compressing objects",
    "^remote: Total \\d+ \\(delta",
    "^remote: Resolving deltas",
    "^Unpacking objects"
  ],
  "matchOutput": [
    {
      "pattern": "Already up to date\\.",
      "message": "✓ git pull: already up to date",
      "unless": "(?i)\\b(error|conflict|reject)\\b"
    }
  ]
}
```

**Saída esperada (sample sintético, 507 → ~280 bytes, ~45%):**

```
From git.example.com:dev/claudin
   3c1ce42..bb98dbf  main       -> origin/main
Updating 3c1ce42..bb98dbf
Fast-forward
 src/foo.ts | 12 ++++++++----
 src/bar.ts |  5 ++---
 src/baz.ts |  3 +++
 3 files changed, 11 insertions(+), 6 deletions(-)
```

### Estratégia agressiva (Opção R) — rtk-style

rtk colapsa pra `"ok 3 files +10 -2"` (parseando o stat block). ~90% redução total.

```jsonc
// Opção R — rewrite pseudo-código
{
  "matchOutput": [
    {
      "pattern": "(\\d+) files? changed(?:, (\\d+) insertions?\\(\\+\\))?(?:, (\\d+) deletions?\\(-\\))?",
      "message": "✓ pulled: $1 files +$2 -$3",
      "unless": "CONFLICT|reject|error"
    }
  ]
}
```

**Tradeoff Opção R:** perde lista de arquivos modificados (modelo às vezes precisa pra entender mudanças incoming).

---

## Edge cases / NÃO filtrar quando

- [x] `--dry-run` → passthrough (já mínimo)
- [x] `--no-ff` → preservar merge commit info
- [x] `is_error: true` → passthrough (auth, conflict, network)
- [ ] **Merge conflict** (`CONFLICT (content):`) — preservar inteiro via `unless`
- [ ] **Rebase pull** (`pull --rebase`) — output diferente (`Successfully rebased and updated`)
- [ ] **Empty pull** (`Already up to date.`) — `match_output` cobre
- [ ] **Force pull / reset** — fora de escopo

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois (Opção P) | Depois (Opção R) |
|---|---|---|---|
| Already up to date | ~25 | ~30 (`match_output`) | ~30 |
| **Pull com 3 files (sintético)** | **507** | ~280 (45%) | ~30 (94%) |
| Pull grande (50 files) | ~3.000 | ~1.500 (50%) | ~30 (99%) |
| Pull com conflict | ~1.500 | ~1.200 (preserve) | ~1.200 |

---

## Comparativo com rtk

- rtk: `cmds/git/git.rs::run_pull` — implementação nativa. Colapsa pra `"ok N files +X -Y"`.
- **rtk usa Opção R agressiva.** Nós podemos optar por Opção P (preserva file list) ou Opção R (compacta máximo).

---

## Findings

1. **Padrão idêntico ao git push** em progress lines do remote.
2. **Diff stat** é o sinal principal — preservar em Opção P, compactar em Opção R.
3. **Conflict handling crítico** — `unless` deve cobrir `CONFLICT|reject|error`.
4. **Decisão P vs R** alinhar com `git push` (preserva PR URL = preserva file list).

---

## Validação

Adicionado ao validator com sample sintético (`git-pull-synthetic.txt`). Real fetch retorna 0 bytes (repo já em sync), bloqueando validação real-world. Validar com pull em repo com upstream changes seria follow-up.
