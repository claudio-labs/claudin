# Command: ruff check / ruff format

**Match pattern:** `^ruff\s+(check|format)\b`
**Família:** python linter/formatter
**Tier:** 1.5
**Estratégia provável:** declarative (similar a eslint — strip path absoluto + cap)
**Status:** **NOT analyzed** (`ruff` não instalado local)
**Estimated reduction:** **~30-50%** (estimado, similar a eslint)

---

## Saída crua representativa

⚠️ Não capturado. Estrutura típica:

### `ruff check src/` (clean, 0 errors)

```
All checks passed!
```

Já mínimo absoluto. Passthrough.

### `ruff check src/` com erros

```
src/foo.py:10:5: F401 [*] `os` imported but unused
src/foo.py:25:1: E302 Expected 2 blank lines, found 1
src/foo.py:42:80: E501 Line too long (105 > 100)
src/bar.py:3:1: E402 Module level import not at top of file
src/bar.py:88:5: F841 [*] Local variable `x` is assigned to but never used
Found 5 errors.
[*] 2 fixable with the `--fix` option.
```

Bem compacto por design (formato `path:line:col: code msg`).

### `ruff check src/` com 100 erros

Multiplica por 100 — pode ter 5-15KB.

### `ruff format --check src/`

```
Would reformat: src/foo.py
Would reformat: src/bar.py
Would reformat: src/baz.py
3 files would be reformatted, 47 already formatted.
```

---

## Sinal vs ruído

**Sinal (manter quase tudo):**
- `path:line:col: code msg` — coordenada + diagnóstico
- Footer `Found N errors`
- Footer `[*] X fixable with the --fix option`
- "All checks passed!" / "X already formatted."

**Ruído potencial:**
- **Path absoluto longo** se user passou `/home/user/project/src/foo.py` em vez de `src/foo.py`
- ANSI colors em TTY (rgb codes, sublinhados)
- Linhas em branco redundantes (raras no ruff)

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "ruff",
  "matchCommand": "^ruff\\s+(check|format)\\b",
  "matchCommandReject": "--output-format=(json|junit|github|gitlab|pylint)",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^/[^\\s:]*?/([^/]+/[^/]+/[^:]+):", "replacement": "$1:" }
  ],
  "matchOutput": [
    {
      "pattern": "^All checks passed!$",
      "message": "✓ ruff: all clean",
      "unless": ""
    },
    {
      "pattern": "^\\d+ files? would be reformatted",
      "message": "ruff format: $1 files need formatting",
      "unless": "(?i)\\berror\\b"
    }
  ],
  "maxLines": 100
}
```

**Saída esperada (clean):**

```
✓ ruff: all clean
```

**Saída esperada (com errors):** mesmo conteúdo, paths talvez mais curtos.

---

## Edge cases / NÃO filtrar quando

- [x] `--output-format=json|junit|github|gitlab|pylint` → passthrough estruturado
- [x] `is_error: true` (exit ≠ 0 = erros encontrados) — filtrar mesmo, errors são preservados
- [x] `--quiet` / `-q` → output já reduzido
- [ ] **`--statistics`** flag — adiciona summary table; preservar
- [ ] **`--show-source`** flag — adiciona snippet de source com erro; preservar
- [ ] **`--fix`** sem `--show-fixes` — output igual a sem fix (errors corrigidos não aparecem)
- [ ] **`--add-noqa`** — output diferente, talvez precise filter separado

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois | Redução |
|---|---|---|---|
| `ruff check` clean | ~25 | ~25 (`match_output`) | 0% (mesmo tamanho) |
| `ruff check` com 5 errors | ~400 | ~400 | 0% |
| `ruff check` com 50 errors, paths absolutos | ~6.000 | ~5.000 (relative paths) | ~17% |
| `ruff format --check` 50 files | ~2.000 | ~150 (`match_output`) | ~92% |

**Achado esperado:** ROI relativamente baixo na maioria dos casos. **Ruff já é compacto by design.**

---

## Open questions

- [ ] **Capturar amostras reais** instalando `pip install --user ruff` ou usando uvx.
- [ ] **Mesmo filter cobre `ruff format --check`** ou separar?
- [ ] **`mypy`** tem padrão similar (`path:line: error: msg`) — agrupar com ruff ou separar?
- [ ] Vale a pena? `ruff` é o linter Python mais rápido E mais compacto — talvez nem precise filter.

---

## Comparativo com rtk

- rtk: tem cmd para `ruff` em `cmds/python/`? Verificar.
- Provavelmente filter trivial (cap em maxLines).

---

## Findings empíricos

**ZERO empirical findings** — `ruff` não instalado.

1. **Ruff é compacto por design** — diferente de outros linters (eslint, mypy verbose).
2. **`match_output` "all passed"** é o win — comum em CI checks.
3. **Path-relative replace** dá ~15% adicional se user passou paths absolutos.
4. **Recomendação:** Tier 1.5 baixa prioridade — implementar se telemetria mostrar uso.
