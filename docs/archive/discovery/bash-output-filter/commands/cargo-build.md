# Command: cargo build / cargo check

**Match pattern:** `^cargo\s+(build|check|run)\b`
**Família:** rust
**Tier:** 1
**Estratégia provável:** declarative (strip "Compiling X", "Downloaded X", "Updating crates.io")
**Status:** analyzed
**Estimated reduction:** **~55-65%** (medido — mais conservador que rtk reporta 90%)

---

## Saída crua representativa (rtk repo, 5 May 2026)

### Amostra 1 — `cargo check` (cold cache, 7.980 bytes)

Estrutura:
- Linha 1: `Updating crates.io index`
- Linhas 2-29: `Downloading X v1.2.3` + `Downloaded X v1.2.3` (~28 linhas)
- Linhas 30-150: `Compiling X v1.2.3` ou `Checking X v1.2.3` (~120 linhas)
- Linhas 151-160: warnings com source pointers
- Linha final: `Finished` ou `error: ...`

### Amostra 2 — `cargo build` warm cache (6.469 bytes, 116 Compiling + 10 warnings + 1 Finished)

Trecho típico:

```
   Compiling cfg-if v1.0.4
   Compiling stable_deref_trait v1.2.1
   Compiling writeable v0.6.2
   ...                                   ← 116 linhas iguais
   Compiling rtk v0.28.2 (/home/dev/projects/rtk)

warning: direct cast of function item into an integer
    --> src/platform/main.rs:2231:64
     |
2231 |                     libc::signal(libc::SIGINT, handle_signal as libc::sighandler_t);
     |                                                              ^^^^^^^^^^^^^^^^^^^^^
     |
help: first cast to a pointer `as *const ()`
     |
2231 |                     libc::signal(libc::SIGINT, handle_signal as *const () as libc::sighandler_t);
     |                                                              ++++++++++++

warning: `rtk` (bin "rtk") generated 9 warnings (run `cargo fix --bin "rtk" -p rtk` to apply 2 suggestions)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 16.41s
```

**Quebra de linhas:**

| Tipo | Count | Descrição |
|---|---|---|
| `Compiling X` | 116 | Crates dep | 
| `warning:` | 10 | Marker de início de warning block |
| `help:` | 2 | Sugestão dentro de warning |
| `= note:` | 2 | Nota dentro de warning |
| Linhas com `\|` (source pointer) | 28 | Conteúdo do warning |
| `Finished` | 1 | Resultado final |
| **Total estimado** | ~160 linhas | |

**~73% das linhas são puro `Compiling X`** — alvo principal.

### Amostra 3 — `cargo check` cold cache (7.980 bytes)

Mesmo padrão, mas com 28 linhas extras de Downloading/Downloaded no início.

---

## Sinal vs ruído

**Sinal (manter):**
- `Updating crates.io index` (1 linha) — útil saber que houve refetch
- `Compiling <crate-do-projeto>` final — saber que chegou no projeto principal (não dep transitiva)
- `warning:` blocks completos com source pointers
- `help:`, `= note:` (parte do warning)
- `error:` blocks completos
- `Finished ...` linha

**Ruído (remover):**
- `Compiling X v1.2.3` para deps transitivas — 99% do volume
- `Checking X v1.2.3` para deps — idem
- `Downloading X v1.2.3` — substituível por contagem ("Downloaded 28 crates")
- `Downloaded X v1.2.3` — idem
- `Blocking waiting for file lock on package cache` — raro mas inútil

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "cargo-build",
  "matchCommand": "^cargo\\s+(build|check|run)\\b",
  "matchCommandReject": "--message-format=json|--quiet|-q\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*Compiling\\s",
    "^\\s*Checking\\s",
    "^\\s*Updating\\s",
    "^\\s*Downloading\\s",
    "^\\s*Downloaded\\s",
    "^\\s*Blocking waiting for file lock"
  ],
  "matchOutput": [
    {
      "pattern": "^\\s*Finished\\s.*\\sin\\s\\d",
      "message": "✓ cargo build successful",
      "unless": "(?i)\\b(warning|error)\\b"
    }
  ]
}
```

**Saída esperada (Amostra 2 filtrada):**

```
warning: direct cast of function item into an integer
    --> src/platform/main.rs:2231:64
     |
2231 |                     libc::signal(libc::SIGINT, handle_signal as libc::sighandler_t);
     |                                                              ^^^^^^^^^^^^^^^^^^^^^
     |
help: first cast to a pointer `as *const ()`
     |
2231 |                     libc::signal(libc::SIGINT, handle_signal as *const () as libc::sighandler_t);
     |                                                              ++++++++++++

warning: direct cast of function item into an integer
... (9 mais warnings similares)

warning: `rtk` (bin "rtk") generated 9 warnings (run `cargo fix --bin "rtk" -p rtk` to apply 2 suggestions)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 16.41s
```

### Estratégia mais agressiva: contar e mostrar

```
[42 crates compiled]
[2 warnings — full text below]
warning: ...
Finished ...
```

Adiciona contagens no topo, mostra só warnings/errors no body. Ganho extra mínimo (~5%).

---

## Edge cases / NÃO filtrar quando

- [x] `--message-format=json` → passthrough (estruturado)
- [x] `--quiet` / `-q` → passthrough (já silenciado)
- [x] `--verbose` / `-vv` → passthrough (user pediu)
- [x] `is_error: true` → passthrough
- [ ] **`cargo run`** com output do programa interleaved — strip de linhas Compiling OK, mas user-program output preservar
- [ ] **`cargo test`** — comportamento diferente, ver `cargo-test.md` (TBD)
- [ ] **`cargo clippy`** — output similar a `cargo check` mas com lints; mesmo filtro deveria funcionar
- [ ] **Errors com snippets** (`E0308: mismatched types`) — preservar inteiro, **podem ser longos** (40+ linhas)
- [ ] **Manter `Compiling <crate-principal>`** — útil saber que chegou na compilação do crate do user. Detectável por path com `(/path/...)`. Adicionar exceção:
  ```
  "stripLinesMatching": [
    "^\\s*Compiling\\s\\S+\\sv\\d+\\.\\d+\\.\\d+\\s*$"   ← cobre só "X v1.2.3" sem path
  ]
  ```
  Linhas tipo `Compiling rtk v0.28.2 (/home/dev/projects/rtk)` (com path entre parênteses) NÃO seriam strippadas.

---

## Estimativa de redução

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| `cargo check` cold | 7.980 | ~3.000 (warnings + finished) | ~62% |
| `cargo build` warm | 6.469 | ~2.500 | ~61% |
| `cargo build` clean (errors) | TBD | TBD (errors preservados inteiros) | ~30-50% |

**ACHADO:** rtk tabela diz 90%; nossa medição diz **~60%**. A diferença pode vir de:
- rtk talvez também strip dos `Finished` e source pointers (mais agressivo)
- rtk talvez tenha cap de `maxLines` reduzindo warnings
- A tabela rtk pode estar medindo `cargo test` (tem mais boilerplate) e não build

---

## Open questions

- [ ] **`cargo test` separado?** Output muito diferente (com "running N tests", "test foo ... ok", testname expansion). Provavelmente sim.
- [ ] **Manter linha `Compiling <crate-principal>`** ou strip tudo? Argumento a favor: o user fica sabendo que a compilação chegou no código dele. Argumento contra: marker `<bash-output-filtered>` já indica que rodou.
- [ ] **`cargo clippy`** mesmo filtro ou separado? Output muito similar a `check`.
- [ ] Como tratar **error com snippet de tipo** (E0308 com 40+ linhas)? Preservar OK, summarizer cuida se for >8KB.

---

## Comparativo com rtk

- rtk: `cmds/rust/cargo_cmd.rs` — não inspecionei a fundo.
- **O que copiamos:** ideia geral de strip dos `Compiling X`/`Downloading X`.
- **O que mudamos:** preservar `Compiling <crate-principal>` (com path) — não vi confirmação que rtk faz isso.

---

## Findings empíricos

1. **73% das linhas em `cargo build` warm são `Compiling X`** — alvo claríssimo.
2. **Warnings ocupam 28 linhas com source pointers** (`|` indentado) — preservar inteiro é caro mas necessário.
3. **`Finished` line é única e curta** — vira `match_output` quando não há erros/warnings.
4. **Diferença `check` vs `build` é só Downloading no `check` cold** — mesmo filtro cobre os dois.
5. **rtk tabela 90% parece otimista demais** — nossa medição empírica conservadora dá ~60%.
