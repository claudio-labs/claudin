# Command: make / cmake

**Match pattern:** `^(make|cmake|gmake)\b`
**Família:** build
**Tier:** 1.5
**Estratégia provável:** declarative (strip echo + Entering directory + recipe noise)
**Status:** **NOT analyzed** (make instalado mas claudin não usa Makefile)
**Estimated reduction:** **~50-80%**

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado em ambiente claudin. Estrutura típica:

### `make` em projeto C

```
make[1]: Entering directory '/path/to/build'
gcc -Wall -O2 -c -o foo.o foo.c
gcc -Wall -O2 -c -o bar.o bar.c
gcc -Wall -O2 -c -o baz.o baz.c
gcc -o myapp foo.o bar.o baz.o -lm
make[1]: Leaving directory '/path/to/build'
```

### `make` com echo (`@cmd` ou non-`@`)

```
make all
echo "Building..."
Building...
gcc -c foo.c
gcc -c bar.c
echo "Linking..."
Linking...
gcc -o myapp foo.o bar.o
```

### `make -j4` paralelo

Recipes interleaved out of order — preservar ordem natural.

### Make com erro

```
gcc -c foo.c
foo.c: In function 'main':
foo.c:42:5: error: 'undefined_var' undeclared (first use in this function)
   42 |     undefined_var = 1;
      |     ^~~~~~~~~~~~~
make: *** [Makefile:23: foo.o] Error 1
```

---

## Sinal vs ruído

**Sinal:**
- Errors / warnings com path:line:col
- `make: *** Error N` — falha com tag de target
- Comando real executado se vai dar erro (`gcc -o myapp` que falhou)

**Ruído:**
- `make[N]: Entering directory '...'` — comum em recursive make (subdirectories)
- `make[N]: Leaving directory '...'`
- Echo de cada comando se não usa `@` prefix — agente raramente precisa de cada comando individual
- `Nothing to be done for 'all'` — passa via `match_output`

---

## Estratégia proposta

```jsonc
{
  "name": "make",
  "matchCommand": "^(make|cmake|gmake)\\b",
  "matchCommandReject": "-q\\b|--quiet|-s\\b|--silent",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^make\\[\\d+\\]: (Entering|Leaving) directory",
    "^\\s*$"
  ],
  "matchOutput": [
    {
      "pattern": "make\\[?\\d*\\]?: Nothing to be done for",
      "message": "✓ make: nothing to do",
      "unless": "(?i)\\b(error|failed)\\b"
    }
  ]
}
```

---

## Edge cases

- [x] `-s` / `--silent` → passthrough (user já reduziu)
- [x] `is_error: true` → filtrar mesmo, errors preservadas
- [ ] **`make -n` (dry run)** — output diferente, lista de comandos. Preservar.
- [ ] **`cmake -B build && cmake --build build`** — output do generator + build, blocks distintos
- [ ] **Recursive make profundo** — `make[1]`, `make[2]`, ... — strip pattern com `\d+` cobre
- [ ] **GNU make vs BSD make** — formatos similares, OK
- [ ] **`@cmd` echo suppressed** — output já mínimo

---

## Estimativa de redução

| Cenário | Antes (est.) | Depois | Redução |
|---|---|---|---|
| Build silencioso (já com `@`) | ~500 | ~500 | 0% |
| Build verbose com 100 arquivos | ~10.000 | ~5.000 | ~50% |
| Recursive make em monorepo | ~8.000 | ~3.000 | ~63% |
| `make` "nothing to do" | ~50 | ~25 | 50% |
| Make com erro | ~3.000 | ~3.000 (preservado) | 0% |

---

## Comparativo com rtk

- rtk: `filters/make.toml` — verificar especificamente se cobre. Mencionado no catálogo TOML de rtk.

---

## Findings empíricos

**ZERO empirical findings** — make não testado em ambiente.

1. **`Entering/Leaving directory`** é signature de noise em recursive make.
2. **`match_output` "Nothing to be done"** é win modesto.
3. **Frequência:** depende do user base — projetos C/C++ usam muito; JS/TS quase nunca.
