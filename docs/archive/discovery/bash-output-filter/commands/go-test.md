# Command: go test

**Match pattern:** `^go\s+test\b`
**Família:** go test
**Tier:** 1.5
**Estratégia provável:** declarative (strip PASS lines, preserve FAIL blocks)
**Status:** **NOT analyzed** (`go` não instalado local)
**Estimated reduction:** **~70-95%** (similar a cargo test / pytest)

---

## Saída crua representativa

⚠️ Não capturado. Estrutura típica:

### `go test ./...` tudo passing (~1-3KB)

```
ok  	github.com/user/proj/internal/auth	0.234s
ok  	github.com/user/proj/internal/db	1.123s
ok  	github.com/user/proj/internal/api	0.567s
ok  	github.com/user/proj/cmd/server	0.089s
```

Já compacto.

### `go test -v ./...` verbose tudo passing (~5-50KB)

```
=== RUN   TestAuthLogin
=== PAUSE TestAuthLogin
=== CONT  TestAuthLogin
--- PASS: TestAuthLogin (0.12s)
=== RUN   TestAuthLogout
--- PASS: TestAuthLogout (0.05s)
=== RUN   TestPasswordHash
--- PASS: TestPasswordHash (0.34s)
... (1 block por teste)
PASS
ok  	github.com/user/proj/internal/auth	0.51s
=== RUN   TestDBConnect
--- PASS: TestDBConnect (1.10s)
... (mais blocks)
PASS
ok  	github.com/user/proj/internal/db	1.123s
```

### `go test ./...` com falha (~3-10KB)

```
ok  	github.com/user/proj/internal/auth	0.234s
--- FAIL: TestDBConnect (0.10s)
    db_test.go:42: connection failed: dial tcp: connection refused
FAIL
FAIL	github.com/user/proj/internal/db	0.234s
ok  	github.com/user/proj/internal/api	0.567s
FAIL
```

### `go test -race -coverprofile=coverage.out ./...` (mais flags)

Output similar mas com warnings de race detector e coverage info.

---

## Sinal vs ruído

**Sinal (manter):**
- `ok package time` — confirmação por package
- `FAIL package time` — falha por package
- **`--- FAIL: TestName (Xs)` block** — nome do teste falho + path + linha + mensagem
- `FAIL` final (resultado overall)
- Coverage output se aplicável

**Ruído (modo `-v`):**
- **`=== RUN TestName`** — uma linha por teste
- `=== PAUSE TestName` / `=== CONT TestName` — interleaved em testes paralelos
- **`--- PASS: TestName (Xs)`** — uma linha por teste passando
- `PASS` (single-line summary do package)

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "go-test",
  "matchCommand": "^go\\s+test\\b",
  "matchCommandReject": "-json|--json|-c\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^=== (RUN|PAUSE|CONT)\\s",
    "^--- PASS:\\s",
    "^PASS$"
  ],
  "matchOutput": [
    {
      "pattern": "^ok\\s+\\S+\\s+[\\d.]+s$",
      "message": "✓ go test: all packages passed",
      "unless": "FAIL"
    }
  ]
}
```

**Saída esperada (modo `-v`, tudo ok, 50KB → 50 bytes):**

```
✓ go test: all packages passed
```

**Saída esperada (modo `-v` com 1 falha, 8KB → ~500 bytes):**

```
ok  	github.com/user/proj/internal/auth	0.234s
--- FAIL: TestDBConnect (0.10s)
    db_test.go:42: connection failed: dial tcp: connection refused
FAIL
FAIL	github.com/user/proj/internal/db	0.234s
ok  	github.com/user/proj/internal/api	0.567s
FAIL
```

---

## Edge cases / NÃO filtrar quando

- [x] `-json` → passthrough (estruturado)
- [x] `-c` (compile only, no run) → output diferente, talvez delegar
- [x] `is_error: true` (exit ≠ 0) — filtrar mesmo (failures preservadas via strip pattern + match_output unless)
- [ ] **`-bench`** — output completamente diferente (benchmark format), filter separado se necessário
- [ ] **`-race`** — adiciona `WARNING: DATA RACE` blocks; preservar inteiro
- [ ] **`-cover` / `-coverprofile`** — adiciona `coverage: X.Y% of statements`; preservar
- [ ] **`-run TestName`** — output reduzido pelo go, filter funciona
- [ ] **Test que escreve stdout via `t.Log()`** — preservar (modelo precisa do output do teste)
- [ ] **`go test -count=N`** runs N vezes — output × N, mesmo filter cobre
- [ ] **`-failfast`** — output curto, OK
- [ ] **Test com `go test -short`** — pode skipar testes; `--- SKIP:` lines aparecem; preservar

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois | Redução |
|---|---|---|---|
| `go test ./...` tudo ok | ~500 | ~50 (`match_output`) | ~90% |
| `go test -v ./...` 50 testes ok | ~10.000 | ~50 | **99%** |
| `go test -v ./...` 1 falha em 50 | ~12.000 | ~600 | **95%** |
| `go test -bench` | ~5.000 | ~5.000 (passthrough — bench format) | 0% |

**Achado esperado:** muito alto ROI no modo `-v` que é onde verbose é problemático.

---

## Open questions

- [ ] **Capturar amostras reais** — instalar Go via mise (`mise use -g go@latest`) ou usar projeto Go demo.
- [ ] **`go test` sem `-v`** já é compacto (1 linha por package). Filter aplicar mesmo assim ou só pra `-v`?
- [ ] **`gotestsum`** (wrapper popular) — output diferente, filter separado.
- [ ] **`golangci-lint run`** — output similar a eslint/ruff, ver `golangci-lint.md` futuro.

---

## Comparativo com rtk

- rtk: tem `cmds/cloud/...`? `cmds/system/...`? Verificar — estava listado em `RUST_HANDLED_COMMANDS`.
- Padrão provável: similar à nossa proposta.

---

## Findings empíricos

**ZERO empirical findings** — Go não instalado.

1. **Modo `-v` é onde tem ROI** — sem `-v`, output já é compacto.
2. **`match_output` "all packages passed"** é o win principal.
3. **FAIL block** tem path + linha + assertion message — preservar inteiro.
4. **Recomendação:** Tier 1.5 — frequência depende do user base do claudin.
