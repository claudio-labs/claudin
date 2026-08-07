# Command: eslint / biome / oxlint / prettier --check

**Match pattern:** `^(eslint|biome\s+check|oxlint|prettier\s+--check)\b`
**Família:** js linter/formatter
**Tier:** 1.5
**Estratégia provável:** declarative (group by file + count)
**Status:** **NOT analyzed** (não capturado)
**Estimated reduction:** ~30-50% (depende da densidade de erros)

---

## Saída crua representativa

⚠️ Não capturado.

### eslint formato default

```
/home/user/project/src/foo.ts
  10:5   error    'unused' is defined but never used  no-unused-vars
  42:15  warning  Unexpected console statement       no-console

/home/user/project/src/bar.ts
  3:1    error    Missing semicolon                  semi
  25:80  warning  Line too long (105 > 100)          max-len

✖ 4 problems (2 errors, 2 warnings)
```

### biome / oxlint

Output similar mas mais compacto por design.

---

## Sinal vs ruído

**Sinal (manter):**
- Path (idealmente truncado se for absoluto longo)
- linha:col + severity + msg + rule

**Ruído:**
- Path absoluto repetido como cabeçalho de cada arquivo (`/home/user/project/src/foo.ts`) — virar relativo
- Linhas em branco entre arquivos
- Footer summary se já evidente do conteúdo

---

## Estratégia proposta

```jsonc
{
  "name": "eslint",
  "matchCommand": "^(eslint|biome\\s+check|oxlint|prettier\\s+--check)\\b",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^/[^\\s]+/(?=src/|tests?/|app/|lib/)", "replacement": "" }
  ],
  "stripLinesMatching": [
    "^\\s*$"
  ]
}
```

---

## Edge cases

- [x] `--format json` / `--reporter json` — passthrough
- [x] `--quiet` — passthrough
- [x] `--fix` — silent on success, errors aparecem (mesmo filtro)
- [ ] **`prettier --write`** — lista arquivos formatados, output diferente (pode ter 100s de linhas em projeto grande)
- [ ] **stylish vs compact reporter** — eslint tem múltiplos. Filter precisa cobrir o default.

---

## Open questions

- [ ] **Capturar amostras reais.**
- [ ] Vale separar filtros (eslint vs biome vs oxlint vs prettier)? Outputs diferem; provavelmente sim na v2.
- [ ] **biome** é mais compacto by design — talvez não precise filtro.

---

## Comparativo com rtk

- rtk: `cmds/js/lint_cmd.rs` (genérico) e `cmds/js/prettier_cmd.rs`.
- **Confirma split entre lint e prettier.**

---

## Findings empíricos

**ZERO empirical findings** — bloqueador, capturar depois.
