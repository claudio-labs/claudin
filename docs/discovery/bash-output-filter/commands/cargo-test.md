# Command: cargo test

**Match pattern:** `^cargo\s+test\b`
**Família:** rust test
**Tier:** 1
**Estratégia provável:** declarative (strip Compiling + match_output all-pass + preserve FAILURES)
**Status:** analyzed (compile-only data real, run-output estimado)
**Estimated reduction:** **~70-95%** (varia muito com pass/fail ratio)

---

## Saída crua representativa

### Amostra 1 — `cargo test --no-run` (REAL no rtk: 1.426 bytes)

Output é igual a `cargo build` (Compiling X v1.2.3 lines + warnings + Finished). Termina com:

```
warning: `rtk` (bin "rtk" test) generated 2 warnings (run `cargo fix --bin "rtk" -p rtk --tests` to apply 2 suggestions)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 11.57s
  Executable unittests src/main.rs (target/debug/deps/rtk-b7f584a7b0aace80)
```

### Amostra 2 — `cargo test` com testes rodando (estimado, ~3-15KB)

```
   Compiling rtk v0.28.2 (...)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 12.34s
     Running unittests src/main.rs (target/debug/deps/rtk-abc123)

running 47 tests
test cmds::git::tests::test_normalize_diff ... ok
test cmds::git::tests::test_run_status ... ok
test cmds::system::ls::tests::test_compact_basic ... ok
... (47 lines)
test cmds::xyz::tests::test_foo ... FAILED
test result: FAILED. 46 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s

failures:

---- cmds::xyz::tests::test_foo stdout ----
thread 'cmds::xyz::tests::test_foo' panicked at src/cmds/xyz.rs:42:
assertion `left == right` failed
  left: 1
 right: 2
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

failures:
    cmds::xyz::tests::test_foo

test result: FAILED. 46 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s

error: test failed, to rerun pass `--bin rtk`
```

### Amostra 3 — `cargo test` com tudo passing (estimado, ~3-10KB)

```
   Compiling rtk v0.28.2 (...)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 12.34s
     Running unittests src/main.rs (target/debug/deps/rtk-abc123)

running 47 tests
test cmds::git::tests::test_normalize_diff ... ok
... (47 ok lines)

test result: ok. 47 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s
```

---

## Sinal vs ruído

**Sinal (manter):**
- `running N tests` — sanity check
- **`failures:` block inteiro** com stack/panic message
- `test result: ok|FAILED. X passed; Y failed; Z ignored`
- Errors críticos (`error: test failed, to rerun pass...`)

**Ruído:**
- `Compiling X v1.2.3` (lines de build dep, igual ao `cargo-build.md`)
- **`test foo::bar ... ok`** — uma linha por test que passou. Em 100 testes, ocupa 100 linhas. **Alvo principal.**
- `Running unittests src/main.rs (target/debug/deps/rtk-<hash>)` — path com binary hash que varia
- `note: run with RUST_BACKTRACE=1...` — repete em cada panic
- Linhas em branco redundantes

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "cargo-test",
  "matchCommand": "^cargo\\s+test\\b",
  "matchCommandReject": "--message-format=json|--quiet|-q\\b|--no-run",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*Compiling\\s",
    "^\\s*Checking\\s",
    "^\\s*Updating\\s",
    "^\\s*Downloading\\s",
    "^\\s*Downloaded\\s",
    "^\\s*Finished\\s.*\\sin\\s\\d",
    "^\\s*Running\\s.*\\(target/debug/deps/",
    "^test\\s.+\\s\\.\\.\\.\\sok\\s*$",
    "^note: run with `RUST_BACKTRACE=1`",
    "^\\s*$"
  ],
  "matchOutput": [
    {
      "pattern": "test result: ok\\. \\d+ passed; 0 failed",
      "message": "✓ cargo test: all tests passed",
      "unless": "(?i)\\b(FAILED|ignored: [1-9])\\b|panicked|warning"
    }
  ]
}
```

**Saída esperada (todos passam, ~10KB → ~50 bytes):**

```
✓ cargo test: all tests passed
```

**Saída esperada (1 falha, ~5KB → ~600 bytes):**

```
running 47 tests
test result: FAILED. 46 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s

failures:

---- cmds::xyz::tests::test_foo stdout ----
thread 'cmds::xyz::tests::test_foo' panicked at src/cmds/xyz.rs:42:
assertion `left == right` failed
  left: 1
 right: 2

failures:
    cmds::xyz::tests::test_foo

test result: FAILED. 46 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s

error: test failed, to rerun pass `--bin rtk`
```

---

## Edge cases / NÃO filtrar quando

- [x] `--quiet` / `-q` — passthrough
- [x] `--message-format=json` — passthrough estruturado
- [x] `--no-run` — só compila, deixa pro filtro `cargo-build`
- [x] `is_error: true` — filtrar mesmo (failure preservada via `unless` + strip pattern)
- [ ] **`-- --nocapture`** — testes printam stdout interleaved; preservar (modelo precisa do output do teste)
- [ ] **`-- --ignored`** — só rodar testes ignorados, output curto
- [ ] **`cargo bench`** — output de benchmark, **não cobrir** aqui (ver `cargo-bench.md` futuro)
- [ ] **Doc tests** — output adicional `Doc-tests <crate>` com seu próprio block. Preservar.
- [ ] **Threads paralelas** podem interleave output — preservar ordem mesmo se "test ... ok" parece fora de sequência
- [ ] **`#[ignore]` testes** — aparecem como `... ignored` em vez de `ok`. Strip pattern atual cobre só `ok`.

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`cargo test --no-run` (REAL: build only, 1.426 bytes)** | 1.426 | ~50 (delegar ao `cargo-build`) | ~96% |
| 47 testes todos passam | ~5.000 | ~50 (`match_output`) | **99%** |
| 47 testes com 1 falha | ~6.000 | ~600 (preserva FAILURES) | ~90% |
| 200 testes todos passam | ~15.000 | ~50 | **99%** |
| 200 testes com 10 falhas | ~25.000 | ~5.000 (10 panic blocks preservados) | ~80% |

---

## Open questions

- [ ] **Capturar amostra real de `cargo test`** rodando (não só `--no-run`).
- [ ] Como filter trata **`cargo test --workspace`** em workspace com 10 crates? Output tem `Running ... <crate1>`, `Running ... <crate2>`, etc.
- [ ] **`cargo nextest`** (alternativo, mais rápido) — output completamente diferente. Filter separado se claudio user usar.
- [ ] **`-- --skip <pattern>`** ou `-- foo::test_bar` (filtro de testes) — output reduzido pelo cargo, filter funciona normalmente.

---

## Comparativo com rtk

- rtk: filtro embebido em `cargo_cmd.rs` (não inspecionei a fundo).
- **O que copiamos:** strip de `Compiling X` + `Finished` lines.
- **O que adicionamos:**
  - Strip de `test ... ok` lines (rtk pode não fazer isso especificamente)
  - `match_output` para "all passed" (rtk pode usar `on_empty`)

---

## Findings empíricos

1. **`cargo test --no-run` ≡ `cargo build`** — output idêntico (compile only). Delegar pro filtro `cargo-build.md`.
2. **`test ... ok` lines** dominam em testes que passam — strip é o win principal.
3. **`match_output` "all passed"** é o `match_output` mais valioso aqui — 99% no caso comum.
4. **FAILURES block** tem panic + path + assertion — preservar inteiro é crítico.
