# Command: mypy

**Match pattern:** `^(mypy|python\s+-m\s+mypy)\b`
**Família:** python type checker
**Tier:** 1.5
**Estratégia provável:** declarative (similar a tsc — replace de hints + path-relative)
**Status:** **NOT analyzed** (mypy não instalado)
**Estimated reduction:** **~10-30%** (similar a tsc)

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado.

### `mypy src/` clean

```
Success: no issues found in 47 source files
```

Já mínimo, passthrough.

### `mypy src/` com erros

```
src/foo.py:10: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]
src/foo.py:25: error: Function is missing a return type annotation  [no-untyped-def]
src/bar.py:42: note: This is likely because of...
src/bar.py:42: error: Argument 1 to "process" has incompatible type "Optional[int]"; expected "int"  [arg-type]
src/baz.py:88: error: Cannot find implementation or library stub for module named "third_party_lib"  [import]
src/baz.py:88: note: See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports
Found 4 errors in 3 files (checked 47 source files)
```

### `mypy` em projeto grande (1000+ erros)

Pode chegar a 100KB+.

---

## Sinal vs ruído

**Sinal:**
- `path:line: error: msg [code]` — diagnóstico
- `path:line: note: ...` — contexto adicional
- `path:line: warning: msg`
- Footer `Found N errors in M files`

**Ruído:**
- **Path absoluto** se user passou abs path
- **`note: See <url>` repetitivo** quando muitos erros do mesmo tipo (similar ao "Try changing the 'lib'" do tsc)
- ANSI colors em TTY

---

## Estratégia proposta

```jsonc
{
  "name": "mypy",
  "matchCommand": "^(mypy|python\\s+-m\\s+mypy)\\b",
  "matchCommandReject": "--no-error-summary|--show-traceback",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^/(?:[^/:]+/){3,}([^/:]+/[^/:]+/[^:]+):", "replacement": "$1:" },
    { "pattern": "\\s+\\[[a-z\\-]+\\]$", "replacement": "" }
  ],
  "matchOutput": [
    {
      "pattern": "^Success: no issues found",
      "message": "✓ mypy: clean",
      "unless": ""
    }
  ]
}
```

`\s+\[code\]$` strippa o error code (`[assignment]`, `[arg-type]` etc) — economiza ~20 chars/linha mas perde categorização. **Decisão:** manter, é útil.

Versão alternativa sem strip do code:

```jsonc
{
  "replace": [
    { "pattern": "^/(?:[^/:]+/){3,}([^/:]+/[^/:]+/[^:]+):", "replacement": "$1:" }
  ]
}
```

---

## Edge cases

- [x] `--no-error-summary` → passthrough
- [x] `--show-traceback` → passthrough (debug mode)
- [x] `is_error: true` (exit 1+ = errors found) → filtrar mesmo, errors preservadas
- [ ] **`--strict`** mode — mais errors, mesmo filter
- [ ] **`--show-error-context`** — mostra source snippet inline; preservar
- [ ] **Module-level errors** (Cannot find module) — comum + repetitivo

---

## Estimativa de redução

| Cenário | Antes (est.) | Depois | Redução |
|---|---|---|---|
| Clean | ~50 | ~25 (`match_output`) | 50% |
| 5 errors com paths absolutos | ~800 | ~600 | ~25% |
| 100 errors em monorepo | ~15.000 | ~12.000 | ~20% |
| 1000+ errors (very large) | ~100.000 | ~75.000 (paths) | ~25% (mas precisa summarizer também) |

---

## Open questions

- [ ] **Capturar amostras reais** — instalar mypy.
- [ ] **Strip do error code (`[assignment]`)** vale? 20 chars/error × 100 errors = 2KB. ROI marginal mas perde categorização.
- [ ] **Agrupamento por error code** (estilo tsc proposto v2) — útil aqui também, alto ROI.
- [ ] **mypy + ruff** — agente moderno usa ambos. Filters separados, OK.

---

## Comparativo com rtk

- rtk: tem `mypy` em `cmds/python/`? Verificar.

---

## Findings empíricos

**ZERO empirical findings** — mypy não instalado.

1. **`mypy` é compacto by design** — formato uniforme `path:line: severity: msg [code]`.
2. **`match_output` "Success"** é o win principal.
3. **Tier 1.5 baixa prioridade** — frequência depende do user base Python claudin.
