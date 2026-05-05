# Command: pytest

**Match pattern:** `^(pytest|python\s+-m\s+pytest)\b`
**Família:** python
**Tier:** 1 (alvo, mas não validado empiricamente)
**Estratégia provável:** declarative (head + preserve FAILURES block + tail)
**Status:** **NOT analyzed** (pytest não disponível no ambiente de discovery)
**Estimated reduction:** ~70-90% (rtk reporta 90%, alinhado com expectativa)

---

## Saída crua representativa

**⚠️ Amostras NÃO capturadas** — pytest não está instalado no ambiente local. Análise baseada em conhecimento da ferramenta.

### Amostra 1 — todos passam (estimado, ~500-800 bytes)

```
============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.3.0
rootdir: /home/user/project
collected 47 items

tests/test_foo.py ...........                                            [ 23%]
tests/test_bar.py ...........................                            [ 80%]
tests/test_baz.py ..........                                             [100%]

============================== 47 passed in 1.23s ==============================
```

### Amostra 2 — alguns falham (estimado, ~3-8KB)

```
============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.3.0
rootdir: /home/user/project
collected 47 items

tests/test_foo.py .....F.....                                            [ 23%]
tests/test_bar.py ........................F..                            [ 80%]
tests/test_baz.py ..........                                             [100%]

=================================== FAILURES ===================================
___________________________ test_user_authentication ___________________________

self = <tests.test_foo.TestAuth object at 0x7f...>

    def test_user_authentication(self):
        user = User(username="alice")
>       assert user.is_authenticated == True
E       AssertionError: assert False == True
E        +  where False = <User: alice>.is_authenticated

tests/test_foo.py:42: AssertionError
[... 1 more failure block ...]

=========================== short test summary info ============================
FAILED tests/test_foo.py::test_user_authentication - AssertionError: assert False
FAILED tests/test_bar.py::TestApi::test_endpoint - assert 500 == 200
========================= 2 failed, 45 passed in 2.34s =========================
```

### Amostra 3 — verbose `-v` (estimado, ~10KB+)

Mesmo conteúdo da Amostra 2 mas com **uma linha por teste**:

```
tests/test_foo.py::test_login PASSED                                     [  2%]
tests/test_foo.py::test_logout PASSED                                    [  4%]
tests/test_foo.py::test_user_authentication FAILED                       [  6%]
... (47 linhas)
```

---

## Sinal vs ruído

**Sinal (manter):**
- Header com versão de pytest e platform (linha 1-2) — útil pra debug em CI
- `collected N items` — sanity check
- Block `FAILURES` inteiro — **stack traces precisam ficar inteiros**
- Block `ERRORS` (collection errors) — preservar inteiro
- `short test summary info` — overview rápido
- Linha final (`X failed, Y passed in Zs`)

**Ruído:**
- Linhas `tests/foo.py ........F..` (progress dots) — substituir por contagem
- Warnings summary (`PytestDeprecationWarning`) — geralmente não acionável
- Plugins listing no header se irrelevante (`-- pytest, pluggy, anyio, asyncio, ...`)

**Em modo `-v`:**
- 1 linha por teste passado (`test_foo PASSED`) — substituir por contagem se >20 tests
- Linhas FAILED preservar

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "pytest",
  "matchCommand": "^(pytest|python\\s+-m\\s+pytest)\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^=+ warnings summary =+$",
    "^PytestDeprecationWarning",
    "^PytestUnraisableExceptionWarning"
  ],
  "matchOutput": [
    {
      "pattern": "^=+ \\d+ passed in [\\d.]+s =+$",
      "message": "✓ pytest: all tests passed",
      "unless": "(?i)\\b(failed|error|warning)\\b"
    }
  ],
  "maxLines": 100
}
```

### Estratégia mais sofisticada (v2)

Detectar e preservar blocks delimitados por `=== FAILURES ===` e `=== ERRORS ===`:

```ts
// pseudocódigo — não declarativo simples
function compactPytest(raw: string): string {
  const sections = splitBy(raw, /^=+\s.*\s=+$/m)
  const keep = sections.filter(s =>
    s.startsWith('FAILURES') ||
    s.startsWith('ERRORS') ||
    s.startsWith('short test summary')
  )
  const header = sections[0]  // session info
  const footer = lastLine(raw)
  return [header, ...keep, footer].join('\n\n')
}
```

Isso preserva exatamente os blocks que importam, descartando o "progress dots" e warnings.

---

## Edge cases / NÃO filtrar quando

- [x] `--tb=line` ou `--tb=no` → user já pediu compacto, passthrough
- [x] `--tb=short` → curto mas não tão compacto, talvez filtrar mesmo assim
- [x] `-v` / `-vv` → output muito maior; **considerar não filtrar** ou usar maxLines maior
- [x] `--co` (collect-only) → comportamento diferente, passthrough
- [x] `is_error: true` (exit code 1+ = falha de teste) → **NÃO** passthrough automático aqui — pytest exit 1 é "tests failed", e o user PRECISA do output filtrado pra entender. Esse é caso especial onde `is_error: true` ainda merece filtro.
  - Ver `commandSemantics.ts` no claudio — ele sabe que pytest exit 1 é "tests failed", não "comando falhou".
- [ ] `--lf` (last failed) → output curto, passthrough
- [ ] `-x` (stop at first failure) → output curto, passthrough
- [ ] **Doctests** interleaved → não testado, provavelmente OK
- [ ] **Snapshot mismatches** (syrupy) → output enorme com diffs, **preservar**
- [ ] **Capture stdout/stderr de testes** (`Captured stdout call`) → preservar (modelo pode precisar)
- [ ] **`pytest --json-report`** → passthrough (estruturado)

---

## Estimativa de redução

| Cenário | Antes (bytes, estimado) | Depois (estimado) | Redução |
|---|---|---|---|
| Todos passam | 800 | 80 (`match_output`) | 90% |
| 2 falhas em 47 | 6.000 | 3.000 (preserve FAILURES, strip dots) | 50% |
| 10 falhas | 20.000 | 12.000 (FAILURES dominam) | 40% |
| `-v` 100 testes ok | 8.000 | 80 (`match_output`) | 99% |

**Achado esperado:** ROI alto quando todos passam (caso comum em dev iterativo), modesto quando há falhas (preservar tracebacks é caro).

---

## Open questions

- [ ] **Coletar amostras reais** instalando pytest em sandbox. Bloqueador pra finalizar spec.
- [ ] Como detectar e tratar `pytest -v` differently? Mode-specific filter? Ou só `maxLines` maior?
- [ ] **Manter `Captured stdout/stderr` blocks?** São longos mas podem ter info crítica de debug.
- [ ] **`unittest`** (`python -m unittest`) tem output similar mas diferente — filtro separado?
- [ ] **`nose`** (legacy) — fora de escopo

---

## Comparativo com rtk

- rtk: tem filtro nativo? Verificar `cmds/python/` — não estava listado em `RUST_HANDLED_COMMANDS` no `toml_filter.rs:281`. Provavelmente é filtro TOML em `src/filters/`.
- rtk reporta 90% na tabela — viável só no caso "all pass".

---

## Findings empíricos

**ZERO empirical findings** — pytest não disponível no ambiente. Análise toda baseada em conhecimento prévio.

**Bloqueador:** precisa coletar amostras reais antes de spec final. Sugestões:
1. Instalar pytest temporariamente (`pip install --user pytest`)
2. Pedir um contributor com projeto Python pra rodar e capturar
3. Diferir pra Fase 0 — telemetria já cobre isso
